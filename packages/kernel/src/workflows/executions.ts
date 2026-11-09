import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Owner } from "./schema.js";

export const OUTPUT_MAX_BYTES = 256 * 1024;
export const RUN_MAX_BYTES = 4 * 1024 * 1024;
/** The reason for an action run stopped by the user. */
export const ACTION_STOPPED = "Arrêtée à ta demande";
export const KEPT_RUNS = 20;
/** Tries (builder replays) have their own quota: they never push out a real run. */
export const KEPT_ATTEMPTS = 10;
export const ID_EXECUTION = /^[0-9TZ-]+(?:-essai)?$/;
const ATTEMPT_SUFFIX = "-essai";

export const BlockTrace = z.object({
  id: z.string(),
  type: z.string(),
  // « interrompu »: started, not finished, when WebAiOs stopped during the run.
  // « repris »: output taken from the original run of a try, without being copied (`items` is).
  status: z.enum(["succeeded", "partial", "failed", "interrupted", "not-run", "resumed"]),
  start: z.string().nullable(),
  end: z.string().nullable(),
  items: z.number().nullable(),
  output: z.unknown().optional(),
  outputTruncated: z.literal(true).optional(),
  error: z.string().optional(),
  log: z.array(z.string()),
});
export type BlockTrace = z.infer<typeof BlockTrace>;

export const Execution = z.object({
  version: z.literal(1),
  id: z.string(),
  owner: z.object({ type: z.enum(["widget", "action"]), id: z.string() }),
  // The input of an action launched with a text (clio lyon).
  input: z.string().max(200).optional(),
  trigger: z.enum(["planifiee", "manuelle", "agent", "rejeu"]),
  // Only for a try: the start block and the run whose upstream outputs are taken.
  attempt: z.object({ start: z.string(), origin: z.string() }).optional(),
  start: z.string(),
  end: z.string().nullable(),
  status: z.enum(["reussie", "partielle", "echouee", "interrompue", "accord-requis"]),
  error: z.string().optional(),
  kernelError: z.literal(true).optional(),
  blocks: z.array(BlockTrace),
});
export type Execution = Omit<z.infer<typeof Execution>, "owner"> & { owner: Owner };

export type ResumeExecution = Pick<Execution, "id" | "trigger" | "start" | "end" | "status" | "attempt" | "input"> & {
  blocks: { id: string; status: BlockTrace["status"]; items: number | null }[];
};

/** A run's identifier: its ISO start, without « : » or « . » (safe as a file name). */
export function idExecution(startIso: string): string {
  return startIso.replace(/[:.]/g, "-");
}

/** A try's identifier: that of the run that has the same start, followed by « -essai ». */
export function attemptId(startIso: string): string {
  return idExecution(startIso) + ATTEMPT_SUFFIX;
}

const runsFolder = (dataFolder: string) => join(dataFolder, "executions");

