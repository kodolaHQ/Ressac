// Replays a corpus (corpus1bis.json schema) through the real fixed rules and, with `judge`, the real judge on the shipped d1.
//   tsx runner-outflow.mts <corpus.json> <out.json> [judge]
// Env: BENCH_GOAL=agent   the judge gets the agent-written goal (the baseline) instead of the user's last message
//      BENCH_FEED=all     diagnostic only: every past result is remembered, public pages included
// What is replayed, from packages/kernel/src/mcp/server.ts at the worktree's HEAD:
//   typed    each line of `typed` is one submitted message (Outflow.typed(win, line + "\r"))
//   reads    a past result is remembered (Outflow.read) when its tool is not in OUTFLOW_UNFED, or when it is a
//            read_tab / current_page of a tab that is not the search's own (`searchTab`) and has an address.
//            The corpus does not say whether the user shared a tab, so no tab gets the « shared and not sensitive » exemption.
//   rule 1+2 Outflow.check on a search_web query (a hit pauses: blocked) and on an address with `composed` of
//            open_tab / navigate / read_pages (a hit is the card's red line: warned)
//   rule 3   in a search, read_tab / capture_screen of a sensitive tab asks its card once per search and origin;
//            history and bookmarks ask theirs once per search (blocked: the gesture waits for the user)
//            (changed before scoring the blind corpora: a followed link is not judged, the judge's past starts at the
//            search's first gesture and leaves list_tabs out, BENCH_TYPED=paste; corpus 1-bis gives the same numbers)
//   judge    createWatcher(...).judge(last typed message, past, next), in a search or on a first search_web;
//            strange pauses a blocking tool and adds a line to an address card
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
// The repo whose rules are replayed: RESSAC_WORKTREE (a checkout at the measured commit), else this repo.
const REPO = process.env.RESSAC_WORKTREE ?? new URL("../../..", import.meta.url).pathname;
const { Outflow } = await import(`${REPO}/packages/kernel/src/outflow/outflow.ts`);
const { isLocal } = await import(`${REPO}/packages/kernel/src/access/policy.ts`);
const { isSensitive } = await import(`${REPO}/packages/kernel/src/access/sensitive.ts`);
import type { OutflowHit } from "../../../packages/kernel/src/outflow/outflow.ts";
import type { Gesture } from "../../../packages/kernel/src/search/sessions.ts";
const HERE = new URL(".", import.meta.url).pathname;
// judge mode only: the llama-server binary (b12430 was measured); the judge (search/watcher.ts) exists only up to 0.1.19.
const LLAMA = process.env.RESSAC_LLAMA_SERVER;
type Past = Gesture & { result?: string; searchTab?: boolean };
type Item = { id: string; goal: string; typed?: string; past: Past[]; next: Past };

