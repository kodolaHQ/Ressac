// Site app windows: the registry of open app windows, their containers, their bar's controller, and the guard that
// keeps each app on its domains before any request leaves. The host (noyau/sites.ts) owns the data; this module owns
// the windows (Electron's main/sites/fenetres.ts).
import type { Cadre } from "../../../navigateur/src/commun/modele";
import { ECART_OUVERTURE_ACCUEIL_MS, ICONE_MAX, type EtatFenetreSite, type MessageVersLAccueil } from "../../../navigateur/src/commun/sites";
import type { SiteOuvrable } from "../../../navigateur/src/main/sites/fenetres";
import { decisionNavigation, decisionOuverture, type ContexteNavigation } from "../../../navigateur/src/main/sites/navigation";
import { adresseSurDomaine } from "../../../../packages/noyau/src/sites/adresses";
import { ID_SITE } from "../../../../packages/noyau/src/sites/schemas";
import { gardienGestes } from "../../shared/geste-widget";
import type { AgentHost } from "../agent/host";
import type { SiteFrameData } from "../agent/site-actor";
import { isSiteContainer, removeSiteContainer, siteContainer } from "./containers";
import { blockedNotice, httpHost, type BlockedNotice } from "./site-guard";
import { forgetHome, serveHome, siteImage } from "./site-home";

// Keep in sync with agent/site-actor.ts SITE_FRAMES.
const SITE_FRAMES = "webaios-sites";
/** The window.arguments[1] key that marks a site app window from its creation (read before store.windows.claim). */
export const SITE_WINDOW_KEY = "webaios-site";
/** Electron's BrowserWindow: 1200 × 800 by default, 360 × 240 at least. */
const SIZE = { largeur: 1200, hauteur: 800 };
const MIN = { largeur: 360, hauteur: 240 };

/** What the site actor runs in each frame of a container: published to every content process. */
export function publishSiteFrames(map: Map<number, SiteFrameData>): void {
  Services.ppmm.sharedData.set(SITE_FRAMES, map);
  Services.ppmm.sharedData.flush();
}

/** What the bar (ui/site-api.ts) drives, through `window.parent.webaiosSiteWindow`. */
export interface SiteWindowController {
  state(): EtatFenetreSite;
  onState(cb: (e: EtatFenetreSite) => void): () => void;
  /** « Entrer dans le site »: the start address the first time only. */
  enter(): void;
  /** ⌂: the home screen; the site's page stays loaded behind it. */
  home(): void;
  back(): void;
  forward(): void;
  reload(): void;
  /** A navigation or an open of the app was refused: kept for « Ouvrir dans un onglet », mentioned in the bar. */
  blocked(url: string): void;
  /** « Ouvrir dans un onglet »: the last blocked link, in the last main window (its active space); the mention falls. */
  openBlocked(): void;
  memory(): Promise<(MessageVersLAccueil & { type: "memoire" }) | null>;
  onMemory(cb: (m: MessageVersLAccueil & { type: "memoire" }) => void): () => void;
  /**
   * The home screen asks for an address (Electron's ouvrirDepuisAccueil): on the current domain, just after a real
   * gesture in the home (consumed), one per ECART_OUVERTURE_ACCUEIL_MS; false if refused.
   */
  openFromHome(adresse: string): boolean;
  /** A site image for the home, as `data:`, loaded in the app's container; null if refused. */
  image(url: string): Promise<string | null>;
  /** The served copy's URL (re-served when the home's files change, then the state is broadcast), or null. */
  homeUrl(): Promise<string | null>;
  /** A real (isTrusted) press in the home's frame. */
  homeGesture(): void;
}

