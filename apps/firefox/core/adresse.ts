export type MoteurRecherche = "google" | "duckduckgo" | "qwant";

export const MOTEURS: Record<MoteurRecherche, string> = {
  google: "https://www.google.com/search?q=%s",
  duckduckgo: "https://duckduckgo.com/?q=%s",
  qwant: "https://www.qwant.com/?q=%s",
};

const SCHEMAS_ACCEPTES = ["http:", "https:", "file:", "about:"];
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i;
const DOMAINE = /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i;

/** The normalized URL, or `null` if it does not parse (« http:// » alone, port out of range…). */
const analyser = (texte: string) => (URL.canParse(texte) ? new URL(texte).href : null);

/** Turns what the user types in the address bar into a URL; `null` if the input is refused. */
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
  // Neither a URL nor a valid domain: search the text as is.
  return MOTEURS[moteur].replace("%s", encodeURIComponent(texte));
}
