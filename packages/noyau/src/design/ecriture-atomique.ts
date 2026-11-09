import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Writes a JSON atomically (temporary then rename): folder 0o700, file 0o600. */
export async function ecrireJsonPrive(fichier: string, donnees: unknown): Promise<void> {
  const dossier = dirname(fichier);
  await mkdir(dossier, { recursive: true, mode: 0o700 });
  await chmod(dossier, 0o700);
  const temporaire = join(dossier, `${basename(fichier)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temporaire, JSON.stringify(donnees, null, 2), { mode: 0o600 });
  await chmod(temporaire, 0o600);
  await rename(temporaire, fichier);
}
