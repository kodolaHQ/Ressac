// File work in the agent's workspace, safe against links it swaps in at any time. Node has no openat: a child process
// (chdir is process-wide) walks by working folder instead, each folder entered checked to be the inode lstat saw in the
// verified folder before it, so no path is resolved again from the top through a link.
import { execFile } from "node:child_process";

/** `fn(...args)` in a child Node process, its result as JSON; null if it threw. `fn` must be self-contained (toString()). */
export function inChild<T>(fn: (...args: any[]) => T, args: unknown[], timeout = 30_000): Promise<T | null> {
  // tsx (esbuild keepNames) wraps inner functions in __name(), absent in the child.
  const script = `var __name = (f) => f; process.stdout.write(JSON.stringify((${fn.toString()})(...JSON.parse(process.argv[1]))) ?? "null")`;
  return new Promise((resolve) => {
    execFile(process.execPath, ["-e", script, JSON.stringify(args)], { encoding: "utf8", timeout, maxBuffer: 1024 * 1024, env: {} }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        resolve(null);
      }
    });
  });
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
