import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const MEMOIRE_MAX_OCTETS = 3 * 1024 * 1024;

/** Mémoire des blocs d'un widget : par id de bloc, son type et ce qu'il a retenu d'une exécution à l'autre. */
export type MemoireBlocs = Record<string, { type: string; valeur: unknown }>;

const FichierMemoire = z.object({
  version: z.literal(1),
  blocs: z.record(z.string(), z.object({ type: z.string(), valeur: z.unknown() })),
});

/** Mémoire des blocs, ou vide si absente, abîmée ou trop grosse. */
export async function lireMemoire(dossierDonnees: string): Promise<MemoireBlocs> {
  const chemin = join(dossierDonnees, "memoire.json");
  try {
    if ((await stat(chemin)).size > MEMOIRE_MAX_OCTETS) return {};
    return FichierMemoire.parse(JSON.parse(await readFile(chemin, "utf8"))).blocs as MemoireBlocs;
  } catch {
    return {};
  }
}

/** Écrit la mémoire ; false, sans rien écrire, si elle dépasse 3 Mo. */
export async function ecrireMemoire(dossierDonnees: string, m: MemoireBlocs): Promise<boolean> {
  const texte = JSON.stringify({ version: 1, blocs: m });
  if (Buffer.byteLength(texte) > MEMOIRE_MAX_OCTETS) return false;
  const cible = join(dossierDonnees, "memoire.json");
  await mkdir(dossierDonnees, { recursive: true });
  const temporaire = `${cible}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaire, texte);
    await rename(temporaire, cible);
  } finally {
    await rm(temporaire, { force: true });
  }
  return true;
}

/** Efface les exécutions et la mémoire (retrait d'un accord, widget retiré). */
export async function effacerExecutionsEtMemoire(dossierDonnees: string): Promise<void> {
  await rm(join(dossierDonnees, "executions"), { recursive: true, force: true });
  await rm(join(dossierDonnees, "memoire.json"), { force: true });
}