interface OpenSite {
  site: SiteOuvrable;
  userContextId: number;
  window: Window;
  /** The app view's <browser>, once the window is set up. */
  view: any;
  vue: EtatFenetreSite["vue"];
  /** Has the start address been loaded (« Entrer dans le site » loads it once)? */
  loaded: boolean;
  listeners: Set<(e: EtatFenetreSite) => void>;
  /** browserIds of the sign-in windows (connexion) kept for this app. */
  small: Set<number>;
  /** The hosts of the blocked navigations and opens, in order (read by the e2e). */
  blocked: string[];
  notice: BlockedNotice;
  /** The served home copy, until the home's files change. */
  home: Promise<string | null> | null;
  /** When the home last opened an address. */
  lastHomeOpen: number;
}

const open = new Map<string, OpenSite>();
const byContainer = new Map<number, OpenSite>();
let host: AgentHost | null = null;
let dataDir = "";
let openTab: (url: string) => void = () => {};
/** The last real presses in each app's home (one allows one open). */
const gestures = gardienGestes<string>();
const memoryListeners = new Map<string, Set<(m: MessageVersLAccueil & { type: "memoire" }) => void>>();

const context = (s: OpenSite): ContexteNavigation => ({
  domaines: s.site.domaines,
  connexion: s.site.declaration.connexion ?? [],
  adressesLocales: Services.env.get("WEBAIOS_TEST_ADRESSES_LOCALES") === "1",
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function block(s: OpenSite, url: string): void {
  s.blocked.push(hostOf(url));
  s.notice.block(url);
}

function loadInView(s: OpenSite, url: string): void {
  s.loaded = true;
  s.view?.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
}

/** A <browser> outside the app view and its sign-in windows that tried to load a page of the container: closed. */
function closeStray(browser: any): void {
  const win = browser?.ownerDocument?.defaultView;
  if (!win || browser === [...open.values()].find((s) => s.window === win)?.view) return;
  Services.tm.dispatchToMainThread(() => {
    const tab = win.gBrowser?.getTabForBrowser(browser);
    if (tab && win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(tab);
    else win.close();
  });
}

/**
 * Before any request connects (http-on-modify-request), every top-level document of a site container: the app view
 * goes only to the app's domains or its sign-in domains (decisionNavigation); so does a kept sign-in window. Any other
 * browser of the container is a window the page just opened (window.open with features: Firefox creates it without
 * asking browserDOMWindow): its first page decides (decisionOuverture). A refused load is cancelled before the request
 * is sent, with NS_BINDING_ABORTED so that the view stays on its page (no error page). The container of an app whose
 * window is closed loads nothing (a window it opened that outlived it).
 * shortcut: preconnects and speculative connections never reach this observer (a TCP connection, no HTTP request);
 * upgrade if a blocked host must never see a connection.
 */
const observer = {
  observe(subject: any) {
    const ch = subject.QueryInterface(Ci.nsIHttpChannel);
    const li = ch.loadInfo;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) return;
    const userContextId = li.originAttributes.userContextId;
    const s = byContainer.get(userContextId);
    if (!s) {
      if (isSiteContainer(userContextId)) ch.cancel(Cr.NS_BINDING_ABORTED);
      return;
    }
    const url: string = ch.URI.spec;
    const bc = li.browsingContext;
    const browserId: number = ch.browserId || bc?.browserId;
    const ctx = context(s);
    const inView = browserId === s.view?.browserId;
    if (inView || s.small.has(browserId)) {
      if (decisionNavigation(url, ctx) === "suivre") return;
      ch.cancel(Cr.NS_BINDING_ABORTED);
      // A sign-in window's refused page is not mentioned (Electron's equiperPetite).
      if (inView) block(s, url);
      return;
    }
    // A sign-in window opens nothing (Electron's equiperPetite denies every open).
    if (s.small.has(bc?.opener?.top?.browserId)) {
      ch.cancel(Cr.NS_BINDING_ABORTED);
      return closeStray(bc?.top?.embedderElement);
    }
    const d = decisionOuverture(url, ctx);
    if (d === "petite-fenetre") return void s.small.add(browserId);
    ch.cancel(Cr.NS_BINDING_ABORTED);
    closeStray(bc?.top?.embedderElement);
    if (d === "dans-l-appli") loadInView(s, url);
    else block(s, url);
  },
};
let observing = false;

/**
 * browser.xhtml with browser.js's window.arguments: [1] extra options (the marker), [5] the first tab's userContextId;
 * no URL ([0]), so nothing loads before the window is set up. No `toolbar` (nor `all`) feature: window.toolbar.visible is
 * false for good (its setter refuses), so BrowserWindowTracker.getTopWindow() never returns the window.
 */
function openInContainer(userContextId: number, marker: unknown, size: string): Window {
  const container = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(Ci.nsISupportsPRUint32);
  container.data = userContextId;
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  for (const a of [null, marker, null, null, null, container]) args.appendElement(a);
  return Services.ww.openWindow(null, "chrome://browser/content/browser.xhtml", "_blank", `chrome,dialog=no,non-private,resizable,minimizable,titlebar,close,${size}`, args);
}

/** Electron's cadreVisible: the frame kept, if it still meets a screen. */
function visible(c: Cadre): boolean {
  const screen = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager).screenForRect(c.x, c.y, c.largeur, c.hauteur);
  const [l, t, w, h] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
  screen.GetAvailRectDisplayPix(l, t, w, h);
  return c.x < l.value + w.value && c.x + c.largeur > l.value && c.y < t.value + h.value && c.y + c.hauteur > t.value;
}

/** The window's features: the kept frame (outer size, as Electron's bounds), else 1200 × 800; 360 × 240 at least. */
function frameFeatures(cadre: Cadre | null | undefined): string {
  const c = cadre && [cadre.x, cadre.y, cadre.largeur, cadre.hauteur].every(Number.isFinite) && visible(cadre) ? cadre : null;
  const largeur = Math.max(MIN.largeur, Math.round(c?.largeur ?? SIZE.largeur));
  const hauteur = Math.max(MIN.hauteur, Math.round(c?.hauteur ?? SIZE.hauteur));
  return `outerWidth=${largeur},outerHeight=${hauteur}${c ? `,left=${Math.round(c.x)},top=${Math.round(c.y)}` : ""}`;
}

/** The window's frame as Electron notes it (getNormalBounds), or null while it is minimized or fullscreen. Still read at unload. */
function frameOf(win: Window): Cadre | null {
  if (win.windowState === win.STATE_MINIMIZED || win.windowState === win.STATE_FULLSCREEN) return null;
  return { x: win.screenX, y: win.screenY, largeur: win.outerWidth, hauteur: win.outerHeight };
}

function noteFrame(s: OpenSite): void {
  const cadre = frameOf(s.window);
  if (cadre) host?.notify("sites.noter", { id: s.site.id, cadre });
}

function stateOf(s: OpenSite): EtatFenetreSite {
  const url: string = s.view?.currentURI?.spec ?? "";
  return {
    id: s.site.id,
    nom: s.site.declaration.nom,
    vue: s.vue,
    aAccueil: s.site.aAccueil,
    domaine: httpHost(url) ?? httpHost(s.site.depart) ?? "",
    peutReculer: !!s.view?.canGoBack,
    peutAvancer: !!s.view?.canGoForward,
    // Address tracking and the accord card are plan 32's: the app opens as Electron's « Ouvrir sans retouches ».
    suivi: false,
    recherche: false,
    avis: s.notice.avis,
    accord: null,
  };
}

function broadcast(s: OpenSite): void {
  if (s.window.closed) return;
  // The bar's frame covers the window on the home screen (window.css).
  s.window.document.documentElement.toggleAttribute("webaios-site-home", s.vue === "accueil");
  const e = stateOf(s);
  for (const cb of s.listeners) cb(e);
}

function controllerOf(s: OpenSite): SiteWindowController {
  const id = s.site.id;
  return {
    state: () => stateOf(s),
    onState(cb) {
      s.listeners.add(cb);
      return () => void s.listeners.delete(cb);
    },
    enter() {
      if (s.vue === "accord") return;
      s.vue = "site";
      if (!s.loaded) loadInView(s, s.site.depart);
      broadcast(s);
    },
    home() {
      if (!s.site.aAccueil || s.vue === "accord") return;
      s.vue = "accueil";
      broadcast(s);
    },
    back() {
      if (s.vue === "site" && s.view?.canGoBack) s.view.goBack();
    },
    forward() {
      if (s.vue === "site" && s.view?.canGoForward) s.view.goForward();
    },
    reload() {
      if (s.vue === "site" && s.loaded) s.view?.reload();
    },
    blocked: (url) => block(s, url),
    openBlocked() {
      const url = s.notice.take();
      if (!url) return;
      broadcast(s);
      openTab(url);
    },
    memory: () => host?.request<(MessageVersLAccueil & { type: "memoire" }) | null>("sites.memoireAccueil", { id }).catch(() => null) ?? Promise.resolve(null),
    onMemory(cb) {
      let set = memoryListeners.get(id);
      if (!set) memoryListeners.set(id, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    openFromHome(adresse) {
      if (open.get(id) !== s || typeof adresse !== "string") return false;
      const now = Date.now();
      if (now - s.lastHomeOpen < ECART_OUVERTURE_ACCUEIL_MS) return false;
      const url = adresseSurDomaine(adresse, httpHost(s.site.depart) ?? "", s.site.domaines, s.site.depart, { adressesLocales: !!context(s).adressesLocales });
      // Without a recent real gesture nothing opens: a home that asks on load would send back to the site at each ⌂.
      if (!url || !gestures.accepter(id, id) || s.vue !== "accueil") return false;
      loadInView(s, url);
      s.vue = "site";
      broadcast(s);
      s.lastHomeOpen = now;
      return true;
    },
    image: async (url) => (open.get(id) === s && typeof url === "string" ? siteImage(s.userContextId, url, s.site.domaines) : null),
    homeUrl: () => (open.get(id) === s && s.site.aAccueil ? (s.home ??= serveHome(dataDir, id)) : Promise.resolve(null)),
    homeGesture() {
      if (open.get(id) === s) gestures.geste(id, id);
    },
  };
}

/** The window is set up (site-window.ts): its view is watched, then, in the site view, sent to the app's address. */
function attach(s: OpenSite, browser: any): void {
  s.view = browser;
  const win = s.window;
  const id = s.site.id;
  // A page kept in the bfcache comes back without a request, so without the request guard (measured: history.back()
  // to a removed domain, zero request): none is kept, dropped at each location change and when the rules change.
  // Kept on the window: the browser holds its progress listeners weakly.
  const listener = ((win as any).webaiosSiteProgress = {
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    onLocationChange(progress: any, _request: unknown, _location: unknown, flags: number) {
      if (!progress.isTopLevel) return;
      browser.browsingContext?.sessionHistory?.evictAllDocumentViewers();
      // A new page: the mention of a link blocked on the previous one falls (Electron's did-navigate).
      if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) s.notice.clear();
      // After the tab browser's own listener has updated canGoBack and canGoForward.
      Services.tm.dispatchToMainThread(() => broadcast(s));
    },
  });
  browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
  // The favicon Firefox shows for the page (a data: URL from its FaviconLoader), noted as Electron's faviconEnDonnees.
  let favicon: string | null = null;
  win.gBrowser.tabContainer.addEventListener("TabAttrModified", (e: CustomEvent<{ changed: string[] }>) => {
    if (!e.detail.changed.includes("image")) return;
    const icon = win.gBrowser.getIcon(win.gBrowser.selectedTab);
    if (typeof icon !== "string" || !icon.startsWith("data:image/") || icon.length > ICONE_MAX || icon === favicon) return;
    favicon = icon;
    host?.notify("sites.noter", { id, favicon });
  });
  // The frame is noted as it moves (MozUpdateWindowPos, chrome only), is resized and closes; the host writes it later.
  let pending: number | undefined;
  const noteSoon = () => {
    win.clearTimeout(pending);
    pending = win.setTimeout(() => noteFrame(s), 200);
  };
  win.windowRoot.addEventListener("MozUpdateWindowPos", noteSoon);
  win.addEventListener("resize", noteSoon);
  // On the loaded window: the about:blank document a new window starts with unloads too.
  win.addEventListener(
    "unload",
    () => {
      win.clearTimeout(pending);
      noteFrame(s);
      s.listeners.clear();
      s.notice.dispose();
      if (byContainer.get(s.userContextId) === s) byContainer.delete(s.userContextId);
      // Reopened before this unload: the sign-in windows are the new app's.
      if (open.get(id) !== s) return;
      open.delete(id);
      memoryListeners.delete(id);
      host?.notify("sites.ferme", { id });
      // Its sign-in windows close with it (the request guard refuses any page of a closed app's container anyway).
      // Only this app's: a main window is never closed here, whatever its tab's container.
      for (const w of Services.wm.getEnumerator("navigator:browser")) if (w.document.documentElement.getAttribute("webaios-site-small") === id) w.close();
    },
    { once: true },
  );
  if (s.vue === "site") loadInView(s, s.site.depart);
  broadcast(s);
}

/** Sign-in windows opened by sites.routeOpen, and the address each loads once set up (takeSmallUrl). */
const smallUrls = new Map<Window, string>();

/** The site apps' windows, for the host (handlers) and the store. */
export const sites = {
  /**
   * Opens the app's window, or brings it to the front without reloading it (its declaration and domains are taken
   * over). False if the id is not a site app's.
   */
  open(site: SiteOuvrable, cadre?: Cadre | null): boolean {
    if (typeof site?.id !== "string" || !ID_SITE.test(site.id)) return false;
    const known = open.get(site.id);
    if (known && !known.window.closed) {
      sites.update(site);
      if (known.window.windowState === known.window.STATE_MINIMIZED) (known.window as any).restore();
      known.window.focus();
      return true;
    }
    if (!observing) {
      observing = true;
      Services.obs.addObserver(observer, "http-on-modify-request");
    }
    const userContextId = siteContainer(site.id);
    const marker = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
    marker.setPropertyAsAString(SITE_WINDOW_KEY, site.id);
    const win = openInContainer(userContextId, marker, frameFeatures(cadre));
    // Opened « sans retouches » (plan 31 injects nothing): never the accord card.
    const s: OpenSite = { site, userContextId, window: win, view: null, vue: site.aAccueil ? "accueil" : "site", loaded: false, listeners: new Set(), small: new Set(), blocked: [], notice: blockedNotice(() => broadcast(s)), home: null, lastHomeOpen: -Infinity };
    open.set(site.id, s);
    byContainer.set(userContextId, s);
    return true;
  },
  /** Closes the app's window without asking its page (deletion, the host's request); its frame is noted first. */
  async close(id: string): Promise<void> {
    const s = open.get(id);
    if (!s || s.window.closed) return;
    noteFrame(s);
    await new Promise<void>((ok) => {
      const o = {
        observe(w: unknown, topic: string) {
          if (topic !== "domwindowclosed" || w !== s.window) return;
          Services.ww.unregisterNotification(o);
          ok();
        },
      };
      Services.ww.registerNotification(o);
      s.window.close();
    });
  },
  /** « Supprimer »: the app's container (cookies, storage) and its served home copies are wiped. */
  async erase(id: string): Promise<void> {
    if (typeof id !== "string" || !ID_SITE.test(id)) return;
    await removeSiteContainer(id);
    if (dataDir) await forgetHome(dataDir, id);
  },
  /** site.json changed: the open app takes its new declaration and domains (its bfcache is dropped), without showing. */
  update(site: SiteOuvrable): void {
    const s = open.get(site?.id);
    if (!s || s.window.closed) return;
    s.site = site;
    s.view?.browsingContext?.sessionHistory?.evictAllDocumentViewers();
    // The home screen is gone: the site view (Electron's reprendre).
    if (s.vue === "accueil" && !site.aAccueil) {
      s.vue = "site";
      if (!s.loaded) loadInView(s, site.depart);
    }
    s.window.gBrowser?.updateTitlebar();
    broadcast(s);
  },
  openIds(): string[] {
    return [...open.values()].filter((s) => !s.window.closed).map((s) => s.site.id);
  },
  /** The app whose container this is, if its window is open. */
  siteOfContainer(userContextId: number): string | undefined {
    return byContainer.get(userContextId)?.site.id;
  },
  windowOf(id: string): Window | undefined {
    const s = open.get(id);
    return s && !s.window.closed ? s.window : undefined;
  },
  /** The app as its window was opened or last updated (the window reads it as it loads). */
  siteOf(id: string): SiteOuvrable | undefined {
    return open.get(id)?.site;
  },
  /** The window's controller, from its creation (site-window.ts); the view is attached once Firefox's startup is done. */
  controller(id: string): SiteWindowController | undefined {
    const s = open.get(id);
    return s ? controllerOf(s) : undefined;
  },
  attach(id: string, browser: any): void {
    const s = open.get(id);
    if (s) attach(s, browser);
  },
  /** window.open, target=_blank and links opened in a tab or a window: the app view, a sign-in window, or blocked. */
  routeOpen(id: string, url: string): "dans-l-appli" | "petite-fenetre" | "bloquer" {
    const s = open.get(id);
    if (!s) return "bloquer";
    const d = decisionOuverture(url, context(s));
    if (d === "dans-l-appli") loadInView(s, url);
    if (d === "bloquer") block(s, url);
    // Not Firefox's fall-through window: it would have every feature (a toolbar, so getTopWindow() would pick it).
    // shortcut: this window has no opener; upgrade if a sign-in opened by window.open without features needs one.
    if (d === "petite-fenetre") smallUrls.set(openInContainer(s.userContextId, null, "width=500,height=650"), url);
    return d;
  },
  /** The address a sign-in window opened by routeOpen loads, once (setupSiteSmallWindow). */
  takeSmallUrl(win: Window): string | undefined {
    const url = smallUrls.get(win);
    smallUrls.delete(win);
    return url;
  },
  /** The hosts blocked so far in the app's window (read by the e2e in place of the bar's mention until Task 4). */
  blocked(id: string): string[] {
    return open.get(id)?.blocked ?? [];
  },
  /** The host's requests (noyau/sites.ts SitesChrome), positional params. */
  handlers: {
    "sites.ouvrir": ([site, cadre]: [SiteOuvrable, Cadre | null]) => sites.open(site, cadre),
    "sites.fermer": ([id]: [string]) => sites.close(id),
    "sites.effacer": ([id]: [string]) => sites.erase(id),
    "sites.mettreAJour": ([site]: [SiteOuvrable]) => sites.update(site),
    "sites.ouvertes": () => sites.openIds(),
    // The home's files changed: served again; the bar's home frame reads homeUrl on the state broadcast.
    "sites.accueilChange": ([id]: [string]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      s.home = null;
      broadcast(s);
    },
  },
};

export type SiteApps = typeof sites;

/** Started with the store: the host the windows report to, and where the served home copies live. */
export function bindSites(agent: AgentHost, dir: string, openInTab: (url: string) => void): void {
  host = agent;
  dataDir = dir;
  openTab = openInTab;
  agent.on("sites.memoire", (p: { id?: unknown; message?: MessageVersLAccueil & { type: "memoire" } }) => {
    if (typeof p?.id !== "string" || !p.message) return;
    for (const cb of memoryListeners.get(p.id) ?? []) cb(p.message);
  });
}
