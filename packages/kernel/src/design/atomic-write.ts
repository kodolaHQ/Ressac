import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Writes a JSON atomically (temporary then rename): folder 0o700, file 0o600. */
export async function writePrivateJson(file: string, data: unknown): Promise<void> {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const temp = join(folder, `${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}
