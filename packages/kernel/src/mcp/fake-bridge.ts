import type { DevRight } from "../access/policy.js";
import type { CpuProfile } from "../devtools/summaries.js";
import type { ReadPage } from "../workflows/protocol.js";
import {
  TabNotFound,
  PrivateTab,
  DevToolsBusy,
  ProfileDenied,
  SiteChanged,
  type TabRead,
  type BrowserHistory,
  type MessageConsole,
  type TabInfo,
  type PageReadOptions,
  type KeptPage,
  type BrowserDevTools,
  type BrowserBridge,
  type NetworkRequest,
  type HistoryResult,
  type JsResult,
  type PageLink,
} from "./bridge.js";

// Transparent 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const PROFILE: CpuProfile = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: "calculer", url: "http://exemple/app.js", lineNumber: 9 } },
  ],
  samples: [2, 2, 1],
  timeDeltas: [0, 1000, 1000],
  startTime: 0,
  endTime: 3000,
};

/** A minimal `.heapsnapshot`: `n` « Fuite » objects of 100 bytes. */
function heap(n: number): string {
  const nodes: number[] = [];
  for (let i = 0; i < n; i++) nodes.push(3, 0, i + 1, 100, 0);
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native"], "string", "number", "number", "number"],
      },
    },
    nodes,
    strings: ["Fuite"],
  });
}

/** Waits for abandonment: an operation that never ends on its own. */
const pending = <T>(signal: AbortSignal): Promise<T> =>
  new Promise<T>((_, ko) => {
    const reject = () => ko(new Error("Interrompu"));
    if (signal.aborted) reject();
    else signal.addEventListener("abort", reject, { once: true });
  });

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Simulated dev tools: buffers set by the tests. */
class FakeDevTools implements BrowserDevTools {
  readonly consoles = new Map<string, MessageConsole[]>();
  readonly networks = new Map<string, NetworkRequest[]>();
  readonly busy = new Set<string>();
  heapObjects = 2;

  constructor(
    private readonly note: (method: string, ...args: unknown[]) => void,
    private readonly find: (id: string) => TabInfo,
    private readonly block: boolean,
  ) {}

  /** As the browser: a tab no longer on the origin the kernel checked throws SiteChanged. */
  private check(id: string, origin?: string): void {
    const tab = this.find(id);
    if (this.busy.has(id)) throw new DevToolsBusy();
    if (origin !== undefined && originOf(tab.url) !== origin) throw new SiteChanged(id);
  }

  async attach(id: string) {
    this.note("attach", id);
    this.check(id);
  }

  async detach(id: string) {
    this.note("detach", id);
  }

  async console(id: string, origin: string) {
    this.note("console", id);
    this.check(id, origin);
    return [...(this.consoles.get(id) ?? [])];
  }

  async network(id: string, origin: string) {
    this.note("network", id);
    this.check(id, origin);
    return [...(this.networks.get(id) ?? [])];
  }

  async body(id: string, origin: string, request: string) {
    this.note("body", id, request);
    this.check(id, origin);
    return { body: `Corps de ${request}`, base64: false };
  }

  async profile(id: string, origin: string, o: { durationMs?: number; reload?: boolean }, signal: AbortSignal) {
    this.note("profile", id, o);
    this.check(id, origin);
    if (this.block) return pending<{ profile: CpuProfile; metrics: Record<string, number> }>(signal);
    return { profile: PROFILE, metrics: { Nodes: 42 } };
  }

  async memorySnapshot(id: string, origin: string, signal: AbortSignal) {
    this.note("memorySnapshot", id);
    this.check(id, origin);
    if (this.block) return pending<string>(signal);
    return heap(this.heapObjects);
  }

  async run(id: string, origin: string, code: string, _signal: AbortSignal): Promise<JsResult> {
    this.note("run", id, code);
    this.check(id, origin);
    if (code.startsWith("throw ")) return { exception: `${code.slice(6)}\n    at <anonymous>:1:1` };
    return { value: JSON.stringify({ code }) };
  }

  async reload(id: string, origin: string, noCache: boolean) {
    this.note("reload", id, noCache);
    this.check(id, origin);
  }
}

