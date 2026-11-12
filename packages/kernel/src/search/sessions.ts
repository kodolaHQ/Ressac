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
  hand?: { path: string[]; resolve(r: { outcome: Outcome; path: string[] }): void };
}

const PATH_MAX = 20;
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

  current(window: string) {
    return this.byWindow.get(window);
  }

  start(window: string, tabId: string, goal: string): void {
    if (this.byWindow.has(window)) throw new Error("a search is already running in this window");
    this.stopped.delete(window);
    const s: Search = { window, tabId, goal, gestures: [], free: new Set(), pages: 0, startedAt: this.now(), text: "" };
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
    clearTimeout(s.timer);
    this.band(s, "working");
    try { return await f(); } finally {
      if (this.byTab.get(tabId) === s) {
        this.band(s, "idle");
        if (!s.hand) this.arm(s);
      }
    }
  }

  pageRead(tabId: string, url: string, links: readonly string[]): void {
    const s = this.byTab.get(tabId);
    if (!s) return;
    s.pages++;
    s.free.add(norm(url));
    for (const l of links) s.free.add(norm(l));
  }

  isFree(tabId: string, url: string): boolean {
    const s = this.byTab.get(tabId);
    if (!s) return false;
    try { if (this.engineOrigin && new URL(url).origin === this.engineOrigin) return true; } catch { /* not a URL */ }
    return s.free.has(norm(url));
  }

  allow(tabId: string, url: string): void { this.byTab.get(tabId)?.free.add(norm(url)); }

  log(tabId: string, g: Gesture): void { this.byTab.get(tabId)?.gestures.push(g); }

  handOver(tabId: string, text: string): Promise<{ outcome: Outcome; path: string[] }> {
    const s = this.byTab.get(tabId);
    if (!s) return Promise.resolve({ outcome: "stop", path: [] });
    clearTimeout(s.timer);
    s.text = text;
    this.band(s, "yours");
    return new Promise((resolve) => { s.hand = { path: [], resolve }; });
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

  tabNavigated(tabId: string, url: string): void { this.byTab.get(tabId)?.hand?.path.push(url); }

  tabClosed(tabId: string): void {
    const s = this.byTab.get(tabId);
    if (s) this.end(s, "closed");
  }

  reset(): void {
    for (const s of [...this.byTab.values()]) this.end(s, "stop");
    this.stopped.clear();
  }

  setEngineOrigin(origin: string): void { this.engineOrigin = origin; }

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
