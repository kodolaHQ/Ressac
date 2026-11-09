import { z } from "zod";
import type { BlocksMemory } from "./memory.js";
import type { Block, Link } from "./schema.js";

/** Maximum size of a widget's data (its `donnees.json`, an as-it-goes publication). */
export const DATA_MAX_SIZE = 2 * 1024 * 1024;

/** Maximum size of a line of the harvester <-> kernel protocol. */
export const LINE_MAX_BYTES = 4 * 1024 * 1024;

export const HarvesterFunction = z.enum(["lirePage", "recuperer", "kev", "gemma", "chercherWeb"]);
export type HarvesterFunction = z.infer<typeof HarvesterFunction>;

const SentMemory = z.record(z.string(), z.object({ type: z.string(), value: z.unknown() }));

/** Status of a block at its end, as the container sends it. */
export const ContainerBlockStatus = z.enum(["reussi", "partiel", "echoue"]);

/**
 * Harvester's standard output: one JSON line per message. For a workflow, traces (`bloc`, `journal`) and the
 * blocks' memory (`memoire`, just before `fin`; also along the way for a progressive run, the last one
 * received counts); during the as-it-goes chain, `publication`s; the end stays `fin` / `echec`.
 */
export const HarvesterMessage = z.union([
  z.object({ t: z.literal("appel"), n: z.number().int(), f: HarvesterFunction, a: z.unknown() }),
  z.object({ t: z.literal("bloc"), id: z.string(), step: z.literal("debut") }),
  z.object({
    t: z.literal("bloc"),
    id: z.string(),
    step: z.literal("fin"),
    status: ContainerBlockStatus,
    output: z.unknown().optional(),
    outputTooBig: z.literal(true).optional(),
    error: z.string().optional(),
  }),
  // Action only (`avancement` in `debut`): a per-item block has reached `faits` items out of `total`.
  z
    .object({ t: z.literal("bloc"), id: z.string(), step: z.literal("avancement"), done: z.number().int().min(0), total: z.number().int().min(0) })
    .refine((m) => m.done <= m.total),
  z.object({ t: z.literal("journal"), block: z.string(), text: z.string() }),
  z.object({ t: z.literal("memoire"), memory: SentMemory }),
  z.object({ t: z.literal("publication"), data: z.unknown(), done: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ t: z.literal("fin"), data: z.unknown() }),
  z.object({ t: z.literal("echec"), error: z.string() }),
]);
export type HarvesterMessage = z.infer<typeof HarvesterMessage>;

/** What the container receives of a validated workflow: its blocks, its links and the run order. */
export type SentWorkflow = { blocks: Block[]; links: Link[]; order: string[] };

/** For a try: the blocks to rerun (in order) and the outputs taken from the original run, per block. */
export type ReplaySent = { reruns: string[]; outputs: Record<string, unknown> };

/**
 * Harvester's standard input: the initial line (always with its workflow, implicit for a lone `recolte.mjs`),
 * then the blocks' memory, then the answers.
 */
export const KernelMessage = z.union([
  z.object({
    t: z.literal("debut"),
    previous: z.unknown(),
    now: z.string(),
    config: z.unknown().optional(),
    workflow: z.object({ blocks: z.array(z.unknown()), links: z.array(z.unknown()), order: z.array(z.string()) }),
    replay: z.object({ reruns: z.array(z.string()), outputs: z.record(z.string(), z.unknown()) }).optional(),
    limitMs: z.number().int().positive().optional(),
    progressive: z.literal(true).optional(),
    input: z.string().optional(),
    progress: z.literal(true).optional(),
  }),
  z.object({ t: z.literal("memoire"), memory: SentMemory }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("reponse"), n: z.number().int(), error: z.string() }),
]);
export type KernelMessage = z.infer<typeof KernelMessage>;

/** Arguments of the calls, depending on the function. */
/** At most 20 screens scrolled by a page read (`defiler`). */
export const SCROLL_MAX = 20;
export const ReadPageArgs = z.object({ url: z.string(), account: z.boolean().optional(), scroll: z.number().int().min(0).max(SCROLL_MAX).optional() });
export const FetchArgs = z.object({ url: z.string(), format: z.enum(["texte", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
/** Web search done by the kernel; answer: `{ titre, url, extrait }[]`, at most `nombre`. */
export const SearchWebArgs = z.object({ query: z.string().min(1).max(500), count: z.number().int().min(1).max(20) });
export const ArgsGemma = z.object({ prompt: z.string(), images: z.array(z.string()).optional(), json: z.boolean().optional() });

export type ReadPage = { url: string; title: string; text: string; links: { text: string; url: string }[] };

/** Parses a line of the harvester's output; null if invalid. */
export function readHarvesterMessage(line: string): HarvesterMessage | null {
  try {
    const r = HarvesterMessage.safeParse(JSON.parse(line));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function responseLine(n: number, result: { ok: unknown } | { error: string }): string {
  return JSON.stringify({ t: "reponse", n, ...result }) + "\n";
}

export type StartOptions = {
  previous: unknown;
  now: string;
  config: unknown;
  workflow: SentWorkflow;
  replay?: ReplaySent;
  /** No more items run after this delay (`dureeMaxMinutes × 60 000`). */
  limitMs?: number;
  /** Memory sent along the way, as-it-goes publications. */
  progressive?: true;
  /** Action only: the text typed at launch (`{saisie}` of the templates, `ctx.saisie`). */
  input?: string;
  /** Action only: the per-item blocks send their progress. */
  progress?: true;
};

/**
 * The `debut` line; the keys `rejeu`, `limiteMs`, `progressif`, `saisie` and `avancement` are only there if they are
 * given (the line of a widget without the new fields does not change).
 */
export function lineStart(o: StartOptions): string {
  return (
    JSON.stringify({
      t: "debut",
      previous: o.previous ?? null,
      now: o.now,
      config: o.config ?? null,
      workflow: o.workflow,
      ...(o.replay ? { replay: { reruns: o.replay.reruns, outputs: o.replay.outputs } } : {}),
      ...(o.limitMs !== undefined ? { limitMs: o.limitMs } : {}),
      ...(o.progressive ? { progressive: true } : {}),
      ...(o.input !== undefined ? { input: o.input } : {}),
      ...(o.progress ? { progress: true } : {}),
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
  return JSON.stringify({ t: "memoire", memory: m }) + "\n";
}
