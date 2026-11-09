import type { HomeTheme } from "../../../packages/noyau/src/accueil/theme";

// The theme validated by the kernel becomes CSS variables on the home root; when absent, home keeps the
// application's variables (and follows light/dark mode). A color is re-checked here: nothing but a
// #rrggbb must reach the style, even if the object was not validated.
const COULEUR = /^#[0-9a-f]{6}$/i;

/** Theme key → suffix of the `--accueil-*` variable. */
const COULEURS = { fond: "fond", carte: "carte", texte: "texte", texteDoux: "texte-doux", accent: "accent", bord: "bord" } as const;

const POLICES = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  serif: "serif",
  mono: "ui-monospace, monospace",
} as const;

export function variablesTheme(t: HomeTheme | null): Record<string, string> {
  const variables: Record<string, string> = {};
  if (!t) return variables;
  for (const [cle, suffixe] of Object.entries(COULEURS)) {
    const couleur = t[cle as keyof typeof COULEURS];
    if (typeof couleur === "string" && COULEUR.test(couleur)) variables[`--accueil-${suffixe}`] = couleur;
  }
  if (Number.isInteger(t.rayon) && t.rayon! >= 0 && t.rayon! <= 24) variables["--accueil-rayon"] = `${t.rayon}px`;
  if (Number.isInteger(t.espace) && t.espace! >= 0 && t.espace! <= 24) variables["--accueil-espace"] = `${t.espace}px`;
  // hasOwn: « toString » or « constructor » must not pass for a font.
  if (t.police && Object.hasOwn(POLICES, t.police)) variables["--accueil-police"] = POLICES[t.police];
  return variables;
}
