import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { shippedHashes } from "./initialize.js";

export type InstructionKind = "claude" | "codex";
/** Container path to content; an absent file has no key, a link, too-long, binary, unreadable file or too-many tree is a marker starting with "\u0000". */
export type Snapshot = Record<string, string>;
export type DiffLine = { kind: " " | "+" | "-"; text: string };
/** `marker`: what stands in for unshown content ("too-long", "binary", "other", "unreadable", "too-many" or "link:" + target). */
export type InstructionChange = { path: string; status: "changed" | "created" | "deleted"; lines: DiffLine[] | null; marker?: string };
export interface InstructionIo {
  read(files: string[], trees: string[]): Promise<Snapshot>;
  /** null deletes. */
  write(entries: Record<string, string | null>): Promise<void>;
}

const TEXTS = ["AGENTS.md", "guides/widgets.md", "guides/extensions.md", "guides/actions.md", "guides/site-apps.md"];
const CLAUDE_FILES = TEXTS.map((t) => `/workspace/${t}`);
export const WATCHED: Record<InstructionKind, { files: string[]; trees: string[] }> = {
  claude: { files: CLAUDE_FILES, trees: [] },
  // Codex 0.169 skill roots ($CODEX_HOME/skills, ~/.agents/skills, project .codex/skills and .agents/skills); the whole project .codex also holds a config.toml.
  codex: {
    files: [...CLAUDE_FILES, "/workspace/AGENTS.override.md", "/home/node/.codex/AGENTS.md", "/home/node/.codex/AGENTS.override.md"],
    trees: ["/workspace/.agents/skills", "/workspace/.codex", "/home/node/.codex/skills", "/home/node/.agents/skills"],
  },
};

export const ACCEPTED_AGENTS_IN_CONTAINER = "/workspace/.ressac/instructions/AGENTS.md";
export const DIFF_LINES_MAX = 2000;
/** Codex installs its own system skills here, and reinstalls them on an update or when they go missing. */
const CODEX_SYSTEM_SKILLS = "/home/node/.codex/skills/.system/";

const isMarker = (s: string | undefined) => s?.startsWith("\u0000") ?? false;

export function lineDiff(before: string, after: string): DiffLine[] | null {
  // An empty side is no lines, so a created or deleted file has no spurious blank line.
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > DIFF_LINES_MAX || b.length > DIFF_LINES_MAX) return null;
  // lcs[i][j]: longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ kind: " ", text: a[i++]! }), j++;
    else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: "-", text: a[i++]! });
    else out.push({ kind: "+", text: b[j++]! });
  }
  return out;
}

export class InstructionReview {
  constructor(
    private readonly paths: SpacePaths,
    private readonly io: InstructionIo,
    private readonly models: string,
    private readonly locale: () => string,
  ) {}

  private get dir() {
    return join(this.paths.internal, "instructions");
  }

  private inKind(kind: InstructionKind, path: string) {
    const w = WATCHED[kind];
    // A link is recorded where it sits: at a tree root or on a folder above a watched path.
    return [...w.files, ...w.trees].some((x) => x === path || x.startsWith(`${path}/`)) || w.trees.some((t) => path.startsWith(`${t}/`));
  }

