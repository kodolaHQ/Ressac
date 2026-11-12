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
  hand?: { path: string[]; promise: Promise<{ outcome: Outcome; path: string[] }>; resolve(r: { outcome: Outcome; path: string[] }): void };
}

const PATH_MAX = 20;
const URL_MAX = 500;
/** Normalised http(s) address short enough to remember, else undefined. */
function freeable(u: string): string | undefined {
  if (u.length > URL_MAX) return undefined;
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:" ? norm(u) : undefined; } catch { return undefined; }
}
function norm(u: string): string {
  try { const x = new URL(u); x.hash = ""; return x.href; } catch { return u; }
}

export class SearchSessions {
  private byWindow = new Map<string, Search>();
  private byTab = new Map<string, Search>();
  private stopped = new Set<string>();
  private engineOrigin = "";
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
    const s: Search = { window, tabId, goal, gestures: [], free: new Set(), pages: 0, startedAt: this.now(), text: "", inFlight: 0 };
    this.byWindow.set(window, s);
    this.byTab.set(tabId, s);
    this.arm(s);
  }

  owns(tabId: string): boolean { return this.byTab.has(tabId); }

  takeStop(window: string): boolean { return this.stopped.delete(window); }

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

  pageRead(tabId: string, url: string, links: readonly string[]): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    s.pages++;
    for (const l of [url, ...links]) this.allow(tabId, l);
  }

  isFree(tabId: string, url: string): boolean {
    const s = this.byTab.get(tabId);
    if (!s) return false;
    try { if (this.engineOrigin && new URL(url).origin === this.engineOrigin) return true; } catch { /* not a URL */ }
    return s.free.has(norm(url));
  }

  allow(tabId: string, url: string): void {
    const u = freeable(url);
    if (u) this.byTab.get(tabId)?.free.add(u);
  }

  log(tabId: string, g: Gesture): void { this.byTab.get(tabId)?.gestures.push(g); }

  handOver(tabId: string, text: string): Promise<{ outcome: Outcome; path: string[] }> {
    const s = this.byTab.get(tabId);
    if (!s) return Promise.resolve({ outcome: "stop", path: [] });
    if (s.hand) return s.hand.promise; // one question to the user at a time
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
    this.band(s, "idle");
    this.arm(s);
    resolve({ outcome: "continue", path: kept });
  }

  stop(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    this.stopped.add(s.window);
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

  setEngineOrigin(origin: string): void {
    try { this.engineOrigin = new URL(origin).origin; } catch { this.engineOrigin = ""; }
  }

  private band(s: Search, state: BandState): void {
    this.o.show(s.tabId, { state, text: s.text, pages: s.pages, startedAt: s.startedAt });
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
    const h = s.hand;
    s.hand = undefined;
    h?.resolve({ outcome, path: h.path.slice(-PATH_MAX) });
  }
}
