import type { DevRight, PageBlock, PageField, PageLink, TabInfo, TabRead, Zone } from "@ressac/kernel";
import { FIELDS_MAX } from "../../../../packages/kernel/src/mcp/bridge";
import { AGENT_PROFILE, privateTab, tabProfile, recapOfUrl, type Decision, type PendingRequest, type Outcome, type WindowState, type BrowserState, type SpaceId, type WindowId, type Tab } from "../../shared/model";

const info = (state: BrowserState, o: Tab): TabInfo => ({
  id: o.id,
  title: o.title,
  url: o.url,
  space: state.spaces.find((e) => e.id === o.spaceId)?.name ?? "",
  // The agent's own profile (its search tab, a hand_over sign-in) is never the user's.
  agentReached: o.agentReached !== false || o.profile === AGENT_PROFILE || !!o.tweakScript,
  // Fill by kind offers this profile's passport only (design § 8.3).
  profile: tabProfile(state, o),
});

/** Ressac internal pages (`ressac:`): the agent never sees them. */
const internal = (o: Tab) => o.url.startsWith("ressac:");

/** The agent sees the tab: neither an internal page, nor a tab of a private space (spec §3.3). */
const visible = (state: BrowserState, o: Tab) => !internal(o) && !privateTab(state, o);

/** All the tabs, all windows combined, as the agent sees them. */
export function tabInfos(state: BrowserState): TabInfo[] {
  return Object.values(state.tabs).filter((o) => visible(state, o)).map((o) => info(state, o));
}

/** The tab the user is looking at in the window, internal page included. */
function shownTab(state: BrowserState, windowId: WindowId | undefined): Tab | undefined {
  const f = state.windows.find((x) => x.id === windowId);
  const id = f?.active[f.activeSpace];
  return id ? state.tabs[id] : undefined;
}

export function activeTabOf(state: BrowserState, windowId: WindowId | undefined): TabInfo | null {
  const o = shownTab(state, windowId);
  return o && visible(state, o) ? info(state, o) : null;
}

/** The space requested by the agent: by id, then by name (case-insensitive), otherwise the active space. A private space counts as unknown. */
export function resolveSpace(state: BrowserState, f: WindowState, space?: string): SpaceId {
  if (!space) return f.activeSpace;
  const opened = state.spaces.filter((x) => !x.private);
  const e = opened.find((x) => x.id === space) ?? opened.find((x) => x.name.toLowerCase() === space.toLowerCase());
  return e?.id ?? f.activeSpace;
}

/**
 * What the access policy must learn from a state change: navigations and closings. A tab moved into
 * a private space is closed to the agent: read and developer tools drop.
 */
export function policyChanges(before: BrowserState, after: BrowserState): { navigated: { id: string; url: string }[]; closed: string[] } {
  const navigated: { id: string; url: string }[] = [];
  const closed: string[] = [];
  for (const [id, o] of Object.entries(before.tabs)) {
    const n = after.tabs[id];
    if (!n || (!privateTab(before, o) && privateTab(after, n))) closed.push(id);
    else if (n.url !== o.url) navigated.push({ id, url: n.url });
  }
  return { navigated: navigated, closed: closed };
}

/**
 * The recaps no tab shows any more (closed, its window closed, or navigated elsewhere): their files can go. A tab
 * moved into a private space still exists, so its recap stays.
 */
export function closedRecaps(before: BrowserState, after: BrowserState): string[] {
  if (before.tabs === after.tabs) return [];
  const kept = new Set(Object.values(after.tabs).map((o) => recapOfUrl(o.url)));
  const shown = new Set(Object.values(before.tabs).map((o) => recapOfUrl(o.url)));
  return [...shown].filter((r): r is string => r !== null && !kept.has(r));
}

/** The recap of the window's active tab, if it shows one. */
export const activeRecap = (state: BrowserState, windowId: WindowId | undefined): string | null => recapOfUrl(shownTab(state, windowId)?.url ?? "");

/** The recaps on screen: the active tab of a window. */
export const shownRecaps = (state: BrowserState): string[] =>
  state.windows.map((f) => activeRecap(state, f.id)).filter((r): r is string => r !== null);

/** The spaces that just went from non-private to private (the reverse changes nothing in the history). */
export function spacesBecamePrivate(before: BrowserState, after: BrowserState): string[] {
  return after.spaces.filter((n) => n.private && before.spaces.some((o) => o.id === n.id && !o.private)).map((n) => n.id);
}

/**
 * A question that will no longer get a useful answer: its targeted tab is closed. An agent request is displayed
 * in its window, whatever tab is displayed: closing that one does not concern it.
 */
