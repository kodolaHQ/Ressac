// Site app windows: the registry of open app windows, their containers, their bar's controller, and the guard that
// keeps each app on its domains before any request leaves. The host (noyau/sites.ts) owns the data; this module owns
// the windows.
import type { DesignState } from "../../shared/api";
import type { Cadre } from "../../shared/model";
import { INFO_NOTICE_DURATION_MS, HOME_OPEN_GAP_MS, ICON_MAX, type BarNotice, type SiteWindowState, type MessageToHome } from "../../shared/sites";
import type { TweakError } from "../../core/sites/injection";
import { decisionNavigation, openDecision, type NavigationContext } from "../../core/sites/navigation";
import { relativeUrl, urlOnDomain, hostInSite } from "../../../../packages/kernel/src/sites/urls";
import type { TweaksRead } from "../../../../packages/kernel/src/sites/lire";
import { ID_SITE } from "../../../../packages/kernel/src/sites/schemas";
import type { SiteChrome } from "../../host/sites";
import { gestureGuard } from "../../shared/widget-gesture";
import { HOST_EXITED, type AgentHost } from "../agent/host";
import type { DesignService } from "./design";
import { apps } from "./apps";
import { isSiteContainer, removeSiteContainer, siteContainer } from "./containers";
import { blockedNotice, httpHost, type BlockedNotice } from "./site-guard";
import { frameError, frameInjection, frameMemory, framePosition, frameResume, siteOfFrame } from "./site-frames";
import { forgetHome, serveHome, servedHost, siteImage } from "./site-home";

// Keep in sync with agent/site-actor.ts SITE_FRAMES.
const SITE_FRAMES = "webaios-sites";
/** The window.arguments[1] key that marks a site app window from its creation (read before store.windows.claim). */
export const SITE_WINDOW_KEY = "webaios-site";
/** 1200 × 800 by default, 360 × 240 at least. */
const SIZE = { largeur: 1200, hauteur: 800 };
const MIN = { largeur: 360, hauteur: 240 };

/** The open apps' containers (userContextId → app id), published to every content process: the site actor asks only there. */
export function publishSiteFrames(map: Map<number, string>): void {
  Services.ppmm.sharedData.set(SITE_FRAMES, map);
  Services.ppmm.sharedData.flush();
}

/** What the bar (ui/site-api.ts) drives, through `window.parent.webaiosSiteWindow`. */
export interface SiteWindowController {
  state(): SiteWindowState;
  onState(cb: (e: SiteWindowState) => void): () => void;
  /** « Autoriser » (oui) or « Ouvrir sans retouches » on the grant card; `empreinte` is the card's. */
  accord(yes: boolean, hash: string): Promise<void>;
  /** « Entrer dans le site »: the start address the first time only. */
  enter(): void;
  /** ⌂: the home screen; the site's page stays loaded behind it. */
  home(): void;
  back(): void;
  forward(): void;
  reload(): void;
  /** « Chercher la nouvelle adresse »: the host reads the reference page. */
  findAddress(): void;
  /** A navigation or an open of the app was refused: kept for « Ouvrir dans un onglet », mentioned in the bar. */
  blocked(url: string): void;
  /** « Ouvrir dans un onglet »: the last blocked link, in the last main window (its active space); the mention falls. */
  openBlocked(): void;
  memory(): Promise<(MessageToHome & { type: "memoire" }) | null>;
  onMemory(cb: (m: MessageToHome & { type: "memoire" }) => void): () => void;
  /**
   * The home screen asks for an address: on the current domain, just after a real
   * gesture in the home (consumed), one per ECART_OUVERTURE_ACCUEIL_MS; false if refused.
   */
  openFromHome(address: string): boolean;
  /** A site image for the home, as `data:`, loaded in the app's container; null if refused. */
  image(url: string): Promise<string | null>;
  /** The served copy's URL (re-served when the home's files change, then the state is broadcast), or null. */
  homeUrl(): Promise<string | null>;
  /** A real (isTrusted) press in the home's frame. */
  homeGesture(): void;
  /** Watches the home's frame: any document load in it other than a page of the served copy is cancelled before it starts. */
  guardHome(frame: HTMLIFrameElement): void;
  /** This window's design mode: the target is the controller's app (`site`), never an id from the bar. */
  design: { etat(): Promise<DesignState>; toggle(): void; relire(): void; openCart(): void; onChange(cb: () => void): () => void };
}

