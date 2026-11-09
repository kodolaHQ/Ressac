import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

export const MEMORY_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Memory of a widget's blocks: by block id, its type, what it kept from one run to the next and
 * the hash of the params with which it kept it (absent from an old memory).
 */
export type BlocksMemory = Record<string, { type: string; valeur: unknown; empreinte?: string }>;

const MemoryFile = z.object({
  version: z.literal(1),
  blocs: z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown(), empreinte: z.string().optional() })),
});

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** JSON text of a value, keys sorted recursively: two equal values give the same text. */
export const canonicalJson = (v: unknown): string => JSON.stringify(canonical(v));

/**
 * Hash (16 characters) of a block's params: a block's memory is only valid for its settings. `garderJours`
 * is not part of it: changing the lifetime of the kept results does not erase them.
 */
export function paramsHash(p: Record<string, unknown>): string {
  const { garderJours: _keepDays, ...settings } = p;
  return createHash("sha256").update(canonicalJson(settings)).digest("hex").slice(0, 16);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Runs `f` alone on this widget's memory: the write of a run's memory and the erasure of a
 * builder record go one after the other (no read-modify-write loses another).
 */
export function withMemory<T>(dataFolder: string, f: () => Promise<T>): Promise<T> {
  const key = resolve(dataFolder);
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(f);
  const fin = next.catch(() => {});
  locks.set(key, fin);
  void fin.then(() => {
    if (locks.get(key) === fin) locks.delete(key);
  });
  return next;
}

/** The blocks' memory, or empty if absent, damaged or too big. */
export async function readMemory(dataFolder: string): Promise<BlocksMemory> {
  const path = join(dataFolder, "memoire.json");
  try {
    if ((await stat(path)).size > MEMORY_MAX_BYTES) return {};
    return MemoryFile.parse(JSON.parse(await readFile(path, "utf8"))).blocs as BlocksMemory;
  } catch {
    return {};
  }
}

/** Writes the memory; false, without writing anything, if it exceeds 3 MB. */
export async function writeMemory(dataFolder: string, m: BlocksMemory): Promise<boolean> {
  const text = JSON.stringify({ version: 1, blocs: m });
  if (Buffer.byteLength(text) > MEMORY_MAX_BYTES) return false;
  const target = join(dataFolder, "memoire.json");
  await mkdir(dataFolder, { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  return true;
}

/** Erases the runs and the memory (grant withdrawal, widget removed). */
export async function clearRunsAndMemory(dataFolder: string): Promise<void> {
  await rm(join(dataFolder, "executions"), { recursive: true, force: true });
  await rm(join(dataFolder, "memoire.json"), { force: true });
}
