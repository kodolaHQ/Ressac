import { navigationOutsideSite, TabNotFound, PrivateTab, type DevRight, type TabInfo, type PageReadOptions } from "../shims/kernel";
import type { BrowserState, WindowId, Tab } from "../../shared/model";
import { privateTab, WORKFLOW_PREFIX } from "../../shared/model";
import { policyChanges, tabInfos, activeTabOf, appTab, siteTab, originOf, SITE_PREFIX, resolveSpace } from "../../core/agent/pont";
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
function privateMirror(state: BrowserState, windows: WindowRegistry): { prives: string[]; actifPrive: boolean } {
  const isPrivate = (o: Tab | undefined) => !!o && !internal(o) && privateTab(state, o);
  const f = state.fenetres.find((x) => x.id === windows.active());
  const active = f && f.actif[f.espaceActif];
  return { prives: Object.values(state.onglets).filter(isPrivate).map((o) => o.id), actifPrive: isPrivate(active ? state.onglets[active] : undefined) };
}

/** Each window's active tab URL, for `workflow_ouvert`: only a workflow page, never a web URL (null otherwise). */
function activeWorkflows(state: BrowserState): Record<WindowId, string | null> {
  const r: Record<WindowId, string | null> = {};
  for (const f of state.fenetres) {
    const url = state.onglets[f.actif[f.espaceActif] ?? ""]?.url;
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
    const m = windows.get(store.state.onglets[id]?.fenetreId ?? "");
    if (!m) throw new Error("Aucune fenêtre ouverte");
    return m;
  };
  /** Throws PrivateTab for a tab in a private space: a call that crosses the switch to private reads nothing. */
  const tab = (id: string): Tab => {
    const state = store.state;
    const o = state.onglets[id];
    if (!o) throw new TabNotFound(id);
    if (privateTab(state, o)) throw new PrivateTab(id);
    return o;
  };
  /** A tab whose page can be read: Firefox's crash or error page is not the page. */
  const loadedTab = (id: string): Tab => {
    const o = tab(id);
    if (o.plante) throw new Error("La page a planté : rechargez-la.");
    if (o.erreur) throw new Error("La page n'a pas pu être chargée.");
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
    const text = String(r?.texte ?? "").slice(0, TEXT_MAX);
    const selection = String(r?.selection ?? "").slice(0, TEXT_MAX);
    return selection ? { texte: text, selection } : { texte: text };
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
  const openTab = ([url, space]: [string, string?]): TabInfo => {
    const state = store.state;
    const f = state.fenetres.find((x) => x.id === windows.active()) ?? state.fenetres[0];
    if (!f) throw new Error("Aucune fenêtre ouverte");
    const spaceId = resolveSpace(state, f, space);
    if (state.espaces.find((e) => e.id === spaceId)?.prive ?? true) throw new Error("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
    const id = crypto.randomUUID();
    store.dispatch({ type: "ouvrirOnglet", fenetreId: f.id, url, espaceId: spaceId, activer: true, ouvertParAgent: true }, () => id);
    if (!store.state.onglets[id]) throw new Error(`Impossible d'ouvrir ${url}`);
    store.dispatch({ type: "activerOnglet", id }); // also switches to its space
    return tabInfos(store.state).find((o) => o.id === id)!;
  };

  return {
    // Decision 3: no window open (the last one kept), no active tab.
    ongletActif: ([win]: [WindowId?] = []) => activeTabOf(store.state, win ?? windows.active()),
    listerOnglets: () => [...tabInfos(store.state), ...apps.forAgent().map(appTab), ...sites.forAgent().map(siteTab)],
    ouvrirOnglet: openTab,
    naviguer: ([id, url]: [string, string]) => {
      if (id.startsWith(SITE_PREFIX)) {
        if (!sites.viewFor(id.slice(SITE_PREFIX.length))) throw new TabNotFound(id);
        // Never a tab instead: off the app's domains nothing loads (the kernel checked it already).
        const r = sites.navigateForAgent(id.slice(SITE_PREFIX.length), url);
        if (r === "refuse") throw new Error(navigationOutsideSite(url));
        return r === "en-attente" ? r : undefined;
      }
      if (id.startsWith(APP_PREFIX)) {
        const folder = id.slice(APP_PREFIX.length);
        if (!apps.viewFor(folder)) throw new TabNotFound(id);
        // The app window never leaves its origin: elsewhere, a tab of the main window.
        if (!apps.navigateForAgent(folder, url)) openTab([url]);
        return;
      }
      tab(id);
      windowOf(id).controller.navigateForAgent(id, url);
    },
    lireTexte: ([id]: [string]) => onSiteView(id, getText) ?? outsidePrivate(id, getText),
    capturer: ([id]: [string]) => onSiteView(id, snapshot) ?? outsidePrivate(id, (browser) => snapshot(browser, windowOf(id).window)),
    // « L'agent veut lire l'onglet … » in the active window; refused with none to show it. The signal aborts when the
    // host goes: the card falls.
    demanderAutorisation: ([o]: [TabInfo], signal) => {
      const f = windows.active();
      return f ? questions.ask(o, f, signal) : false;
    },
    // The dev tools card, in the active window; refused with none to show it. The kernel takes it down (signal) when a
    // new conversation starts.
    demanderOutilsDev: ([o, d]: [TabInfo, { droits: DevRight[]; raison: string; agent: string }], signal) => {
      const f = windows.active();
      return f ? questions.askDevTools(o, d, f, signal) : [];
    },
    // The « donnees-widget » card in the active window; refused with none to show it. The kernel takes it down (signal)
    // when a new conversation starts.
    demanderDonneesWidget: ([o]: [{ id: string; nom: string; agent: string; genre?: "action" | "site" }], signal) => {
      const f = windows.active();
      return f ? questions.askWidgetData(o, f, signal) : false;
    },
    lirePageInvisible: ([url, o]: [string, PageReadOptions & { menagee?: string }], signal) =>
      readPage(store, url, o, signal, (reading, hostName, s) => host().request("lecture.changerHote", { lecture: reading, hote: hostName }, s)),
    lireHtmlInvisible: ([url, o]: [string, { adressesLocales?: boolean }], signal) => readHtml(store, url, o ?? {}, signal),
    // The kernel's dev tools (RemoteBridge.outilsDev): one owner per kernel start, its token on every call.
    "outilsDev.owner": () => devtools.owner(),
    "outilsDev.call": ([token, method, args]: Parameters<DevTools["call"]>, signal) => devtools.call(token, method, args, signal),
    "outilsDev.release": ([token]: [string]) => devtools.release(String(token)),
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
    if (next !== mirror) host.notify("prives", JSON.parse((mirror = next)));
    const nextWorkflows = JSON.stringify(activeWorkflows(store.state));
    if (nextWorkflows !== workflows) host.notify("fenetres.actives", JSON.parse((workflows = nextWorkflows)));
  };
  store.subscribe((state, previous) => {
    refresh();
    const { navigues: navigated, fermes: closed } = policyChanges(previous, state);
    for (const n of navigated) host.notify("politique.navigue", n);
    for (const id of closed) host.notify("politique.ferme", { id });
    // Opening the agent panel on a tab gives it to the agent and pre-fills its context.
    for (const f of state.fenetres) {
      const opened = f.panneauAgentOuvert && !previous.fenetres.find((x) => x.id === f.id)?.panneauAgentOuvert;
      const tab = opened && activeTabOf(state, f.id);
      if (tab) host.notify("agent.panneauOuvert", { fenetre: f.id, onglet: tab });
    }
    if (state.reglages.profilAgent !== previous.reglages.profilAgent)
      host.request("changerProfil", { profilAgent: state.reglages.profilAgent }).catch((e) => console.error("[agent] profile change failed:", e));
  });
  return refresh;
}

/** The private and workflow mirrors a new host starts from. */
export const sendMirror = (store: Store, windows: WindowRegistry, notify: (method: string, params: unknown) => void) => {
  notify("prives", privateMirror(store.state, windows));
  notify("fenetres.actives", activeWorkflows(store.state));
};