/** Simulated browser: for the tests and the dev command. */
export class FakeBridge implements BrowserBridge {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly tabs: TabInfo[];
  private active: string | null;
  private readonly allow: boolean;
  private counter = 0;
  /** Tabs in a private space: invisible, as in the real browser. */
  private readonly privateTabs = new Set<string>();
  readonly devTools?: FakeDevTools;
  readonly history?: BrowserHistory;
  readonly bookmarks?: BrowserBridge["bookmarks"];
  readonly search?: BrowserBridge["search"];
  /** Recap ids with an open tab, in opening order; `recapsPrivate` makes `recaps.open` answer « private ». */
  readonly recapsOpened: string[] = [];
  recapsPrivate = false;
  private activeRecap: string | null = null;
  readonly recaps: NonNullable<BrowserBridge["recaps"]> = {
    open: async (window, id, title) => {
      this.note("recaps.open", window, id, title);
      if (this.recapsPrivate) return "private";
      if (!this.recapsOpened.includes(id)) this.recapsOpened.push(id);
      this.activeRecap = id;
      return "opened";
    },
    close: async (id) => {
      this.note("recaps.close", id);
      if (this.recapsOpened.includes(id)) this.recapsOpened.splice(this.recapsOpened.indexOf(id), 1);
      if (this.activeRecap === id) this.activeRecap = null;
    },
    active: async () => this.activeRecap,
    visible: async () => [...this.recapsOpened],
  };
  private readonly failing = new Set<string>();
  private readonly hanging = new Set<string>();
  /** Links of the successive reads (the last one repeats), to simulate a page whose results come late. */
  linkSequence?: PageLink[][];
  /** The next reads refused because the tab went to another site meanwhile (an engine redirect). */
  siteChanges = 0;
  /** What the browser would add to a read of a tab at this address (status, blocks, structured data…). */
  captures = new Map<string, Partial<TabRead>>();
  readPageInvisible?: (url: string, o: PageReadOptions) => Promise<ReadPage>;
  readHtmlInvisible?: (url: string, o: { localAddresses?: boolean; signal?: AbortSignal }) => Promise<{ url: string; html: string }>;
  /** Suspended reads in progress, by URL: `relacher` lets them finish. */
  private readonly suspended = new Map<string, (() => void)[]>();
  askWidgetData?: (o: { id: string; name: string; agent: string; kind?: "action" | "site" | "history" }, signal?: AbortSignal) => Promise<boolean>;
  /** Domains of each site app (id → domains), for `siteUrlAllowed`. */
  private readonly sites: Record<string, string[]>;
  /** Site apps whose tweaks card is shown: navigating answers « pending ». */
  private readonly pendingSites: Set<string>;
  askAddress?: BrowserBridge["askAddress"];
  /** The signals the address card was asked with. */
  readonly addressSignals: AbortSignal[] = [];
  askDevTools?: (o: TabInfo, d: { rights: DevRight[]; reason: string; agent: string }, signal?: AbortSignal) => Promise<DevRight[]>;