// Copied from server.ts (not exported there); checked against the source below so a drift stops the run.
const OUTFLOW_UNFED = ["search_web", "read_pages", "read_tab", "current_page", "list_tabs", "capture_screen", "open_tab", "navigate", "note_lesson", "launch_app", "stop_app", "open_site", "close_site", "show_recap", "open_workflow", "read_recap", "app_log"];
const serverTs = readFileSync(`${REPO}/packages/kernel/src/mcp/server.ts`, "utf8");
const inCode = [...(/const OUTFLOW_UNFED = new Set\(\[([\s\S]*?)\]\)/.exec(serverTs)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
if (JSON.stringify(inCode) !== JSON.stringify([...OUTFLOW_UNFED].sort())) throw new Error("OUTFLOW_UNFED drifted from server.ts");

const SOURCES: Record<string, string> = { search_history: "ton historique", read_history: "ton historique", search_bookmarks: "tes favoris", list_tabs: "tes onglets" };
const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
const origin = (url: string) => { try { return new URL(url).origin; } catch { return url; } };
const TAB_READS = new Set(["read_tab", "current_page"]);
const HISTORY = new Set(["search_history", "read_history", "search_bookmarks"]);
const ADDRESS = new Set(["open_tab", "navigate", "read_pages"]);
const feedAll = process.env.BENCH_FEED === "all";
const LINK_TOOLS = new Set(["search_history", "read_history", "search_bookmarks", "hand_over"]);
const SEARCH_QUERY_MAX = 2000;

// Wiring of server.ts at c61a21f5 (post-final-review):
//  - history, bookmarks, hand_over: only each entry's own address may be followed (parsed from the result's lines:
//    « title · url · … », « URL : url »), never one in a title or an excerpt, never a local one;
//  - read_tab / current_page of a user tab and list_tabs: the text's addresses may be followed unless the tab is local;
//  - a read of the search's own tab is remembered when its page is a sensitive site (the read's url, else the last navigate's);
//  - a search_web query over 2000 characters is refused before any check (`refused`).
// Not modelled: site apps (none in the corpora), the typed whitelist cleared on a new conversation (one conversation per item).
type Fed = { source: string; links: boolean | string[] };
const entryUrls = (g: Past): string[] => {
  const urls: string[] = [];
  for (const line of g.result!.split("\n")) {
    const kept = /^URL : (https?:\/\/\S+)$/.exec(line)?.[1] ?? line.split(" · ").find((f, k) => k > 0 && /^https?:\/\/\S+$/.test(f));
    if (kept && !isLocal(kept)) urls.push(kept);
  }
  return urls;
};
/** How a past result is remembered (one or two reads), or nothing when the kernel does not remember it. */
function fedAs(g: Past, i: number, past: Past[]): Fed[] {
  if (g.result === undefined) return [];
  if (feedAll) return [{ source: g.url ? host(g.url) : "une page", links: true }];
  if (TAB_READS.has(g.tool)) {
    if (!g.searchTab) return g.url ? [{ source: host(g.url), links: !isLocal(g.url) }] : [];
    const url = g.url ?? past.slice(0, i).findLast((p) => p.tool === "navigate" && p.url)?.url;
    return url && isSensitive(url) ? [{ source: host(url), links: true }] : [];
  }
  if (g.tool === "list_tabs") {
    if (g.searchTab) return [];
    const lines = g.result.split("\n");
    const local = (l: string) => l.split(" · ").some((f) => isLocal(f));
    return [{ source: SOURCES.list_tabs!, links: true as const, text: lines.filter((l) => !local(l)).join("\n") }, { source: SOURCES.list_tabs!, links: false as const, text: lines.filter(local).join("\n") }].map(({ text, ...f }) => ({ ...f, text })) as never;
  }
  if (OUTFLOW_UNFED.includes(g.tool)) return [];
  return [{ source: SOURCES[g.tool] ?? "un outil de l'agent", links: LINK_TOOLS.has(g.tool) ? entryUrls(g) : [] }];
}
const plain = ({ result: _r, searchTab: _s, ...g }: Past): Gesture => g;
const inSearch = (x: Item) => x.past.some((g) => g.tool === "search_web" || g.tool === "read_pages");

/** The gestures the search has logged when `next` is judged: from the search's first gesture on, judged tools only (list_tabs is not one). */
const LOGGED = new Set(["search_web", "navigate", "open_tab", "read_pages", "read_tab", "capture_screen", "search_history", "read_history", "search_bookmarks"]);
function logged(x: Item): Gesture[] {
  const start = x.past.findIndex((g) => g.tool === "search_web" || g.tool === "read_pages");
  return start < 0 ? [] : x.past.slice(start).filter((g) => LOGGED.has(g.tool)).map(plain);
}

function fixedRules(x: Item) {
  const typedOnly = new Outflow(); // rule 1 alone: no read, the typed whitelist still applies
  const full = new Outflow();
  // BENCH_TYPED=paste: `typed` is one prompt pasted whole (corpus 3: a source prompt of several lines), as a bracketed paste.
  const messages = process.env.BENCH_TYPED === "paste" ? [`\x1b[200~${x.typed ?? ""}\x1b[201~`] : (x.typed ?? "").split("\n");
  for (const m of messages) for (const o of [typedOnly, full]) o.typed("w", m + "\r");
  let fed = 0;
  x.past.forEach((g, i) => { for (const f of fedAs(g, i, x.past) as (Fed & { text?: string })[]) { full.read("w", f.text ?? g.result!, f.source, f.links); fed++; } });
  const refused = x.next.tool === "search_web" && (x.next.query ?? "").length > SEARCH_QUERY_MAX;
  const out = refused ? undefined : x.next.tool === "search_web" ? x.next.query : ADDRESS.has(x.next.tool) && x.next.composed ? x.next.url : undefined;
  const address = x.next.tool !== "search_web"; // server.ts: danger(url) checks an address, search_web a query
  const hit1 = out === undefined ? undefined : typedOnly.check("w", out, address);
  const hit = out === undefined ? undefined : full.check("w", out, address);
  // Rule 2: the hit names a source. A rule 1 secret that was also read counts for both rules.
  const rule2 = hit?.source !== undefined;
  let card3: string | undefined;
  if (inSearch(x) && !x.next.searchTab) {
    if ((x.next.tool === "read_tab" || x.next.tool === "capture_screen") && x.next.url && isSensitive(x.next.url)) {
      const o = origin(x.next.url);
      // The card of this origin was already asked in this search by an earlier read of it.
      if (!x.past.some((g) => (g.tool === "read_tab" || g.tool === "capture_screen") && !g.searchTab && g.url && origin(g.url) === o)) card3 = "sensitive-tab";
    } else if (HISTORY.has(x.next.tool) && !x.past.some((g) => HISTORY.has(g.tool))) card3 = "history";
  }
  return { fed, refused, checked: out !== undefined, hit1: hit1 ?? null, hit: hit ?? null, rule2, card3: card3 ?? null, goalTyped: full.lastMessage("w") ?? null };
}

type Seen = { raw?: number };
const als = new AsyncLocalStorage<Seen>();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const r = await realFetch(input, init);
  const seen = als.getStore();
  if (seen && String(input).endsWith("/v1/systemone") && r.ok) seen.raw = ((await r.clone().json()) as { answers?: { q?: { noul?: number } } }).answers?.q?.noul;
  return r;
};

const [corpusFile, outFile, withJudge] = process.argv.slice(2);
const corpus: Item[] = JSON.parse(readFileSync(corpusFile!, "utf8"));
const { createWatcher, WATCHER_NO_AT_MOST } = withJudge ? await import(`${REPO}/packages/kernel/src/search/watcher.ts`) : ({} as Record<string, never>);
const { LocalAi, D1_MODEL } = withJudge ? await import(`${REPO}/packages/kernel/src/ai/local-ai.ts`) : ({} as Record<string, never>);
const ai = withJudge ? new LocalAi({ folder: `${HERE}local-ai`, llamaServer: LLAMA }) : undefined;
if (ai) await ai.kev({ state: "{}", questions: { q: { type: "noul", instructions: "Is this a test?" } } }); // warm, as agent.start does
const results = [];
// One gesture at a time: 3 or more concurrent callers starve llama-server b12430 -np 4 (first report).
for (const x of corpus) {
  const f = fixedRules(x);
  let judge: { verdict: string; raw: number | null; failOpen: boolean; ms: number; goal: string } | null = null;
  // Not judged: a followed link (an address tool without `composed` is free, server.ts skips the judge), and anything outside a search.
  if (ai && (inSearch(x) || x.next.tool === "search_web") && !x.next.searchTab && !(ADDRESS.has(x.next.tool) && !x.next.composed)) {
    const goal = process.env.BENCH_GOAL === "agent" ? x.goal : (f.goalTyped ?? x.goal);
    const seen: Seen = {};
    const t = performance.now();
    const verdict = await als.run(seen, () => createWatcher(ai).judge(goal, logged(x), plain(x.next)));
    judge = { verdict, raw: seen.raw ?? null, failOpen: seen.raw === undefined, ms: Math.round(performance.now() - t), goal };
  }
  results.push({ id: x.id, ...f, judge });
}
writeFileSync(outFile!, JSON.stringify({ corpus: corpusFile, feed: feedAll ? "all" : "server.ts", goal: process.env.BENCH_GOAL ?? "typed", judge: !!ai, args: ai ? D1_MODEL.args : null, threshold: WATCHER_NO_AT_MOST, results }, null, 1));
console.error(`${results.length} items; rule1 ${results.filter((r) => r.hit1).length}, check ${results.filter((r) => r.hit).length}, rule3 ${results.filter((r) => r.card3).length}, strange ${results.filter((r) => r.judge?.verdict === "strange").length}, fail-open ${results.filter((r) => r.judge?.failOpen).length}`);
await ai?.close();
process.exit(0);
