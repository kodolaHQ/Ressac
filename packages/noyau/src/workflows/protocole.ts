import { z } from "zod";
import type { MemoireBlocs } from "./memoire.js";
import type { Bloc, Lien } from "./schema.js";

/** Maximum size of a widget's data (its `donnees.json`, an as-it-goes publication). */
export const TAILLE_MAX_DONNEES = 2 * 1024 * 1024;

/** Maximum size of a line of the harvester <-> kernel protocol. */
export const LIGNE_MAX_OCTETS = 4 * 1024 * 1024;

export const FonctionRecolteur = z.enum(["lirePage", "recuperer", "kev", "gemma", "chercherWeb"]);
export type FonctionRecolteur = z.infer<typeof FonctionRecolteur>;

const MemoireEnvoyee = z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown() }));

/** Status of a block at its end, as the container sends it. */
export const StatutBlocConteneur = z.enum(["reussi", "partiel", "echoue"]);

/**
 * Harvester's standard output: one JSON line per message. For a workflow, traces (`bloc`, `journal`) and the
 * blocks' memory (`memoire`, just before `fin`; also along the way for a progressive run, the last one
 * received counts); during the as-it-goes chain, `publication`s; the end stays `fin` / `echec`.
 */
export const MessageRecolteur = z.union([
  z.object({ t: z.literal("appel"), n: z.number().int(), f: FonctionRecolteur, a: z.unknown() }),
  z.object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("debut") }),
  z.object({
    t: z.literal("bloc"),
    id: z.string(),
    etape: z.literal("fin"),
    statut: StatutBlocConteneur,
    sortie: z.unknown().optional(),
    sortieTropGrosse: z.literal(true).optional(),
    erreur: z.string().optional(),
  }),
  // Action only (`avancement` in `debut`): a per-item block has reached `faits` items out of `total`.
  z
    .object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("avancement"), faits: z.number().int().min(0), total: z.number().int().min(0) })
    .refine((m) => m.faits <= m.total),
  z.object({ t: z.literal("journal"), bloc: z.string(), texte: z.string() }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("publication"), donnees: z.unknown(), faits: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ t: z.literal("fin"), donnees: z.unknown() }),
  z.object({ t: z.literal("echec"), erreur: z.string() }),
]);
export type MessageRecolteur = z.infer<typeof MessageRecolteur>;

/** What the container receives of a validated workflow: its blocks, its links and the run order. */
export type WorkflowEnvoye = { blocs: Bloc[]; liens: Lien[]; ordre: string[] };

/** For a try: the blocks to rerun (in order) and the outputs taken from the original run, per block. */
export type RejeuEnvoye = { relances: string[]; sorties: Record<string, unknown> };

/**
 * Harvester's standard input: the initial line (always with its workflow, implicit for a lone `recolte.mjs`),
 * then the blocks' memory, then the answers.
 */
export const MessageNoyau = z.union([
  z.object({
    t: z.literal("debut"),
    precedent: z.unknown(),
    maintenant: z.string(),
    config: z.unknown().optional(),
    workflow: z.object({ blocs: z.array(z.unknown()), liens: z.array(z.unknown()), ordre: z.array(z.string()) }),
    rejeu: z.object({ relances: z.array(z.string()), sorties: z.record(z.string(), z.unknown()) }).optional(),
    limiteMs: z.number().int().positive().optional(),
    progressif: z.literal(true).optional(),
    saisie: z.string().optional(),
    avancement: z.literal(true).optional(),
  }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), erreur: z.string() }),
]);
export type MessageNoyau = z.infer<typeof MessageNoyau>;

/** Arguments of the calls, depending on the function. */
/** At most 20 screens scrolled by a page read (`defiler`). */
export const DEFILER_MAX = 20;
export const ArgsLirePage = z.object({ url: z.string(), compte: z.boolean().optional(), defiler: z.number().int().min(0).max(DEFILER_MAX).optional() });
export const ArgsRecuperer = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
/** Web search done by the kernel; answer: `{ titre, url, extrait }[]`, at most `nombre`. */
export const ArgsChercherWeb = z.object({ requete: z.string().min(1).max(500), nombre: z.number().int().min(1).max(20) });
export const ArgsGemma = z.object({ prompt: z.string(), images: z.array(z.string()).optional(), json: z.boolean().optional() });

export type PageLue = { url: string; titre: string; texte: string; liens: { texte: string; url: string }[] };

/** Parses a line of the harvester's output; null if invalid. */
export function lireMessageRecolteur(ligne: string): MessageRecolteur | null {
  try {
    const r = MessageRecolteur.safeParse(JSON.parse(ligne));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function ligneReponse(n: number, resultat: { ok: unknown } | { erreur: string }): string {
  return JSON.stringify({ t: "reponse", n, ...resultat }) + "\n";
}

export type OptionsDebut = {
  precedent: unknown;
  maintenant: string;
  config: unknown;
  workflow: WorkflowEnvoye;
  rejeu?: RejeuEnvoye;
  /** No more items run after this delay (`dureeMaxMinutes × 60 000`). */
  limiteMs?: number;
  /** Memory sent along the way, as-it-goes publications. */
  progressif?: true;
  /** Action only: the text typed at launch (`{saisie}` of the templates, `ctx.saisie`). */
  saisie?: string;
  /** Action only: the per-item blocks send their progress. */
  avancement?: true;
};

/**
 * The `debut` line; the keys `rejeu`, `limiteMs`, `progressif`, `saisie` and `avancement` are only there if they are
 * given (the line of a widget without the new fields does not change).
 */
export function ligneDebut(o: OptionsDebut): string {
  return (
    JSON.stringify({
      t: "debut",
      precedent: o.precedent ?? null,
      maintenant: o.maintenant,
      config: o.config ?? null,
      workflow: o.workflow,
      ...(o.rejeu ? { rejeu: { relances: o.rejeu.relances, sorties: o.rejeu.sorties } } : {}),
      ...(o.limiteMs !== undefined ? { limiteMs: o.limiteMs } : {}),
      ...(o.progressif ? { progressif: true } : {}),
      ...(o.saisie !== undefined ? { saisie: o.saisie } : {}),
      ...(o.avancement ? { avancement: true } : {}),
    }) + "\n"
  );
}

/**
 * Bytes of the start line as it is sent (with, for a replay, the taken outputs): the harvester
 * refuses a line of more than `LIGNE_MAX_OCTETS`. To measure before launching a try, to refuse without writing anything.
 */
export function octetsLigneDebut(o: OptionsDebut): number {
  return Buffer.byteLength(ligneDebut(o));
}

export function debutTropGros(o: OptionsDebut): boolean {
  return octetsLigneDebut(o) > LIGNE_MAX_OCTETS;
}

export function ligneMemoire(m: MemoireBlocs): string {
  return JSON.stringify({ t: "memoire", memoire: m }) + "\n";
}
