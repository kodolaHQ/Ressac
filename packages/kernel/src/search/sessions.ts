export type BandState = "working" | "yours" | "idle";
export interface Band { state: BandState; text: string; pages: number; startedAt: number }
export const STOP_TEXT = "L'utilisateur a arrêté la recherche : ne continue pas, dis ce que tu as trouvé.";
export const CLOSED_TEXT = "Onglet fermé par l'utilisateur : la recherche est finie.";
export type Gesture = { tool: string; query?: string; url?: string; composed?: boolean };

type Outcome = "continue" | "stop" | "closed";
interface Search {
  window: string; tabId: string; goal: string; gestures: Gesture[];
  free: Set<string>; pages: number; startedAt: number; text: string;
  timer?: ReturnType<typeof setTimeout>;
  inFlight: number;
  enders: Set<() => void>;
  hand?: { path: string[]; promise: Promise<{ outcome: Outcome; path: string[] }>; resolve(r: { outcome: Outcome; path: string[] }): void };
}

const PATH_MAX = 20;
export const URL_MAX = 500;
const GESTURES_MAX = 50;
const FREE_MAX = 10_000;
/** A parsed http(s) address of at most URL_MAX characters, else undefined. */
function web(u: string): URL | undefined {
  if (u.length > URL_MAX) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:" ? x : undefined;
  } catch { return undefined; }
}

export class SearchSessions {
  private byWindow = new Map<string, Search>();
  private byTab = new Map<string, Search>();
  /** Windows whose search the user stopped, with the tab that was its search tab and when. */
  private stopped = new Map<string, { tab: string; at: number }>();
  private readonly now: () => number;
  private readonly idleMs: number;

  constructor(private o: { show(tabId: string, band: Band | null): void; now?: () => number; idleMs?: number }) {
    this.now = o.now ?? Date.now;
    this.idleMs = o.idleMs ?? 120_000;
  }

  current(window: string): { tabId: string; goal: string; gestures: readonly Gesture[] } | undefined {
    const s = this.byWindow.get(window);
    return s && { tabId: s.tabId, goal: s.goal, gestures: [...s.gestures] };
  }

  start(window: string, tabId: string, goal: string): void {
    if (this.byWindow.has(window)) throw new Error("a search is already running in this window");
    if (this.byTab.has(tabId)) throw new Error("this tab already belongs to a search");
    this.stopped.delete(window);
    const s: Search = { window, tabId, goal, gestures: [], free: new Set(), pages: 0, startedAt: this.now(), text: "", inFlight: 0, enders: new Set() };
    this.byWindow.set(window, s);
    this.byTab.set(tabId, s);
    this.arm(s);
  }

  owns(tabId: string): boolean { return this.byTab.has(tabId); }

  /** Calls `f` once when the search of this tab ends (stop, idle, tab closed, reset); returns the unsubscribe. */
  onEnd(tabId: string, f: () => void): () => void {
    const e = this.byTab.get(tabId)?.enders;
    if (!e) { f(); return () => {}; }
    e.add(f);
    return () => e.delete(f);
  }

  /**
   * True once after a stop, for a call in `window` (about the former search tab `tabId`, if given; another tab does not
   * consume it). A stop no call took within the idle delay expires: a later search is a new intent.
   */
  takeStop(window: string, tabId?: string): boolean {
    const t = this.stopped.get(window);
    if (t && this.now() - t.at > this.idleMs) this.stopped.delete(window);
    return t !== undefined && (tabId === undefined || tabId === t.tab) && this.stopped.delete(window);
  }

  async step<T>(tabId: string, text: string, f: () => Promise<T>): Promise<T> {
    const s = this.byTab.get(tabId);
    if (!s) return f();
    s.text = text;
    s.inFlight++;
    clearTimeout(s.timer);
    if (!s.hand) this.band(s, "working");
    try { return await f(); } finally {
      s.inFlight--;
      if (this.byTab.get(tabId) === s && !s.hand && s.inFlight === 0) {
        this.band(s, "idle");
        this.arm(s);
      }
    }
  }

