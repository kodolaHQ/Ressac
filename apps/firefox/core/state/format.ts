import fs from "node:fs/promises";
import { join } from "node:path";

export const DATA_FORMAT = 2;
export const FORMAT_FILE = ".format-version";

/** Reads the marker; anything but {"format": DATA_FORMAT} (absent, unreadable, older) counts as unknown. */
async function isKnown(dataDir: string): Promise<boolean> {
  try {
    return JSON.parse(await fs.readFile(join(dataDir, FORMAT_FILE), "utf8"))?.format === DATA_FORMAT;
  } catch {
    return false;
  }
}

export const RESET_FILE = ".reset-requested";

const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(-\d+)?$/;

/** What a reset or a format change leaves in place: the agent's files, Ressac's own Ollama, and the request itself. */
const STAYS = ["workspace", "ollama", RESET_FILE];

/** The ISO date of a path that is exactly `<dataDir>.backup-<timestamp>[-n]` (what checkDataFormat writes), else null. */
export function backupDate(dataDir: string, path: string): string | null {
  const prefix = `${dataDir}.backup-`;
  const m = path.startsWith(prefix) ? STAMP.exec(path.slice(prefix.length)) : null;
  return m && `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

/**
 * Makes sure the data folder is of the current format, and honours a reset request. An unknown format or a reset marker
 * sets the whole folder aside (workspace/ stays in place: it holds the user's projects) and starts anew. Returns the
 * backup path and why, or null when nothing was set aside.
 */
export async function checkDataFormat(dataDir: string, now: Date = new Date()): Promise<{ backup: string; reason: "format" | "reset" } | null> {
  const reset = await fs.access(join(dataDir, RESET_FILE)).then(() => true, () => false);
  if (!reset && (await isKnown(dataDir))) return null;
  let backup: string | null = null;
  if (await fs.access(dataDir).then(() => true, () => false)) {
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    for (let i = 0; ; i++) {
      backup = `${dataDir}.backup-${timestamp}${i ? `-${i}` : ""}`;
      if (await fs.access(backup).then(() => false, () => true)) break;
    }
    await fs.mkdir(backup, { recursive: true });
    // workspace/ never moves, nor Ressac's own Ollama (a program, not data: it would be downloaded again), and dataDir
    // always exists. An entry that cannot move stays in place, logged: the rest still lands in this backup, which the
    // marker and the notice name (a rerun at the next start would set the new, empty session aside under another name).
    for (const name of await fs.readdir(dataDir))
      if (!STAYS.includes(name)) await fs.rename(join(dataDir, name), join(backup, name)).catch((e) => console.error(`[data] ${name} not set aside:`, e));
  }
  await fs.rm(join(dataDir, RESET_FILE), { force: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(join(dataDir, FORMAT_FILE), JSON.stringify({ format: DATA_FORMAT }));
  return backup === null ? null : { backup, reason: reset ? "reset" : "format" };
}
