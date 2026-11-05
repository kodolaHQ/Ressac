import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CheminsEspace } from "../chemins.js";

/** Couleur #rrggbb : ni nom, ni rgba, pour que la page puisse l'appliquer telle quelle. */
const couleur = z.string().regex(/^#[0-9a-fA-F]{6}$/, "couleur #rrggbb attendue");

/** Thème de la page d'accueil, écrit par l'agent ; la page Firefox l'applique, absent ou invalide elle garde le défaut. */
export const ThemeAccueil = z.object({
  version: z.literal(1),
  fond: couleur.optional(),
  carte: couleur.optional(),
  texte: couleur.optional(),
  texteDoux: couleur.optional(),
  accent: couleur.optional(),
  bord: couleur.optional(),
  rayon: z.number().int().min(0).max(24).optional(),
  espace: z.number().int().min(0).max(24).optional(),
  police: z.enum(["system", "serif", "mono"]).optional(),
}).strict();
export type ThemeAccueil = z.infer<typeof ThemeAccueil>;

/** theme : null si absent. erreur : présent et invalide (le défaut s'applique, le fichier n'est jamais réécrit). */
export async function lireTheme(c: CheminsEspace): Promise<{ theme: ThemeAccueil | null; erreur?: string }> {
  let brut: unknown;
  try {
    brut = JSON.parse(await readFile(join(c.accueil, "theme.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { theme: null };
    return { theme: null, erreur: `theme.json invalide : ${(e as Error).message}` };
  }
  const r = ThemeAccueil.safeParse(brut);
  return r.success ? { theme: r.data } : { theme: null, erreur: `theme.json invalide : ${r.error.message}` };
}
