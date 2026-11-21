import {
  type ChangeHost,
  TabNotFound,
  PrivateTab,
  DevToolsBusy,
  SiteChanged,
  ProfileDenied,
  type DevRight,
  type BrowserHistory,
  type TabInfo,
  type PageLink,
  type PageReadOptions,
  type BrowserDevTools,
  type DevToolsOwner,
  type ReadPage,
  type BrowserBridge,
  type Band,
} from "../../../packages/kernel/src/index.ts";
import type { History } from "../core/history.ts";
import type { Rpc } from "../shared/rpc.ts";

/** The kernel's browser bridge, answered by Firefox over JSON-RPC. Only the private-tab mirror lives here. */
export class RemoteBridge implements BrowserBridge {
  private privateTabs = new Set<string>();
  private activePrivate = false;

  /** The agent's history tools; absent, it has none. */
  readonly history?: BrowserHistory;

  readonly bookmarks: NonNullable<BrowserBridge["bookmarks"]> = {
    find: ({ query, limit }) => this.rpc.request("bookmarks.search", [query, limit]),
  };

  constructor(
    private readonly rpc: Rpc,
    h?: Pick<History, "searchForAgent" | "keptText">,
    /** Answered from the host's mirror of the open site apps (synchronous in BrowserBridge). */
    private readonly siteAllowed: (site: string, url: string) => boolean = () => false,
  ) {
    if (h)
      this.history = {
        // The kernel checked the ISO dates and bounded the limit.
        find: async ({ query: request, since: from, until, limit }) =>
          h.searchForAgent({
            query: request,
            limit: limit,
            ...(from !== undefined ? { since: new Date(from) } : {}),
            ...(until !== undefined ? { until: new Date(until) } : {}),
          }),
        read: async (url) => h.keptText(url),
      };
  }

  setPrivate(m: { privateTabs: string[]; activePrivate: boolean }): void {
    this.privateTabs = new Set(m.privateTabs);
    this.activePrivate = m.activePrivate;
  }

