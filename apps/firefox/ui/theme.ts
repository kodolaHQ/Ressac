import type { ThemeAccueil } from "../../../packages/noyau/src/accueil/theme";

// Le thème validé par le noyau devient des variables CSS sur la racine de l'accueil ; absent, l'accueil garde les
// variables de l'application (et suit le mode clair/sombre). Une couleur est revérifiée ici : rien d'autre qu'un
// #rrggbb ne doit atteindre le style, même si l'objet n'a pas été validé.
const COULEUR = /^#[0-9a-f]{6}$/i;

/** Clé du thème → suffixe de la variable `--accueil-*`. */
const COULEURS = { fond: "fond", carte: "carte", texte: "texte", texteDoux: "texte-doux", accent: "accent", bord: "bord" } as const;

const POLICES = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif',
  serif: "serif",
  mono: "ui-monospace, monospace",
} as const;

export function variablesTheme(t: ThemeAccueil | null): Record<string, string> {
  const variables: Record<string, string> = {};
  if (!t) return variables;
  for (const [cle, suffixe] of Object.entries(COULEURS)) {
    const couleur = t[cle as keyof typeof COULEURS];
    if (typeof couleur === "string" && COULEUR.test(couleur)) variables[`--accueil-${suffixe}`] = couleur;
  }
  if (Number.isInteger(t.rayon) && t.rayon! >= 0 && t.rayon! <= 24) variables["--accueil-rayon"] = `${t.rayon}px`;
  if (Number.isInteger(t.espace) && t.espace! >= 0 && t.espace! <= 24) variables["--accueil-espace"] = `${t.espace}px`;
  // hasOwn : « toString » ou « constructor » ne doivent pas passer pour une police.
  if (t.police && Object.hasOwn(POLICES, t.police)) variables["--accueil-police"] = POLICES[t.police];
  return variables;
}
