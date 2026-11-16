// File work in the agent's workspace, safe against links it swaps in at any time. Node has no openat: a child process
// (chdir is process-wide) walks by working folder instead, each folder entered checked to be the inode lstat saw in the
// verified folder before it, so no path is resolved again from the top through a link.
import { execFile } from "node:child_process";

/** Runs `call` (an expression over `args`) in a child Node process, its result as JSON; null if it threw. */
function run<T>(call: string, args: unknown[], timeout: number): Promise<T | null> {
  // tsx (esbuild keepNames) wraps inner functions in __name(), absent in the child. The arguments come on stdin: a
  // capture can exceed the command line's limit.
  const script = `var __name = (f) => f; const args = JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0, "utf8")); process.stdout.write(JSON.stringify(${call}) ?? "null")`;
  return new Promise((resolve) => {
    // 16 MB: the largest read (1 MB of tweaks) even fully escaped by JSON.
    const child = execFile(process.execPath, ["-e", script], { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, env: {} }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        resolve(null);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(args));
  });
}

/** `fn(...args)` in a child Node process, its result as JSON; null if it threw. `fn` must be self-contained (toString()). */
export function inChild<T>(fn: (...args: any[]) => T, args: unknown[], timeout = 30_000): Promise<T | null> {
  return run(`(${fn.toString()})(...args)`, args, timeout);
}

/**
 * `fn(...args)` in a child whose working folder is `<top>/<names…>`, entered by `enter`: so `fn` works by bare names in
 * the verified folder. Null if a folder was refused or `fn` threw.
 */
export function inFolder<T>(top: string, names: string[], fn: (...args: any[]) => T, args: unknown[], o: { create?: boolean; timeout?: number } = {}): Promise<T | null> {
  return run(`((${enter.toString()})(args[0], args[1], args[2]), (${fn.toString()})(...args.slice(3)))`, [top, names, o.create === true, ...args], o.timeout ?? 30_000);
}

/**
 * Child side: chdir into `top` then each of `names`, each a real folder (never a link) checked by dev/ino once entered;
 * `create`: a missing one is made as a real folder. Throws on a refusal.
 */
export function enter(top: string, names: string[], create: boolean): void {
  const fs = process.getBuiltinModule("node:fs");
  const step = (path: string) => {
    const l = fs.lstatSync(path);
    if (!l.isDirectory()) throw new Error("not a real folder");
    process.chdir(path);
    const here = fs.statSync(".");
    if (here.dev !== l.dev || here.ino !== l.ino) throw new Error("folder changed");
  };
  step(top);
  for (const name of names) {
    if (name === "" || name === "." || name === ".." || name.includes("/")) throw new Error("bad name");
    // An existing entry stays as is: the step judges it.
    if (create) fs.mkdirSync(name, { recursive: true });
    step(name);
  }
}

export type ReadFiles =
  | { files: ({ text: string; mtime: number } | null)[]; skipped?: Record<number, "absent" | "refused" | "big"> }
  | { failed: number; why: "absent" | "refused" | "big" };

/**
 * Child side (after `enter`): the files at `paths` (relative, `/`-separated), each folder on the way entered and checked
 * by dev/ino, each file opened by bare name with O_NOFOLLOW, at most `max` bytes each and `totalMax` in all. The first
 * failure stops the reads: its index and why; with `skip`, a file that fails is null instead (why in `skipped`). `encoding` "base64" for
 * binary files (an image).
 */
export function readFiles(paths: string[], max: number, totalMax: number, skip = false, encoding: "utf8" | "base64" = "utf8"): ReadFiles {
  const fs = process.getBuiltinModule("node:fs");
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  type Id = { dev: number; ino: number };
  const same = (a: Id, b: Id) => a.dev === b.dev && a.ino === b.ino;
  const home = process.cwd();
  const top = fs.statSync(".");
  let total = 0;
  const one = (path: string): { text: string; mtime: number } | "absent" | "refused" | "big" => {
    // Back to the verified folder: by path, then checked to be the same.
    process.chdir(home);
    if (!same(fs.statSync("."), top)) throw new Error("folder changed");
    const parts = path.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) return "refused";
    const name = parts.pop()!;
    for (const part of parts) {
      const l = fs.lstatSync(part, { throwIfNoEntry: false });
      if (!l) return "absent";
      if (!l.isDirectory()) return "refused";
      process.chdir(part);
      if (!same(fs.statSync("."), l)) return "refused";
    }
    const l = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!l) return "absent";
    if (!l.isFile()) return "refused";
    if (l.size > max) return "big";
    const fd = fs.openSync(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return "refused";
      const buffer = Buffer.alloc(max + 1);
      let size = 0;
      for (let n; size <= max && (n = fs.readSync(fd, buffer, size, max + 1 - size, null)) > 0; ) size += n;
      // A file that grew since lstat is refused, never cut.
      if (size > max || (total += size) > totalMax) return "big";
      return { text: buffer.subarray(0, size).toString(encoding), mtime: st.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  };
  const files: ({ text: string; mtime: number } | null)[] = [];
  const skipped: Record<number, "absent" | "refused" | "big"> = {};
  for (let i = 0; i < paths.length; i++) {
    const r = one(paths[i]!);
    if (typeof r === "string" && !skip) return { failed: i, why: r };
    if (typeof r === "string") skipped[i] = r;
    files.push(typeof r === "string" ? null : r);
  }
  return { files, skipped };
}

/** Child side (after `enter`): the names in the working folder. */
export function listFolder(): string[] {
  return process.getBuiltinModule("node:fs").readdirSync(".");
}

/**
 * Child side (after `enter`): `moves` renamed from the parent folder into this one (`..` is the real parent, never a
 * link), then each `[name, base64]` of `writes` written atomically by bare name (temp O_CREAT|O_EXCL|O_NOFOLLOW, then
 * rename), then each of `removes` (a file or a link, never followed) deleted. "failed" if a write or a delete failed.
 */
export function writeEntries(writes: [string, string][], moves: string[], removes: string[] = []): "done" | "failed" {
  const fs = process.getBuiltinModule("node:fs");
  const { randomBytes } = process.getBuiltinModule("node:crypto");
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  for (const m of moves) {
    try {
      fs.renameSync(`../${m}`, m);
    } catch {
      // already moved, or gone
    }
  }
  for (const [name, data] of writes) {
    const temp = `${name}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
      try {
        fs.writeFileSync(fd, Buffer.from(data, "base64"));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, name);
    } catch {
      fs.rmSync(temp, { force: true });
      return "failed";
    }
  }
  try {
    for (const name of removes) fs.rmSync(name, { force: true });
  } catch {
    return "failed";
  }
  return "done";
}

/**
 * Child side: renames `<parent>/<name>` (a real folder, never a link) to `to`, `parent` entered by chdir and checked
 * by dev/ino, so the rename happens in the real folder even if a link took its place; "absent", "moved" or "refused".
 */
export function moveEntry(parent: string, name: string, to: string): "absent" | "moved" | "refused" {
  const fs = process.getBuiltinModule("node:fs");
  const p = fs.lstatSync(parent);
  if (!p.isDirectory()) return "refused";
  process.chdir(parent);
  const here = fs.statSync(".");
  if (here.dev !== p.dev || here.ino !== p.ino) return "refused";
  if (!fs.readdirSync(".").includes(name)) return "absent";
  if (!fs.lstatSync(name).isDirectory()) return "refused";
  fs.renameSync(name, to);
  return "moved";
}
