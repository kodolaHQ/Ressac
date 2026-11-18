import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../paths.js";
import { shippedHashes } from "./initialize.js";

export type InstructionKind = "claude" | "codex";
/** Container path to content; an absent file has no key, a link or too-long file is a marker starting with "\u0000". */
export type Snapshot = Record<string, string>;
export type DiffLine = { kind: " " | "+" | "-"; text: string };
export type InstructionChange = { path: string; status: "changed" | "created" | "deleted"; lines: DiffLine[] | null };
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

const isMarker = (s: string | undefined) => s?.startsWith("\u0000") ?? false;

export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
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
    return w.files.includes(path) || w.trees.some((t) => path.startsWith(`${t}/`));
  }

  /** The stored reference; with no file yet (first run), the shipped templates of the space language. */
  private async load(): Promise<Snapshot> {
    try {
      return (JSON.parse(await readFile(join(this.dir, "reference.json"), "utf8")) as { files: Snapshot }).files;
    } catch {
      const lang = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(this.locale()) && existsSync(join(this.models, this.locale())) ? this.locale() : "en";
      const ref: Snapshot = {};
      for (const t of TEXTS) ref[`/workspace/${t}`] = await readFile(join(this.models, existsSync(join(this.models, lang, t)) ? lang : "en", t), "utf8");
      return ref;
    }
  }

  private async save(files: Snapshot) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, "reference.json.tmp");
    await writeFile(tmp, JSON.stringify({ files }));
    await rename(tmp, join(this.dir, "reference.json"));
  }

  async pending(kind: InstructionKind): Promise<{ snapshot: Snapshot; changes: InstructionChange[] }> {
    const ref = await this.load();
    const snapshot = await this.io.read(WATCHED[kind].files, WATCHED[kind].trees);
    const changes: InstructionChange[] = [];
    let moved = false;
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
      const markerSide = isMarker(now) || isMarker(before);
      changes.push({ path, status: before === undefined ? "created" : now === undefined ? "deleted" : "changed", lines: markerSide ? null : lineDiff(before ?? "", now ?? "") });
    }
    if (moved) await this.save(ref);
    return { snapshot, changes };
  }

  async keep(kind: InstructionKind, snapshot: Snapshot): Promise<void> {
    const ref = Object.fromEntries(Object.entries(await this.load()).filter(([p]) => !this.inKind(kind, p)));
    await this.save({ ...ref, ...Object.fromEntries(Object.entries(snapshot).filter(([p]) => this.inKind(kind, p))) });
  }

  async revert(kind: InstructionKind, snapshot: Snapshot): Promise<void> {
    const ref = await this.load();
    const entries: Record<string, string | null> = {};
    for (const path of new Set([...Object.keys(snapshot), ...Object.keys(ref).filter((p) => this.inKind(kind, p))])) {
      if (snapshot[path] === ref[path]) continue;
      const before = ref[path];
      // A link or too-long file is never recreated.
      const target = before === undefined || isMarker(before) ? null : before;
      if (target === null && snapshot[path] === undefined) continue;
      entries[path] = target;
    }
    await this.io.write(entries);
  }

  async acceptedAgents(): Promise<string> {
    const file = join(this.dir, "AGENTS.md");
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, (await this.load())["/workspace/AGENTS.md"] ?? "");
    return file;
  }
}