/** Where the design mode aims in an app's window. */
export interface SiteDesignView {
  win: Window;
  nom: string;
  vue: SiteWindowState["vue"];
  /** The app view's <browser>. */
  browser: any;
  /** The home's frame (data-testid site-cadre-accueil in the bar) when the home is shown and shows this app's served copy (homePage), else null. */
  home: HTMLIFrameElement | null;
  /** Where to aim, in the site window's coordinates: the home frame's (bar rect + frame rect), else the view's. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Whether the design mode can aim at the view. */
  available: boolean;
}

interface OpenSite {
  site: SiteChrome;
  /** The app's tweaks' files, as the host last read them. */
  retouches: TweaksRead;
  /** The tweaks' console (site-frames.ts frameError), until the window closes. */
  erreurs: TweakError[];
  userContextId: number;
  window: Window;
  /** The app view's <browser>, once the window is set up. */
  view: any;
  vue: SiteWindowState["vue"];
  /** The address to load once the card is answered (the agent's), and whether it asked for it. */
  aCharger: string | null;
  aChargerAgent: boolean;
  /** Has the start address been loaded (« Entrer dans le site » loads it once)? */
  loaded: boolean;
  listeners: Set<(e: SiteWindowState) => void>;
  /** browserIds of the sign-in windows (connexion) kept for this app. */
  small: Set<number>;
  /** The hosts of the blocked navigations and opens, in order (read by the e2e). */
  blocked: string[];
  notice: BlockedNotice;
  /** The served home copy, until the home's files change. */
  home: Promise<string | null> | null;
  /** When the home last opened an address. */
  lastHomeOpen: number;
  /** The address of the last load WebAiOs started in the view: the address follow reads it back. */
  target: string | null;
  /** A reading of the reference page is under way (the bar's button shows it). */
  searching: boolean;
  /** The host's mention (address changed, not found…); a blocked link replaces it: the bar shows one mention. */
  hostNotice: BarNotice | null;
  /** WebAiOs just started a load in the view; `wanted`: the view's current load is one (chargementVoulu). */
  wantNext: boolean;
  wanted: boolean;
}

const open = new Map<string, OpenSite>();
const byContainer = new Map<number, OpenSite>();
let host: AgentHost | null = null;
let dataDir = "";
let openTab: (url: string) => void = () => {};
let design: Pick<DesignService, "etat" | "toggle" | "relire" | "openCart" | "onChange"> | null = null;
/** The last real presses in each app's home (one allows one open). */
const gestures = gestureGuard<string>();
const memoryListeners = new Map<string, Set<(m: MessageToHome & { type: "memoire" }) => void>>();
/** Told after an app's window closed (the agent's questions on `site:<id>` fall). */
const closeListeners = new Set<() => void>();

const context = (s: OpenSite): NavigationContext => ({
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
  s.hostNotice = null;
  s.blocked.push(hostOf(url));
  s.notice.block(url);
}

/** The address follow: only an app that declares suiviAdresse; the host reads the reference page. */
function follow(s: OpenSite, url: string | null): void {
  if (!s.site.declaration.suiviAdresse || open.get(s.site.id) !== s) return;
  host?.notify("sites.chercher", { id: s.site.id, url });
}

/** A reload is a load WebAiOs started too (measured: the system principal): the follow aims at the page reloaded. */
function reloadView(s: OpenSite): void {
  s.wantNext = true;
  s.target = s.view?.currentURI?.spec ?? s.target;
  s.view?.reload();
}

function loadInView(s: OpenSite, url: string): void {
  s.wantNext = true;
  s.loaded = true;
  s.target = url;
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
    // An agent app's container: its own origin rule (store/apps.ts).
    if (apps.request(ch, li)) return;
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
      // A new load (not a redirect of one) is wanted if WebAiOs just started it; its redirects keep that.
      if (inView && li.redirectChain.length === 0) {
        s.wanted = s.wantNext;
        s.wantNext = false;
      }
      // Under the home or the card, the view loads only what WebAiOs starts. An add-on's tabs.reload,
      // goBack or goForward (no fixupAndLoadURIString to refuse them, see site-window.ts) is cancelled before it is sent.
      // The page's own navigations wait for « Entrer » too; Firefox's add-ons run in every app (§4.9).
      if (inView && s.vue !== "site" && !s.wanted) {
        console.warn(`[sites] chargement arrêté dans la vue (vue ${s.vue}, non voulu) : ${url.slice(0, 80)}`);
        return void ch.cancel(Cr.NS_BINDING_ABORTED);
      }
      if (decisionNavigation(url, ctx) === "suivre") return;
      ch.cancel(Cr.NS_BINDING_ABORTED);
      // A sign-in window's refused page is not mentioned.
      if (inView) block(s, url);
      // Sent off the site (a parked domain) during a load WebAiOs started (loadInView loads as the system principal): the
      // site may have moved. A redirect after a click in the page has the page's principal: nothing is read.
      if (inView && li.triggeringPrincipal.isSystemPrincipal && li.redirectChain.length > 0) follow(s, s.target);
      return;
    }
    // A sign-in window opens nothing.
    if (s.small.has(bc?.opener?.top?.browserId)) {
      ch.cancel(Cr.NS_BINDING_ABORTED);
      return closeStray(bc?.top?.embedderElement);
    }
    const d = openDecision(url, ctx);
    if (d === "petite-fenetre") return void s.small.add(browserId);
    ch.cancel(Cr.NS_BINDING_ABORTED);
    closeStray(bc?.top?.embedderElement);
    if (d === "dans-l-appli") loadInView(s, url);
    else block(s, url);
  },
};
let observing = false;

