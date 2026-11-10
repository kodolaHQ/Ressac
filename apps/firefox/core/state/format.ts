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

/**
 * Makes sure the data folder is of the current format. An unknown format sets the whole folder aside (workspace/ stays
 * in place: it holds the user's projects) and starts anew. Returns the backup path, or null when nothing was set aside.
 */
export async function checkDataFormat(dataDir: string, now: Date = new Date()): Promise<string | null> {
  if (await isKnown(dataDir)) return null;
  let backup: string | null = null;
  if (await fs.access(dataDir).then(() => true, () => false)) {
    const timestamp = now.toISOString().replace(/[:.]/g, "-");
    for (let i = 0; ; i++) {
      backup = `${dataDir}.backup-${timestamp}${i ? `-${i}` : ""}`;
      if (await fs.access(backup).then(() => false, () => true)) break;
    }
    await fs.rename(dataDir, backup);
  }
  await fs.mkdir(dataDir, { recursive: true });
  if (backup && (await fs.access(join(backup, "workspace")).then(() => true, () => false))) await fs.rename(join(backup, "workspace"), join(dataDir, "workspace"));
  await fs.writeFile(join(dataDir, FORMAT_FILE), JSON.stringify({ format: DATA_FORMAT }));
  return backup;
}
