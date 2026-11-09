import { z } from "zod";
import type { BlocksMemory } from "./memory.js";
import type { Block, Link } from "./schema.js";

/** Maximum size of a widget's data (its `data.json`, an as-it-goes publication). */
export const DATA_MAX_SIZE = 2 * 1024 * 1024;

/** Maximum size of a line of the harvester <-> kernel protocol. */
export const LINE_MAX_BYTES = 4 * 1024 * 1024;

export const HarvesterFunction = z.enum(["readPage", "fetch", "kev", "gemma", "searchWeb"]);
export type HarvesterFunction = z.infer<typeof HarvesterFunction>;

const SentMemory = z.record(z.string(), z.object({ type: z.string(), value: z.unknown() }));

/** Status of a block at its end, as the container sends it. */
export const ContainerBlockStatus = z.enum(["succeeded", "partial", "failed"]);

/**
 * Harvester's standard output: one JSON line per message. For a workflow, traces (`block`, `log`) and the
 * blocks' memory (`memory`, just before `end`; also along the way for a progressive run, the last one
 * received counts); during the as-it-goes chain, `publication`s; the end stays `end` / `failure`.
 */
export const HarvesterMessage = z.union([
  z.object({ t: z.literal("call"), n: z.number().int(), f: HarvesterFunction, a: z.unknown() }),
  z.object({ t: z.literal("block"), id: z.string(), step: z.literal("start") }),
  z.object({
    t: z.literal("block"),
    id: z.string(),
    step: z.literal("end"),
    status: ContainerBlockStatus,
    output: z.unknown().optional(),
    outputTooBig: z.literal(true).optional(),
    error: z.string().optional(),
  }),
  // Action only (`progress` in `start`): a per-item block has reached `done` items out of `total`.
  z
    .object({ t: z.literal("block"), id: z.string(), step: z.literal("progress"), done: z.number().int().min(0), total: z.number().int().min(0) })
    .refine((m) => m.done <= m.total),
  z.object({ t: z.literal("log"), block: z.string(), text: z.string() }),
  z.object({ t: z.literal("memory"), memory: SentMemory }),
  z.object({ t: z.literal("publication"), data: z.unknown(), done: z.number().int().min(0), total: z.number().int().min(0) }),
  z.object({ t: z.literal("end"), data: z.unknown() }),
  z.object({ t: z.literal("failure"), error: z.string() }),
]);
export type HarvesterMessage = z.infer<typeof HarvesterMessage>;

/** What the container receives of a validated workflow: its blocks, its links and the run order. */
export type SentWorkflow = { blocks: Block[]; links: Link[]; order: string[] };

/** For a try: the blocks to rerun (in order) and the outputs taken from the original run, per block. */
export type ReplaySent = { reruns: string[]; outputs: Record<string, unknown> };

/**
 * Harvester's standard input: the initial line (always with its workflow, implicit for a lone `harvest.mjs`),
 * then the blocks' memory, then the answers.
 */
export const KernelMessage = z.union([
  z.object({
    t: z.literal("start"),
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
  z.object({ t: z.literal("memory"), memory: SentMemory }),
  z.object({ t: z.literal("answer"), n: z.number().int(), ok: z.unknown() }),
  z.object({ t: z.literal("answer"), n: z.number().int(), error: z.string() }),
]);
export type KernelMessage = z.infer<typeof KernelMessage>;

/** Arguments of the calls, depending on the function. */
/** At most 20 screens scrolled by a page read (`scroll`). */
export const SCROLL_MAX = 20;
export const ReadPageArgs = z.object({ url: z.string(), account: z.boolean().optional(), scroll: z.number().int().min(0).max(SCROLL_MAX).optional() });
export const FetchArgs = z.object({ url: z.string(), format: z.enum(["text", "json"]).optional() });
export const ArgsKev = z.object({ state: z.string(), questions: z.record(z.string(), z.unknown()) });
/** Web search done by the kernel; answer: `{ title, url, excerpt }[]`, at most `count`. */
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
  return JSON.stringify({ t: "answer", n, ...result }) + "\n";
}

export type StartOptions = {
  previous: unknown;
  now: string;
  config: unknown;
  workflow: SentWorkflow;
  replay?: ReplaySent;
  /** No more items run after this delay (`maxDurationMinutes × 60 000`). */
  limitMs?: number;
  /** Memory sent along the way, as-it-goes publications. */
  progressive?: true;
  /** Action only: the text typed at launch (`{input}` of the templates, `ctx.userInput`). */
  input?: string;
  /** Action only: the per-item blocks send their progress. */
  progress?: true;
};

/**
 * The `start` line; the keys `replay`, `limitMs`, `progressive`, `input` and `progress` are only there if they are
 * given (the line of a widget without the new fields does not change).
 */
export function lineStart(o: StartOptions): string {
  return (
    JSON.stringify({
      t: "start",
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
  return JSON.stringify({ t: "memory", memory: m }) + "\n";
}