/** The request guard and the view policy: installed with the store (bindApps), and again (a no-op) with a site app's window. */
export function installGuard(): void {
  if (observing) return;
  observing = true;
  Services.obs.addObserver(observer, "http-on-modify-request");
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(viewPolicy.classID, "WebAiOs site view policy", POLICY_CONTRACT, viewPolicy);
  Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
}

const publishOpen = () => publishSiteFrames(new Map([...byContainer].map(([uc, s]) => [uc, s.site.id])));

/** The home's frame may show only a page (.html, so with the home's CSP) of the copy served now, or about:blank. */
function homePage(id: string, uri: { spec: string } | null): boolean {
  if (uri?.spec === "about:blank") return true;
  try {
    const u = new URL(uri?.spec ?? "");
    return u.protocol === "resource:" && u.host === servedHost(id) && /\.html$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** The network failures that make the app look for a new address, as Firefox statuses. */
const NETWORK_ERRORS = new Set<number>([
  Cr.NS_ERROR_UNKNOWN_HOST,
  Cr.NS_ERROR_CONNECTION_REFUSED,
  Cr.NS_ERROR_NET_TIMEOUT,
  Cr.NS_ERROR_NET_RESET,
  Cr.NS_ERROR_NET_INTERRUPT,
  Cr.NS_ERROR_OFFLINE,
  Cr.NS_ERROR_PROXY_CONNECTION_REFUSED,
]);

const POLICY_CONTRACT = "@webaios/site-view-policy;1";
/**
 * The app view shows only the web. A top-level load of the view that
 * is not http(s) (file: from ⌘O or a dropped file, mailto: and other external schemes before the OS handler is asked,
 * blob:, data:) is refused before its channel opens; it shows no error page, the view stays on its page. The request
 * guard above only sees HTTP channels. Firefox's own error pages still load.
 */
const viewPolicy = {
  classID: Components.ID("{6d1f3c2a-8b4e-4f7a-9c35-2e8d7a1b5f40}"),
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  createInstance: (iid: unknown) => (viewPolicy.QueryInterface as (iid: unknown) => unknown)(iid),
  shouldLoad(location: any, li: any): number {
    const accept = Ci.nsIContentPolicy.ACCEPT;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT || location.schemeIs("http") || location.schemeIs("https") || li.loadErrorPage) return accept;
    const browserId = li.browsingContext?.browserId;
    if (!browserId || (![...open.values()].some((s) => s.view?.browserId === browserId) && !apps.isAppView(browserId))) return accept;
    console.warn(`[sites] chargement arrêté dans la vue (hors du web) : ${String(location.spec).slice(0, 80)}`);
    return Ci.nsIContentPolicy.REJECT_REQUEST;
  },
  shouldProcess: () => Ci.nsIContentPolicy.ACCEPT,
};

/**
 * browser.xhtml with browser.js's window.arguments: [1] extra options (the marker), [5] the first tab's userContextId;
 * no URL ([0]), so nothing loads before the window is set up. No `toolbar` (nor `all`) feature: window.toolbar.visible is
 * false for good (its setter refuses), so BrowserWindowTracker.getTopWindow() never returns the window.
 */
export function openInContainer(userContextId: number, marker: unknown, size: string): Window {
  const container = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(Ci.nsISupportsPRUint32);
  container.data = userContextId;
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  for (const a of [null, marker, null, null, null, container]) args.appendElement(a);
  return Services.ww.openWindow(null, "chrome://browser/content/browser.xhtml", "_blank", `chrome,dialog=no,non-private,resizable,minimizable,titlebar,close,${size}`, args);
}

/** The frame kept, if it still meets a screen. */
function visible(c: Cadre): boolean {
  const screen = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager).screenForRect(c.x, c.y, c.largeur, c.hauteur);
  const [l, t, w, h] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
  screen.GetAvailRectDisplayPix(l, t, w, h);
  return c.x < l.value + w.value && c.x + c.largeur > l.value && c.y < t.value + h.value && c.y + c.hauteur > t.value;
}

