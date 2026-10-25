import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../../src/chemins.js";

export async function ecrireBloc(c: CheminsEspace, id: string, contenu: unknown | string, fichiers: Record<string, string> = {}) {
  const dossier = join(c.blocs, id);
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "bloc.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  for (const [nom, texte] of Object.entries(fichiers)) await writeFile(join(dossier, nom), texte);
}

export const blocAgent = (titre = "Veille") => ({ titre, type: "agent", consigne: "Cherche." });
export const blocApp = (titre = "App") => ({ titre, type: "app", url: "https://app.daily.dev" });