export function staleQuestion(d: PendingRequest, state: BrowserState): boolean {
  // An extension's grant card: it drops with its space; the agent's also when the space's profile
  // becomes private (no agent extension is loaded there). Registry removal and cut-off: ServiceExtensions.
  if (d.extension) {
    const space = state.spaces.find((e) => e.id === d.extension!.spaceId);
    if (!space) return true;
    if (d.extension.source === "agent" && state.spaces.some((e) => e.profile === space.profile && e.private)) return true;
  }
  // An app window (`app:<folder>`) or site app window (`site:<id>`) is not a tab: its closing and its
  // navigations are tracked separately.
  const win = d.target !== undefined && (d.target.startsWith(APP_PREFIX) || d.target.startsWith(SITE_PREFIX));
  const tab = d.target && !win ? state.tabs[d.target] : undefined;
  if (d.target && !win && !tab) return true;
  // Moved into a private space: the agent no longer has access there, the question is moot.
  if (tab && privateTab(state, tab)) return true;
  // The rights cover the site the user saw: the tab went elsewhere, the card drops.
  if (tab && (d.permissions.includes("devtools") || d.permissions.includes("read-tab") || d.permissions.includes("mask-devtools")) && originOf(tab.url) !== d.origin) return true;
  return !d.windowId && d.tabId !== null && !state.tabs[d.tabId];
}

/**
 * The decision kept for a UI answer: a « yes » to a hardened extension card is received only if it
 * carries the « Je comprends » box checked (`confirme`); otherwise it is a refusal, whatever the UI shows.
 */
export function allowedDecision(d: PendingRequest, decision: Decision, confirmed?: boolean): Decision {
  if (decision === "allow" && d.extension?.hardened && confirmed !== true) return "deny";
  return decision;
}

/** The origin of a URL, or the URL as is if it has none. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** A read request with no answer after this delay is refused: the agent does not stay blocked. */
export const QUESTION_DELAY_MS = 120_000;

/**
 * Asks the user a question and waits for their answer. `poser` displays the question, receives what is needed to answer it, and
 * returns what is needed to withdraw it (called if the delay expires, or if `signal` is raised: the answer is then a refusal).
 * `delaiMs` is `Infinity` for a question with no delay.
 */