  /** Changes the band text of a step in progress (a tool that counts its own progress). */
  setText(tabId: string, text: string): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    s.text = text;
    if (!s.hand) this.band(s, "working");
  }

  pageRead(tabId: string, url: string, links: readonly string[]): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    s.pages++;
    for (const l of [url, ...links]) this.allow(tabId, l);
  }

  /**
   * The address to open without a card: `url` itself if it was read as it is, its fragment-less form if only that was
   * (a fragment the agent adds is dropped: the page's script would read it), else undefined.
   */
  freeAs(tabId: string, url: string): string | undefined {
    const free = this.byTab.get(tabId)?.free;
    const x = web(url);
    if (!free || !x) return undefined;
    if (free.has(x.href)) return url;
    x.hash = "";
    return free.has(x.href) ? x.href : undefined;
  }

  isFree(tabId: string, url: string): boolean {
    return this.freeAs(tabId, url) !== undefined;
  }

  /** Remembers the address as read, and its fragment-less form. */
  allow(tabId: string, url: string): void {
    const free = this.byTab.get(tabId)?.free;
    const x = web(url);
    if (!free || !x) return;
    for (const u of [x.href, ((x.hash = ""), x.href)]) if (free.size < FREE_MAX) free.add(u);
  }

  /** A hand is open on this search tab: the page is the user's. */
  handing(tabId: string): boolean {
    return !!this.byTab.get(tabId)?.hand;
  }

  /** Settles when the hand open on this tab ends (at once without one). */
  handEnd(tabId: string): Promise<void> {
    return this.byTab.get(tabId)?.hand?.promise.then(() => {}) ?? Promise.resolve();
  }

  log(tabId: string, g: Gesture): void {
    const list = this.byTab.get(tabId)?.gestures;
    if (!list) return;
    list.push(g);
    if (list.length > GESTURES_MAX) list.shift();
  }

  handOver(tabId: string, text: string): Promise<{ outcome: Outcome; path: string[] }> {
    const s = this.byTab.get(tabId);
    if (!s) return Promise.resolve({ outcome: "stop", path: [] });
    if (s.hand) return s.hand.promise; // one question to the user at a time (a watcher pause waits for its own: handEnd)
    clearTimeout(s.timer);
    s.text = text;
    this.band(s, "yours");
    let resolve!: (r: { outcome: Outcome; path: string[] }) => void;
    const promise = new Promise<{ outcome: Outcome; path: string[] }>((res) => { resolve = res; });
    s.hand = { path: [], promise, resolve };
    return promise;
  }

  continue(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (!s?.hand) return;
    const { path, resolve } = s.hand;
    s.hand = undefined;
    const kept = path.slice(-PATH_MAX);
    if (kept.length) this.allow(tabId, kept[kept.length - 1]!);
    this.resume(s);
    resolve({ outcome: "continue", path: kept });
  }

  /** The agent's call that waited for the user is gone (cancelled): the page is nobody's wait any more; back to idle. */
  abandon(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (!s?.hand) return;
    const { resolve } = s.hand;
    s.hand = undefined;
    this.resume(s);
    // shortcut: a second hand_over sent while this hand was open shares it and gets a stop too (a watcher pause never
    // shares: it waits for its own hand); track callers if agents send two hand_over at once.
    resolve({ outcome: "stop", path: [] });
  }

  stop(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    this.stopped.set(s.window, { tab: s.tabId, at: this.now() });
    this.end(s, "stop");
  }

  dismiss(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (s) this.end(s, "stop");
  }

  tabNavigated(tabId: string, url: string): void {
    const p = this.byTab.get(tabId)?.hand?.path;
    if (!p) return;
    p.push(url);
    if (p.length > PATH_MAX) p.shift();
  }

  tabClosed(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (s) this.end(s, "closed");
  }

  reset(): void {
    for (const s of [...this.byTab.values()]) this.end(s, "stop");
    this.stopped.clear();
  }

  private band(s: Search, state: BandState): void {
    this.o.show(s.tabId, { state, text: s.text, pages: s.pages, startedAt: s.startedAt });
  }

  private resume(s: Search): void {
    if (s.inFlight > 0) this.band(s, "working"); // the last step to end sets idle and arms the timer
    else { this.band(s, "idle"); this.arm(s); }
  }

  private arm(s: Search): void {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => this.end(s, "stop"), this.idleMs);
  }

  private end(s: Search, outcome: Outcome): void {
    clearTimeout(s.timer);
    this.byWindow.delete(s.window);
    this.byTab.delete(s.tabId);
    this.o.show(s.tabId, null);
    for (const f of s.enders) {
      try { f(); } catch (e) { console.error("search: an end callback threw", e); }
    }
    const h = s.hand;
    s.hand = undefined;
    h?.resolve({ outcome, path: h.path.slice(-PATH_MAX) });
  }
}
