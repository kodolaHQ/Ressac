import { navigationOutsideSite, TabNotFound, PrivateTab, type DevRight, type TabInfo, type PageReadOptions } from "../shims/kernel";
import type { BrowserState, WindowId, Tab, Band } from "../../shared/model";
import { privateTab, WORKFLOW_PREFIX, AGENT_PROFILE } from "../../shared/model";
import { ENGINES } from "../../core/url";
import { boundLinks, policyChanges, tabInfos, activeTabOf, appTab, siteTab, originOf, SITE_PREFIX, resolveSpace } from "../../core/agent/bridge";
import type { Handler } from "../../shared/rpc";
import type { AgentApps } from "../store/apps";
import type { DevTools } from "../store/devtools";
import type { SiteApps } from "../store/sites";
import type { Store } from "../store/store";
import type { WindowRegistry } from "../store/windows";
import type { AgentHost } from "./host";
import { readHtml, readPage } from "./invisible";
import type { Questions } from "./questions";

const XHTML = "http://www.w3.org/1999/xhtml";
/** An agent app window seen as a tab: `app:<dossier>`. */
const APP_PREFIX = "app:";
/** As the page actor. */
const TEXT_MAX = 100_000;

const internal = (o: Tab) => o.url.startsWith("webaios:");

/** What the host's bridge mirrors for its two synchronous methods (estPrive, ongletActifPrive). */
function privateMirror(state: BrowserState, windows: WindowRegistry): { privateTabs: string[]; activePrivate: boolean } {
  const isPrivate = (o: Tab | undefined) => !!o && !internal(o) && privateTab(state, o);
  const f = state.windows.find((x) => x.id === windows.active());
  const active = f && f.active[f.activeSpace];
  return { privateTabs: Object.values(state.tabs).filter(isPrivate).map((o) => o.id), activePrivate: isPrivate(active ? state.tabs[active] : undefined) };
}

/** Each window's active tab URL, for `open_workflow`: only a workflow page, never a web URL (null otherwise). */
function activeWorkflows(state: BrowserState): Record<WindowId, string | null> {
  const r: Record<WindowId, string | null> = {};
  for (const f of state.windows) {
    const url = state.tabs[f.active[f.activeSpace] ?? ""]?.url;
    r[f.id] = url?.startsWith(WORKFLOW_PREFIX) ? url : null;
  }
  return r;
}

