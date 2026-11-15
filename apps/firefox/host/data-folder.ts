import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { backupDate } from "../core/state/format";
import type { Backup } from "../shared/settings";

const run = promisify(execFile);
const HISTORY = "history.sqlite";

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
  // The history is live (WAL): a raw copy can miss writes or not open. A consistent copy goes in its place.
  const live = join(dataDir, HISTORY);
  const snapshot = (await stat(live).then(() => true, () => false)) ? await mkdtemp(join(tmpdir(), "ressac-export-")) : null;
  try {
    if (snapshot) {
      const db = new DatabaseSync(live, { readOnly: true });
      try {
        db.exec(`VACUUM INTO '${join(snapshot, HISTORY).replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
    }
    const history = [HISTORY, `${HISTORY}-wal`, `${HISTORY}-shm`];
    await run("/usr/bin/zip", ["-r", "-q", "-y", out, ".", "-x", ...EXPORT_EXCLUDED.flatMap((n) => [`${n}/*`, n]), ...history], { cwd: dataDir });
    if (snapshot) await run("/usr/bin/zip", ["-q", out, HISTORY], { cwd: snapshot });
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
  }
  return out;
}
