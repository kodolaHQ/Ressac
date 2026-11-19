import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { say } from "../i18n.js";
import { queued, writeAtomic } from "../workflows/executions.js";

/**
 * What the user approved a widget or action without an account to read: its `public` domains and the web, as declared at the
 * time of the approval. Stored in `<widgetsFolder>/reads.json` (`<actionsFolder>/reads.json` for the actions), outside the
 * workspace: the agent cannot write it. `code` (widgets): the `codeHash` of the files the approval was given for; the agent
 * can rewrite them, so a harvest whose staged copy hashes otherwise does not run.
 */
export const Reads = z.object({ public: z.array(z.string()), web: z.boolean(), code: z.string().optional() });
export type Reads = z.infer<typeof Reads>;

const ID = /^[a-z0-9-]+$/;
const file = (folder: string) => join(folder, "reads.json");

/** The file's valid entries; an absent or damaged file counts as nothing approved. */
export async function readReads(folder: string, strict = false): Promise<Record<string, Reads>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file(folder), "utf8"));
  } catch (e) {
    // `strict` (before a write): only absent or damaged counts as empty; EMFILE, EACCES… fail the write, never erase the others.
    if (strict && !(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
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
    const reads = await readReads(folder, true);
    change(reads);
    await writeAtomic(file(folder), JSON.stringify(reads, null, 2));
  });
}

export async function approveReads(folder: string, id: string, reads: Reads): Promise<void> {
  if (!ID.test(id)) throw new Error(`invalid id: ${id}`);
  const r = Reads.parse(reads);
  return modify(folder, (all) => {
    all[id] = { public: [...r.public].sort(), web: r.web, ...(r.code !== undefined ? { code: r.code } : {}) };
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

/**
 * The hash of an owner's code as a harvest stages it: every top-level regular file but `data.json` (names and contents).
 * Run on the staged copy, it hashes exactly what will run.
 */
export async function codeHash(folder: string): Promise<string> {
  const h = createHash("sha256");
  const names = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile() && e.name !== "data.json").map((e) => e.name).sort();
  for (const n of names) {
    const content = await readFile(join(folder, n));
    h.update(`${n}\0${content.length}\0`).update(content);
  }
  return h.digest("hex");
}

/** May this owner read any host? Never with an account; without one, when it declares `web` or its approval has `web`. */
export async function readsUnrestricted(folder: string, id: string, declaration: { sources: { account: string[]; web?: boolean } }): Promise<boolean> {
  if (declaration.sources.account.length) return false;
  return declaration.sources.web === true || (await readReads(folder))[id]?.web === true;
}

type Sources = { sources: { account: readonly string[]; public: readonly string[]; web?: boolean } };

/** An owner without account that reads something: its approval is tied to its code. */
export const readsCode = (d: Sources) => d.sources.account.length === 0 && (d.sources.public.length > 0 || d.sources.web === true);

/** Approved reads cover the declaration, and carry a code hash when they must (one from before the hash is asked again). */
export const readsApproved = (d: Sources & { sources: { public: string[] } }, approved?: Reads) => readsCovered(d, approved) && (!readsCode(d) || approved?.code !== undefined);

/** The staged code must be the one the reads were approved for (runWorkflow's `checkStaged`). */
export function codeCheck(folder: string, id: string, d: Sources, locale: string): { checkStaged?: (staged: string) => Promise<string | null> } {
  if (!readsCode(d)) return {};
  return { checkStaged: async (staged) => ((await readReads(folder))[id]?.code === (await codeHash(staged)) ? null : say(locale, "kernel-err-code-changed")) };
}