  /**
   * `outilsDev` provides the simulated dev tools; `accorderDev` also provides the consent card,
   * which answers these rights. `bloquer`: profiles and snapshots only end on abandonment. `history` provides
   * the history: `chercher` returns `resultats` (at most `limite`), `lire` the page of `textes` at this URL, and
   * `error`, if given, makes both fail. `lecture` provides `readPageInvisible`: the page of `pages` at this URL
   * (otherwise an empty page), `readHtmlInvisible`: the HTML of `html` at this URL (otherwise ""), and ProfileDenied for a profile of `deny`. A read (page or HTML) of a URL of `suspendues` only
   * ends at `relacher(url)`, or at the abandonment of its `signal`: it is then noted « readCanceled » and rejected with
   * the signal's reason, like the real bridge that closes its window. `redirections` simulates a redirect:
   * the requested URL leads to the associated URL, and that page is the one returned; to another host, with
   * `changeHost`, it waits for it first (noted « changeHost »). `donneesWidget` provides the
   * « donnees-widget » card (and that of a site app, `genre: "site"`), which answers this value. `sites`: the domains
   * of each open site app (`site:<id>` tabs with `site` set), for `siteUrlAllowed`.
   */
  constructor(
    tabs: TabInfo[],
    o: {
      active: string | null;
      allow: boolean;
      devTools?: boolean;
      grantDev?: DevRight[];
      block?: boolean;
      bookmarks?: { url: string; title: string }[];
      history?: { results: HistoryResult[]; texts?: KeptPage[]; error?: string };
      read?: { pages: ReadPage[]; html?: Record<string, string>; deny?: string[]; redirects?: Record<string, string>; suspended?: string[] };
      widgetData?: boolean;
      sites?: Record<string, string[]>;
      pendingSites?: string[];
      /** Provides the search tab; `privateWindows`: windows whose active space is private. */
      search?: { privateWindows?: string[]; /** Addresses whose read fails. */ failing?: string[]; /** Addresses whose read never answers. */ hanging?: string[] };
      /** Provides the address card: answers this value, `"later"` true after 400 ms, or `"wait"` until its signal is raised (then false). */
      address?: boolean | "wait" | "later";
    },
  ) {
    this.sites = o.sites ?? {};
    this.pendingSites = new Set(o.pendingSites ?? []);
    this.tabs = tabs.map((x) => ({ ...x }));
    this.active = o.active;
    this.allow = o.allow;
    if (o.devTools || o.grantDev) {
      this.devTools = new FakeDevTools((m, ...a) => this.note(m, ...a), (id) => this.find(id), o.block ?? false);
    }
    const h = o.history;
    if (h) {
      const fail = () => {
        if (h.error) throw new Error(h.error);
      };
      this.history = {
        find: async (q) => {
          this.note("history.find", { ...q });
          fail();
          return h.results.slice(0, q.limit).map((r) => ({ ...r }));
        },
        read: async (url) => {
          this.note("history.read", url);
          fail();
          const p = h.texts?.find((x) => x.url === url);
          return p ? { ...p } : null;
        },
      };
    }
    const bm = o.bookmarks;
    if (bm)
      this.bookmarks = {
        find: async (q) => {
          this.note("bookmarks.find", { ...q });
          return bm.slice(0, q.limit).map((r) => ({ ...r }));
        },
      };
    const reading = o.read;
    if (reading) {
      const wait = async (url: string, signal: AbortSignal | undefined) => {
        if (signal?.aborted) throw signal.reason;
        if (!reading.suspended?.includes(url)) return;
        await new Promise<void>((ok, ko) => {
          const end = () => {
            signal?.removeEventListener("abort", cancel);
            ok();
          };
          const cancel = () => {
            this.suspended.set(url, (this.suspended.get(url) ?? []).filter((f) => f !== end));
            this.note("readCanceled", url);
            ko(signal!.reason);
          };
          this.suspended.set(url, [...(this.suspended.get(url) ?? []), end]);
          signal?.addEventListener("abort", cancel, { once: true });
        });
      };
      this.readPageInvisible = async (url, { signal, changeHost, ...l }) => {
        this.note("readPageInvisible", url, { ...l });
        await wait(url, signal);
        if (l.profile !== null && reading.deny?.includes(l.profile)) throw new ProfileDenied(l.profile);
        const finalUrl = reading.redirects?.[url] ?? url;
        // Like the real bridge: a redirect to another host waits for `changeHost` before going out.
        const host = new URL(finalUrl).hostname;
        if (changeHost && host !== new URL(url).hostname) {
          this.note("changeHost", host);
          await changeHost(host);
        }
        const p = reading.pages.find((x) => x.url === finalUrl);
        return p ? structuredClone(p) : { url: finalUrl, title: "", text: "", links: [] };
      };
      this.readHtmlInvisible = async (url, { signal, ...l }) => {
        this.note("readHtmlInvisible", url, { ...l });
        await wait(url, signal);
        return { url, html: reading.html?.[url] ?? "" };
      };
    }
    const searching = o.search;
    for (const u of searching?.failing ?? []) this.failing.add(u);
    for (const u of searching?.hanging ?? []) this.hanging.add(u);
    if (searching)
      this.search = {
        open: async (window, target, reuse) => {
          this.note("search.open", window, target, reuse);
          if (window !== undefined && searching.privateWindows?.includes(window)) throw new Error("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
          const url = "query" in target ? `https://moteur.test/?q=${encodeURIComponent(target.query)}` : target.url;
          const old = reuse ? this.tabs.find((x) => x.id === reuse) : undefined;
          if (reuse && !old) throw new TabNotFound(reuse);
          if (old) {
            old.url = url;
            return { ...old };
          }
          const tab = { id: `search-${++this.counter}`, title: url, url, space: "perso" };
          this.tabs.push(tab);
          this.active = tab.id;
          return { ...tab };
        },
        openBackground: async (searchTabId, url) => {
          this.note("search.openBackground", searchTabId, url);
          const tab = { id: `bg-${++this.counter}`, title: url, url, space: this.find(searchTabId).space };
          this.tabs.push(tab);
          return { ...tab };
        },
        close: async (tabId) => {
          this.note("search.close", tabId);
          this.closeTab(tabId);
        },
        band: async (tabId, band) => this.note("search.band", tabId, band),
      };
    const widgetData = o.widgetData;
    if (widgetData !== undefined) {
      this.askWidgetData = async (d) => {
        this.note("askWidgetData", { ...d });
        return widgetData;
      };
    }
    const address = o.address;
    if (address !== undefined) {
      this.askAddress = (d, window, signal) => {
        this.note("askAddress", { ...d }, window);
        if (signal) this.addressSignals.push(signal);
        if (address === "later") return new Promise((ok) => setTimeout(() => ok(true), 400));
        if (address !== "wait") return Promise.resolve(address);
        return new Promise((ok) => signal?.addEventListener("abort", () => ok(false), { once: true }));
      };
    }
    const giveGrant = o.grantDev;
    if (giveGrant) {
      this.askDevTools = async (tab, d) => {
        this.note("askDevTools", { ...tab }, d);
        return [...giveGrant];
      };
    }
  }

  /** Tab fields changed (for example the `empreinte` of a site app whose site.json was rewritten). */
  editTab(id: string, changes: Partial<TabInfo>): void {
    const o = this.tabs.find((x) => x.id === id);
    if (o) Object.assign(o, changes);
  }

  /** The tab (or site app window) closes. */
  closeTab(id: string): void {
    const i = this.tabs.findIndex((x) => x.id === id);
    if (i >= 0) this.tabs.splice(i, 1);
  }

  /** Like the real browser: the host is a domain of the open app or one of their subdomains. */
  siteUrlAllowed(site: string, url: string): boolean {
    this.note("siteUrlAllowed", site, url);
    if (!this.tabs.some((x) => x.site === site)) return false;
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return false;
      host = u.hostname;
    } catch {
      return false;
    }
    return (this.sites[site] ?? []).some((d) => host === d || host.endsWith(`.${d}`));
  }

