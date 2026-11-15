import { relative, sep } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";
import { inFolder, readFiles } from "../workspace/confined.js";

/** #rrggbb color: no name, no rgba, so the page can apply it as is. */
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "couleur #rrggbb attendue");

/** Home page theme, written by the agent; the Firefox page applies it, absent or invalid it keeps the default. */
export const HomeTheme = z.object({
  version: z.literal(1),
  background: color.optional(),
  card: color.optional(),
  text: color.optional(),
  mutedText: color.optional(),
  accent: color.optional(),
  border: color.optional(),
  radius: z.number().int().min(0).max(24).optional(),
  spacing: z.number().int().min(0).max(24).optional(),
  font: z.enum(["system", "serif", "mono"]).optional(),
}).strict();
export type HomeTheme = z.infer<typeof HomeTheme>;

/** theme: null if absent. erreur: present and invalid (the default applies, the file is never rewritten). */
export async function readTheme(c: SpacePaths): Promise<{ theme: HomeTheme | null; error?: string }> {
  // Through the confined child: a link the agent puts there never leads to a file of the Mac or a device.
  const r0 = await inFolder(c.root, relative(c.root, c.home).split(sep), readFiles, [["theme.json"], 64 * 1024, 64 * 1024]);
  if (!r0 || ("failed" in r0 && r0.why === "absent")) return { theme: null };
  if ("failed" in r0) return { theme: null, error: `theme.json invalide : ${r0.why === "big" ? "trop gros" : "pas un fichier"}` };
  let raw: unknown;
  try {
    raw = JSON.parse(r0.files[0]!.text);
  } catch (e) {
    return { theme: null, error: `theme.json invalide : ${(e as Error).message}` };
  }
  const r = HomeTheme.safeParse(raw);
  return r.success ? { theme: r.data } : { theme: null, error: `theme.json invalide : ${r.error.message}` };
}
