import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { queued, writeAtomic } from "../workflows/executions.js";

/**
 * What the user approved a widget or action without an account to read: its `public` domains and the web, as declared at the
 * time of the approval. Stored in `<widgetsFolder>/reads.json` (`<actionsFolder>/reads.json` for the actions), outside the
 * workspace: the agent cannot write it.
 */
export const Reads = z.object({ public: z.array(z.string()), web: z.boolean() });
export type Reads = z.infer<typeof Reads>;

const ID = /^[a-z0-9-]+$/;
const file = (folder: string) => join(folder, "reads.json");

/** The file's valid entries; an absent or damaged file counts as nothing approved. */
export async function readReads(folder: string): Promise<Record<string, Reads>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file(folder), "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const reads: Record<string, Reads> = {};
  for (const [id, value] of Object.entries(raw)) {
    const r = Reads.safeParse(value);
    if (ID.test(id) && r.success) reads[id] = r.data;
  }
  return reads;
}

/** One write at a time per file: two approvals at once do not erase each other. */
function modify(folder: string, change: (r: Record<string, Reads>) => void): Promise<void> {
  return queued(file(folder), async () => {
    const reads = await readReads(folder);
    change(reads);
    await writeAtomic(file(folder), JSON.stringify(reads, null, 2));
  });
}

export async function approveReads(folder: string, id: string, reads: Reads): Promise<void> {
  if (!ID.test(id)) throw new Error(`invalid id: ${id}`);
  const r = Reads.parse(reads);
  return modify(folder, (all) => {
    all[id] = { public: [...r.public].sort(), web: r.web };
  });
}

export async function removeReads(folder: string, id: string): Promise<void> {
  if (!ID.test(id)) return;
  return modify(folder, (all) => {
    delete all[id];
  });
}

/** Approved reads cover the declaration: its public domains are a subset, and the web only if approved. Nothing to read: covered. */
export function readsCovered(declaration: { sources: { public: string[]; web?: boolean } }, approved?: Reads): boolean {
  const { public: publics, web } = declaration.sources;
  if (publics.length === 0 && !web) return true;
  if (!approved) return false;
  return publics.every((d) => approved.public.includes(d)) && (!web || approved.web);
}

/** May this owner read any host? Never with an account; without one, when it declares `web` or its approval has `web`. */
export async function readsUnrestricted(folder: string, id: string, declaration: { sources: { account: string[]; web?: boolean } }): Promise<boolean> {
  if (declaration.sources.account.length) return false;
  return declaration.sources.web === true || (await readReads(folder))[id]?.web === true;
}

/**
 * The migration, once per folder: every owner without account that was on disk before this start gets its declared public
 * domains and `web`, so it keeps reading any host as before the gate. A `fresh` one (a starter just copied) gets exactly what
 * it declares. Entries already there are kept. A marker records it, so a `reads.json` the user removed later is
 * not seeded again.
 */
export async function seedReads(folder: string, owners: { id: string; sources: { account: string[]; public: string[]; web?: boolean }; fresh?: boolean }[]): Promise<void> {
  const marker = join(folder, "reads.seeded");
  if (await stat(marker).then(() => true, () => false)) return;
  await modify(folder, (all) => {
    for (const o of owners) if (ID.test(o.id) && o.sources.account.length === 0) all[o.id] ??= { public: [...o.sources.public].sort(), web: !o.fresh || o.sources.web === true };
  });
  await writeAtomic(marker, "");
}
