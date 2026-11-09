export type MoteurRecherche = "google" | "duckduckgo" | "qwant";

export const MOTEURS: Record<MoteurRecherche, string> = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  qwant: "https://www.qwant.com/?q=%s",
};

const SCHEMAS_ACCEPTES = ["http:", "https:", "file:", "about:"];
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i;
const DOMAINE = /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i;

/** L'URL normalisée, ou `null` si elle ne s'analyse pas (« http:// » seul, port hors limites…). */
const analyser = (texte: string) => (URL.canParse(texte) ? new URL(texte).href : null);

/** Transforme ce que l'utilisateur tape dans la barre d'adresse en URL ; `null` si la saisie est refusée. */
export function versUrl(saisie: string, moteur: MoteurRecherche): string | null {
  const texte = saisie.trim();
  if (!texte) return null;
  if (/^javascript:/i.test(texte)) return null;
  const schema = /^([a-z][a-z0-9+.-]*):/i.exec(texte)?.[1]?.toLowerCase();
  if (schema && SCHEMAS_ACCEPTES.includes(`${schema}:`) && (schema === "about" || texte.includes("//"))) {
    const url = schema === "about" ? texte : analyser(texte);
    if (url) return url;
  } else if (LOCAL.test(texte) || DOMAINE.test(texte)) {
    const url = analyser(`${LOCAL.test(texte) ? "http" : "https"}://${texte}`);
    if (url) return url;
  }
  // Ni URL ni domaine valide : on cherche le texte tel quel.
  return MOTEURS[moteur].replace("%s", encodeURIComponent(texte));
}
