// Agent app windows: one window per running app, the app's page alone, in
// its own container (`webaios-app-<dossier>`), kept on its origin (http://localhost:<port>) by the request guard and
// the view policy of sites.ts. The host (host/applications.ts) owns the apps; this module owns their windows.
import type { DesignState } from "../../shared/api";
import type { FrameBounds, AccessState } from "../../shared/model";
import { validFolder } from "./app-folder";
import { HOST_EXITED, type AgentHost } from "../agent/host";
import type { DesignService } from "./design";
import { appContainer, isAppContainer, removeAppContainer } from "./containers";
import { frameFeatures, frameOf, installGuard, openInContainer } from "./sites";

/** The window.arguments[1] key that marks an agent app window from its creation (read before anything claims it). */
export const APP_WINDOW_KEY = "webaios-app";

interface OpenApp {
  dossier: string;
  nom: string;
  /** `http://localhost:<port>`: follows a relaunch on another port. */
  origin: string;
  userContextId: number;
  window: Window;
  /** The app view's <browser>, once the window is set up (app-window.ts). */
  view: any;
  /** A close WebAiOs wanted (the app stopped, its host gone): it does not stop the app. */
  wanted: boolean;
}

const open = new Map<string, OpenApp>();
let host: AgentHost | null = null;
let openTab: (url: string) => void = () => {};
let dataDir = "";
/** After quit-application-granted, a window closing is the quit's, never the user's (spike S8). */
let quitting = false;
const closeListeners = new Set<() => void>();
let access: () => AccessState = () => ({ agent: "L'agent", onglets: {} });
let design: Pick<DesignService, "etat" | "toggle" | "openCart" | "relire"> | null = null;

/** What the badge frame of an app window gets from the chrome (ui/badge-api.ts copies every value it hands over). */
export interface BadgeChrome {
  acces: { etat(): AccessState; couper(id: unknown, right: unknown): void };
  surAcces(cb: (e: AccessState) => void): () => void;
  pastilleTaille(openedApp: unknown): void;
  /** Its window's design mode (target `app`, from the window, never from the frame). */
  design: { etat(): Promise<DesignState>; basculer(): void; panier(): void; relire(): void };
}

// Badge sizes: closed, the WebAiOs button alone or with the agent's access; open, its bubble or menu.
const BADGE = { closed: [48, 28], withAccess: [88, 28], open: [300, 320] } as const;

const sameOrigin = (url: string, origin: string) => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

const byContainer = (userContextId: number) => [...open.values()].find((a) => a.userContextId === userContextId);

function toTab(url: string): void {
  if (/^https?:\/\//i.test(url)) openTab(url);
}

function load(a: OpenApp, url = a.origin + "/"): void {
  denyPermissions(a);
  a.view?.browsingContext?.sessionHistory?.evictAllDocumentViewers();
  a.view?.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
}

/** Firefox's permission types a page can ask for or read (Notification.permission, permissions.query). */
const PERMISSIONS = ["desktop-notification", "geo", "camera", "microphone", "screen", "midi", "midi-sysex", "xr", "persistent-storage", "storage-access"];

/**
 * The app's code was not reviewed: no permission in its window. Its asks are already
 * refused (permission-hooks.ts: a <browser> with no WebAiOs tab); denied here too, so the page reads « denied ».
 */
function denyPermissions(a: OpenApp): void {
  const principal = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(a.origin), { userContextId: a.userContextId });
  for (const type of PERMISSIONS) Services.perms.addFromPrincipal(principal, type, Services.perms.DENY_ACTION, Services.perms.EXPIRE_SESSION);
}

function told(): void {
  for (const cb of closeListeners)
    try {
      cb();
    } catch (e) {
      console.error("[apps] listener failed:", e);
    }
}

