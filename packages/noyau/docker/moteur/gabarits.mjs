// Gabarits des paramètres texte : `{chemin}` remplacé par une valeur de l'élément en cours (ou de l'entrée), ou de la
// configuration du propriétaire (`{config.…}`). `{chemin?}` est facultatif : une valeur absente y devient une chaîne
// vide (pour un enrichissement, comme une fiabilité). Pour une action lancée avec une saisie, le repère exact `{saisie}`
// (ou `{saisie?}`) vaut cette saisie, avant un champ `saisie` de l'élément. Pas d'expressions : rien n'est jamais évalué.

const MOTIF = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\?)?\}/g;
const SEUL = /^\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\??\}$/;

/** Valeur au bout d'un chemin `a.b.0` ; seulement des propriétés propres (jamais celles du prototype). */
export function lireChemin(valeur, chemin) {
  let v = valeur;
  for (const morceau of chemin.split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, morceau)) return undefined;
    v = v[morceau];
  }
  return v;
}

const absente = (v) => v === undefined || v === null || v === "";
const enTexte = (v) => (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Remplit un gabarit. Rend `{ texte }`, ou `{ absente: chemin }` à la première valeur absente, `null` ou vide d'un
 * repère `{chemin}` ; un repère facultatif `{chemin?}` sans valeur est remplacé par une chaîne vide.
 * `saisie` (texte, action seulement) : la valeur de `{saisie}` ; sans elle, `{saisie}` lit l'élément comme avant.
 * `url` : chaque valeur est encodée, sauf si le gabarit est exactement un seul `{chemin}` (une URL entière).
 * `texteMax` : chaque valeur insérée est coupée à cette longueur.
 */
export function remplir(gabarit, { element, config, saisie }, { url = false, texteMax = Infinity } = {}) {
  const encoder = url && !SEUL.test(gabarit);
  let manquante = null;
  const texte = gabarit.replace(MOTIF, (tout, chemin, facultatif) => {
    if (manquante) return tout;
    const v =
      chemin === "saisie" && typeof saisie === "string"
        ? saisie
        : chemin.startsWith("config.")
          ? lireChemin(config, chemin.slice("config.".length))
          : lireChemin(element, chemin);
    if (absente(v)) {
      if (facultatif) return "";
      manquante = chemin;
      return tout;
    }
    const t = enTexte(v).slice(0, texteMax);
    return encoder ? encodeURIComponent(t) : t;
  });
  return manquante ? { absente: manquante } : { texte };
}

/** Levée par `ctx.remplir` : l'interpréteur ne lance rien pour cet élément (ou rend `null` en mode simple). */
export class ValeurAbsente extends Error {
  constructor(chemin) {
    super(`valeur absente : ${chemin}`);
    this.chemin = chemin;
  }
}