export function waitForResponse(
  ask: (reply: (d: Outcome) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  return waitForOutcome(ask, delayMs, signal).then((d) => d === "allow");
}

/**
 * Like `waitForResponse`, but tells whether the question lapsed without an answer from the user (`withdrawn`: delay, `signal`,
 * or withdrawn by whoever asked it).
 */
export function waitForOutcome(
  ask: (reply: (d: Outcome) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<Outcome> {
  if (signal?.aborted) return Promise.resolve("withdrawn");
  return new Promise((ok) => {
    let finished = false;
    const reply = (d: Outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      ok(d);
    };
    const abandon = () => {
      if (finished) return;
      remove();
      reply("withdrawn");
    };
    // `Infinity`: no delay (a question coming from a click by the user waits for their answer).
    const timer = Number.isFinite(delayMs) ? setTimeout(abandon, delayMs) : undefined;
    const remove = ask(reply);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

/**
 * Like `waitForResponse`, for the developer tools card: returns the checked rights if the user allows,
 * `[]` if they refuse, if the delay expires or if `signal` is raised (the card is then withdrawn).
 */
export function waitForRights(
  ask: (reply: (d: Outcome, rights?: DevRight[]) => void) => () => void,
  delayMs = QUESTION_DELAY_MS,
  signal?: AbortSignal,
): Promise<DevRight[]> {
  if (signal?.aborted) return Promise.resolve([]);
  return new Promise((ok) => {
    let finished = false;
    const reply = (d: Outcome, rights: DevRight[] = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abandon);
      ok(d === "allow" ? rights : []);
    };
    const abandon = () => {
      if (finished) return;
      remove();
      reply("deny");
    };
    const timer = setTimeout(abandon, delayMs);
    const remove = ask(reply);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

const APP_PREFIX = "app:";
/** Tab id, for the agent, of a site app's window: `site:<id>`. */
export const SITE_PREFIX = "site:";

/** A site app's window seen as a `site:<id>` tab: its title is the app's name, never the page's. */
export function siteTab(s: { id: string; name: string; url: string; domain: string; hash: string; agentReached?: boolean }): TabInfo {
  return { id: SITE_PREFIX + s.id, title: s.name, url: s.url, space: "", site: s.id, domain: s.domain, hash: s.hash, ...(s.agentReached ? { agentReached: true } : {}) };
}

/**
 * A question from the agent about a site app window (`cible: site:<id>`) that is moot: the window is
 * closed, or (developer tools) its page went to another origin. The app's card (without a target) is not
 * concerned: its grant is valid for the app, window open or not.
 */
export function staleSiteQuestion(d: PendingRequest, opened: { id: string; url: string }[]): boolean {
  if (!d.target?.startsWith(SITE_PREFIX)) return false;
  const site = opened.find((s) => SITE_PREFIX + s.id === d.target);
  return !site || (d.permissions.includes("devtools") && originOf(site.url) !== d.origin);
}

/** An app's window seen as an `app:<folder>` tab by the agent. */
export function appTab(a: { folder: string; title: string; url: string }): TabInfo {
  return { id: APP_PREFIX + a.folder, title: a.title, url: a.url, space: "", app: a.folder };
}

const LINKS_MAX = 500;
/** A longer address is dropped, not cut: a cut address is a wrong one. */
const LINK_URL_MAX = 500;
const ZONES = new Set<string>(["main", "other", "aside", "header", "nav", "footer", "lang"] satisfies Zone[]);
const IMAGE_URL_MAX = 2_048;
/** The links of a page as the agent gets them: from a web process, so bounded and checked (http(s) only, a known zone, an https photo). */
export function boundLinks(raw: unknown): (PageLink & { zone: Zone })[] {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, LINKS_MAX)
    .map((l: any) => ({
      text: String(l?.text ?? "").slice(0, 80),
      url: String(l?.url ?? ""),
      zone: (ZONES.has(l?.zone) ? l.zone : "other") as Zone,
      ...(typeof l?.image === "string" && l.image.length <= IMAGE_URL_MAX && l.image.startsWith("https://") && URL.canParse(l.image) ? { image: l.image as string } : {}),
    }))
    .filter((l) => l.url.length <= LINK_URL_MAX && URL.canParse(l.url) && /^https?:$/.test(new URL(l.url).protocol));
}

const BLOCKS_MAX = 6_000;
const BLOCK_TEXT_MAX = 5_000;
const STRUCTURED_MAX = 50;
/** One structured entry, serialized: a bigger one is dropped, not cut (a cut JSON is a wrong one). */
const STRUCTURED_ENTRY_MAX = 50_000;
const READER_MAX = 200_000;
const REDIRECTS_MAX = 10;
const int = (v: unknown, min: number, max: number) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined);

/** What a page read adds to the text and links (`TabRead`), from a web process: bounded, checked, wrong types dropped. */
export function boundCapture(raw: unknown): Omit<TabRead, "text" | "selection" | "links"> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Omit<TabRead, "text" | "selection" | "links"> = {};
  if (Array.isArray(r.blocks))
    out.blocks = r.blocks.slice(0, BLOCKS_MAX).map((b: any): PageBlock => {
      const row = int(b?.row, 0, 100_000);
      return { text: String(b?.text ?? "").slice(0, BLOCK_TEXT_MAX), h: int(b?.h, 0, 6) ?? 0, zone: (ZONES.has(b?.zone) ? b.zone : "other") as Zone, ...(row === undefined ? {} : { row }) };
    });
  if (Array.isArray(r.structured))
    out.structured = r.structured
      .slice(0, STRUCTURED_MAX * 4)
      .filter((x) => {
        try {
          return JSON.stringify(x).length <= STRUCTURED_ENTRY_MAX;
        } catch {
          return false;
        }
      })
      .slice(0, STRUCTURED_MAX)
      .map((x) => JSON.parse(JSON.stringify(x)));
  if (typeof r.reader === "string") out.reader = r.reader.slice(0, READER_MAX);
  const status = int(r.status, 100, 599);
  if (status !== undefined) out.status = status;
  if (Array.isArray(r.redirects))
    out.redirects = r.redirects
      .filter((u): u is string => typeof u === "string" && u.length <= LINK_URL_MAX && URL.canParse(u) && /^https?:$/.test(new URL(u).protocol))
      .slice(0, REDIRECTS_MAX);
  if (typeof r.contentType === "string") out.contentType = r.contentType.slice(0, 100);
  const passwords = int(r.passwords, 0, 1000);
  if (passwords !== undefined) out.passwords = passwords;
  return out;
}

export { FIELDS_MAX };
const FIELD_TYPES = new Set(["text", "password", "email", "tel", "search", "url", "number", "textarea", "contenteditable"]);
/**
 * The fields of one document as the agent gets them (chrome/agent/fill-actor.ts): from a web process, so bounded and
 * checked. Each handle is `<innerWindowId>:<n>`: the document's own, so a frame that navigated never resolves an old one.
 */
export function boundFields(raw: unknown, innerWindowId: number): PageField[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((f: any) => Number.isInteger(f?.n) && f.n >= 0 && FIELD_TYPES.has(f.type) && typeof f.autocomplete === "string" && f.autocomplete.length <= 100)
    .slice(0, FIELDS_MAX)
    .map((f: any) => ({ handle: `${innerWindowId}:${f.n}`, type: f.type, autocomplete: f.autocomplete, label: String(f.label ?? "").replace(/\s+/g, " ").trim().slice(0, 80) }));
}