/** A <browser> of the container other than the app view (a window.open with features): closed. */
function closeStray(browser: any): void {
  const win = browser?.ownerDocument?.defaultView;
  if (!win || [...open.values()].some((a) => a.view === browser)) return;
  Services.tm.dispatchToMainThread(() => {
    const tab = win.gBrowser?.getTabForBrowser(browser);
    if (tab && win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(tab);
    else win.close();
  });
}

/** The window is gone (from its creation on): the host is told, unless it was replaced or forgotten meanwhile. */
function closed(a: OpenApp): void {
  if (open.get(a.dossier) === a) {
    open.delete(a.dossier);
    host?.notify("applications.fenetreFermee", { dossier: a.dossier, byUser: !a.wanted && !quitting });
  }
  told();
}

function closeWindow(a: OpenApp): Promise<void> {
  a.wanted = true;
  if (a.window.closed) return Promise.resolve();
  return new Promise<void>((ok) => {
    const o = {
      observe(w: unknown, topic: string) {
        if (topic !== "domwindowclosed" || w !== a.window) return;
        Services.ww.unregisterNotification(o);
        ok();
      },
    };
    Services.ww.registerNotification(o);
    a.window.close();
  });
}

export const apps = {
  /**
   * Opens the app's window on `http://localhost:<port>/`, or reloads the open one there (a relaunch, maybe on another
   * port: the guard follows the new origin). An invalid dossier opens nothing.
   */
  open(a: { dossier: string; nom: string; port: number }, frame: FrameBounds | null): void {
    if (typeof a?.dossier !== "string" || !validFolder(a.dossier) || typeof a.nom !== "string" || !Number.isInteger(a.port) || a.port <= 0 || a.port > 65535) return;
    const origin = `http://localhost:${a.port}`;
    const known = open.get(a.dossier);
    if (known && !known.window.closed) {
      known.nom = a.nom;
      known.origin = origin;
      load(known);
      apps.show(a.dossier);
      return;
    }
    const userContextId = appContainer(a.dossier);
    const marker = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
    marker.setPropertyAsAString(APP_WINDOW_KEY, a.dossier);
    const win = openInContainer(userContextId, marker, frameFeatures(frame));
    const app: OpenApp = { dossier: a.dossier, nom: a.nom, origin, userContextId, window: win, view: null, wanted: false };
    open.set(a.dossier, app);
    const onClose = {
      observe(w: unknown, topic: string) {
        if (topic !== "domwindowclosed" || w !== win) return;
        Services.ww.unregisterNotification(onClose);
        closed(app);
      },
    };
    Services.ww.registerNotification(onClose);
  },
  /** A close WebAiOs wants (the app stopped): the page is not asked, the host is not told it was closed by the user. */
  async close(folder: string): Promise<void> {
    const a = open.get(folder);
    if (a) await closeWindow(a);
  },
  /** « Ouvrir »: the window in front, not reloaded; false if the app has none. */
  show(folder: string): boolean {
    const a = open.get(folder);
    if (!a || a.window.closed) return false;
    if (a.window.windowState === a.window.STATE_MINIMIZED) (a.window as any).restore();
    a.window.focus();
    return true;
  },
  /** « Supprimer »: the app's container (cookies, storage) is wiped. */
  async erase(folder: string): Promise<void> {
    if (typeof folder === "string" && validFolder(folder)) await removeAppContainer(folder);
  },
  /**
   * « Afficher le dossier »: `<dataDir>/espace/projets/<dossier>` shown in the Finder, never opened (an `x.app` folder
   * would launch). One path segment only. WEBAIOS_TEST_REVEAL (e2e): the path is appended to
   * that file instead.
   */
  reveal(folder: string): void {
    if (typeof folder !== "string" || folder === "" || folder === "." || folder === ".." || /[/\\\0]/.test(folder) || !dataDir) return;
    const path = PathUtils.join(dataDir, "espace", "projets", folder);
    const test = Services.env.get("WEBAIOS_TEST_REVEAL");
    if (test) return void IOUtils.writeUTF8(test, path + "\n", { mode: "appendOrCreate" }).catch((e: unknown) => console.warn("[apps] reveal not noted:", e));
    try {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(path);
      f.reveal();
    } catch (e) {
      console.warn("[apps] dossier non affiché :", e);
    }
  },
  /** The host is gone: every app window closes, as wanted closes, and is forgotten at once (spec §13.8). */
  closeAll(): void {
    for (const a of [...open.values()]) {
      open.delete(a.dossier);
      void closeWindow(a);
    }
  },
  /** The app as its window reads it while it is set up (app-window.ts): undefined if it is not this window's. */
  appOf(win: Window): Pick<OpenApp, "dossier" | "nom" | "origin"> | undefined {
    return [...open.values()].find((a) => a.window === win);
  },
  dossierOf(win: Window): string | undefined {
    return apps.appOf(win)?.dossier;
  },
  /** The window is set up: its view is attached and sent to the app. */
  attach(win: Window, browser: any): void {
    const a = [...open.values()].find((x) => x.window === win);
    if (!a) return;
    a.view = browser;
    load(a);
  },
  /** A main window tab for an address the app may not load (only http(s)). */
  toTab,
  /** The view's top document changed (app-window.ts): the host's policy follows; a change of origin drops stale questions. */
  navigated(win: Window, url: string): void {
    const a = [...open.values()].find((x) => x.window === win);
    if (!a) return;
    host?.notify("applications.navigation", { dossier: a.dossier, url, titre: apps.titleOf(a) });
    told();
  },
  /** The frame (resize, move, close) and a kept favicon, for the host's memory. */
  note(win: Window, o: { frame?: boolean; favicon?: string }): void {
    const a = [...open.values()].find((x) => x.window === win);
    if (!a) return;
    const frame = o.frame ? frameOf(win) : null;
    if (frame) host?.notify("applications.noter", { dossier: a.dossier, cadre: frame });
    if (o.favicon) host?.notify("applications.noter", { dossier: a.dossier, favicon: o.favicon });
  },
  titleOf(a: Pick<OpenApp, "nom" | "view">): string {
    return String(a.view?.contentTitle ?? "").trim() || a.nom;
  },
  /** The app view's <browser> and its window. */
  viewFor(folder: string): { browser: any; window: Window } | undefined {
    const a = open.get(folder);
    return a?.view && !a.window.closed ? { browser: a.view, window: a.window } : undefined;
  },
  /** The open windows for the agent, seen as `app:<dossier>` tabs. */
  forAgent(): { dossier: string; titre: string; url: string }[] {
    return [...open.values()]
      .filter((a) => !a.window.closed)
      .map((a) => {
        const url: string = a.view?.currentURI?.spec ?? "";
        return { dossier: a.dossier, titre: apps.titleOf(a), url: url && url !== "about:blank" ? url : a.origin + "/" };
      });
  },
  /** Navigation on `app:`: in the window on the app's origin, else false (the bridge opens a tab). */
  navigateForAgent(folder: string, url: string): boolean {
    const a = open.get(folder);
    if (!a?.view || !sameOrigin(url, a.origin)) return false;
    load(a, url);
    return true;
  },
  /** Told when an app window closes or its page changes. */
  onClosed(cb: () => void): () => void {
    closeListeners.add(cb);
    return () => void closeListeners.delete(cb);
  },
  /** Is this an agent app's container (running or not)? */
  ownsContainer: (userContextId: number): boolean => isAppContainer(userContextId),
  isAppView(browserId: number): boolean {
    return [...open.values()].some((a) => a.view?.browserId === browserId);
  },
  /**
   * The request guard's part for agent apps (sites.ts's observer, top-level documents): true if the channel is of an app
   * container, handled here. The view loads only its app's origin (a redirect too); anything else is cancelled before it
   * is sent, then opened in a main window tab. Any other <browser> of the container (window.open with features) is
   * closed, its address in a tab. The container of an app not open loads nothing.
   */
  request(ch: any, li: any): boolean {
    const userContextId = li.originAttributes.userContextId;
    if (!userContextId) return false;
    const a = byContainer(userContextId);
    if (!a) {
      if (!isAppContainer(userContextId)) return false;
      ch.cancel(Cr.NS_BINDING_ABORTED);
      return true;
    }
    const url: string = ch.URI.spec;
    const bc = li.browsingContext;
    const browserId: number = ch.browserId || bc?.browserId;
    const inView = !!a.view && browserId === a.view.browserId;
    if (inView && sameOrigin(url, a.origin)) return true;
    ch.cancel(Cr.NS_BINDING_ABORTED);
    // Before the view is attached nothing of the container may load, and no browser can be told from the view yet.
    if (!inView && a.view) closeStray(bc?.top?.embedderElement);
    toTab(url);
    return true;
  },
  /**
   * The badge of an app window: only its own app's access (accessOf), the frame sized by `size` as
   * that access and its menu change, its own app's design mode. Undefined if the window is not an app's.
   */
  badge(win: Window, size: (width: number, height: number) => void): BadgeChrome | undefined {
    const folder = apps.dossierOf(win);
    if (!folder) return undefined;
    const id = "app:" + folder;
    const target = { type: "app" as const, dossier: folder };
    // Never another tab's access.
    const own = (): AccessState => {
      const e = access();
      const t = e.onglets[id];
      return { agent: e.agent, onglets: t ? { [id]: t } : {} };
    };
    let opened = false;
    const place = () => {
      const t = access().onglets[id];
      const [width, height] = opened ? BADGE.open : t && (t.lecture || t.droits.length > 0) ? BADGE.withAccess : BADGE.closed;
      size(width, height);
    };
    const listeners = new Set<(e: AccessState) => void>();
    const changed = () => {
      place();
      for (const cb of listeners)
        try {
          cb(own());
        } catch (e) {
          console.error("[apps] badge listener failed:", e);
        }
    };
    const offs = [host?.on("acces", changed), host?.on(HOST_EXITED, changed)];
    win.addEventListener("unload", () => offs.forEach((f) => f?.()), { once: true });
    place();
    return {
      acces: {
        etat: own,
        // Its own app's access only.
        couper: (cut, right) => {
          if (cut === id && (right === undefined || typeof right === "string")) host?.notify("politique.couper", { id, droit: right });
        },
      },
      surAcces(cb) {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
      pastilleTaille(openedApp) {
        if (typeof openedApp !== "boolean") return;
        opened = openedApp;
        place();
      },
      design: {
        // Set by bindApps, before any app window opens.
        etat: () => design!.etat(target),
        basculer: () => void design!.toggle(target),
        panier: () => void design!.openCart(target),
        // The Review page of any app, one without manifest included.
        relire: () => void design!.relire(target),
      },
    };
  },
  /** The host's requests (host/applications.ts chrome), positional params. */
  handlers: {
    "apps.ouvrir": ([a, frame]: [{ dossier: string; nom: string; port: number }, FrameBounds | null]) => apps.open(a, frame),
    "apps.fermer": ([folder]: [string]) => apps.close(folder),
    "apps.montrer": ([folder]: [string]) => apps.show(folder),
    "apps.effacer": ([folder]: [string]) => apps.erase(folder),
  },
};

export type AgentApps = typeof apps;

/**
 * A redirect of the view's page off the web (Location: file:, data:…): no http channel follows, so the request guard
 * never sees it, and Firefox's own refusal would leave the view on about:blank. Cancelled on the response, the view stays.
 */
const redirects = {
  observe(subject: any) {
    const ch = subject.QueryInterface(Ci.nsIHttpChannel);
    const li = ch.loadInfo;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT || !apps.isAppView(ch.browserId || li.browsingContext?.browserId)) return;
    if (ch.responseStatus < 300 || ch.responseStatus > 399) return;
    let location = "";
    try {
      location = new URL(ch.getResponseHeader("Location"), ch.URI.spec).protocol;
    } catch {
      return;
    }
    if (location !== "http:" && location !== "https:") ch.cancel(Cr.NS_BINDING_ABORTED);
  },
};

/**
 * Started with the store: the host the windows report to, the main window tab for what leaves an app, the agent's
 * access (the badges) and the design mode of each app window.
 */
export function bindApps(agent: AgentHost, openInTab: (url: string) => void, dir: string, o: { access: () => AccessState; design: NonNullable<typeof design> }): void {
  host = agent;
  dataDir = dir;
  openTab = openInTab;
  access = o.access;
  design = o.design;
  // From the start, not with the first window: an app container left from a previous run loads nothing either.
  installGuard();
  Services.obs.addObserver(redirects, "http-on-examine-response");
  Services.obs.addObserver({ observe: () => (quitting = true) }, "quit-application-granted");
}