  /** The stored reference; with no file yet (first run), the shipped templates of the space language. */
  private async load(): Promise<Snapshot> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, "reference.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(this.locale()) && existsSync(join(this.models, this.locale())) ? this.locale() : "en";
      const ref: Snapshot = {};
      for (const t of TEXTS) ref[`/workspace/${t}`] = await readFile(join(this.models, existsSync(join(this.models, lang, t)) ? lang : "en", t), "utf8");
      return ref;
    }
    const files = (JSON.parse(raw) as { files?: unknown }).files;
    if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("instructions reference: no files object");
    return files as Snapshot;
  }

  private chain: Promise<unknown> = Promise.resolve();
  /** Reference updates are read-modify-write: two windows' sessions must not overwrite each other. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async save(files: Snapshot, name = "reference") {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${name}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify({ files }));
    await rename(tmp, join(this.dir, `${name}.json`));
  }

  pending(kind: InstructionKind): Promise<{ snapshot: Snapshot; changes: InstructionChange[] }> {
    return this.serial(() => this.compare(kind));
  }

  private async compare(kind: InstructionKind): Promise<{ snapshot: Snapshot; changes: InstructionChange[] }> {
    const ref = await this.load();
    const snapshot = await this.io.read(WATCHED[kind].files, WATCHED[kind].trees);
    const changes: InstructionChange[] = [];
    let moved = false;
    // Codex's first install of its system skills is no change anyone made: taken in silently, watched from then on.
    if (!Object.keys(ref).some((p) => p.startsWith(CODEX_SYSTEM_SKILLS)))
      for (const [p, c] of Object.entries(snapshot)) if (p.startsWith(CODEX_SYSTEM_SKILLS)) (ref[p] = c), (moved = true);
    for (const path of new Set([...Object.keys(snapshot), ...Object.keys(ref).filter((p) => this.inKind(kind, p))])) {
      const now = snapshot[path];
      const before = ref[path];
      if (now === before) continue;
      const rel = path.slice("/workspace/".length);
      if (now !== undefined && TEXTS.includes(rel) && path.startsWith("/workspace/") && (await shippedHashes(rel, this.models)).has(createHash("sha256").update(now).digest("hex"))) {
        ref[path] = now;
        moved = true;
        continue;
      }
      const marker = [now, before].find(isMarker)?.slice(1).replace(/^(too-long|binary):.*$/s, "$1");
      const status = before === undefined ? "created" : now === undefined ? "deleted" : "changed";
      changes.push(marker === undefined ? { path, status, lines: lineDiff(before ?? "", now ?? "") } : { path, status, lines: null, marker });
    }
    if (moved) await this.save(ref);
    return { snapshot, changes };
  }

  keep(kind: InstructionKind, snapshot: Snapshot): Promise<void> {
    return this.serial(async () => {
      const ref = Object.fromEntries(Object.entries(await this.load()).filter(([p]) => !this.inKind(kind, p)));
      await this.save({ ...ref, ...Object.fromEntries(Object.entries(snapshot).filter(([p]) => this.inKind(kind, p))) });
    });
  }

  revert(kind: InstructionKind, snapshot: Snapshot): Promise<void> {
    return this.serial(() => this.restore(kind, snapshot));
  }

  private async restore(kind: InstructionKind, snapshot: Snapshot): Promise<void> {
    const ref = await this.load();
    const entries: Record<string, string | null> = {};
    for (const path of new Set([...Object.keys(snapshot), ...Object.keys(ref).filter((p) => this.inKind(kind, p))])) {
      if (snapshot[path] === ref[path]) continue;
      const before = ref[path];
      // A marker is never recreated; a marker the snapshot holds (a too-many tree…) is removed whole.
      const target = before === undefined || isMarker(before) ? null : before;
      if (target === null && snapshot[path] === undefined) continue;
      entries[path] = target;
    }
    // What Revenir replaces is kept, last revert only: a user's own edit or file is never lost for good.
    await this.save(Object.fromEntries(Object.keys(entries).flatMap((p) => (snapshot[p] === undefined ? [] : [[p, snapshot[p]!]]))), "replaced");
    // Deletes first: a folder the agent replaced by a link goes before the files beneath it are written.
    await this.io.write(Object.fromEntries(Object.entries(entries).sort(([, a], [, b]) => Number(a !== null) - Number(b !== null))));
  }

  async acceptedAgents(): Promise<string> {
    const file = join(this.dir, "AGENTS.md");
    const accepted = (await this.load())["/workspace/AGENTS.md"];
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `AGENTS.${randomUUID()}.tmp`);
    // A marker (link, too long, binary) is no text the user read: Claude gets no AGENTS.md at all.
    await writeFile(tmp, accepted === undefined || isMarker(accepted) ? "" : accepted);
    await rename(tmp, file);
    return file;
  }
}