/** The kernel's BrowserBridge, answered on the store and the windows' tabs. */
export function bridgeHandlers(
  store: Store,
  questions: Questions,
  windows: WindowRegistry,
  devtools: DevTools,
  host: () => AgentHost,
  sites: Pick<SiteApps, "forAgent" | "viewFor" | "navigateForAgent">,
  apps: Pick<AgentApps, "forAgent" | "viewFor" | "navigateForAgent">,
): Record<string, Handler> {
  /** The open window that holds the tab. */
  const windowOf = (id: string) => {
    const m = windows.get(store.state.tabs[id]?.windowId ?? "");
    if (!m) throw new Error("Aucune fenêtre ouverte");
    return m;
  };
  /** Throws PrivateTab for a tab in a private space: a call that crosses the switch to private reads nothing. */
  const tab = (id: string): Tab => {
    const state = store.state;
    const o = state.tabs[id];
    if (!o) throw new TabNotFound(id);
    if (privateTab(state, o)) throw new PrivateTab(id);
    return o;
  };
  /** A tab whose page can be read: Firefox's crash or error page is not the page. */
  const loadedTab = (id: string): Tab => {
    const o = tab(id);
    if (o.crashed) throw new Error("La page a planté : rechargez-la.");
    if (o.error) throw new Error("La page n'a pas pu être chargée.");
    return o;
  };
  /**
   * Reads the tab's page (its XUL tab created in the background and loaded if needed), then checks the tab did not
   * become private nor go to another origin meanwhile: access was checked on the URL from before.
   */
  const outsidePrivate = async <T>(id: string, read: (browser: any) => Promise<T>): Promise<T> => {
    const before = loadedTab(id);
    const browser = await windowOf(id).controller.ensure(id);
    loadedTab(id); // crashed or failed while it loaded
    const r = await read(browser);
    const origin = originOf(before.url);
    if (originOf(tab(id).url) !== origin || originOf(browser.currentURI.spec) !== origin)
      throw new Error("L'onglet a changé de site pendant la lecture : rien n'est rendu.");
    return r;
  };
  /** The view of a site app window (`site:<id>`) or of an agent app window (`app:<dossier>`); null for any other id. */
  const windowView = (id: string) =>
    id.startsWith(SITE_PREFIX) ? sites.viewFor(id.slice(SITE_PREFIX.length)) : id.startsWith(APP_PREFIX) ? apps.viewFor(id.slice(APP_PREFIX.length)) : null;
  /**
   * Reads the view of a site app or agent app window: never a site app's bar, home or card, nor an app's badge or
   * overlay. Closed, before or during the read: TabNotFound (a clean answer). Undefined for
   * any other id.
   */
  const onSiteView = <T>(id: string, read: (browser: any, win: Window) => Promise<T>): Promise<T> | undefined => {
    const view = windowView(id);
    if (view === null) return undefined;
    if (!view) return Promise.reject(new TabNotFound(id));
    return read(view.browser, view.window).catch((e) => {
      if (windowView(id)?.browser !== view.browser) throw new TabNotFound(id);
      throw e;
    });
  };
  const getText = async (browser: any) => {
    const r = await browser.browsingContext.currentWindowGlobal.getActor("WebAiOsPage").sendQuery("getText");
    // The child runs in a web process: its answer is not trusted.
    const text = String(r?.text ?? "").slice(0, TEXT_MAX);
    const selection = String(r?.selection ?? "").slice(0, TEXT_MAX);
    const links = boundLinks(r?.links);
    return selection ? { text: text, selection, links } : { text: text, links };
  };
  const snapshot = async (browser: any, win: Window) => {
    const bitmap = await browser.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    try {
      const canvas = win.document.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    } finally {
      bitmap.close();
    }
  };

  /** The agent's demos open in the foreground, marked ✦. With no window open, in the kept one. */
  const openTabIn = (window: WindowId | undefined, url: string, space?: string, extra: { profile?: string; background?: boolean } = {}): TabInfo => {
    const state = store.state;
    const f = state.windows.find((x) => x.id === (window ?? windows.active())) ?? state.windows[0];
    if (!f) throw new Error("Aucune fenêtre ouverte");
    const spaceId = resolveSpace(state, f, space);
    if (state.spaces.find((e) => e.id === spaceId)?.private ?? true) throw new Error("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
    const id = crypto.randomUUID();
    const { background, ...fields } = extra;
    store.dispatch({ type: "openTab", windowId: f.id, url, spaceId: spaceId, activate: !background, openedByAgent: true, ...fields }, () => id);
    if (!store.state.tabs[id]) throw new Error(`Impossible d'ouvrir ${url}`);
    if (!background) store.dispatch({ type: "activateTab", id }); // also switches to its space
    return tabInfos(store.state).find((o) => o.id === id)!;
  };

  const openTab = ([url, space]: [string, string?]): TabInfo => openTabIn(undefined, url, space);

  return {
    // Decision 3: no window open (the last one kept), no active tab.
    activeTab: ([win]: [WindowId?] = []) => activeTabOf(store.state, win ?? windows.active()),
    listTabs: () => [...tabInfos(store.state), ...apps.forAgent().map(appTab), ...sites.forAgent().map(siteTab)],
    openTab: openTab,
    navigate: async ([id, url]: [string, string]) => {
      if (id.startsWith(SITE_PREFIX)) {
        if (!sites.viewFor(id.slice(SITE_PREFIX.length))) throw new TabNotFound(id);
        // Never a tab instead: off the app's domains nothing loads (the kernel checked it already).
        const r = sites.navigateForAgent(id.slice(SITE_PREFIX.length), url);
        if (r === "refused") throw new Error(navigationOutsideSite(url));
        return r === "pending" ? r : undefined;
      }
      if (id.startsWith(APP_PREFIX)) {
        const folder = id.slice(APP_PREFIX.length);
        if (!apps.viewFor(folder)) throw new TabNotFound(id);
        // The app window never leaves its origin: elsewhere, a tab of the main window.
        if (!apps.navigateForAgent(folder, url)) openTab([url]);
        return;
      }
      tab(id);
      await windowOf(id).controller.navigateForAgentLoaded(id, url);
    },
    // The agent's search tab, in its own login profile; `reuse`: that tab goes to the new address instead.
    "search.open": async ([win, target, reuse]: [WindowId | undefined, { query: string } | { url: string }, string?]) => {
      const template = Services.env.get("WEBAIOS_TEST_SEARCH_URL") || ENGINES[store.state.settings.engine];
      const url = "query" in target ? template.replace("%s", encodeURIComponent(target.query)) : target.url;
      const engineOrigin = new URL(template.replace("%s", "")).origin;
      if (reuse !== undefined && store.state.tabs[reuse]) {
        tab(reuse);
        await windowOf(reuse).controller.navigateForAgentLoaded(reuse, url);
        // Closed during the load: nothing to return.
        const info = tabInfos(store.state).find((o) => o.id === reuse);
        if (!info) throw new TabNotFound(reuse);
        return { ...info, engineOrigin };
      }
      return { ...openTabIn(win, url, undefined, { profile: AGENT_PROFILE }), engineOrigin };
    },
    "search.openBackground": ([searchTab, url]: [string, string]) => {
      const t = tab(searchTab);
      return openTabIn(t.windowId, url, t.spaceId, { profile: AGENT_PROFILE, background: true });
    },
    "search.close": ([id]: [string]) => void store.dispatch({ type: "closeTab", id }),
    // The band of the search tab: the window draws it (window/search-band.ts) from the tab's state.
    "search.band": ([id, band]: [string, Band | null]) => void store.dispatch({ type: "setAgentSearch", id, band }),
    readText: ([id]: [string]) => onSiteView(id, getText) ?? outsidePrivate(id, getText),
    capture: ([id]: [string]) => onSiteView(id, snapshot) ?? outsidePrivate(id, (browser) => snapshot(browser, windowOf(id).window)),
    // « L'agent veut lire l'onglet … » in the active window; refused with none to show it. The signal aborts when the
    // host goes: the card falls.
    askPermission: ([o]: [TabInfo], signal) => {
      const f = windows.active();
      return f ? questions.ask(o, f, signal) : false;
    },
    // The dev tools card, in the active window; refused with none to show it. The kernel takes it down (signal) when a
    // new conversation starts.
    askDevTools: ([o, d]: [TabInfo, { rights: DevRight[]; reason: string; agent: string }], signal) => {
      const f = windows.active();
      return f ? questions.askDevTools(o, d, f, signal) : [];
    },
    // The card for an address the agent composed, in the window of its search; refused with none to show it.
    askAddress: ([o, win]: [{ url: string; reason: string; agent: string; opinion?: string }, WindowId | undefined], signal) => {
      const f = win ?? windows.active();
      return f ? questions.askAddress(o, f, signal) : false;
    },
    // The « donnees-widget » card in the active window; refused with none to show it. The kernel takes it down (signal)
    // when a new conversation starts.
    askWidgetData: ([o]: [{ id: string; name: string; agent: string; kind?: "action" | "site" }], signal) => {
      const f = windows.active();
      return f ? questions.askWidgetData(o, f, signal) : false;
    },
    readPageInvisible: ([url, o]: [string, PageReadOptions & { pacedId?: string }], signal) =>
      readPage(store, url, o, signal, (reading, hostName, s) => host().request("read.changeHost", { read: reading, host: hostName }, s)),
    readHtmlInvisible: ([url, o]: [string, { localAddresses?: boolean }], signal) => readHtml(store, url, o ?? {}, signal),
    // The kernel's dev tools (RemoteBridge.outilsDev): one owner per kernel start, its token on every call.
    "devtools.owner": () => devtools.owner(),
    "devtools.call": ([token, method, args]: Parameters<DevTools["call"]>, signal) => devtools.call(token, method, args, signal),
    "devtools.release": ([token]: [string]) => devtools.release(String(token)),
  };
}

/**
 * Tells the host what the access policy and the private mirror must learn from each state change. Returns the mirror's
 * refresh, for what moves the active window without a state change (focus, a window closing).
 */
export function trackState(store: Store, host: AgentHost, windows: WindowRegistry): () => void {
  let mirror = JSON.stringify(privateMirror(store.state, windows));
  let workflows = JSON.stringify(activeWorkflows(store.state));
  const refresh = () => {
    const next = JSON.stringify(privateMirror(store.state, windows));
    if (next !== mirror) host.notify("privateTabs", JSON.parse((mirror = next)));
    const nextWorkflows = JSON.stringify(activeWorkflows(store.state));
    if (nextWorkflows !== workflows) host.notify("windows.active", JSON.parse((workflows = nextWorkflows)));
  };
  store.subscribe((state, previous) => {
    refresh();
    const { navigated: navigated, closed: closed } = policyChanges(previous, state);
    for (const n of navigated) host.notify("policy.navigated", n);
    for (const id of closed) host.notify("policy.closed", { id });
    // Opening the agent panel on a tab gives it to the agent and pre-fills its context.
    for (const f of state.windows) {
      const opened = f.agentPanelOpen && !previous.windows.find((x) => x.id === f.id)?.agentPanelOpen;
      const tab = opened && activeTabOf(state, f.id);
      if (tab) host.notify("agent.panelOpened", { window: f.id, tab: tab });
    }
    if (state.settings.decisionModel !== previous.settings.decisionModel) host.notify("ai.decisionModel", { model: state.settings.decisionModel });
    if (state.settings.codexEngine !== previous.settings.codexEngine) host.notify("agent.codexEngine", { engine: state.settings.codexEngine });
    if (state.settings.claudeEngine !== previous.settings.claudeEngine) host.notify("agent.claudeEngine", { engine: state.settings.claudeEngine });
    if (state.settings.agentProfile !== previous.settings.agentProfile)
      host.request("changeProfile", { agentProfile: state.settings.agentProfile }).catch((e) => console.error("[agent] profile change failed:", e));
  });
  return refresh;
}

/** The private and workflow mirrors a new host starts from. */
export const sendMirror = (store: Store, windows: WindowRegistry, notify: (method: string, params: unknown) => void) => {
  notify("privateTabs", privateMirror(store.state, windows));
  notify("windows.active", activeWorkflows(store.state));
};
