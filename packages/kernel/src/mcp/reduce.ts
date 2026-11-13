import type { PageBlock, TabRead } from "./bridge.js";

/** What the code can tell of a page, without a model. */
export type PageState = "ok" | "introuvable" | "bloquée" | "connexion demandée" | "vide" | "pdf";

const PAIRS_MAX = 20;
const PAIR_VALUE_MAX = 200;
const LEAD_MAX = 1_200;
const PASSAGE_MAX = 1_500;
/** A passage's body past this length starts the next passage. */
const PASSAGE_CUT = 900;
/** Check-page markers count only on a short page: a long article about captchas is an article. */
const SHORT_PAGE = 3_000;
/** …with almost no links: a results page about captchas is a page of links. */
const CHECK_LINKS_MAX = 5;
const CHECK_MARKERS =
  /(captcha|verify you are human|vérifiez que vous êtes humain|unusual traffic|trafic inhabituel|cf-challenge|are you a robot|êtes-vous un robot|access denied|accès refusé)/i;
const LOGIN_PATH = /\/(login|signin|sign-in|connexion|auth)\b/i;
const MENU_ZONES = new Set(["nav", "footer", "lang", "header"]);

const visibleText = (r: TabRead) => (r.blocks ? r.blocks.map((b) => b.text).join("\n") : r.text);

export function pageState(r: TabRead, url: string, title = ""): PageState {
  const visible = visibleText(r);
  if (r.contentType === "application/pdf") return "pdf";
  if (r.status === 404 || r.status === 410) return "introuvable";
  if (r.status === 403 || r.status === 429 || (visible.length < SHORT_PAGE && (r.links?.length ?? 0) < CHECK_LINKS_MAX && CHECK_MARKERS.test(`${visible} ${title}`))) return "bloquée";
  if ((r.passwords ?? 0) > 0 && visible.length < SHORT_PAGE) return "connexion demandée";
  if (LOGIN_PATH.test(url) && (r.redirects ?? []).length) return "connexion demandée";
  if (visible.trim().length < 40) return "vide";
  return "ok";
}

export function stateLine(r: TabRead, url: string, title = ""): string {
  return `État : ${pageState(r, url, title)}${r.status ? ` (${r.status})` : ""}`;
}

const SKIPPED_KEY = /^(@context|@id|@type|image|logo|url|sameAs|potentialAction)$/;
function flatten(o: unknown, prefix: string, out: string[]): void {
  if (out.length >= PAIRS_MAX * 2 || o == null) return;
  if (typeof o !== "object") {
    const v = String(o).replace(/\s+/g, " ").trim();
    if (v && v.length <= PAIR_VALUE_MAX && !/^https?:\/\/schema\.org/.test(v)) out.push(`${prefix} : ${v}`);
    return;
  }
  if (Array.isArray(o)) {
    for (const x of o.slice(0, 5)) flatten(x, prefix, out);
    return;
  }
  for (const [k, v] of Object.entries(o)) if (!SKIPPED_KEY.test(k)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
}

/** The page's structured data as « champ : valeur » pairs, 20 at most (prices, dates, authors, hours). */
export function structuredPairs(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const s of raw) flatten(s, "", out);
  return [...new Set(out)].slice(0, PAIRS_MAX);
}

const deaccent = (s: string) =>
  s.normalize("NFKC").toLowerCase().replace(/[’‘`´]/g, "'").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const STOP = new Set(
  "le la les un une des de du d l et ou a au aux en dans sur pour par que qui quoi quel quelle quels quelles est sont ce cet cette ces se sa son ses il elle ils elles on y ne pas plus comment combien quand selon ete etait avec sans entre lui leur leurs dont the of and to in for is".split(" "),
);
const words = (s: string) => deaccent(s).replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 1 && !STOP.has(w));

/** The blocks of the main content: those the reader mode kept, else all but menus, else all. */
function mainBlocks(r: TabRead): PageBlock[] {
  if (!r.blocks) return r.text.split(/\n{2,}/).map((text) => ({ text: text.replace(/\s+/g, " ").trim(), h: 0, zone: "main" as const }));
  const size = (bs: PageBlock[]) => bs.reduce((n, b) => n + b.text.length, 0);
  const reader = r.reader && r.reader.length > 800 ? deaccent(r.reader) : null;
  let keep = reader ? r.blocks.filter((b) => reader.includes(deaccent(b.text).slice(0, 60))) : [];
  if (size(keep) < 500) keep = r.blocks.filter((b) => !MENU_ZONES.has(b.zone));
  if (size(keep) < 200) keep = r.blocks;
  return keep;
}

/** The page cut in passages, each starting at a heading (shown `## …`) or after PASSAGE_CUT characters. */
function passages(r: TabRead): string[] {
  const out: string[] = [];
  let cur: { text: string; row?: number } | null = null;
  for (const b of mainBlocks(r)) {
    if (!b.text) continue;
    if (b.h || !cur || cur.text.length > PASSAGE_CUT) {
      if (cur) out.push(cur.text);
      cur = { text: b.h ? `## ${b.text}` : b.text, row: b.row };
      continue;
    }
    cur.text += (b.row !== undefined && cur.row === b.row ? " | " : "\n") + b.text;
    cur.row = b.row;
  }
  if (cur) out.push(cur.text);
  return out;
}

/**
 * The reduced page for a question, within `budget` characters: the structured pairs first, then the whole page if it
 * fits, else the lead passage and the passages sharing the most words with the question, in page order.
 */
export function reducedPage(r: TabRead, question: string, budget: number): { text: string; shown: number; total: number } {
  const all = passages(r);
  const pairs = structuredPairs(r.structured ?? []);
  const head = pairs.length ? `Données structurées :\n${pairs.join("\n")}\n\n` : "";
  let room = budget - head.length;
  const cut = all.map((p, i) => p.slice(0, i === 0 ? LEAD_MAX : PASSAGE_MAX));
  const chosen = new Set<number>();
  if (all.reduce((n, p) => n + p.length + 2, 0) <= room) all.forEach((_, i) => chosen.add(i));
  else {
    const q = new Set(words(question));
    const score = (p: string) => {
      const hits = words(p).filter((w) => q.has(w));
      return new Set(hits).size * 3 + Math.min(hits.length, 10) / 2 + (/\d/.test(p) ? 0.5 : 0);
    };
    if (cut[0] !== undefined && cut[0].length + 2 <= room) {
      chosen.add(0);
      room -= cut[0].length + 2;
    }
    const ranked = cut.map((p, i) => ({ i, s: score(p) })).sort((a, b) => b.s - a.s);
    for (const { i, s } of ranked) {
      if (s <= 0 || chosen.has(i) || cut[i]!.length + 2 > room) continue;
      chosen.add(i);
      room -= cut[i]!.length + 2;
    }
  }
  const body = cut.filter((_, i) => chosen.has(i)).join("\n\n");
  return { text: (head + body).slice(0, budget), shown: chosen.size, total: all.length };
}
