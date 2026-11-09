import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpacePaths } from "../../src/paths.js";

/** Valid widget declaration, with an editable default size. */
export const declarationWidget = (defaultValue = { w: 4, h: 4 }, extra: Record<string, unknown> = {}) => ({
  name: "Widget",
  description: "Un widget de test",
  sizes: { min: { w: 1, h: 1 }, max: { w: 12, h: 8 }, default: defaultValue },
  ...extra,
});

/** Writes `<widgets>/<id>/widget.json` (or the given raw text) and the side files. */
export async function writeWidget(c: SpacePaths, id: string, content: unknown | string = declarationWidget(), files: Record<string, string> = {}) {
  const folder = join(c.widgets, id);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "widget.json"), typeof content === "string" ? content : JSON.stringify(content));
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
}
