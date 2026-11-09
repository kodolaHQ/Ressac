import type { DevRight } from "../access/policy.js";
import type { CpuProfile } from "../devtools/summaries.js";
import type { ReadPage } from "../workflows/protocole.js";
import {
  TabNotFound,
  PrivateTab,
  DevToolsBusy,
  ProfileDenied,
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

  private check(id: string): void {
    this.find(id);
    if (this.busy.has(id)) throw new DevToolsBusy();
  }

  async attach(id: string) {
    this.note("attacher", id);
    this.check(id);
  }

  async detach(id: string) {
    this.note("detacher", id);
  }

  async console(id: string) {
    this.note("console", id);
    this.check(id);
    return [...(this.consoles.get(id) ?? [])];
  }

  async network(id: string) {
    this.note("reseau", id);
    this.check(id);
    return [...(this.networks.get(id) ?? [])];
  }

  async body(id: string, request: string) {
    this.note("corps", id, request);
    this.check(id);
    return { body: `Corps de ${request}`, base64: false };
  }

  async profile(id: string, o: { durationMs?: number; reload?: boolean }, signal: AbortSignal) {
    this.note("profiler", id, o);
    this.check(id);
    if (this.block) return pending<{ profile: CpuProfile; metrics: Record<string, number> }>(signal);
    return { profile: PROFILE, metrics: { Nodes: 42 } };
  }

  async memorySnapshot(id: string, signal: AbortSignal) {
    this.note("instantaneMemoire", id);
    this.check(id);
    if (this.block) return pending<string>(signal);
    return heap(this.heapObjects);
  }

  async run(id: string, code: string, _signal: AbortSignal): Promise<JsResult> {
    this.note("executer", id, code);
    this.check(id);
    if (code.startsWith("throw ")) return { exception: `${code.slice(6)}\n    at <anonymous>:1:1` };
    return { value: JSON.stringify({ code }) };
  }

  async reload(id: string, noCache: boolean) {
    this.note("recharger", id, noCache);
    this.check(id);
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
  readPageInvisible?: (url: string, o: PageReadOptions) => Promise<ReadPage>;
  readHtmlInvisible?: (url: string, o: { localAddresses?: boolean; signal?: AbortSignal }) => Promise<{ url: string; html: string }>;
  /** Suspended reads in progress, by URL: `relacher` lets them finish. */
  private readonly suspended = new Map<string, (() => void)[]>();
  askWidgetData?: (o: { id: string; name: string; agent: string; kind?: "action" | "site" }, signal?: AbortSignal) => Promise<boolean>;
  /** Domains of each site app (id → domains), for `adresseSitePermise`. */
  private readonly sites: Record<string, string[]>;
  /** Site apps whose tweaks card is shown: navigating answers « pending ». */
  private readonly pendingSites: Set<string>;
  askDevTools?: (o: TabInfo, d: { rights: DevRight[]; reason: string; agent: string }, signal?: AbortSignal) => Promise<DevRight[]>;

  /**
   * `outilsDev` provides the simulated dev tools; `accorderDev` also provides the consent card,
   * which answers these rights. `bloquer`: profiles and snapshots only end on abandonment. `historique` provides
   * the history: `chercher` returns `resultats` (at most `limite`), `lire` the page of `textes` at this URL, and
   * `erreur`, if given, makes both fail. `lecture` provides `lirePageInvisible`: the page of `pages` at this URL
   * (otherwise an empty page), `lireHtmlInvisible`: the HTML of `html` at this URL (otherwise ""), and ProfileDenied for a profile of `refuser`. A read (page or HTML) of a URL of `suspendues` only
   * ends at `relacher(url)`, or at the abandonment of its `signal`: it is then noted « lectureAnnulee » and rejected with
   * the signal's reason, like the real bridge that closes its window. `redirections` simulates a redirect:
   * the requested URL leads to the associated URL, and that page is the one returned; to another host, with
   * `changerHote`, it waits for it first (noted « changerHote »). `donneesWidget` provides the
   * « donnees-widget » card (and that of a site app, `genre: "site"`), which answers this value. `sites`: the domains
   * of each open site app (`site:<id>` tabs with `site` set), for `adresseSitePermise`.
   */
  constructor(
    tabs: TabInfo[],
    o: {
      active: string | null;
      allow: boolean;
      devTools?: boolean;
      grantDev?: DevRight[];
      block?: boolean;
      history?: { results: HistoryResult[]; texts?: KeptPage[]; error?: string };
      read?: { pages: ReadPage[]; html?: Record<string, string>; deny?: string[]; redirects?: Record<string, string>; suspended?: string[] };
      widgetData?: boolean;
      sites?: Record<string, string[]>;
      pendingSites?: string[];
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
          this.note("chercherHistorique", { ...q });
          fail();
          return h.results.slice(0, q.limit).map((r) => ({ ...r }));
        },
        read: async (url) => {
          this.note("lireHistorique", url);
          fail();
          const p = h.texts?.find((x) => x.url === url);
          return p ? { ...p } : null;
        },
      };
    }
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
            this.note("lectureAnnulee", url);
            ko(signal!.reason);
          };
          this.suspended.set(url, [...(this.suspended.get(url) ?? []), end]);
          signal?.addEventListener("abort", cancel, { once: true });
        });
      };
      this.readPageInvisible = async (url, { signal, changeHost: changeHost, ...l }) => {
        this.note("lirePageInvisible", url, { ...l });
        await wait(url, signal);
        if (l.profile !== null && reading.deny?.includes(l.profile)) throw new ProfileDenied(l.profile);
        const finalUrl = reading.redirects?.[url] ?? url;
        // Like the real bridge: a redirect to another host waits for `changerHote` before going out.
        const host = new URL(finalUrl).hostname;
        if (changeHost && host !== new URL(url).hostname) {
          this.note("changerHote", host);
          await changeHost(host);
        }
        const p = reading.pages.find((x) => x.url === finalUrl);
        return p ? structuredClone(p) : { url: finalUrl, title: "", text: "", links: [] };
      };
      this.readHtmlInvisible = async (url, { signal, ...l }) => {
        this.note("lireHtmlInvisible", url, { ...l });
        await wait(url, signal);
        return { url, html: reading.html?.[url] ?? "" };
      };
    }
    const widgetData = o.widgetData;
    if (widgetData !== undefined) {
      this.askWidgetData = async (d) => {
        this.note("demanderDonneesWidget", { ...d });
        return widgetData;
      };
    }
    const giveGrant = o.grantDev;
    if (giveGrant) {
      this.askDevTools = async (tab, d) => {
        this.note("demanderOutilsDev", { ...tab }, d);
        return [...giveGrant];
      };
    }
  }

  /** Tab fields changed (for example the `empreinte` of a site app whose site.json was rewritten). */
  editTab(id: string, champs: Partial<TabInfo>): void {
    const o = this.tabs.find((x) => x.id === id);
    if (o) Object.assign(o, champs);
  }

  /** The tab (or site app window) closes. */
  closeTab(id: string): void {
    const i = this.tabs.findIndex((x) => x.id === id);
    if (i >= 0) this.tabs.splice(i, 1);
  }

  /** Like the real browser: the host is a domain of the open app or one of their subdomains. */
  siteUrlAllowed(site: string, url: string): boolean {
    this.note("adresseSitePermise", site, url);
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
    this.note("ongletActif");
    return this.tabs.find((x) => x.id === this.active && !this.privateTabs.has(x.id)) ?? null;
  }

  async listTabs() {
    this.note("listerOnglets");
    return this.tabs.filter((x) => !this.privateTabs.has(x.id)).map((x) => ({ ...x }));
  }

  async readText(id: string) {
    this.note("lireTexte", id);
    const o = this.find(id);
    return { text: `Texte de ${o.title} (${o.url})` };
  }

  async openTab(url: string, space?: string) {
    this.note("ouvrirOnglet", url, space);
    const o = { id: `agent-${++this.counter}`, title: url, url, space: space ?? "perso" };
    this.tabs.push(o);
    this.active = o.id;
    return { ...o };
  }

  async navigate(id: string, url: string): Promise<void | "pending"> {
    this.note("naviguer", id, url);
    const o = this.find(id);
    if (o.site !== undefined && this.pendingSites.has(o.site)) return "pending";
    o.url = url;
  }

  async capture(id: string) {
    this.note("capturer", id);
    this.find(id);
    return PNG;
  }

  async askPermission(o: TabInfo) {
    this.note("demanderAutorisation", o.id);
    return this.allow;
  }
}
