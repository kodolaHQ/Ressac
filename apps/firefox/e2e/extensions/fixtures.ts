import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes an agent extension into `<racine>/extensions/<id>/` (the test's data dir): each file by relative path (a Buffer
 * as is, an object as JSON). Nothing written there grants a right.
 */
export function ecrireExtensionAgent(racine: string, id: string, fichiers: Record<string, string | object>): void {
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const chemin = join(racine, "extensions", id, nom);
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, typeof contenu === "string" || Buffer.isBuffer(contenu) ? contenu : JSON.stringify(contenu, null, 2));
  }
}
