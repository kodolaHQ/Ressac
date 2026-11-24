import {
  type ChangeHost,
  TabNotFound,
  PrivateTab,
  DevToolsBusy,
  SiteChanged,
  LoadRefused,
  ProfileDenied,
  type DevRight,
  type BrowserHistory,
  type TabInfo,
  type TabRead,
  type PageReadOptions,
  type BrowserDevTools,
  type DevToolsOwner,
  type ReadPage,
  type BrowserBridge,
  type Band,
  type LoadOptions,
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
    /** The kernel's notice for a conversation (fill_field blocked): the host keeps it for the window's panel. */
    private readonly lockNotice: (o: { text: string }, window: string | undefined) => void = () => {},
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
      const x = e as Error & { id?: string; profile?: string; url?: string };
      if (x.name === "TabNotFound") throw new TabNotFound(x.id!);
      if (x.name === "PrivateTab") throw new PrivateTab(x.id!);
      if (x.name === "ProfileDenied") throw new ProfileDenied(x.profile!);
      if (x.name === "DevToolsBusy") throw new DevToolsBusy();
      if (x.name === "SiteChanged") throw new SiteChanged(x.id!);
      if (x.name === "LoadRefused") throw new LoadRefused(String(x.url));
      throw e;
    }
  }

  activeTab = () => this.call<TabInfo | null>("activeTab", []);
  listTabs = () => this.call<TabInfo[]>("listTabs", []);
  readText = (id: string, o?: { capture?: boolean; expect?: string }) =>
    this.call<TabRead>("readText", o?.capture || o?.expect !== undefined ? [id, o] : [id]);
  // `o` sent only when it restricts: Firefox reads a missing one as no restriction.
  openTab = (url: string, space?: string, o?: LoadOptions) =>
    this.call<TabInfo>("openTab", o?.allow != null ? [url, space, o] : space === undefined ? [url] : [url, space]);
  navigate = (id: string, url: string, o?: LoadOptions) => this.call<void | "pending">("navigate", o?.allow != null ? [id, url, o] : [id, url]);
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
  /** A masking card taken down (signal: new conversation, call dropped) answers no, as a refusal would. */
  private card<T>(method: string, params: unknown[], no: T, signal?: AbortSignal): Promise<T> {
    return this.call<T>(method, params, signal).catch((e) => {
      if (signal?.aborted) return no;
      throw e;
    });
  }
  askReveal: NonNullable<BrowserBridge["askReveal"]> = (o, window, signal) => this.card("askReveal", [o, window], false, signal);
  askLabelAlert: NonNullable<BrowserBridge["askLabelAlert"]> = (o, window, signal) => this.card("askLabelAlert", [o, window], false, signal);
  /** The usernames of the fill cards up, by reference: they never go in a card's request. */
  private readonly pendingLogins = new Map<string, { window: string | undefined; logins: string[] }>();
  /** The passport values a fill card offers, by the kernel's choice ref (ruling F10): the card gets `ref` and `shown` only. */
  private readonly pendingPassport = new Map<string, { window: string | undefined; value: string }>();
  askFill: NonNullable<BrowserBridge["askFill"]> = (o, window, signal) => {
    const { logins, rows, ...rest } = o;
    const choices = rows?.flatMap((r) => r.choices ?? []) ?? [];
    for (const c of choices) this.pendingPassport.set(c.ref, { window, value: c.value });
    const card = rows ? { ...rest, rows: rows.map(({ choices, ...r }) => (choices ? { ...r, choices: choices.map(({ ref, shown }) => ({ ref, shown })) } : r)) } : rest;
    const ref = logins?.length ? crypto.randomUUID() : undefined;
    if (ref) this.pendingLogins.set(ref, { window, logins: logins! });
    return this.card("askFill", [ref ? { ...card, loginCount: logins!.length, loginsRef: ref } : card, window], { yes: false }, signal).finally(() => {
      if (ref) this.pendingLogins.delete(ref);
      for (const c of choices) this.pendingPassport.delete(c.ref);
    });
  };
  /** A pending fill card's passport value, for « Voir » in its own window only (none when the kernel named no window). */
  passportFor(ref: unknown, window: unknown): string | null {
    const e = typeof ref === "string" ? this.pendingPassport.get(ref) : undefined;
    return e && e.window !== undefined && e.window === window ? e.value : null;
  }
  /** A pending fill card's usernames, for « Voir » in its own window only (none when the kernel named no window). */
  loginsFor(ref: unknown, window: unknown): string[] | null {
    const e = typeof ref === "string" ? this.pendingLogins.get(ref) : undefined;
    return e && e.window !== undefined && e.window === window ? [...e.logins] : null;
  }
  /** Firefox seals and writes (chrome/agent/fill.ts); a saved login's password never comes through here. */
  readonly fill: NonNullable<BrowserBridge["fill"]> = {
    prepare: (tab, handle) => this.call("fill.prepare", [tab, handle]),
    commit: (seal, v, origin) => this.call("fill.commit", [seal, v, origin]),
  };
  askDevUnlock: NonNullable<BrowserBridge["askDevUnlock"]> = (o, d, signal) => this.card("askDevUnlock", [o, d], false, signal);
  askLockNotice = (o: { text: string }, window: string | undefined) => this.lockNotice(o, window);
  readonly search: NonNullable<BrowserBridge["search"]> = {
    open: (window, target, reuse, o) => this.call("search.open", o?.allow != null ? [window, target, reuse, o] : [window, target, reuse]),
    openBackground: (searchTabId, url, o) => this.call("search.openBackground", o?.allow != null ? [searchTabId, url, o] : [searchTabId, url]),
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