  /** Lets the suspended reads of this URL finish; returns their number. */
  release(url: string): number {
    const list = this.suspended.get(url) ?? [];
    this.suspended.delete(url);
    for (const end of list) end();
    return list.length;
  }

  private dev(): FakeDevTools {
    if (!this.devTools) throw new Error("PontFactice créé sans outilsDev");
    return this.devTools;
  }

  setConsole(id: string, messages: MessageConsole[]): void {
    this.dev().consoles.set(id, messages);
  }

  setNetwork(id: string, requests: NetworkRequest[]): void {
    this.dev().networks.set(id, requests);
  }

  /** The user opens their dev tools on the tab. */
  occupy(id: string): void {
    this.dev().busy.add(id);
  }

  /** The tab moves into a private space (named `espace` if given). */
  makePrivate(id: string, space?: string): void {
    const o = this.tabs.find((x) => x.id === id);
    if (o && space !== undefined) o.space = space;
    this.privateTabs.add(id);
  }

  isPrivate(id: string): boolean {
    return this.privateTabs.has(id);
  }

  activePrivateTab(): boolean {
    return this.active !== null && this.privateTabs.has(this.active);
  }

  /** The next snapshot has one more « Fuite » object. */
  growHeap(): void {
    this.dev().heapObjects += 1;
  }

  private note(method: string, ...args: unknown[]) {
    this.calls.push({ method: method, args });
  }

  private find(id: string): TabInfo {
    const o = this.tabs.find((x) => x.id === id);
    if (!o) throw new TabNotFound(id);
    if (this.privateTabs.has(id)) throw new PrivateTab(id);
    return o;
  }

  async activeTab() {
    this.note("activeTab");
    return this.tabs.find((x) => x.id === this.active && !this.privateTabs.has(x.id)) ?? null;
  }

  async listTabs() {
    this.note("listTabs");
    return this.tabs.filter((x) => !this.privateTabs.has(x.id)).map((x) => ({ ...x }));
  }

  async readText(id: string, o?: { capture?: boolean; expect?: string }) {
    if (o) this.note("readText", id, o);
    else this.note("readText", id);
    const tab = this.find(id);
    if (o?.expect !== undefined && originOf(o.expect) !== originOf(tab.url)) throw new SiteChanged(id);
    if (this.hanging.has(tab.url)) await new Promise(() => {});
    if (this.failing.has(tab.url)) throw new Error("Page illisible");
    if (this.siteChanges > 0) {
      this.siteChanges--;
      throw new SiteChanged(id);
    }
    const seq = this.linkSequence;
    const links = seq?.length ? (seq.length > 1 ? seq.shift()! : seq[0]!) : [{ text: "Annonce", url: "https://exemple.fr/a" }];
    return { text: `Texte de ${tab.title} (${tab.url})`, links, ...(o?.capture ? this.captures.get(tab.url) : {}) };
  }

  async openTab(url: string, space?: string) {
    this.note("openTab", url, space);
    const o = { id: `agent-${++this.counter}`, title: url, url, space: space ?? "perso" };
    this.tabs.push(o);
    this.active = o.id;
    return { ...o };
  }

  async navigate(id: string, url: string): Promise<void | "pending"> {
    this.note("navigate", id, url);
    const o = this.find(id);
    if (o.site !== undefined && this.pendingSites.has(o.site)) return "pending";
    o.url = url;
  }

  async capture(id: string, o?: { expect?: string }) {
    this.note("capture", id);
    if (o?.expect !== undefined && originOf(o.expect) !== originOf(this.find(id).url)) throw new SiteChanged(id);
    this.find(id);
    return PNG;
  }

  async askPermission(o: TabInfo, _signal?: AbortSignal) {
    this.note("askPermission", o.id);
    return this.allow;
  }
}