// A temporary name specific to each write, as for donnees.json.
export async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(join(target, ".."), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

const LINE_MAX_BYTES = 2 * 1024;
const MAX_ERROR_BYTES = 2 * 1024;
const LIGNES_MAX = 200;

/** The start of a text, `octets` bytes at most. */
export function cut(text: string, bytes: number): string {
  let s = text.slice(0, bytes);
  while (Buffer.byteLength(s) > bytes) s = s.slice(0, Math.floor(s.length * 0.9));
  return s;
}

// Safety net: an output that is too big is kept as text (the start of its JSON) and marked; if the file
// still exceeds 4 MB, the biggest outputs go first.
function truncate(entry: Execution): Execution {
  const e: Execution = entry.error === undefined ? entry : { ...entry, error: cut(entry.error, MAX_ERROR_BYTES) };
  const sizes: number[] = [];
  const blocks = e.blocks.map((b0, i) => {
    const b = clampText(b0);
    sizes[i] = 0;
    if (b.output === undefined) return b;
    const text = JSON.stringify(b.output) ?? "null";
    const bytes = Buffer.byteLength(text);
    if (bytes <= OUTPUT_MAX_BYTES) {
      sizes[i] = bytes;
      return b;
    }
    const wasCut = cut(text, OUTPUT_MAX_BYTES);
    sizes[i] = Buffer.byteLength(JSON.stringify(wasCut));
    return { ...b, output: wasCut, outputTruncated: true as const };
  });
  let current: Execution = { ...e, blocks: blocks };
  while (Buffer.byteLength(JSON.stringify(current, null, 2)) > RUN_MAX_BYTES) {
    let worst = -1;
    for (let i = 0; i < blocks.length; i++) if (sizes[i]! > 0 && (worst < 0 || sizes[i]! > sizes[worst]!)) worst = i;
    if (worst < 0) break;
    const { output: _removed, ...rest } = blocks[worst]!;
    blocks[worst] = { ...rest, outputTruncated: true };
    sizes[worst] = 0;
    current = { ...e, blocks: blocks };
  }
  // Still too big: the longest logs are replaced by a remark line.
  while (Buffer.byteLength(JSON.stringify(current, null, 2)) > RUN_MAX_BYTES) {
    let worst = -1;
    let max = 0;
    for (let i = 0; i < blocks.length; i++) {
      const t = Buffer.byteLength(JSON.stringify(blocks[i]!.log));
      if (t > max) {
        max = t;
        worst = i;
      }
    }
    if (worst < 0 || blocks[worst]!.log.length <= 1) break;
    blocks[worst] = { ...blocks[worst]!, log: [`… ${blocks[worst]!.log.length} lignes coupées`] };
    current = { ...e, blocks: blocks };
  }
  return current;
}

// Error and log of a block: lines of 2 KB at most, 200 lines at most (the last ones are kept).
function clampText(b: BlockTrace): BlockTrace {
  let log = b.log.map((l) => (Buffer.byteLength(l) > LINE_MAX_BYTES ? cut(l, LINE_MAX_BYTES) : l));
  if (log.length > LIGNES_MAX) {
    log = [`… ${log.length - LIGNES_MAX} lignes coupées`, ...log.slice(-LIGNES_MAX)];
  }
  return { ...b, log: log, ...(b.error === undefined ? {} : { error: cut(b.error, MAX_ERROR_BYTES) }) };
}

/** Writes a run (truncated if needed) and only keeps the 20 most recent real ones, and the 10 most recent tries. */
export async function writeRun(dataFolder: string, e: Execution): Promise<void> {
  if (!ID_EXECUTION.test(e.id)) throw new Error(`id d'exécution invalide : ${e.id}`);
  const folder = runsFolder(dataFolder);
  await writeAtomic(join(folder, `${e.id}.json`), JSON.stringify(truncate(e), null, 2));
  const names = await runNames(folder);
  for (const [group, kept] of [
    [names.filter((n) => !n.endsWith(`${ATTEMPT_SUFFIX}.json`)), KEPT_RUNS],
    [names.filter((n) => n.endsWith(`${ATTEMPT_SUFFIX}.json`)), KEPT_ATTEMPTS],
  ] as const) {
    const sorted = [...group].sort();
    for (const name of sorted.slice(0, Math.max(0, sorted.length - kept))) await rm(join(folder, name), { force: true });
  }
}

async function runNames(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((n) => n.endsWith(".json") && ID_EXECUTION.test(n.slice(0, -5)));
  } catch {
    return [];
  }
}

export async function readRun(dataFolder: string, id: string): Promise<Execution | null> {
  if (!ID_EXECUTION.test(id)) return null;
  try {
    const path = join(runsFolder(dataFolder), `${id}.json`);
    if ((await stat(path)).size > RUN_MAX_BYTES) return null;
    const loaded = Execution.parse(JSON.parse(await readFile(path, "utf8")));
    return loaded as Execution;
  } catch {
    return null;
  }
}

function summarize(e: Execution): ResumeExecution {
  return {
    id: e.id,
    trigger: e.trigger,
    ...(e.attempt ? { attempt: e.attempt } : {}),
    ...(e.input !== undefined ? { input: e.input } : {}),
    start: e.start,
    end: e.end,
    status: e.status,
    blocks: e.blocks.map((b) => ({ id: b.id, status: b.status, items: b.items })),
  };
}

/**
 * Summaries already read, by path, with the file's inode, date and size: the list is re-read at each change
 * of a widget (up to 20 files of 4 MB each), only a new or rewritten file is re-read. null: damaged file.
 */
const readSummaries = new Map<string, { ino: number; mtimeMs: number; size: number; resume: ResumeExecution | null }>();
const READ_SUMMARIES_MAX = 1000;

/** Summaries of the kept runs, most recent first; a damaged file is ignored. */
export async function listRuns(dataFolder: string): Promise<ResumeExecution[]> {
  const folder = runsFolder(dataFolder);
  const names = (await runNames(folder)).sort().reverse();
  const resumes: ResumeExecution[] = [];
  for (const name of names) {
    const path = join(folder, name);
    let s;
    try {
      s = await stat(path);
    } catch {
      continue;
    }
    const known = readSummaries.get(path);
    let resume: ResumeExecution | null;
    if (known && known.ino === s.ino && known.mtimeMs === s.mtimeMs && known.size === s.size) resume = known.resume;
    else {
      const e = await readRun(dataFolder, name.slice(0, -5));
      resume = e ? summarize(e) : null;
      readSummaries.delete(path);
      readSummaries.set(path, { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size, resume });
      // The oldest entries go first.
      while (readSummaries.size > READ_SUMMARIES_MAX) readSummaries.delete(readSummaries.keys().next().value!);
    }
    if (resume) resumes.push(resume);
  }
  return resumes;
}
