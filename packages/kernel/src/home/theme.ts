import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { SpacePaths } from "../paths.js";

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
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(c.home, "theme.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { theme: null };
    return { theme: null, error: `theme.json invalide : ${(e as Error).message}` };
  }
  const r = HomeTheme.safeParse(raw);
  return r.success ? { theme: r.data } : { theme: null, error: `theme.json invalide : ${r.error.message}` };
}
