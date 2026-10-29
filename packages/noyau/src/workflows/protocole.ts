import { z } from "zod";
import type { MemoireBlocs } from "./memoire.js";
import type { Bloc, Lien } from "./schema.js";

/** Taille maximale d'une ligne du protocole récolteur <-> noyau. */
export const LIGNE_MAX_OCTETS = 4 * 1024 * 1024;

export const FonctionRecolteur = z.enum(["lirePage", "recuperer", "kev", "gemma"]);
export type FonctionRecolteur = z.infer<typeof FonctionRecolteur>;

const MemoireEnvoyee = z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown() }));

/** Statut d'un bloc à sa fin, tel que l'envoie le conteneur. */
export const StatutBlocConteneur = z.enum(["reussi", "partiel", "echoue"]);

/**
 * Sortie standard du récolteur : une ligne JSON par message. Pour un workflow, des traces (`bloc`, `journal`) et la
 * mémoire des blocs (`memoire`, juste avant `fin`) ; la fin reste `fin` / `echec`.
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
  z.object({ t: z.literal("journal"), bloc: z.string(), texte: z.string() }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("fin"), donnees: z.unknown() }),
  z.object({ t: z.literal("echec"), erreur: z.string() }),
]);
export type MessageRecolteur = z.infer<typeof MessageRecolteur>;

/** Ce que le conteneur reçoit d'un workflow validé : ses blocs, ses liens et l'ordre d'exécution. */
export type WorkflowEnvoye = { blocs: Bloc[]; liens: Lien[]; ordre: string[] };

/**
 * Entrée standard du récolteur : la ligne initiale, puis (pour un workflow) la mémoire des blocs, puis les réponses.
 * Sans `workflow`, le récolteur lance `recolte.mjs` comme avant les workflows.
 */
export const MessageNoyau = z.union([
  z.object({
    t: z.literal("debut"),
    precedent: z.unknown(),
    maintenant: z.string(),
    config: z.unknown().optional(),
    workflow: z.object({ blocs: z.array(z.unknown()), liens: z.array(z.unknown()), ordre: z.array(z.string()) }).optional(),
  }),
  z.object({ t: z.literal("memoire"), memoire: MemoireEnvoyee }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), erreur: z.string() }),
]);
export type MessageNoyau = z.infer<typeof MessageNoyau>;

/** Arguments des appels, selon la fonction. */
export const ArgsLirePage = z.object({ url: z.string(), compte: z.boolean().optional() });
export const ArgsRecuperer = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
export const ArgsGemma = z.object({ prompt: z.string(), images: z.array(z.string()).optional(), json: z.boolean().optional() });

export type PageLue = { url: string; titre: string; texte: string; liens: { texte: string; url: string }[] };

/** Analyse une ligne de la sortie du récolteur ; null si invalide. */
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

export function ligneDebut(o: { precedent: unknown; maintenant: string; config: unknown; workflow?: WorkflowEnvoye }): string {
  return (
    JSON.stringify({
      t: "debut",
      precedent: o.precedent ?? null,
      maintenant: o.maintenant,
      config: o.config ?? null,
      ...(o.workflow ? { workflow: o.workflow } : {}),
    }) + "\n"
  );
}

export function ligneMemoire(m: MemoireBlocs): string {
  return JSON.stringify({ t: "memoire", memoire: m }) + "\n";
}
