// L'aperçu des résultats donné à Gemma : leur forme (chaque chemin et son type) et quelques exemples, bornés. Pur.
// Les résultats sont des faits lus sur des pages web : l'aperçu est une donnée, jamais une consigne.

export const APERCU_MAX = 6000;
const ELEMENTS_EXEMPLE = 3;
const TEXTE_EXEMPLE = 120;
const CLES_MAX = 30;
const ECHANTILLON = 20;
const NOEUDS_EXEMPLES_MAX = 400;
const DESCRIPTION_MAX = 300;
const CHEMIN_MAX = 80;

type Dict = Record<string, unknown>;
const estObjet = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

/** Un dictionnaire sans prototype : une clé « __proto__ » des résultats reste une clé comme une autre. */
const dict = (): Dict => Object.create(null) as Dict;

function couper(s: string, max: number): string {
  if (s.length <= max) return s;
  let fin = max;
  const c = s.charCodeAt(fin - 1);
  if (c >= 0xd800 && c <= 0xdbff) fin--;
  return s.slice(0, fin) + "…";
}

function nature(v: unknown): string {
  if (v === null || v === undefined) return "vide";
  if (typeof v === "string") return "texte";
  if (typeof v === "number") return "nombre";
  if (typeof v === "boolean") return "booléen";
  if (Array.isArray(v)) return "liste";
  return "objet";
}

/** Le type d'une valeur en une ligne : les champs d'une liste d'objets sont détaillés, le reste reste court. */
function decrire(v: unknown): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "liste (0)";
    const echantillon = v.slice(0, ECHANTILLON);
    if (echantillon.every(estObjet)) {
      const champs = new Map<string, string>();
      for (const e of echantillon) {
        for (const k of Object.keys(e).slice(0, CLES_MAX)) if (!champs.has(k)) champs.set(k, nature(e[k]));
      }
      const detail = [...champs].slice(0, CLES_MAX).map(([k, t]) => `${couper(k, 40)}: ${t}`).join(", ");
      return `liste (${v.length}) d'objets { ${detail} }`;
    }
    const natures = new Set(echantillon.map(nature));
    if (natures.size === 1) {
      const n = [...natures][0]!;
      return `liste (${v.length}) de ${n === "texte" ? "textes" : n === "nombre" ? "nombres" : n === "booléen" ? "booléens" : n === "liste" ? "listes" : "valeurs"}`;
    }
    return `liste (${v.length}) de valeurs`;
  }
  if (estObjet(v)) {
    const cles = Object.keys(v);
    return `objet { ${cles.slice(0, CLES_MAX).map((k) => couper(k, 40)).join(", ")}${cles.length > CLES_MAX ? ", …" : ""} }`;
  }
  return nature(v);
}

/** Chaque chemin et son type, les objets étant parcourus jusqu'à `profondeur` niveaux. */
function forme(racine: unknown, profondeur: number): Dict {
  const f = dict();
  const poser = (chemin: string, v: unknown) => { f[couper(chemin, CHEMIN_MAX)] = couper(decrire(v), DESCRIPTION_MAX); };
  if (!estObjet(racine)) {
    poser("$", racine);
    return f;
  }
  const pile: { v: Dict; prefixe: string; niveau: number }[] = [{ v: racine, prefixe: "", niveau: 1 }];
  while (pile.length > 0) {
    const { v, prefixe, niveau } = pile.shift()!;
    for (const k of Object.keys(v).slice(0, CLES_MAX)) {
      const chemin = prefixe + k;
      const e = v[k];
      poser(chemin, e);
      if (estObjet(e) && niveau < profondeur) pile.push({ v: e, prefixe: chemin + ".", niveau: niveau + 1 });
    }
  }
  return f;
}

/** Une copie réduite : 3 éléments par liste, textes à 120, `profondeur` niveaux, un nombre de noeuds borné. */
function exemples(racine: unknown, profondeur: number): unknown {
  let noeuds = 0;
  const copie = (v: unknown, niveau: number): unknown => {
    if (++noeuds > NOEUDS_EXEMPLES_MAX) return "…";
    if (typeof v === "string") return couper(v, TEXTE_EXEMPLE);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean" || v === null) return v;
    if (v === undefined) return null;
    if (niveau >= profondeur) return Array.isArray(v) ? `[liste (${v.length})]` : "[objet]";
    if (Array.isArray(v)) return v.slice(0, ELEMENTS_EXEMPLE).map((e) => copie(e, niveau + 1));
    const o = dict();
    for (const k of Object.keys(v as Dict).slice(0, CLES_MAX)) o[couper(k, 40)] = copie((v as Dict)[k], niveau + 1);
    return o;
  };
  return copie(racine, 0);
}

/** JSON `{ forme, exemples }` d'au plus APERCU_MAX caractères : les exemples partent d'abord, puis les niveaux profonds. */
export function apercuResultats(resultats: unknown): string {
  const essais: [number, boolean][] = [[4, true], [3, true], [2, true], [4, false], [3, false], [2, false], [1, false]];
  for (const [profondeur, avecExemples] of essais) {
    const s = JSON.stringify(avecExemples ? { forme: forme(resultats, profondeur), exemples: exemples(resultats, profondeur) } : { forme: forme(resultats, profondeur) });
    if (s.length <= APERCU_MAX) return s;
  }
  // Dernier recours : les premiers chemins seulement.
  const f = forme(resultats, 1);
  const gardee = dict();
  for (const k of Object.keys(f)) {
    gardee[k] = f[k];
    if (JSON.stringify({ forme: gardee }).length > APERCU_MAX) {
      delete gardee[k];
      break;
    }
  }
  return JSON.stringify({ forme: gardee });
}

/** `null`, `""`, `[]`, `{}`, ou un objet dont toutes les valeurs sont vides (récursivement). Itératif. */
export function resultatsVides(r: unknown): boolean {
  const pile: unknown[] = [r];
  while (pile.length > 0) {
    const v = pile.pop();
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      return false;
    }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) pile.push((v as Record<string, unknown>)[k]);
      continue;
    }
    return false;
  }
  return true;
}
