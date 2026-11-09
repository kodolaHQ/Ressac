import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../../src/chemins.js";

/** Valid widget declaration, with an editable default size. */
export const declarationWidget = (defaultValue = { l: 4, h: 4 }, extra: Record<string, unknown> = {}) => ({
  nom: "Widget",
  description: "Un widget de test",
  tailles: { min: { l: 1, h: 1 }, max: { l: 12, h: 8 }, defaut: defaultValue },
  ...extra,
});

/** Writes `<widgets>/<id>/widget.json` (or the given raw text) and the side files. */
export async function writeWidget(c: SpacePaths, id: string, content: unknown | string = declarationWidget(), files: Record<string, string> = {}) {
  const dossier = join(c.widgets, id);
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "widget.json"), typeof content === "string" ? content : JSON.stringify(content));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dossier, name), text);
}
