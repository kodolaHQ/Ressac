import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheminsEspace } from "../../src/chemins.js";

/** Déclaration de widget valide, avec une taille par défaut modifiable. */
export const declarationWidget = (defaut = { l: 4, h: 4 }, extra: Record<string, unknown> = {}) => ({
  nom: "Widget",
  description: "Un widget de test",
  tailles: { min: { l: 1, h: 1 }, max: { l: 12, h: 8 }, defaut },
  ...extra,
});

/** Écrit `<widgets>/<id>/widget.json` (ou le texte brut donné) et les fichiers annexes. */
export async function ecrireWidget(c: CheminsEspace, id: string, contenu: unknown | string = declarationWidget(), fichiers: Record<string, string> = {}) {
  const dossier = join(c.widgets, id);
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "widget.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
  for (const [nom, texte] of Object.entries(fichiers)) await writeFile(join(dossier, nom), texte);
}
