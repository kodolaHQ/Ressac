import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Format version this code reads and writes, for each half (the Firefox store and the kernel). */
export const KNOWN_FORMAT = 2;

export type Marker = { store: number; kernel: number };

const file = (dataDir: string) => join(dataDir, ".format-version");

/** The data was written by a newer WebAiOs: nothing is read nor written. */
export class FutureFormatError extends Error {
  constructor(m: Marker) {
    super(`Les données (${JSON.stringify(m)}) viennent d'une version plus récente de WebAiOs (format ${KNOWN_FORMAT} connu) : rien n'est modifié.`);
    this.name = "FutureFormatError";
  }
}

/** Absent: `{store: 1, kernel: 1}` (data from before the English formats). Unreadable: an error, nothing is migrated. */
export async function readMarker(dataDir: string): Promise<Marker> {
  let text: string;
  try {
    text = await readFile(file(dataDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { store: 1, kernel: 1 };
    throw e;
  }
  const v = JSON.parse(text) as Partial<Marker>;
  const half = (n: unknown) => (Number.isInteger(n) && (n as number) >= 1 ? (n as number) : 1);
  if (typeof v !== "object" || v === null) throw new Error(`${file(dataDir)} illisible`);
  return { store: half(v.store), kernel: half(v.kernel) };
}

/** Writes one half of the marker, keeping the other (temporary file then rename). */
export async function writeMarkerHalf(dataDir: string, half: keyof Marker, version: number): Promise<void> {
  const m = { ...(await readMarker(dataDir)), [half]: version };
  const tmp = `${file(dataDir)}.tmp`;
  await writeFile(tmp, JSON.stringify(m) + "\n");
  await rename(tmp, file(dataDir));
}