  private async call<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    try {
      return await this.rpc.request<T>(method, params, signal);
    } catch (e) {
      // The kernel expects an aborted read to reject with the signal's own reason.
      if (signal?.aborted) throw signal.reason;
      const x = e as Error & { id?: string; profile?: string };
      if (x.name === "TabNotFound") throw new TabNotFound(x.id!);
      if (x.name === "PrivateTab") throw new PrivateTab(x.id!);
      if (x.name === "ProfileDenied") throw new ProfileDenied(x.profile!);
      if (x.name === "DevToolsBusy") throw new DevToolsBusy();
      if (x.name === "SiteChanged") throw new SiteChanged(x.id!);
      throw e;
    }
  }

  activeTab = () => this.call<TabInfo | null>("activeTab", []);
  listTabs = () => this.call<TabInfo[]>("listTabs", []);
  readText = (id: string, o?: { capture?: boolean; expect?: string }) =>
    this.call<{ text: string; selection?: string; links?: PageLink[] }>("readText", o?.capture || o?.expect !== undefined ? [id, o] : [id]);
  openTab = (url: string, space?: string) => this.call<TabInfo>("openTab", space === undefined ? [url] : [url, space]);
  navigate = (id: string, url: string) => this.call<void | "pending">("navigate", [id, url]);
  capture = async (id: string, o?: { expect?: string }) => Buffer.from(await this.call<string>("capture", o ? [id, o] : [id]), "base64");
  // Taken down (signal) when a new conversation starts: refused.
  askPermission = (o: TabInfo, signal?: AbortSignal) =>
    this.call<boolean>("askPermission", [o], signal).catch((e) => {
      if (signal?.aborted) return false;
      throw e;
    });
  // Taken down (signal) when a new conversation starts: no rights.
  askDevTools = (o: TabInfo, d: { rights: DevRight[]; reason: string; agent: string }, signal?: AbortSignal) =>
    this.call<DevRight[]>("askDevTools", [o, d], signal).catch((e) => {
      if (signal?.aborted) return [];
      throw e;
    });
  // The kernel keeps the grant for the conversation and takes the card down (signal) when a new one starts: refused then.
  askWidgetData = (o: { id: string; name: string; agent: string; kind?: "action" | "site" }, signal?: AbortSignal) =>
    this.call<boolean>("askWidgetData", [o], signal).catch((e) => {
      if (signal?.aborted) return false;
      throw e;
    });
  // Taken down (signal) when a new conversation starts: refused.
  askAddress = (o: { url: string; reason: string; agent: string; danger?: string }, window: string | undefined, signal?: AbortSignal) =>
    this.call<boolean>("askAddress", [o, window], signal).catch((e) => {
      if (signal?.aborted) return false;
      throw e;
    });
  readonly search: NonNullable<BrowserBridge["search"]> = {
    open: (window, target, reuse) => this.call("search.open", [window, target, reuse]),
    openBackground: (searchTabId, url) => this.call("search.openBackground", [searchTabId, url]),
    close: (tabId) => this.call("search.close", [tabId]),
    band: (tabId: string, band: Band | null) => this.call("search.band", [tabId, band]),
  };
  readonly recaps: NonNullable<BrowserBridge["recaps"]> = {
    open: (window, id, title) => this.call("recaps.open", [window, id, title]),
    close: (id) => this.call("recaps.close", [id]),
    active: (window) => this.call("recaps.active", [window]),
    visible: () => this.call("recaps.visible", []),
  };
  siteUrlAllowed = (site: string, url: string) => this.siteAllowed(site, url);
  isPrivate = (id: string) => this.privateTabs.has(id);
  activePrivateTab = () => this.activePrivate;

  /**
   * The tab dev tools, run by Firefox (chrome/store/devtools.ts). Only an owner's are usable: Firefox keeps its
   * attachments across kernel starts, a new owner revokes the previous one.
   */
  readonly devTools: BrowserDevTools = {
    // Without an owner's token Firefox refuses every call.
    ...this.devToolsFor(Promise.resolve("")),
    owner: () => {
      const token = this.call<{ token: string }>("devtools.owner", []).then((r) => r.token);
      token.catch(() => {});
      return { ...this.devToolsFor(token), release: () => void token.then((t) => this.rpc.notify("devtools.release", [t]), () => {}) };
    },
  };

  /** Each method sends its arguments with the owner's token; a trailing AbortSignal cancels the request instead. */
  private devToolsFor(token: Promise<string>): Omit<DevToolsOwner, "release"> {
    const f =
      (method: keyof BrowserDevTools) =>
      async (...a: unknown[]): Promise<any> => {
        const signal = a.at(-1) instanceof AbortSignal ? (a.pop() as AbortSignal) : undefined;
        return this.call("devtools.call", [await token, method, a], signal);
      };
    return {
      attach: f("attach"),
      detach: f("detach"),
      console: f("console"),
      network: f("network"),
      body: f("body"),
      profile: f("profile"),
      memorySnapshot: f("memorySnapshot"),
      run: f("run"),
      reload: f("reload"),
    };
  }

  /** The waits of the paced reads in progress, by the id Firefox echoes back (`read.changeHost`). */
  private readonly pacedReads = new Map<string, ChangeHost>();

  readPageInvisible = async (url: string, o: PageReadOptions): Promise<ReadPage> => {
    const { signal, changeHost, ...options } = o;
    if (!changeHost) return this.call<ReadPage>("readPageInvisible", [url, options], signal);
    const id = crypto.randomUUID();
    this.pacedReads.set(id, changeHost);
    try {
      return await this.call<ReadPage>("readPageInvisible", [url, { ...options, pacedId: id }], signal);
    } finally {
      this.pacedReads.delete(id);
    }
  };

  /** Firefox asks to wait for another site's turn: answered when the kernel's Pacing lets the read go. */
  changeHost(reading: string, host: string): Promise<void> {
    const f = this.pacedReads.get(reading);
    return f ? f(host) : Promise.reject(new Error("Lecture inconnue"));
  }

  readHtmlInvisible = (url: string, o: { localAddresses?: boolean; signal?: AbortSignal }) => {
    const { signal, ...options } = o;
    return this.call<{ url: string; html: string }>("readHtmlInvisible", [url, options], signal);
  };
}
