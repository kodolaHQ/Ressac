import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { writePrivateJson } from "../design/atomic-write.js";
import type { DiffFile } from "./repo.js";
import { newPosition, type Block } from "./diff.js";

/** Re-exported by design/remarks.ts (task 5), which does not redefine it. */
export const EMPTY_REMARK = "Une remarque vide n'est pas acceptée.";

export interface Comment {
  id: string; file: string; start: number; end: number;
  lines: { mark: " " | "+" | "-"; text: string }[];
  text: string; created: string; sent: boolean; resolved: boolean; lineChanged: boolean;
}

const Schema = z.array(z.object({
  id: z.string(), file: z.string(), start: z.number(), end: z.number(),
  lines: z.array(z.object({ mark: z.enum([" ", "+", "-"]), text: z.string() })),
  text: z.string(), created: z.string(), sent: z.boolean(), resolved: z.boolean(), lineChanged: z.boolean(),
}));

interface Shown { mark: " " | "+" | "-"; text: string; position: number; block: number; hint: number }

function shownList(blocks: Block[]): Shown[] {
  return blocks.flatMap((b, block) => b.lines.map((l, hint) => ({ mark: l.mark, text: l.text, position: newPosition(b, hint), block: block, hint: hint })));
}

function nearest<T>(items: T[], pos: (t: T) => number, target: number): T {
  return items.reduce((m, t) => (Math.abs(pos(t) - target) < Math.abs(pos(m) - target) ? t : m));
}

/** Pure re-anchoring: a comment is never deleted, only moved or marked « ligne changée ». */
export function rejoin(c: Comment, blocks: Block[]): Comment {
  const lines = shownList(blocks);
  const n = c.lines.length;
  const windows: Shown[][] = [];
  if (n > 0) {
    for (let i = 0; i + n <= lines.length; i++) {
      const f = lines.slice(i, i + n);
      // The text alone: a « + » line becomes context again after « Marquer comme relu ».
      if (f.every((l, k) => l.block === f[0]!.block && l.text === c.lines[k]!.text)) windows.push(f);
    }
  }
  if (windows.length > 0) {
    const f = nearest(windows, (w) => w[0]!.position, c.start);
    return { ...c, start: f[0]!.position, end: f[n - 1]!.position, lineChanged: false };
  }
  const sameText = n > 0 ? lines.filter((l) => l.text === c.lines[0]!.text) : [];
  if (sameText.length > 0) {
    const l = nearest(sameText, (x) => x.position, c.start);
    return { ...c, start: l.position, end: l.position, lineChanged: true };
  }
  if (lines.length > 0) {
    const l = nearest(lines, (x) => x.position, c.start);
    return { ...c, start: l.position, end: l.position, lineChanged: true };
  }
  return { ...c, lineChanged: true };
}

export class ReviewComments {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<Comment[]> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); } catch { return []; }
    try { return Schema.parse(JSON.parse(raw)); } catch { return []; }
  }

  // Serialized read-modify-write: two simultaneous calls do not overwrite each other.
  private transform<T>(f: (list: Comment[]) => { list: Comment[]; result: T }): Promise<T> {
    const task = this.writes.then(async () => {
      const { list: list, result: result } = f(await this.read());
      await writePrivateJson(this.file, list);
      return result;
    });
    this.writes = task.catch(() => undefined);
    return task;
  }

  async list(): Promise<Comment[]> {
    await this.writes;
    return this.read();
  }

  add(c: Pick<Comment, "file" | "start" | "end" | "lines" | "text">): Promise<Comment> {
    if (c.text.trim() === "") return Promise.reject(new Error(EMPTY_REMARK));
    return this.transform((list) => {
      const fresh: Comment = {
        id: `c-${randomBytes(4).toString("hex")}`, file: c.file, start: c.start, end: c.end,
        lines: c.lines.map((l) => ({ mark: l.mark, text: l.text })), text: c.text,
        created: new Date().toISOString(), sent: false, resolved: false, lineChanged: false,
      };
      return { list: [...list, fresh], result: fresh };
    });
  }

  edit(id: string, text: string): Promise<void> {
    if (text.trim() === "") return Promise.reject(new Error(EMPTY_REMARK));
    return this.transform((list) => ({ list: list.map((c) => (c.id === id ? { ...c, text: text, sent: false } : c)), result: undefined }));
  }

  resolve(id: string, resolved: boolean): Promise<void> {
    return this.transform((list) => ({ list: list.map((c) => (c.id === id ? { ...c, resolved: resolved } : c)), result: undefined }));
  }

  delete(id: string): Promise<void> {
    return this.transform((list) => ({ list: list.filter((c) => c.id !== id), result: undefined }));
  }

  pasteFile(path: string, diff: DiffFile | null): Promise<Comment[]> {
    return this.transform((list) => {
      const next = list.map((c) => (c.file !== path ? c : diff ? rejoin(c, diff.blocks) : { ...c, lineChanged: true }));
      return { list: next, result: next.filter((c) => c.file === path) };
    });
  }

  async toSend(): Promise<Comment[]> {
    return (await this.list()).filter((c) => !c.resolved);
  }

  markSent(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    return this.transform((list) => ({ list: list.map((c) => (idSet.has(c.id) ? { ...c, sent: true } : c)), result: undefined }));
  }

  /** Marks as sent those whose text is still the one that left (a change in the meantime stays to be sent). */
  markSentIfUnchanged(sent: { id: string; text: string }[]): Promise<void> {
    const texts = new Map(sent.map((e) => [e.id, e.text]));
    return this.transform((list) => ({
      list: list.map((c) => (texts.get(c.id) === c.text ? { ...c, sent: true } : c)),
      result: undefined,
    }));
  }

  afterReviewed(): Promise<void> {
    return this.transform((list) => ({ list: list.filter((c) => !c.resolved), result: undefined }));
  }
}
