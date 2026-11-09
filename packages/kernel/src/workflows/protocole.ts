import { z } from "zod";
import type { BlocksMemory } from "./memory.js";
import type { Block, Link } from "./schema.js";

/** Maximum size of a widget's data (its `donnees.json`, an as-it-goes publication). */
export const DATA_MAX_SIZE = 2 * 1024 * 1024;

/** Maximum size of a line of the harvester <-> kernel protocol. */
export const LINE_MAX_BYTES = 4 * 1024 * 1024;

export const HarvesterFunction = z.enum(["lirePage", "recuperer", "kev", "gemma", "chercherWeb"]);
export type HarvesterFunction = z.infer<typeof HarvesterFunction>;

const SentMemory = z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown() }));

/** Status of a block at its end, as the container sends it. */
export const ContainerBlockStatus = z.enum(["reussi", "partiel", "echoue"]);

/**
 * Harvester's standard output: one JSON line per message. For a workflow, traces (`bloc`, `journal`) and the
 * blocks' memory (`memoire`, just before `fin`; also along the way for a progressive run, the last one
 * received counts); during the as-it-goes chain, `publication`s; the end stays `fin` / `echec`.
 */
export const HarvesterMessage = z.union([
  z.object({ t: z.literal("appel"), n: z.number().int(), f: HarvesterFunction, a: z.unknown() }),
  z.object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("debut") }),
  z.object({
    t: z.literal("bloc"),
    id: z.string(),
    etape: z.literal("fin"),
    statut: ContainerBlockStatus,
    sortie: z.unknown().optional(),
    sortieTropGrosse: z.literal(true).optional(),
    erreur: z.string().optional(),
  }),
  // Action only (`avancement` in `debut`): a per-item block has reached `faits` items out of `total`.
  z
    .object({ t: z.literal("bloc"), id: z.string(), etape: z.literal("avancement"), faits: z.number().int().min(0), total: z.number().int().min(0) })
    .refine((m) => m.faits <= m.total),
  z.object({ t: z.literal("journal"), bloc: z.string(), texte: z.string() }),
  z.object({ t: z.literal("memoire"), memoire: SentMemory }),
  z.object({ t: z.literal("publication"), donnees: z.unknown(), faits: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ t: z.literal("fin"), donnees: z.unknown() }),
  z.object({ t: z.literal("echec"), erreur: z.string() }),
]);
export type HarvesterMessage = z.infer<typeof HarvesterMessage>;

/** What the container receives of a validated workflow: its blocks, its links and the run order. */
export type SentWorkflow = { blocs: Block[]; liens: Link[]; ordre: string[] };

/** For a try: the blocks to rerun (in order) and the outputs taken from the original run, per block. */
export type ReplaySent = { relances: string[]; sorties: Record<string, unknown> };

/**
 * Harvester's standard input: the initial line (always with its workflow, implicit for a lone `recolte.mjs`),
 * then the blocks' memory, then the answers.
 */
export const KernelMessage = z.union([
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
  z.object({ t: z.literal("memoire"), memoire: SentMemory }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), erreur: z.string() }),
]);
export type KernelMessage = z.infer<typeof KernelMessage>;

/** Arguments of the calls, depending on the function. */
/** At most 20 screens scrolled by a page read (`defiler`). */
export const SCROLL_MAX = 20;
export const ReadPageArgs = z.object({ url: z.string(), compte: z.boolean().optional(), defiler: z.number().int().min(0).max(SCROLL_MAX).optional() });
export const FetchArgs = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
/** Web search done by the kernel; answer: `{ titre, url, extrait }[]`, at most `nombre`. */
export const SearchWebArgs = z.object({ requete: z.string().min(1).max(500), nombre: z.number().int().min(1).max(20) });
export const ArgsGemma = z.object({ prompt: z.string(), images: z.array(z.string()).optional(), json: z.boolean().optional() });

export type ReadPage = { url: string; titre: string; texte: string; liens: { texte: string; url: string }[] };

/** Parses a line of the harvester's output; null if invalid. */
export function readHarvesterMessage(line: string): HarvesterMessage | null {
  try {
    const r = HarvesterMessage.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function responseLine(n: number, result: { ok: unknown } | { erreur: string }): string {
  return JSON.stringify({ t: "reponse", n, ...result }) + "\n";
}

export type StartOptions = {
  precedent: unknown;
  maintenant: string;
  config: unknown;
  workflow: SentWorkflow;
  rejeu?: ReplaySent;
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
export function lineStart(o: StartOptions): string {
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
 * refuses a line of more than `LINE_MAX_BYTES`. To measure before launching a try, to refuse without writing anything.
 */
export function lineStartBytes(o: StartOptions): number {
  return Buffer.byteLength(lineStart(o));
}

export function startTooBig(o: StartOptions): boolean {
  return lineStartBytes(o) > LINE_MAX_BYTES;
}

export function memoryLine(m: BlocksMemory): string {
  return JSON.stringify({ t: "memoire", memoire: m }) + "\n";
}
