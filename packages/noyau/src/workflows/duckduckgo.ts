// Reading the HTML version of DuckDuckGo, no dependency. The page's content is data.
// Read in a single pass (no regular expression that backtracks over the whole page):
// a hostile page cannot freeze the kernel.

export const URL_DUCKDUCKGO = "https://html.duckduckgo.com/html/";
export const SEARCH_DENIED = "Recherche refusée par DuckDuckGo (vérification anti-robot)";
export const UNREADABLE_RESULTS = "Résultats illisibles : la page de DuckDuckGo a peut-être changé";

export type SearchResult = { titre: string; url: string; extrait: string };

/** Page size read at most; the rest is ignored. */
const PAGE_MAX = 2 * 1024 * 1024;
/** A longer tag is not one: it is treated as text. */
const TAG_MAX = 4096;

export const urlRecherche = (request: string, base = URL_DUCKDUCKGO) => base + "?q=" + encodeURIComponent(request);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,6}));/gi, (m, hex?: string, dec?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? m;
    const n = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  });
}

const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;
function clean(s: string, max: number): string {
  const t = s.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  return (t.length > max ? t.slice(0, max) : t).replace(LONE_SURROGATES, "");
}

function href(href: string): string | null {
  let target = decode(href).trim();
  if (target.length > 6000) return null;
  try {
    const u = new URL(target.startsWith("//") ? "https:" + target : target);
    if (u.hostname === "duckduckgo.com" && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (!uddg) return null;
      target = uddg;
    } else if (target.startsWith("//")) {
      return null;
    }
    const v = new URL(target);
    if ((v.protocol !== "http:" && v.protocol !== "https:") || v.username || v.password) return null;
    return v.href.length <= 2000 ? v.href : null;
  } catch {
    return null;
  }
}

type Token =
  | { texte: string }
  | { balise: string; nom: string; ferme: boolean; classes: string[]; brut: string };

const ATTR_CLASS = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const attribute = (brut: string, re: RegExp) => {
  const m = re.exec(brut);
  return m ? (m[1] ?? m[2] ?? "") : null;
};

/** Splits into tags and texts, in a single pass: a `<` that follows another without `>` restarts the tag. */
function tokens(html: string): Token[] {
  const sortie: Token[] = [];
  let debut = -1;
  let textFrom = 0;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === 60) {
      debut = i;
    } else if (c === 62 && debut >= 0) {
      const brut = html.slice(debut, i + 1);
      if (brut.length <= TAG_MAX) {
        const name = /^<(\/?)([a-z][a-z0-9]*)/i.exec(brut);
        if (name) {
          if (debut > textFrom) sortie.push({ texte: html.slice(textFrom, debut) });
          textFrom = i + 1;
          sortie.push({
            balise: brut, nom: name[2]!.toLowerCase(), ferme: name[1] === "/", brut,
            classes: (attribute(brut, ATTR_CLASS) ?? "").split(/\s+/).filter(Boolean),
          });
        }
      }
      debut = -1;
    }
  }
  if (textFrom < html.length) sortie.push({ texte: html.slice(textFrom) });
  return sortie;
}

const isTag = (j: Token): j is Extract<Token, { balise: string }> => "balise" in j;

/** Raw text up to the matching closing tag (same name, nestings counted) or the end of the block. */
function textUntil(bloc: Token[], depart: number, name: string): string {
  let depth = 1;
  let t = "";
  for (let k = depart + 1; k < bloc.length; k++) {
    const j = bloc[k]!;
    if (!isTag(j)) t += j.texte;
    else if (j.nom === name) {
      depth += j.ferme ? -1 : 1;
      if (depth === 0) break;
    }
  }
  return t;
}

export function extractResults(
  html: string,
  count: number,
): { resultats: SearchResult[] } | { refus: true } | { illisible: true } {
  const tous = tokens(html.length > PAGE_MAX ? html.slice(0, PAGE_MAX) : html);
  // Anti-bot check: only in the markup, never in the page's text.
  if (tous.some((j) => isTag(j) && !j.ferme && /anomaly-modal|\/anomaly\.js|challenge-form/.test(j.brut))) {
    return { refus: true };
  }

  const none = tous.some((j) => isTag(j) && !j.ferme && j.classes.includes("no-results"));
  return lireBlocs(tous, count, none);
}

function lireBlocs(tous: Token[], count: number, none: boolean) {
  const blocs: Token[][] = [];
  for (const j of tous) {
    if (isTag(j) && !j.ferme && j.nom === "div" && j.classes.includes("result")) blocs.push([j]);
    else blocs.at(-1)?.push(j);
  }
  const results: SearchResult[] = [];
  const vus = new Set<string>();
  let recognized = false;
  for (const bloc of blocs) {
    const debut = bloc[0] as Extract<Token, { balise: string }>;
    const iLien = bloc.findIndex((j) => isTag(j) && !j.ferme && j.nom === "a" && j.classes.includes("result__a"));
    if (iLien < 0) continue;
    recognized = true;
    if (debut.classes.includes("result--ad")) continue;
    const lien = bloc[iLien] as Extract<Token, { balise: string }>;
    const url = href(attribute(lien.brut, /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i) ?? "");
    if (!url || vus.has(url)) continue;
    const iExtrait = bloc.findIndex((j) => isTag(j) && !j.ferme && j.classes.includes("result__snippet"));
    const extrait = iExtrait < 0 ? "" : textUntil(bloc, iExtrait, (bloc[iExtrait] as Extract<Token, { balise: string }>).nom);
    vus.add(url);
    results.push({
      titre: clean(decode(textUntil(bloc, iLien, "a")), 300),
      url,
      extrait: clean(decode(extrait), 1000),
    });
  }
  if (recognized) return { resultats: results.slice(0, count) };
  return none ? { resultats: [] } : { illisible: true as const };
}
