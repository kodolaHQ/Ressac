// Reading the HTML version of DuckDuckGo, no dependency. The page's content is data.
// Read in a single pass (no regular expression that backtracks over the whole page):
// a hostile page cannot freeze the kernel.

export const URL_DUCKDUCKGO = "https://html.duckduckgo.com/html/";
export const RECHERCHE_REFUSEE = "Recherche refusée par DuckDuckGo (vérification anti-robot)";
export const RESULTATS_ILLISIBLES = "Résultats illisibles : la page de DuckDuckGo a peut-être changé";

export type ResultatRecherche = { titre: string; url: string; extrait: string };

/** Page size read at most; the rest is ignored. */
const PAGE_MAX = 2 * 1024 * 1024;
/** A longer tag is not one: it is treated as text. */
const BALISE_MAX = 4096;

export const urlRecherche = (requete: string, base = URL_DUCKDUCKGO) => base + "?q=" + encodeURIComponent(requete);

const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decoder(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,6}));/gi, (m, hex?: string, dec?: string, nom?: string) => {
    if (nom) return ENTITES[nom.toLowerCase()] ?? m;
    const n = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}

const SURROGATS_ISOLES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CONTROLES = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
function nettoyer(s: string, max: number): string {
  const t = s.replace(CONTROLES, " ").replace(/\s+/g, " ").trim();
  return (t.length > max ? t.slice(0, max) : t).replace(SURROGATS_ISOLES, "");
}

function adresse(href: string): string | null {
  let cible = decoder(href).trim();
  if (cible.length > 6000) return null;
  try {
    const u = new URL(cible.startsWith("//") ? "https:" + cible : cible);
    if (u.hostname === "duckduckgo.com" && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (!uddg) return null;
      cible = uddg;
    } else if (cible.startsWith("//")) {
      return null;
    }
    const v = new URL(cible);
    if ((v.protocol !== "http:" && v.protocol !== "https:") || v.username || v.password) return null;
    return v.href.length <= 2000 ? v.href : null;
  } catch {
    return null;
  }
}

type Jeton =
  | { texte: string }
  | { balise: string; nom: string; ferme: boolean; classes: string[]; brut: string };

const ATTR_CLASSE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const attribut = (brut: string, re: RegExp) => {
  const m = re.exec(brut);
  return m ? (m[1] ?? m[2] ?? "") : null;
};

/** Splits into tags and texts, in a single pass: a `<` that follows another without `>` restarts the tag. */
function jetons(html: string): Jeton[] {
  const sortie: Jeton[] = [];
  let debut = -1;
  let texteDepuis = 0;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === 60) {
      debut = i;
    } else if (c === 62 && debut >= 0) {
      const brut = html.slice(debut, i + 1);
      if (brut.length <= BALISE_MAX) {
        const nom = /^<(\/?)([a-z][a-z0-9]*)/i.exec(brut);
        if (nom) {
          if (debut > texteDepuis) sortie.push({ texte: html.slice(texteDepuis, debut) });
          texteDepuis = i + 1;
          sortie.push({
            balise: brut, nom: nom[2]!.toLowerCase(), ferme: nom[1] === "/", brut,
            classes: (attribut(brut, ATTR_CLASSE) ?? "").split(/\s+/).filter(Boolean),
          });
        }
      }
      debut = -1;
    }
  }
  if (texteDepuis < html.length) sortie.push({ texte: html.slice(texteDepuis) });
  return sortie;
}

const estBalise = (j: Jeton): j is Extract<Jeton, { balise: string }> => "balise" in j;

/** Raw text up to the matching closing tag (same name, nestings counted) or the end of the block. */
function texteJusqua(bloc: Jeton[], depart: number, nom: string): string {
  let profondeur = 1;
  let t = "";
  for (let k = depart + 1; k < bloc.length; k++) {
    const j = bloc[k]!;
    if (!estBalise(j)) t += j.texte;
    else if (j.nom === nom) {
      profondeur += j.ferme ? -1 : 1;
      if (profondeur === 0) break;
    }
  }
  return t;
}

export function extraireResultats(
  html: string,
  nombre: number,
): { resultats: ResultatRecherche[] } | { refus: true } | { illisible: true } {
  const tous = jetons(html.length > PAGE_MAX ? html.slice(0, PAGE_MAX) : html);
  // Anti-bot check: only in the markup, never in the page's text.
  if (tous.some((j) => estBalise(j) && !j.ferme && /anomaly-modal|\/anomaly\.js|challenge-form/.test(j.brut))) {
    return { refus: true };
  }

  const aucun = tous.some((j) => estBalise(j) && !j.ferme && j.classes.includes("no-results"));
  return lireBlocs(tous, nombre, aucun);
}

function lireBlocs(tous: Jeton[], nombre: number, aucun: boolean) {
  const blocs: Jeton[][] = [];
  for (const j of tous) {
    if (estBalise(j) && !j.ferme && j.nom === "div" && j.classes.includes("result")) blocs.push([j]);
    else blocs.at(-1)?.push(j);
  }
  const resultats: ResultatRecherche[] = [];
  const vus = new Set<string>();
  let reconnu = false;
  for (const bloc of blocs) {
    const debut = bloc[0] as Extract<Jeton, { balise: string }>;
    const iLien = bloc.findIndex((j) => estBalise(j) && !j.ferme && j.nom === "a" && j.classes.includes("result__a"));
    if (iLien < 0) continue;
    reconnu = true;
    if (debut.classes.includes("result--ad")) continue;
    const lien = bloc[iLien] as Extract<Jeton, { balise: string }>;
    const url = adresse(attribut(lien.brut, /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i) ?? "");
    if (!url || vus.has(url)) continue;
    const iExtrait = bloc.findIndex((j) => estBalise(j) && !j.ferme && j.classes.includes("result__snippet"));
    const extrait = iExtrait < 0 ? "" : texteJusqua(bloc, iExtrait, (bloc[iExtrait] as Extract<Jeton, { balise: string }>).nom);
    vus.add(url);
    resultats.push({
      titre: nettoyer(decoder(texteJusqua(bloc, iLien, "a")), 300),
      url,
      extrait: nettoyer(decoder(extrait), 1000),
    });
  }
  if (reconnu) return { resultats: resultats.slice(0, nombre) };
  return aucun ? { resultats: [] } : { illisible: true as const };
}
