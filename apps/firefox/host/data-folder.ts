import { execFile } from "node:child_process";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { backupDate } from "../core/state/format";
import type { Backup } from "../shared/settings";

const run = promisify(execFile);

export const EXPORT_EXCLUDED = ["workspace", "local-ai", "ressac-widgets", "ressac-sites", "ressac-components", "import-tmp"];

export async function listBackups(dataDir: string): Promise<Backup[]> {
  const parent = dirname(dataDir);
  const found: Backup[] = [];
  for (const name of await readdir(parent).catch(() => [])) {
    const path = join(parent, name);
    const date = backupDate(dataDir, path);
    if (!date || !(await lstat(path)).isDirectory()) continue;
    found.push({ path, date, bytes: Number((await run("du", ["-sk", path])).stdout.split(/\s/)[0]) * 1024 });
  }
  // Same-instant backups carry a -n suffix: path order keeps the listing stable.
  return found.sort((a, b) => b.date.localeCompare(a.date) || b.path.localeCompare(a.path));
}

export async function deleteBackup(dataDir: string, path: string): Promise<void> {
  if (!backupDate(dataDir, path) || !(await lstat(path).catch(() => null))?.isDirectory()) throw new Error("Sauvegarde inconnue");
  await rm(path, { recursive: true });
}

/** Zips the data folder minus the heavy or reinstallable parts; returns the zip path. */
export async function exportData(dataDir: string, toDir: string, now: Date = new Date()): Promise<string> {
  const base = join(toDir, `Ressac-donnees-${now.toISOString().slice(0, 10)}`);
  let out = `${base}.zip`;
  for (let i = 2; await stat(out).then(() => true, () => false); i++) out = `${base} (${i}).zip`;
  await run("/usr/bin/zip", ["-r", "-q", "-y", out, ".", "-x", ...EXPORT_EXCLUDED.flatMap((n) => [`${n}/*`, n])], { cwd: dataDir });
  return out;
}
