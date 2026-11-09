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

export const searchUrl = (request: string, base = URL_DUCKDUCKGO) => base + "?q=" + encodeURIComponent(request);

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
const attribute = (raw: string, re: RegExp) => {
  const m = re.exec(raw);
  return m ? (m[1] ?? m[2] ?? "") : null;
};

/** Splits into tags and texts, in a single pass: a `<` that follows another without `>` restarts the tag. */
function tokens(html: string): Token[] {
  const output: Token[] = [];
  let start = -1;
  let textFrom = 0;
  for (let i = 0; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === 60) {
      start = i;
    } else if (c === 62 && start >= 0) {
      const raw = html.slice(start, i + 1);
      if (raw.length <= TAG_MAX) {
        const name = /^<(\/?)([a-z][a-z0-9]*)/i.exec(raw);
        if (name) {
          if (start > textFrom) output.push({ texte: html.slice(textFrom, start) });
          textFrom = i + 1;
          output.push({
            balise: raw, nom: name[2]!.toLowerCase(), ferme: name[1] === "/", brut: raw,
            classes: (attribute(raw, ATTR_CLASS) ?? "").split(/\s+/).filter(Boolean),
          });
        }
      }
      start = -1;
    }
  }
  if (textFrom < html.length) output.push({ texte: html.slice(textFrom) });
  return output;
}

const isTag = (j: Token): j is Extract<Token, { balise: string }> => "balise" in j;

/** Raw text up to the matching closing tag (same name, nestings counted) or the end of the block. */
function textUntil(block: Token[], start: number, name: string): string {
  let depth = 1;
  let t = "";
  for (let k = start + 1; k < block.length; k++) {
    const j = block[k]!;
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
  const all = tokens(html.length > PAGE_MAX ? html.slice(0, PAGE_MAX) : html);
  // Anti-bot check: only in the markup, never in the page's text.
  if (all.some((j) => isTag(j) && !j.ferme && /anomaly-modal|\/anomaly\.js|challenge-form/.test(j.brut))) {
    return { refus: true };
  }

  const none = all.some((j) => isTag(j) && !j.ferme && j.classes.includes("no-results"));
  return readBlocks(all, count, none);
}

function readBlocks(all: Token[], count: number, none: boolean) {
  const blocks: Token[][] = [];
  for (const j of all) {
    if (isTag(j) && !j.ferme && j.nom === "div" && j.classes.includes("result")) blocks.push([j]);
    else blocks.at(-1)?.push(j);
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let recognized = false;
  for (const block of blocks) {
    const start = block[0] as Extract<Token, { balise: string }>;
    const iLink = block.findIndex((j) => isTag(j) && !j.ferme && j.nom === "a" && j.classes.includes("result__a"));
    if (iLink < 0) continue;
    recognized = true;
    if (start.classes.includes("result--ad")) continue;
    const link = block[iLink] as Extract<Token, { balise: string }>;
    const url = href(attribute(link.brut, /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i) ?? "");
    if (!url || seen.has(url)) continue;
    const iSnippet = block.findIndex((j) => isTag(j) && !j.ferme && j.classes.includes("result__snippet"));
    const snippet = iSnippet < 0 ? "" : textUntil(block, iSnippet, (block[iSnippet] as Extract<Token, { balise: string }>).nom);
    seen.add(url);
    results.push({
      titre: clean(decode(textUntil(block, iLink, "a")), 300),
      url,
      extrait: clean(decode(snippet), 1000),
    });
  }
  if (recognized) return { resultats: results.slice(0, count) };
  return none ? { resultats: [] } : { illisible: true as const };
}