/** The window's features: the kept frame (outer size), else 1200 × 800; 360 × 240 at least. */
export function frameFeatures(cadre: Cadre | null | undefined): string {
  const c = cadre && [cadre.x, cadre.y, cadre.largeur, cadre.hauteur].every(Number.isFinite) && visible(cadre) ? cadre : null;
  const width = Math.max(MIN.largeur, Math.round(c?.largeur ?? SIZE.largeur));
  const hauteur = Math.max(MIN.hauteur, Math.round(c?.hauteur ?? SIZE.hauteur));
  return `outerWidth=${width},outerHeight=${hauteur}${c ? `,left=${Math.round(c.x)},top=${Math.round(c.y)}` : ""}`;
}

/** The window's frame (its normal bounds), or null while it is minimized or fullscreen. Still read at unload. */
export function frameOf(win: Window): Cadre | null {
  if (win.windowState === win.STATE_MINIMIZED || win.windowState === win.STATE_FULLSCREEN) return null;
  return { x: win.screenX, y: win.screenY, largeur: win.outerWidth, hauteur: win.outerHeight };
}

function noteFrame(s: OpenSite): void {
  const cadre = frameOf(s.window);
  if (cadre) host?.notify("sites.noter", { id: s.site.id, cadre });
}

function stateOf(s: OpenSite): SiteWindowState {
  const url: string = s.view?.currentURI?.spec ?? "";
  return {
    id: s.site.id,
    nom: s.site.declaration.nom,
    vue: s.vue,
    aAccueil: s.site.aAccueil,
    domaine: httpHost(url) ?? httpHost(s.site.depart) ?? "",
    peutReculer: !!s.view?.canGoBack,
    peutAvancer: !!s.view?.canGoForward,
    suivi: s.site.declaration.suiviAdresse !== undefined,
    recherche: s.searching,
    avis: s.notice.avis ?? s.hostNotice,
    accord: s.vue === "accord" ? s.site.demande : null,
  };
}

/** After the card, the home if there is one, else the site (loaded on its start address the first time). */
function nextView(s: OpenSite): void {
  const agent = s.aChargerAgent;
  s.aChargerAgent = false;
  if (s.aCharger) {
    const to = s.aCharger;
    s.aCharger = null;
    loadInView(s, to);
  }
  // The agent asked for an address during the card: that is what the user sees, even if the app has a home.
  if (s.site.aAccueil && !agent) s.vue = "accueil";
  else {
    s.vue = "site";
    if (!s.loaded) loadInView(s, s.site.depart);
  }
}

