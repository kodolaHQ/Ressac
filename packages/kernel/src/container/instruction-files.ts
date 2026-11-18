// The agent's instruction files, read and restored inside the workshop container by `node -e` (see Workshop.readInstructions).
// Both functions are sent by toString(): self-contained, no import, no module value but through their arguments.
import type { Snapshot } from "../workspace/instructions.js";

export const FILE_MAX = 256 * 1024;
export const TOTAL_MAX = 4 * 1024 * 1024;
export const TREE_FILES_MAX = 500;
export type InstructionLimits = { file: number; total: number; tree: number };
export const LIMITS: InstructionLimits = { file: FILE_MAX, total: TOTAL_MAX, tree: TREE_FILES_MAX };

/**
 * Child side: the `files` and every file under the `trees` (absolute paths), each path walked from `/` with lstat. A link
 * anywhere is recorded as `"\u0000link:" + target` at its own path and nothing under it is read; an absent file has no
 * key; a file over `limits.file` is `"\u0000too-long:" + sha256(first MiB + size)`, one not UTF-8 text (or with a NUL) `"\u0000binary:" + sha256`; a fifo, socket… is `"\u0000other"`. Throws past
 * `limits.tree` tree entries (folders count) or `limits.total` bytes.
 */
export function readInstructionFiles(input: { files: string[]; trees: string[] }, limits: InstructionLimits = LIMITS): Snapshot {
  const fs = process.getBuiltinModule("node:fs");
  const { createHash } = process.getBuiltinModule("node:crypto");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const out: Snapshot = {};
  let total = 0;
  let treeEntries = 0;
  const readFile = (path: string): string => {
    const fd = fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return "\u0000other";
      // At most 1 MiB read: a huge or sparse file must not stall the read; past the limit, its head and size identify it.
      const head = 1024 * 1024;
      const chunks: Buffer[] = [];
      let size = 0;
      const buffer = Buffer.alloc(64 * 1024);
      for (let n; size < head && (n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, head - size), null)) > 0; size += n) chunks.push(Buffer.from(buffer.subarray(0, n)));
      const bytes = Buffer.concat(chunks);
      if (size > limits.file || stat.size > limits.file) return `\u0000too-long:${createHash("sha256").update(bytes).update(String(Math.max(size, stat.size))).digest("hex")}`;
      if ((total += size) > limits.total) throw new Error("instruction files too large");
      const text = bytes.toString("utf8");
      // Not text: never restored, so a revert cannot write a lossy decoding back.
      if (bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes)) return `\u0000binary:${createHash("sha256").update(bytes).digest("hex")}`;
      return text;
    } finally {
      fs.closeSync(fd);
    }
  };
  // The entry at `path`, already known not to sit under a link.
  const record = (path: string, l: import("node:fs").Stats, tree: boolean) => {
    if (l.isSymbolicLink()) out[path] = `\u0000link:${fs.readlinkSync(path)}`;
    else if (l.isDirectory()) {
      if (!tree) return;
      for (const name of fs.readdirSync(path)) {
        const child = `${path}/${name}`;
        const cl = fs.lstatSync(child, { throwIfNoEntry: false });
        if (!cl) continue;
        if (++treeEntries > limits.tree) throw new Error("too many instruction entries");
        record(child, cl, true);
      }
    } else out[path] = l.isFile() ? readFile(path) : "\u0000other";
  };
  const walk = (path: string, tree: boolean) => {
    const parts = path.split("/").filter((p) => p !== "");
    if (!path.startsWith("/") || parts.some((p) => p === "." || p === "..")) throw new Error(`bad path ${path}`);
    let at = "";
    for (let i = 0; i < parts.length; i++) {
      at += `/${parts[i]}`;
      const l = fs.lstatSync(at, { throwIfNoEntry: false });
      if (!l) return;
      if (i === parts.length - 1 || l.isSymbolicLink()) return record(at, l, tree);
      if (!l.isDirectory()) return;
    }
  };
  for (const f of input.files) walk(f, false);
  for (const t of input.trees) walk(t, true);
  return out;
}

/**
 * Child side: each entry written atomically (temp O_CREAT|O_EXCL|O_NOFOLLOW in the real parent, then rename: a link at
 * the path is replaced, never followed), or deleted when null. Missing parent folders are created; a linked or
 * non-folder parent fails that entry. "failed" if any entry failed, the others are still applied.
 */
export function writeInstructionFiles(entries: Record<string, string | null>): "done" | "failed" {
  const fs = process.getBuiltinModule("node:fs");
  const { randomBytes } = process.getBuiltinModule("node:crypto");
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  let failed = false;
  for (const [path, content] of Object.entries(entries)) {
    try {
      const parts = path.split("/").filter((p) => p !== "");
      if (!path.startsWith("/") || parts.length === 0 || parts.some((p) => p === "." || p === "..")) throw new Error("bad path");
      const name = parts.pop()!;
      let parent = "";
      let missing = false;
      for (const part of parts) {
        parent += `/${part}`;
        // shortcut: checked then used by path (Node has no openat); a swap in between only reaches what `node`, the agent's own user, can already touch.
        let l = fs.lstatSync(parent, { throwIfNoEntry: false });
        if (!l && content === null) {
          missing = true;
          break;
        }
        if (!l) {
          fs.mkdirSync(parent, { mode: 0o755 });
          l = fs.lstatSync(parent);
        }
        if (!l.isDirectory()) throw new Error("parent is not a real folder");
      }
      if (missing) continue;
      const target = `${parent}/${name}`;
      if (content === null) {
        if (fs.lstatSync(target, { throwIfNoEntry: false })) fs.unlinkSync(target);
        continue;
      }
      const temp = `${parent}/.${name}.${randomBytes(4).toString("hex")}.tmp`;
      // 0o644 explicit: an exec in the container can run with umask 000.
      const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
      try {
        fs.writeFileSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(temp, target);
      } catch (e) {
        fs.rmSync(temp, { force: true });
        throw e;
      }
    } catch {
      failed = true;
    }
  }
  return failed ? "failed" : "done";
}
