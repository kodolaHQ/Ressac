// Templates of text params: `{chemin}` replaced by a value of the current item (or of the input), or of the
// user's config (`{config.…}`). `{chemin?}` is optional: an absent value becomes an empty
// string (for an enrichment, like a reliability). For an action run with an input, the exact marker `{saisie}`
// (or `{saisie?}`) is that input, before a `saisie` field of the item. No expressions: nothing is ever evaluated.

const MOTIF = /\{([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(\?)?\}/g;
const SEUL = /^\{[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\??\}$/;

/** Value at the end of a path `a.b.0`; own properties only (never those of the prototype). */
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
 * Fills in a template. Returns `{ texte }`, or `{ absente: chemin }` at the first absent, `null` or empty value of a
 * `{chemin}` marker; an optional marker `{chemin?}` without a value is replaced by an empty string.
 * `saisie` (text, action only): the value of `{saisie}`; without it, `{saisie}` reads the item as before.
 * `url`: each value is encoded, unless the template is exactly one `{chemin}` (a whole URL).
 * `texteMax`: each inserted value is cut to this length.
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

/** Thrown by `ctx.remplir`: the interpreter runs nothing for this item (or returns `null` in simple mode). */
export class ValeurAbsente extends Error {
  constructor(chemin) {
    super(`valeur absente : ${chemin}`);
    this.chemin = chemin;
  }
}