function broadcast(s: OpenSite): void {
  if (s.window.closed) return;
  // The bar's frame covers the window on the home screen and on the grant card (window.css): the view stays behind.
  s.window.document.documentElement.toggleAttribute("webaios-site-home", s.vue !== "site");
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
    async accord(yes, hash) {
      if (open.get(id) !== s || typeof yes !== "boolean" || typeof hash !== "string" || hash.length > 128) return;
      await host?.request("sites.accorder", { id, oui: yes, empreinte: hash });
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
      if (s.vue === "site" && s.loaded) reloadView(s);
    },
    findAddress() {
      if (open.get(id) !== s || s.vue !== "site" || !s.site.declaration.suiviAdresse) return;
      // The page shown if it is on the site, else (error page, blocked link…) the start address.
      const url: string = s.view?.currentURI?.spec ?? "";
      follow(s, url && relativeUrl(url, s.site.domaines) !== null ? url : null);
    },
    blocked: (url) => block(s, url),
    openBlocked() {
      const url = s.notice.take();
      if (!url) return;
      broadcast(s);
      openTab(url);
    },
    memory: () => host?.request<(MessageToHome & { type: "memoire" }) | null>("sites.memoireAccueil", { id }).catch(() => null) ?? Promise.resolve(null),
    onMemory(cb) {
      let set = memoryListeners.get(id);
      if (!set) memoryListeners.set(id, (set = new Set()));
      set.add(cb);
      return () => void set.delete(cb);
    },
    openFromHome(address) {
      if (open.get(id) !== s || typeof address !== "string") return false;
      const now = Date.now();
      if (now - s.lastHomeOpen < HOME_OPEN_GAP_MS) return false;
      const url = urlOnDomain(address, httpHost(s.site.depart) ?? "", s.site.domaines, s.site.depart, { adressesLocales: !!context(s).adressesLocales });
      // Without a recent real gesture nothing opens: a home that asks on load would send back to the site at each ⌂.
      if (!url || !gestures.accepter(id, id) || s.vue !== "accueil") return false;
      loadInView(s, url);
      s.vue = "site";
      broadcast(s);
      s.lastHomeOpen = now;
      return true;
    },
    guardHome(frame) {
      const progress = (frame as any).browsingContext?.docShell?.QueryInterface(Ci.nsIWebProgress);
      if (!progress) return;
      const L = Ci.nsIWebProgressListener;
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
        onStateChange(_progress: unknown, request: any, flags: number) {
          if (flags & L.STATE_START && flags & L.STATE_IS_DOCUMENT && !homePage(id, request.QueryInterface(Ci.nsIChannel).originalURI)) request.cancel(Cr.NS_BINDING_ABORTED);
        },
      };
      progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
      // Kept on the frame, and gone with it (with its docShell): the docShell holds its progress listeners weakly.
      (frame as any).webaiosHomeGuard = listener;
    },
    image: async (url) => (open.get(id) === s && typeof url === "string" ? siteImage(s.userContextId, url, s.site.domaines) : null),
    homeUrl: () => (open.get(id) === s && s.site.aAccueil ? (s.home ??= serveHome(dataDir, id)) : Promise.resolve(null)),
    homeGesture() {
      if (open.get(id) === s) gestures.geste(id, id);
    },
    // Set by bindSites, before any app window opens.
    design: {
      etat: () => design!.etat({ type: "site", id }),
      toggle: () => void design!.toggle({ type: "site", id }),
      relire: () => void design!.relire({ type: "site", id }),
      openCart: () => void design!.openCart({ type: "site", id }),
      onChange(cb) {
        // accueil.change: sent at each kernel start, so a restarted host is read again.
        const offs = [...["design.change", "accueil.change", HOST_EXITED].map((m) => host!.on(m, () => cb())), design!.onChange(cb)];
        return () => offs.forEach((f) => f());
      },
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
    // The view's own page did not answer (DNS, refused, timeout, reset, offline). Never
    // NS_BINDING_ABORTED, which is our own refusals.
    onStateChange(progress: any, request: any, flags: number, status: number) {
      const L = Ci.nsIWebProgressListener;
      if (!progress.isTopLevel || !(flags & L.STATE_STOP) || !(flags & L.STATE_IS_DOCUMENT) || !NETWORK_ERRORS.has(status)) return;
      const failed: string | undefined = request instanceof Ci.nsIChannel ? request.URI.spec : undefined;
      follow(s, failed && /^https?:/i.test(failed) ? failed : s.target);
    },
    onLocationChange(progress: any, _request: unknown, _location: unknown, flags: number) {
      if (!progress.isTopLevel) return;
      browser.browsingContext?.sessionHistory?.evictAllDocumentViewers();
      // A new page: the mention of a link blocked on the previous one falls.
      if (!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)) {
        s.notice.clear();
        // The info mention falls at the next page too.
        if (s.hostNotice?.genre === "info") s.hostNotice = null;
      }
      // After the tab browser's own listener has updated canGoBack and canGoForward.
      Services.tm.dispatchToMainThread(() => broadcast(s));
    },
  });
  browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
  // An element's fullscreen in or out (the design mode stops, ✎ greys): the state is broadcast. Kept on the window.
  const fullscreen = ((win as any).webaiosSiteFullscreen = new (win as any).MutationObserver(() => broadcast(s)));
  fullscreen.observe(win.document.documentElement, { attributes: true, attributeFilter: ["inDOMFullscreen"] });
  // The favicon Firefox shows for the page (a data: URL from its FaviconLoader).
  let favicon: string | null = null;
  win.gBrowser.tabContainer.addEventListener("TabAttrModified", (e: CustomEvent<{ changed: string[] }>) => {
    if (!e.detail.changed.includes("image")) return;
    const icon = win.gBrowser.getIcon(win.gBrowser.selectedTab);
    if (typeof icon !== "string" || !icon.startsWith("data:image/") || icon.length > ICON_MAX || icon === favicon) return;
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
  // On the loaded window: the about:blank document a new window starts with unloads too. The rest of the closing is
  // released (closed) once the window is gone, before its startup too.
  win.addEventListener(
    "unload",
    () => {
      win.clearTimeout(pending);
      noteFrame(s);
    },
    { once: true },
  );
  if (s.vue === "site") loadInView(s, s.site.depart);
  broadcast(s);
}

/** The app's window is closed (from its creation: a ⌘W before its startup is done too). */
function closed(s: OpenSite): void {
  const id = s.site.id;
  s.listeners.clear();
  s.notice.dispose();
  if (byContainer.get(s.userContextId) === s) {
    byContainer.delete(s.userContextId);
    publishOpen();
  }
  // Reopened before this close: the sign-in windows are the new app's.
  if (open.get(id) !== s) return;
  open.delete(id);
  memoryListeners.delete(id);
  host?.notify("sites.ferme", { id });
  for (const cb of closeListeners)
    try {
      cb();
    } catch (e) {
      console.error("[sites] close listener failed:", e);
    }
  // Its sign-in windows close with it (the request guard refuses any page of a closed app's container anyway).
  // Only this app's: a main window is never closed here, whatever its tab's container.
  for (const w of Services.wm.getEnumerator("navigator:browser")) if (w.document.documentElement.getAttribute("webaios-site-small") === id) w.close();
}

/** Sign-in windows opened by sites.routeOpen, and the address each loads once set up (takeSmallUrl). */
const smallUrls = new Map<Window, string>();

/** The site apps' windows, for the host (handlers) and the store. */
export const sites = {
  /**
   * Opens the app's window, or brings it to the front without reloading it (its declaration and domains are taken
   * over). False if the id is not a site app's.
   */
  open(site: SiteChrome, cadre: Cadre | null | undefined, tweaks: TweaksRead): boolean {
    if (typeof site?.id !== "string" || !ID_SITE.test(site.id)) return false;
    const known = open.get(site.id);
    if (known && !known.window.closed) {
      sites.update(site, tweaks);
      if (known.window.windowState === known.window.STATE_MINIMIZED) (known.window as any).restore();
      known.window.focus();
      return true;
    }
    installGuard();
    const userContextId = siteContainer(site.id);
    const marker = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
    marker.setPropertyAsAString(SITE_WINDOW_KEY, site.id);
    const win = openInContainer(userContextId, marker, frameFeatures(cadre));
    // The card first if the tweaks need their grant: the view loads nothing until it is answered (nextView).
    const s: OpenSite = { site, retouches: tweaks, erreurs: [], userContextId, window: win, view: null, vue: site.accordRequis ? "accord" : site.aAccueil ? "accueil" : "site", aCharger: null, aChargerAgent: false, loaded: false, listeners: new Set(), small: new Set(), blocked: [], notice: blockedNotice(() => broadcast(s)), home: null, lastHomeOpen: -Infinity, target: null, searching: false, hostNotice: null, wantNext: false, wanted: false };
    open.set(site.id, s);
    byContainer.set(userContextId, s);
    publishOpen();
    const onClose = {
      observe(w: unknown, topic: string) {
        if (topic !== "domwindowclosed" || w !== win) return;
        Services.ww.unregisterNotification(onClose);
        closed(s);
      },
    };
    Services.ww.registerNotification(onClose);
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
  /**
   * Site.json or a tweak changed, or the app is opened again. The open app takes its new
   * declaration, domains and tweaks (its bfcache is dropped), without showing. The rights grew (the grant no longer
   * covers, or new rights after « Ouvrir sans retouches »): the card comes back and the loaded page is reloaded, without
   * the tweaks it had. The grant is no longer needed: the next view. The home is gone: the site. True if the page was
   * reloaded.
   */
  update(site: SiteChrome, tweaks: TweaksRead): boolean {
    const s = open.get(site?.id);
    if (!s || s.window.closed) return false;
    const before = s.site;
    s.site = site;
    s.retouches = tweaks;
    s.view?.browsingContext?.sessionHistory?.evictAllDocumentViewers();
    let reloaded = false;
    // The hash is that of the rights asked (empreinteDroits).
    const grown = before.demande.empreinte !== site.demande.empreinte;
    if (site.accordRequis && s.vue !== "accord" && (!before.accordRequis || grown)) {
      s.vue = "accord";
      if (s.loaded) {
        reloadView(s);
        reloaded = true;
      }
    } else if (s.vue === "accord" && !site.accordRequis) nextView(s);
    else if (s.vue === "accueil" && !site.aAccueil) nextView(s);
    s.window.gBrowser?.updateTitlebar();
    broadcast(s);
    return reloaded;
  },
  /** The choice made on the card (the grant, if given, is already kept in `site`). Nothing if the card is not shown. */
  afterAccord(id: string, site: SiteChrome | null): void {
    const s = open.get(id);
    if (!s || s.window.closed || s.vue !== "accord") return;
    if (site) s.site = site;
    // The grant given does not cover today's declaration (site.json rewritten meanwhile): the card stays.
    if (site?.accordRequis) return broadcast(s);
    // A page already loaded (without tweaks) is reloaded to receive them.
    const reload = site !== null && s.loaded && s.aCharger === null;
    nextView(s);
    if (reload) reloadView(s);
    broadcast(s);
  },
  /** The window's current view, or null if it is not open. */
  viewOf(id: string): SiteWindowState["vue"] | null {
    const s = open.get(id);
    return s && !s.window.closed ? s.vue : null;
  },
  rebroadcast(id: string): void {
    const s = open.get(id);
    if (s) broadcast(s);
  },
  /** The agent's dev tools reload the view: that load is WebAiOs's, not an add-on's (the M1 net spares it under the home). */
  markWanted(id: string): void {
    const s = open.get(id);
    if (s) s.wantNext = true;
  },
  /** The view's page reloaded, if it was ever loaded (its tweaks changed). */
  reloadView(id: string): void {
    const s = open.get(id);
    if (s?.loaded && !s.window.closed) reloadView(s);
  },
  /** The tweaks' console of the open app, or none. */
  errors(id: string): TweakError[] {
    return [...(open.get(id)?.erreurs ?? [])];
  },
  /** The site actor's "injection", for the frame of this WindowGlobalParent (site-frames.ts). */
  frameInjection(wgp: any) {
    const s = siteOfFrame(wgp, open.values());
    return frameInjection(wgp, s, !!(s && context(s).adressesLocales));
  },
  /** The site actor's "erreur": a tweak's error in the frame of this WindowGlobalParent. */
  frameError(wgp: any, e: unknown): void {
    frameError(siteOfFrame(wgp, open.values()), e);
  },
  /** The site actor's "memoire", for the frame of this WindowGlobalParent: relayed to the host. */
  frameMemory(wgp: any, request: unknown) {
    return frameMemory(wgp, siteOfFrame(wgp, open.values()), request, (p) => {
      if (!host) return Promise.reject(new Error("no host"));
      return host.request("sites.memoireOp", p);
    });
  },
  /** The site actor's "position": a video's position, relayed to the host. */
  framePosition(wgp: any, p: unknown): void {
    const s = siteOfFrame(wgp, open.values());
    framePosition(wgp, s, p, !!(s && context(s).adressesLocales), (q) => host?.notify("sites.position", q));
  },
  /** The site actor's "reprise": the position to resume, from the host. */
  frameResume(wgp: any, duration: unknown): Promise<number | null> {
    const s = siteOfFrame(wgp, open.values());
    return frameResume(wgp, s, duration, !!(s && context(s).adressesLocales), (q) => (host ? host.request<number | null>("sites.reprise", q) : Promise.resolve(null)));
  },
  /** « Afficher le dossier »: the app's folder shown in the file manager. */
  revealSite(id: string): void {
    if (typeof id !== "string" || !ID_SITE.test(id) || !dataDir) return;
    try {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(PathUtils.join(dataDir, "espace", "sites", id));
      f.reveal();
    } catch (e) {
      console.warn("[sites] dossier non affiché :", e);
    }
  },
  /**
   * The open windows for the agent: `url` the page shown, `domaine` the app's current
   * one (its start address's), `empreinte` today's declaration's, to which the agent's grant is tied.
   */
  forAgent(): { id: string; nom: string; url: string; domaine: string; empreinte: string }[] {
    return [...open.values()]
      .filter((s) => !s.window.closed)
      .map((s) => {
        const url: string = s.view?.currentURI?.spec ?? "";
        return { id: s.site.id, nom: s.site.declaration.nom, url: url && url !== "about:blank" ? url : s.site.depart, domaine: httpHost(s.site.depart) ?? "", empreinte: s.site.empreinte };
      });
  },
  /** The app view's <browser> and its window: never the bar, the home or the card, nor a sign-in window. */
  viewFor(id: string): { browser: any; window: Window } | undefined {
    const s = open.get(id);
    return s?.view && !s.window.closed ? { browser: s.view, window: s.window } : undefined;
  },
  /** Where the design mode aims and whether it is available; null if the window or its view is not there. */
  designView(id: string): SiteDesignView | null {
    const s = open.get(id);
    if (!s?.view || s.window.closed) return null;
    const win = s.window;
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    let home: HTMLIFrameElement | null = null;
    let bounds = rect(s.view);
    if (s.vue === "accueil") {
      const bar = win.document.getElementById("webaios-site-bar") as HTMLIFrameElement | null;
      const f = bar?.contentDocument?.querySelector('[data-testid="site-cadre-accueil"]') as HTMLIFrameElement | null;
      const spec = f?.contentDocument?.documentURI;
      if (bar && f && spec && spec !== "about:blank" && homePage(id, { spec })) {
        home = f;
        const [b, h] = [rect(bar), rect(f)];
        bounds = { x: b.x + h.x, y: b.y + h.y, width: h.width, height: h.height };
      }
    }
    const url: string = s.view.currentURI?.spec ?? "";
    const host = httpHost(url);
    const available =
      !win.document.documentElement.hasAttribute("inDOMFullscreen") &&
      (s.vue === "accueil"
        ? home !== null
        : s.vue === "site" && openDecision(url, context(s)) === "dans-l-appli" && host !== null && !hostInSite(host, context(s).connexion));
    return { win, nom: s.site.declaration.nom, vue: s.vue, browser: s.view, home, bounds, available };
  },
  /** A passing mention in the bar, gone after DUREE_AVIS_INFO_MS or at the next page; never over a blocked link's. */
  infoNotice(id: string, text: string): void {
    const s = open.get(id);
    if (!s || s.window.closed || s.notice.avis?.genre === "lien-bloque") return;
    const avis: BarNotice = { genre: "info", texte: text };
    s.hostNotice = avis;
    broadcast(s);
    setTimeout(() => {
      if (s.hostNotice !== avis) return;
      s.hostNotice = null;
      broadcast(s);
    }, INFO_NOTICE_DURATION_MS);
  },
  /** A load WebAiOs wants, on the app's domains only; kept for after the card. */
  navigateForAgent(id: string, url: string): "charge" | "en-attente" | "refuse" {
    const s = open.get(id);
    if (!s?.view || s.window.closed || openDecision(url, context(s)) !== "dans-l-appli") return "refuse";
    if (s.vue === "accord") {
      s.aCharger = url;
      s.aChargerAgent = true;
      return "en-attente";
    }
    loadInView(s, url);
    s.vue = "site";
    broadcast(s);
    return "charge";
  },
  onClosed(cb: () => void): () => void {
    closeListeners.add(cb);
    return () => void closeListeners.delete(cb);
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
  siteOf(id: string): SiteChrome | undefined {
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
    const d = openDecision(url, context(s));
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
    "sites.ouvrir": ([site, cadre, tweaks]: [SiteChrome, Cadre | null, TweaksRead]) => sites.open(site, cadre, tweaks),
    "sites.fermer": ([id]: [string]) => sites.close(id),
    "sites.effacer": ([id]: [string]) => sites.erase(id),
    "sites.mettreAJour": ([site, tweaks]: [SiteChrome, TweaksRead]) => sites.update(site, tweaks),
    "sites.rechargerVue": ([id]: [string]) => sites.reloadView(id),
    "sites.erreurs": ([id]: [string]) => sites.errors(id),
    "sites.vue": ([id]: [string]) => sites.viewOf(id),
    "sites.apresAccord": ([id, site]: [string, SiteChrome | null]) => sites.afterAccord(id, site),
    "sites.rediffuser": ([id]: [string]) => sites.rebroadcast(id),
    "sites.ouvertes": () => sites.openIds(),
    // The home's files changed: served again; the bar's home frame reads homeUrl on the state broadcast.
    // Address follow.
    "sites.cherche": ([id, yes]: [string, boolean]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      s.searching = yes;
      broadcast(s);
    },
    "sites.avis": ([id, a]: [string, BarNotice | null]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      s.notice.clear();
      s.hostNotice = a;
      broadcast(s);
    },
    "sites.adresseChangee": ([id, domains, depart, to]: [string, string[], string, string]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      // The card's « suivis »: the domains added by the follow (the host recomputes the same list).
      const declared = new Set(s.site.declaration.domaines.map((x) => x.toLowerCase()));
      const tracked = [...new Set(domains.map((x) => x.toLowerCase()).filter((x) => !declared.has(x)))];
      s.site = { ...s.site, domaines: domains, depart, demande: { ...s.site.demande, suivis: tracked } };
      if (s.vue === "accord") {
        // The card is shown: the view loads nothing before the choice; a page already loaded was on the old domain.
        if (s.loaded) {
          s.aCharger = to;
          s.aChargerAgent = false;
        }
        return broadcast(s);
      }
      loadInView(s, to);
      broadcast(s);
    },
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
export function bindSites(agent: AgentHost, dir: string, openInTab: (url: string) => void, d: NonNullable<typeof design>): void {
  host = agent;
  dataDir = dir;
  openTab = openInTab;
  design = d;
  agent.on("sites.memoire", (p: { id?: unknown; message?: MessageToHome & { type: "memoire" } }) => {
    if (typeof p?.id !== "string" || !p.message) return;
    for (const cb of memoryListeners.get(p.id) ?? []) cb(p.message);
  });
}
