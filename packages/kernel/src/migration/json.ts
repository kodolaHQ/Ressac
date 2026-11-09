import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { canonicalJson } from "../workflows/memory.js";
import { renameJson, type Rule } from "./rename.js";

export { renameJson, type Rule } from "./rename.js";

/** The format is fully renamed: renaming it again changes nothing. */
export const fixedPoint = (v: unknown, r: Rule): boolean => canonicalJson(renameJson(v, r)) === canonicalJson(v);

/** A check run on a migrated file by the verification pass: an error text, or null. */
export type Check = (v: unknown) => string | null | Promise<string | null>;

/** A file left as is (unreadable, a link, not JSON): listed in the report, never overwritten. */
export class Unreadable extends Error {}

export interface Ctx {
  dataDir: string;
  workspace: string;
  now: Date;
  changed: number;
  unreadable: string[];
  conflicts: string[];
  /** Agent extensions whose signed version holds the old guards: marked to sign again. */
  resign: string[];
  dockerErrors: string[];
  written: { path: string; check: Check }[];
  checkpoint(label: string): Promise<void>;
}

export const rel = (ctx: Ctx, p: string) => relative(ctx.dataDir, p);

/** The folder holding `p` is really under the data folder (no linked folder on the way). */
export async function inside(ctx: Ctx, p: string): Promise<boolean> {
  const real = await realpath(dirname(p)).catch(() => null);
  const root = await realpath(ctx.dataDir);
  return real !== null && (real === root || real.startsWith(root + sep));
}

export async function kind(p: string): Promise<"file" | "dir" | "other" | null> {
  try {
    const s = await lstat(p);
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Real sub-folders (never a link), hidden ones (`.trash`) excluded. */
export async function folders(p: string): Promise<string[]> {
  if ((await kind(p)) !== "dir") return [];
  return (await readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
}

export async function filesIn(p: string): Promise<string[]> {
  if ((await kind(p)) !== "dir") return [];
  return (await readdir(p, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
}

/** Reads without following a link (a link could point outside the data folder). */
export async function readNoFollow(p: string): Promise<Buffer> {
  const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Temporary file then rename, same mode as the original (a private file stays private). */
async function writeAtomic(target: string, data: string | Buffer, mode: number): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.migration.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, target);
}

/** Folder or file renamed; absent: done already. The target already there: both left and reported. */
export async function move(ctx: Ctx, from: string, to: string): Promise<void> {
  if ((await kind(from)) === null) return;
  if (!(await inside(ctx, from))) return void ctx.unreadable.push(rel(ctx, from));
  if ((await kind(to)) !== null) return void ctx.conflicts.push(rel(ctx, from));
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  ctx.changed++;
  await ctx.checkpoint(to);
}

/**
 * Rewrites `from` into `to` (same path or a new name) with `f`, atomically, then removes `from`. Absent: nothing
 * (done already). A link, an unreadable or unparsable file, or one `f` fails on: left and listed.
 */
export async function rewrite(ctx: Ctx, from: string, to: string, f: (text: Buffer) => Buffer | string | Promise<Buffer | string>): Promise<boolean> {
  const k = await kind(from);
  if (k === null) return false;
  if (k !== "file" || !(await inside(ctx, from)) || !(await inside(ctx, to))) return void ctx.unreadable.push(rel(ctx, from)), false;
  let text: Buffer;
  let mode: number;
  let out: Buffer | string;
  try {
    mode = (await lstat(from)).mode & 0o777;
    text = await readNoFollow(from);
    out = await f(text);
  } catch {
    // Unreadable, not JSON, or JSON of a shape no step expects (null, a string…): never overwritten.
    return void ctx.unreadable.push(rel(ctx, from)), false;
  }
  if (from !== to || !text.equals(Buffer.from(out))) {
    await writeAtomic(to, out, mode);
    ctx.changed++;
    await ctx.checkpoint(to);
  }
  if (from !== to) {
    await rm(from, { force: true });
    await ctx.checkpoint(from);
  }
  return true;
}

export function parse(text: Buffer | string): unknown {
  try {
    return JSON.parse(text.toString());
  } catch {
    throw new Unreadable();
  }
}

/** Same layout as the original: indented if it was on several lines. Unchanged value: the original bytes. */
export function stringify(v: unknown, original: Buffer | string): string {
  const t = original.toString();
  if (JSON.stringify(v) === JSON.stringify(parse(t))) return t;
  return t.includes("\n") ? JSON.stringify(v, null, 2) + (t.endsWith("\n") ? "\n" : "") : JSON.stringify(v);
}

/** A JSON file renamed with `rule` (and `then` for what the rule cannot say), checked again by the verification. */
export async function rewriteJson(
  ctx: Ctx,
  from: string,
  to: string,
  rule: Rule,
  check: Check | null,
  then: (v: unknown) => unknown = (v) => v,
): Promise<void> {
  await rewrite(ctx, from, to, (t) => stringify(then(renameJson(parse(t), rule)), t));
  ctx.written.push({ path: to, check: (v) => (fixedPoint(v, rule) ? null : "anciens noms restants") ?? check?.(v) ?? null });
}

/** Zod-like `safeParse` as a verification check. */
export const schemaCheck =
  (s: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }): Check =>
  (v) => {
    const r = s.safeParse(v);
    return r.success ? null : (r.error?.issues[0]?.message ?? "invalide");
  };
