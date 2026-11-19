// Site app windows: the registry of open app windows, their containers, their bar's controller, and the guard that
// keeps each app on its domains before any request leaves. The host (host/sites.ts) owns the data; this module owns
// the windows.
import type { Action, DesignState } from "../../shared/api";
import type { FrameBounds } from "../../shared/model";
import { DEFAULT_AURA, type AuraId } from "../../shared/aura";
import { INFO_NOTICE_DURATION_MS, ICON_MAX, type BarNotice, type SiteWindowState, type SiteStartRequest, type MessageToHome } from "../../shared/sites";
import type { TweakError } from "../../core/sites/injection";
import { decisionNavigation, homeOpenUrl, openDecision, type NavigationContext } from "../../core/sites/navigation";
import { relativeUrl, hostInSite } from "../../../../packages/kernel/src/sites/urls";
import type { TweaksRead } from "../../../../packages/kernel/src/sites/read";
import { ID_SITE } from "../../../../packages/kernel/src/sites/schemas";
import type { SiteChrome } from "../../host/sites";
import { gestureGuard } from "../../shared/widget-gesture";
import { HOST_EXITED, type AgentHost } from "../agent/host";
import type { DesignService } from "./design";
import { apps } from "./apps";
import { isSiteContainer, removeSiteContainer, siteContainer } from "./containers";
import { blockedNotice, httpHost, type BlockedNotice } from "./site-guard";
import { frameError, frameInjection, frameMemory, framePosition, frameResume, inheritedProfile, openedFromTab, siteOfFrame, type FrameSite } from "./site-frames";
import { forgetHome, serveHome, servedHost, siteImage } from "./site-home";
import { cutFrameNetwork } from "../window/frame-network";
import { testEnv } from "../test-env";

// Keep in sync with agent/site-actor.ts SITE_FRAMES.
const SITE_FRAMES = "ressac-sites";
/** The window.arguments[1] key that marks a site app window from its creation (read before store.windows.claim). */
export const SITE_WINDOW_KEY = "ressac-site";
/** 1200 × 800 by default, 360 × 240 at least. */
const SIZE = { width: 1200, height: 800 };
const MIN = { width: 360, height: 240 };

/** The open apps' containers (userContextId → app id), published to every content process: the site actor asks only there. */
export function publishSiteFrames(map: Map<number, string>): void {
  Services.ppmm.sharedData.set(SITE_FRAMES, map);
  Services.ppmm.sharedData.flush();
}

/** What the bar (ui/site-api.ts) drives, through `window.parent.ressacSiteWindow`. */
export interface SiteWindowController {
  state(): SiteWindowState;
  /** The aura of the space the app was opened from (the last main window's active space then). */
  aura(): AuraId;
  onState(cb: (e: SiteWindowState) => void): () => void;
  /** « Autoriser » (oui) or « Ouvrir sans retouches » on the grant card; `empreinte` is the card's. */
  grant(yes: boolean, hash: string): Promise<void>;
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
  memory(): Promise<(MessageToHome & { type: "memory" }) | null>;
  onMemory(cb: (m: MessageToHome & { type: "memory" }) => void): () => void;
  /**
   * The home screen asks for an address: on the current domain, just after a real
   * gesture in the home (consumed), one per HOME_OPEN_GAP_MS; false if refused.
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
  /** An address the home asked for that is not the accepted start: shown on the « Ouvrir l'appli ? » card over the home, or null. */
  homeAsk(): SiteStartRequest | null;
  /** The card's choice: « Ouvrir » loads the address it showed (`hash`), « Ne pas ouvrir » stays on the home. */
  answerHomeAsk(yes: boolean, hash: string): void;
  /** This window's design mode: the target is the controller's app (`site`), never an id from the bar. */
  design: { state(): Promise<DesignState>; toggle(): void; review(): void; openCart(): void; onChange(cb: () => void): () => void };
}

/** What the home's frame (ui/SiteHomeFrame.svelte) asks of the chrome, in an app window or over an essential tab. */
export type HomeChrome = Pick<SiteWindowController, "homeUrl" | "homeGesture" | "guardHome" | "homeAsk" | "answerHomeAsk">;

/** What the home shown over an app essential's tab drives (sidebar.html?tabhome, set on its frame as `ressacOverlay.api`). */
export interface TabHomeController extends HomeChrome, Pick<SiteWindowController, "enter" | "memory" | "onMemory" | "openFromHome" | "image"> {
  id: string;
  locale(): string;
  /** The tab's home changed (served again, hidden): the frame reads homeUrl again. */
  onState(cb: () => void): () => void;
}

/** Where the design mode aims in an app's window. */
export interface SiteDesignView {
  win: Window;
  name: string;
  viewState: SiteWindowState["viewState"];
  /** The app view's <browser>. */
  browser: any;
  /** The home's frame (data-testid site-home-frame in the bar) when the home is shown and shows this app's served copy (homePage), else null. */
  home: HTMLIFrameElement | null;
  /** Where to aim, in the site window's coordinates: the home frame's (bar rect + frame rect), else the view's. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Whether the design mode can aim at the view. */
  available: boolean;
}

interface OpenSite {
  site: SiteChrome;
  aura: AuraId;
  /** The app's tweaks' files, as the host last read them. */
  tweaks: TweaksRead;
  /** The tweaks' console (site-frames.ts frameError), until the window closes. */
  errors: TweakError[];
  userContextId: number;
  window: Window;
  /** The app view's <browser>, once the window is set up. */
  view: any;
  viewState: SiteWindowState["viewState"];
  /** The address to load once the card is answered (the agent's), and whether it asked for it. */
  toLoad: string | null;
  agentToLoad: boolean;
  /** Has the start address been loaded (« Entrer dans le site » loads it once)? */
  loaded: boolean;
  listeners: Set<(e: SiteWindowState) => void>;
  /** browserIds of the sign-in windows (connexion) kept for this app. */
  small: Set<number>;
  /** The hosts of the blocked navigations and opens, in order (read by the e2e). */
  blocked: string[];
  notice: BlockedNotice;
  /** When the home last opened an address. */
  lastHomeOpen: number;
  /** The address the home asked for, waiting on the card (homeAsk). */
  homeAsked?: SiteStartRequest | null;
  /** The address of the last load Ressac started in the view: the address follow reads it back. */
  target: string | null;
  /** A reading of the reference page is under way (the bar's button shows it). */
  searching: boolean;
  /** The host's mention (address changed, not found…); a blocked link replaces it: the bar shows one mention. */
  hostNotice: BarNotice | null;
  /** Ressac just started a load in the view; `wanted`: the view's current load is one (chargementVoulu). */
  wantNext: boolean;
  wanted: boolean;
}

const open = new Map<string, OpenSite>();
const byContainer = new Map<number, OpenSite>();
/**
 * App essentials' tabs, by their <browser> (registered at TabOpen, before their first load): their app, and once the
 * host answered (attachTab), what the frame decisions need. They get the window's frame decisions, not its guard.
 * A site.json, tweak or grant change reads them again (sites.tabsChange).
 */
const tabSites = new Map<any, TabSite>();
/**
 * `home`: the tab wants its app's home over its page (from its creation, and at each click on its essential); shown
 * once the host's reading says the app has a home and needs no grant. `frame`: the home's frame over the page.
 */
type TabSite = { id: string; s?: FrameSite; ready?: Promise<void>; home: boolean; frame?: HTMLIFrameElement; leaving?: ReturnType<typeof setTimeout>; lastHomeOpen: number; listeners: Set<() => void>; homeAsked?: SiteStartRequest | null };

/**
 * An agent-written home can compose any address on the app's domain (data in its query): only the accepted start opens
 * at once, any other waits for « Ouvrir » on the card over the home.
 */
const homeAsk = (site: SiteChrome, url: string): SiteStartRequest | null =>
  url === site.start ? null : { name: site.declaration.name, url, page: null, domains: [...site.domains], hash: `home ${url}` };

/** The served home copy of each app, shared by its window and its essentials' tabs, until its files change. */
const served = new Map<string, Promise<string | null>>();
const servedHome = (id: string): Promise<string | null> => {
  let p = served.get(id);
  if (p) return p;
  const serving = serveHome(dataDir, id, (id, token) => (host ? host.request<string[] | null>("sites.copyHome", { id, token }) : Promise.resolve(null)));
  served.set(id, serving);
  // A refusal (host restarting, home half written) is not kept: the next homeUrl tries again.
  void serving.then((u) => u === null && served.get(id) === serving && served.delete(id));
  return serving;
};

/**
 * The host's reading of a tab's app: its frame decisions, or the tab dropped if it never had any (unknown app, being deleted).
 * A re-read that gets nothing (site.json half written, host restarting) keeps the last decisions: a deletion closes the tab anyway.
 */
function readTab(browser: any, t: TabSite): Promise<void> {
  const read = (host ? host.request<{ site: SiteChrome; tweaks: TweaksRead } | null>("sites.tabSite", { id: t.id }) : Promise.resolve(null)).catch((e) => {
    console.warn(`[sites] ${t.id}: tab without its app:`, e);
    return null;
  });
  t.ready = read.then((p) => {
    if (tabSites.get(browser) !== t) return;
    if (p) {
      t.s = { site: p.site, tweaks: p.tweaks, view: browser, errors: t.s?.errors ?? [] };
      renderTab(browser, t);
    } else if (!t.s) {
      tabSites.delete(browser);
      publishOpen();
    }
  });
  return t.ready;
}

/** Where the frame decisions look: the open windows' views and the attached essentials' tabs. */
const frameSites = (): FrameSite[] => [...open.values(), ...[...tabSites.values()].flatMap((t) => (t.s ? [t.s] : []))];
let dispatch: (a: Action) => void = () => {};
let host: AgentHost | null = null;
let dataDir = "";
let openTab: (url: string) => void = () => {};
let activeAura: () => AuraId = () => DEFAULT_AURA;
let design: Pick<DesignService, "state" | "toggle" | "review" | "openCart" | "onChange"> | null = null;
/** The last real presses in each app's home (one allows one open). */
const gestures = gestureGuard<string>();
const memoryListeners = new Map<string, Set<(m: MessageToHome & { type: "memory" }) => void>>();
/** Told after an app's window closed (the agent's questions on `site:<id>` fall). */
const closeListeners = new Set<() => void>();

const context = (s: { site: SiteChrome }): NavigationContext => ({
  domains: s.site.domains,
  login: s.site.declaration.login ?? [],
  localAddresses: testEnv("RESSAC_TEST_LOCAL_ADDRESSES") === "1",
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
  if (!s.site.declaration.urlTracking || open.get(s.site.id) !== s) return;
  host?.notify("sites.lookup", { id: s.site.id, url });
}

/** A reload is a load Ressac started too (measured: the system principal): the follow aims at the page reloaded. */
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
 * asking browserDOMWindow): its first page decides (openDecision). A refused load is cancelled before the request
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
    // An app essential's tab, the tabs and popups it opens are a main window's: the app window's rules are not theirs.
    if (openedFromTab(li.browsingContext?.top?.embedderElement, isTabOfMainWindow)) return;
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
      // A new load (not a redirect of one) is wanted if Ressac just started it; its redirects keep that.
      if (inView && li.redirectChain.length === 0) {
        s.wanted = s.wantNext;
        s.wantNext = false;
      }
      // Under the home or the card, the view loads only what Ressac starts. An add-on's tabs.reload,
      // goBack or goForward (no fixupAndLoadURIString to refuse them, see site-window.ts) is cancelled before it is sent.
      // The page's own navigations wait for « Entrer » too; Firefox's add-ons run in every app (§4.9).
      if (inView && s.viewState !== "site" && !s.wanted) {
        console.warn(`[sites] load stopped in the view (view ${s.viewState}, unwanted): ${url.slice(0, 80)}`);
        return void ch.cancel(Cr.NS_BINDING_ABORTED);
      }
      if (decisionNavigation(url, ctx) === "follow") return;
      ch.cancel(Cr.NS_BINDING_ABORTED);
      // A sign-in window's refused page is not mentioned.
      if (inView) block(s, url);
      // Sent off the site (a parked domain) during a load Ressac started (loadInView loads as the system principal): the
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
    if (d === "small-window") return void s.small.add(browserId);
    ch.cancel(Cr.NS_BINDING_ABORTED);
    closeStray(bc?.top?.embedderElement);
    if (d === "in-app") loadInView(s, url);
    else block(s, url);
  },
};
let observing = false;

/** The request guard and the view policy: installed with the store (bindApps), and again (a no-op) with a site app's window. */
export function installGuard(): void {
  if (observing) return;
  observing = true;
  Services.obs.addObserver(observer, "http-on-modify-request");
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(viewPolicy.classID, "Ressac site view policy", POLICY_CONTRACT, viewPolicy);
  Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
}

const publishOpen = () =>
  publishSiteFrames(new Map([...[...tabSites.values()].map((t): [number, string] => [siteContainer(t.id), t.id]), ...[...byContainer].map(([uc, s]): [number, string] => [uc, s.site.id])]));

/** A <browser> TabSync registered (an app essential's) or whose tab it adopted (opened by one): never a site window's. */
function isTabOfMainWindow(browser: any): boolean {
  if (!browser) return false;
  if (tabSites.has(browser)) return true;
  try {
    // Not ownerGlobal: undefined from this module (see gone()).
    return !!browser.ownerDocument?.defaultView?.gBrowser?.getTabForBrowser(browser)?.hasAttribute("ressac-tab-id");
  } catch {
    return false;
  }
}

/** A browser whose window closed (no TabClose then). Not ownerGlobal: undefined from this module (measured), so every tab looked gone. */
function gone(browser: any): boolean {
  try {
    const win = browser.ownerDocument?.defaultView;
    return !browser.isConnected || !win || win.closed;
  } catch {
    return true;
  }
}

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

const POLICY_CONTRACT = "@ressac/site-view-policy;1";
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
    console.warn(`[sites] load stopped in the view (not the web): ${String(location.spec).slice(0, 80)}`);
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
function visible(c: FrameBounds): boolean {
  const screen = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager).screenForRect(c.x, c.y, c.width, c.height);
  const [l, t, w, h] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
  screen.GetAvailRectDisplayPix(l, t, w, h);
  return c.x < l.value + w.value && c.x + c.width > l.value && c.y < t.value + h.value && c.y + c.height > t.value;
}

/** The window's features: the kept frame (outer size), else 1200 × 800; 360 × 240 at least. */
export function frameFeatures(frame: FrameBounds | null | undefined): string {
  const c = frame && [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) && visible(frame) ? frame : null;
  const width = Math.max(MIN.width, Math.round(c?.width ?? SIZE.width));
  const height = Math.max(MIN.height, Math.round(c?.height ?? SIZE.height));
  return `outerWidth=${width},outerHeight=${height}${c ? `,left=${Math.round(c.x)},top=${Math.round(c.y)}` : ""}`;
}

/** The window's frame (its normal bounds), or null while it is minimized or fullscreen. Still read at unload. */
export function frameOf(win: Window): FrameBounds | null {
  if (win.windowState === win.STATE_MINIMIZED || win.windowState === win.STATE_FULLSCREEN) return null;
  return { x: win.screenX, y: win.screenY, width: win.outerWidth, height: win.outerHeight };
}

function noteFrame(s: OpenSite): void {
  const frame = frameOf(s.window);
  if (frame) host?.notify("sites.note", { id: s.site.id, frame: frame });
}

/** The language shown, set by bindSites (« fr » only before it). */
let shownLocale: () => string = () => "fr";

/** The language changed: every open app window reads its state again. */
export function relabelSiteWindows(): void {
  for (const s of open.values()) broadcast(s);
}

function stateOf(s: OpenSite): SiteWindowState {
  const url: string = s.view?.currentURI?.spec ?? "";
  return {
    id: s.site.id,
    name: s.site.declaration.name,
    viewState: s.viewState,
    hasHome: s.site.hasHome,
    domain: httpHost(url) ?? httpHost(s.site.start) ?? "",
    canGoBack: !!s.view?.canGoBack,
    canGoForward: !!s.view?.canGoForward,
    tracking: s.site.declaration.urlTracking !== undefined,
    search: s.searching,
    notice: s.notice.notice ?? s.hostNotice,
    grant: s.viewState === "grant" ? s.site.request : null,
    start: s.viewState === "grant" ? s.site.startCheck : null,
    locale: shownLocale(),
  };
}

/** After the card, the home if there is one, else the site (loaded on its start address the first time). */
function nextView(s: OpenSite): void {
  const agent = s.agentToLoad;
  s.agentToLoad = false;
  if (s.toLoad) {
    const to = s.toLoad;
    s.toLoad = null;
    loadInView(s, to);
  }
  // The agent asked for an address during the card: that is what the user sees, even if the app has a home.
  if (s.site.hasHome && !agent) s.viewState = "home";
  else {
    s.viewState = "site";
    if (!s.loaded) loadInView(s, s.site.start);
  }
}

function broadcast(s: OpenSite): void {
  if (s.window.closed) return;
  // The bar's frame covers the window on the home screen and on the grant card (window.css): the view stays behind.
  s.window.document.documentElement.toggleAttribute("ressac-site-home", s.viewState !== "site");
  const e = stateOf(s);
  for (const cb of s.listeners) cb(e);
}

function listenMemory(id: string, cb: (m: MessageToHome & { type: "memory" }) => void): () => void {
  let set = memoryListeners.get(id);
  if (!set) memoryListeners.set(id, (set = new Set()));
  set.add(cb);
  return () => void set.delete(cb);
}

/** Watches a home's frame: any document load in it other than a page of app `id`'s served copy is cancelled before it starts. */
function guardHome(id: string, frame: HTMLIFrameElement): void {
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
  (frame as any).ressacHomeGuard = listener;
}

const TAB_HOME_SRC = "chrome://browser/content/ressac/sidebar.html?tabhome";
/** The home's exit fade over a tab (window.css .ressac-tab-home[leaving]). */
const TAB_HOME_FADE_MS = 150;
/** The last real presses in each essential tab's home (one allows one open), by its browserId: never holds a <browser>. */
const tabGestures = gestureGuard<number>();

/**
 * The home over an essential tab's page, as the tab wants it: shown in a frame of the tab's browser stack (it follows the
 * tab's size and is hidden with it), or taken down on a fade. An app without a home, or whose tweaks wait for a grant
 * (no card in a tab), shows its site: the tab stops wanting the home until the next click on its essential.
 */
function renderTab(browser: any, t: TabSite): void {
  const site = t.s?.site;
  // An unaccepted start (its domains changed since) is like a waiting grant: the home opens nothing until the window's card.
  if (site && (!site.hasHome || site.grantRequired || site.startCheck)) t.home = false;
  const show = !!site && t.home && tabSites.get(browser) === t && !gone(browser) && !!browser.parentNode;
  const f = t.frame;
  if (show && f) {
    clearTimeout(t.leaving);
    f.removeAttribute("leaving");
  } else if (show) {
    const nf = browser.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement & { ressacOverlay?: { api: TabHomeController } };
    nf.className = "ressac-tab-home";
    nf.setAttribute("data-testid", "tab-home");
    browser.parentNode.append(nf);
    t.frame = nf;
    nf.ressacOverlay = { api: tabHomeController(browser, t) };
    if (cutFrameNetwork(nf)) nf.src = TAB_HOME_SRC;
  } else if (f && !f.hasAttribute("leaving")) {
    f.setAttribute("leaving", "");
    t.leaving = setTimeout(() => {
      f.remove();
      if (t.frame === f) t.frame = undefined;
    }, TAB_HOME_FADE_MS);
  }
  for (const cb of t.listeners) cb();
}

/** The window's home rules for an essential tab: its app's served copy, opens on its domains after a real press, loaded in the tab. */
function tabHomeController(browser: any, t: TabSite): TabHomeController {
  const live = () => tabSites.get(browser) === t && !gone(browser);
  const shown = () => live() && t.home && !!t.frame && !t.frame.hasAttribute("leaving");
  return {
    id: t.id,
    locale: () => shownLocale(),
    onState(cb) {
      t.listeners.add(cb);
      return () => void t.listeners.delete(cb);
    },
    enter() {
      if (!live()) return;
      t.home = false;
      renderTab(browser, t);
    },
    memory: () => (live() && host ? host.request<(MessageToHome & { type: "memory" }) | null>("sites.homeMemory", { id: t.id }).catch(() => null) : Promise.resolve(null)),
    onMemory: (cb) => listenMemory(t.id, cb),
    openFromHome(address) {
      const s = t.s;
      if (!s || !shown()) return false;
      const now = Date.now();
      const url = homeOpenUrl(address, s.site, t.lastHomeOpen, now, !!context(s).localAddresses);
      // Without a recent real press in this tab's home nothing opens, as in the window.
      if (!url || !tabGestures.accept(browser.browserId, t.id)) return false;
      t.lastHomeOpen = now;
      t.homeAsked = homeAsk(s.site, url);
      if (t.homeAsked) {
        for (const cb of t.listeners) cb();
        return false;
      }
      const uri = Services.io.newURI(url);
      browser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: siteContainer(t.id) }) });
      t.home = false;
      renderTab(browser, t);
      return true;
    },
    image: async (url) => (live() && t.s && typeof url === "string" ? siteImage(siteContainer(t.id), url, t.s.site.domains) : null),
    homeUrl: () => (live() && t.s?.site.hasHome ? servedHome(t.id) : Promise.resolve(null)),
    homeGesture() {
      if (shown()) tabGestures.gesture(browser.browserId, t.id);
    },
    guardHome: (frame) => guardHome(t.id, frame),
    homeAsk: () => (shown() ? (t.homeAsked ?? null) : null),
    answerHomeAsk(yes, hash) {
      const a = t.homeAsked;
      if (!a || a.hash !== hash || !shown()) return;
      t.homeAsked = null;
      if (yes) {
        t.lastHomeOpen = Date.now();
        const uri = Services.io.newURI(a.url);
        browser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: siteContainer(t.id) }) });
        t.home = false;
        renderTab(browser, t);
      } else for (const cb of t.listeners) cb();
    },
  };
}

function controllerOf(s: OpenSite): SiteWindowController {
  const id = s.site.id;
  return {
    state: () => stateOf(s),
    aura: () => s.aura,
    onState(cb) {
      s.listeners.add(cb);
      return () => void s.listeners.delete(cb);
    },
    async grant(yes, hash) {
      if (open.get(id) !== s || typeof yes !== "boolean" || typeof hash !== "string" || hash.length > 128) return;
      await host?.request("sites.grant", { id, yes: yes, hash: hash });
    },
    enter() {
      if (s.viewState === "grant") return;
      s.viewState = "site";
      if (!s.loaded) loadInView(s, s.site.start);
      broadcast(s);
    },
    home() {
      if (!s.site.hasHome || s.viewState === "grant") return;
      s.viewState = "home";
      broadcast(s);
    },
    back() {
      if (s.viewState === "site" && s.view?.canGoBack) s.view.goBack();
    },
    forward() {
      if (s.viewState === "site" && s.view?.canGoForward) s.view.goForward();
    },
    reload() {
      if (s.viewState === "site" && s.loaded) reloadView(s);
    },
    findAddress() {
      if (open.get(id) !== s || s.viewState !== "site" || !s.site.declaration.urlTracking) return;
      // The page shown if it is on the site, else (error page, blocked link…) the start address.
      const url: string = s.view?.currentURI?.spec ?? "";
      follow(s, url && relativeUrl(url, s.site.domains) !== null ? url : null);
    },
    blocked: (url) => block(s, url),
    openBlocked() {
      const url = s.notice.take();
      if (!url) return;
      broadcast(s);
      openTab(url);
    },
    memory: () => host?.request<(MessageToHome & { type: "memory" }) | null>("sites.homeMemory", { id }).catch(() => null) ?? Promise.resolve(null),
    onMemory: (cb) => listenMemory(id, cb),
    openFromHome(address) {
      if (open.get(id) !== s) return false;
      const now = Date.now();
      const url = homeOpenUrl(address, s.site, s.lastHomeOpen, now, !!context(s).localAddresses);
      // Without a recent real gesture nothing opens: a home that asks on load would send back to the site at each ⌂.
      if (!url || !gestures.accept(id, id) || s.viewState !== "home") return false;
      s.lastHomeOpen = now;
      s.homeAsked = homeAsk(s.site, url);
      if (s.homeAsked) {
        broadcast(s);
        return false;
      }
      loadInView(s, url);
      s.viewState = "site";
      broadcast(s);
      return true;
    },
    guardHome: (frame) => guardHome(id, frame),
    homeAsk: () => (open.get(id) === s && s.viewState === "home" ? (s.homeAsked ?? null) : null),
    answerHomeAsk(yes, hash) {
      const a = s.homeAsked;
      if (open.get(id) !== s || !a || a.hash !== hash || s.viewState !== "home") return;
      s.homeAsked = null;
      if (yes) {
        s.lastHomeOpen = Date.now();
        loadInView(s, a.url);
        s.viewState = "site";
      }
      broadcast(s);
    },
    image: async (url) => (open.get(id) === s && typeof url === "string" ? siteImage(s.userContextId, url, s.site.domains) : null),
    homeUrl: () => (open.get(id) === s && s.site.hasHome ? servedHome(id) : Promise.resolve(null)),
    homeGesture() {
      if (open.get(id) === s) gestures.gesture(id, id);
    },
    // Set by bindSites, before any app window opens.
    design: {
      state: () => design!.state({ type: "site", id }),
      toggle: () => void design!.toggle({ type: "site", id }),
      review: () => void design!.review({ type: "site", id }),
      openCart: () => void design!.openCart({ type: "site", id }),
      onChange(cb) {
        // accueil.change: sent at each kernel start, so a restarted host is read again.
        const offs = [...["design.change", "home.change", HOST_EXITED].map((m) => host!.on(m, () => cb())), design!.onChange(cb)];
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
  const listener = ((win as any).ressacSiteProgress = {
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
        if (s.hostNotice?.kind === "info") s.hostNotice = null;
      }
      // After the tab browser's own listener has updated canGoBack and canGoForward.
      Services.tm.dispatchToMainThread(() => broadcast(s));
    },
  });
  browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
  // An element's fullscreen in or out (the design mode stops, ✎ greys): the state is broadcast. Kept on the window.
  const fullscreen = ((win as any).ressacSiteFullscreen = new (win as any).MutationObserver(() => broadcast(s)));
  fullscreen.observe(win.document.documentElement, { attributes: true, attributeFilter: ["inDOMFullscreen"] });
  // The favicon Firefox shows for the page (a data: URL from its FaviconLoader).
  let favicon: string | null = null;
  win.gBrowser.tabContainer.addEventListener("TabAttrModified", (e: CustomEvent<{ changed: string[] }>) => {
    if (!e.detail.changed.includes("image")) return;
    const icon = win.gBrowser.getIcon(win.gBrowser.selectedTab);
    if (typeof icon !== "string" || !icon.startsWith("data:image/") || icon.length > ICON_MAX || icon === favicon) return;
    favicon = icon;
    host?.notify("sites.note", { id, favicon });
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
  if (s.viewState === "site") loadInView(s, s.site.start);
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
  // An essential's tab may still show the home: its frame unsubscribes as it goes.
  if (![...tabSites.values()].some((t) => t.id === id)) memoryListeners.delete(id);
  host?.notify("sites.closed", { id });
  for (const cb of closeListeners)
    try {
      cb();
    } catch (e) {
      console.error("[sites] close listener failed:", e);
    }
  // Its sign-in windows close with it (the request guard refuses any page of a closed app's container anyway).
  // Only this app's: a main window is never closed here, whatever its tab's container.
  for (const w of Services.wm.getEnumerator("navigator:browser")) if (w.document.documentElement.getAttribute("ressac-site-small") === id) w.close();
}

/** Sign-in windows opened by sites.routeOpen, and the address each loads once set up (takeSmallUrl). */
const smallUrls = new Map<Window, string>();

/** The site apps' windows, for the host (handlers) and the store. */
export const sites = {
  /**
   * Opens the app's window, or brings it to the front without reloading it (its declaration and domains are taken
   * over). False if the id is not a site app's.
   */
  open(site: SiteChrome, frame: FrameBounds | null | undefined, tweaks: TweaksRead): boolean {
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
    const win = openInContainer(userContextId, marker, frameFeatures(frame));
    // The card first if the start address or the tweaks need the user's yes: the view loads nothing until it is answered (nextView).
    const s: OpenSite = { site, aura: activeAura(), tweaks: tweaks, errors: [], userContextId, window: win, view: null, viewState: site.grantRequired || site.startCheck ? "grant" : site.hasHome ? "home" : "site", toLoad: null, agentToLoad: false, loaded: false, listeners: new Set(), small: new Set(), blocked: [], notice: blockedNotice(() => broadcast(s)), lastHomeOpen: -Infinity, target: null, searching: false, hostNotice: null, wantNext: false, wanted: false };
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
    // The page's « Supprimer » and the agent's both come through here: the app leaves the essentials and the bar, and
    // every tab of its container closes before the container is wiped (TabSync would create it again).
    dispatch({ type: "forgetSite", id });
    await removeSiteContainer(id);
    served.delete(id);
    if (dataDir) await forgetHome(dataDir, id);
  },
  /**
   * An app essential's tab: its container is published at once (the actor asks from its first document), its frame
   * decisions wait for the host's reading. An unknown app or one being deleted gets nothing.
   */
  async attachTab(id: string, browser: any): Promise<void> {
    if (typeof id !== "string" || !ID_SITE.test(id) || !browser || tabSites.get(browser)?.id === id) return;
    for (const b of tabSites.keys()) if (gone(b)) sites.detachTab(b);
    const t: TabSite = { id, home: true, lastHomeOpen: -Infinity, listeners: new Set() };
    tabSites.set(browser, t);
    publishOpen();
    await readTab(browser, t);
  },
  /** The essential's XUL tab closed; the host forgets the app's tab once its last one is gone. */
  detachTab(browser: any): void {
    const t = tabSites.get(browser);
    if (!t || !tabSites.delete(browser)) return;
    clearTimeout(t.leaving);
    t.frame?.remove();
    t.listeners.clear();
    publishOpen();
    if (![...tabSites.values()].some((x) => x.id === t.id)) host?.notify("sites.tabDetached", { id: t.id });
  },
  /** A click on the app's essential (or « Accueil de l'appli »): its tab shows the app's home, if it has one usable in a tab. */
  showTabHome(browser: any): void {
    const t = tabSites.get(browser);
    if (!t) return;
    t.home = true;
    renderTab(browser, t);
  },
  /** Whether the essential tab of this <browser> wants its home; with `home`, sets it (a tab moved to another window keeps it). */
  wantsHome(browser: any, home?: boolean): boolean | undefined {
    const t = tabSites.get(browser);
    if (t && home !== undefined) {
      t.home = home;
      renderTab(browser, t);
    }
    return t?.home;
  },
  /** Whether app `id`'s essential tabs can show its home (a home, no grant waiting), as last read. */
  tabHasHome(id: string): boolean {
    return [...tabSites.values()].some((t) => t.id === id && !!t.s?.site.hasHome && !t.s.site.grantRequired && !t.s.site.startCheck);
  },
  /** The login profile a page's new tab at `url` takes from its opener's `profile`. */
  childProfile<P extends string>(profile: P | undefined, url: string): P | undefined {
    return inheritedProfile(profile, url, frameSites());
  },
  /** A new host knows no tab: each one is read again (its tweaks refreshed too). */
  reattachTabs(): void {
    for (const [b, t] of [...tabSites]) if (!gone(b)) void readTab(b, t);
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
    s.tweaks = tweaks;
    s.view?.browsingContext?.sessionHistory?.evictAllDocumentViewers();
    let reloaded = false;
    // The hash is that of the rights asked (rightsHash).
    const grown = before.request.hash !== site.request.hash;
    // New start addresses: the card comes back over the page already shown (an accepted one), which stays as it is.
    if (site.startCheck && s.viewState !== "grant" && site.startCheck.hash !== before.startCheck?.hash) s.viewState = "grant";
    else if (site.grantRequired && s.viewState !== "grant" && (!before.grantRequired || grown)) {
      s.viewState = "grant";
      if (s.loaded) {
        reloadView(s);
        reloaded = true;
      }
    } else if (s.viewState === "grant" && !site.grantRequired && !site.startCheck) nextView(s);
    else if (s.viewState === "home" && !site.hasHome) nextView(s);
    s.window.gBrowser?.updateTitlebar();
    broadcast(s);
    return reloaded;
  },
  /** The choice made on the card (the grant, if given, is already kept in `site`). Nothing if the card is not shown. */
  afterGrant(id: string, site: SiteChrome | null): void {
    const s = open.get(id);
    if (!s || s.window.closed || s.viewState !== "grant") return;
    if (site) s.site = site;
    // The grant given does not cover today's declaration (site.json rewritten meanwhile): the card stays.
    if (site?.grantRequired || (site ?? s.site).startCheck) return broadcast(s);
    // A page already loaded (without tweaks) is reloaded to receive them.
    const reload = site !== null && s.loaded && s.toLoad === null;
    nextView(s);
    if (reload) reloadView(s);
    broadcast(s);
  },
  /** The window's current view, or null if it is not open. */
  viewOf(id: string): SiteWindowState["viewState"] | null {
    const s = open.get(id);
    return s && !s.window.closed ? s.viewState : null;
  },
  rebroadcast(id: string): void {
    const s = open.get(id);
    if (s) broadcast(s);
  },
  /** The agent's dev tools reload the view: that load is Ressac's, not an add-on's (the M1 net spares it under the home). */
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
    return [...(open.get(id)?.errors ?? [])];
  },
  /** The site actor's "injection", for the frame of this WindowGlobalParent (site-frames.ts). */
  async frameInjection(wgp: any) {
    // A tab's first document asks before the host has answered attachTab.
    let top: unknown;
    try {
      top = wgp.browsingContext.top.embedderElement;
    } catch {}
    await tabSites.get(top)?.ready;
    const s = siteOfFrame(wgp, frameSites());
    return frameInjection(wgp, s, !!(s && context(s).localAddresses));
  },
  /** The site actor's "error": a tweak's error in the frame of this WindowGlobalParent. */
  frameError(wgp: any, e: unknown): void {
    frameError(siteOfFrame(wgp, frameSites()), e);
  },
  /** The site actor's "memory", for the frame of this WindowGlobalParent: relayed to the host. */
  frameMemory(wgp: any, request: unknown) {
    return frameMemory(wgp, siteOfFrame(wgp, frameSites()), request, (p) => {
      if (!host) return Promise.reject(new Error("no host"));
      return host.request("sites.memoryOp", p);
    });
  },
  /** The site actor's "position": a video's position, relayed to the host. */
  framePosition(wgp: any, p: unknown): void {
    const s = siteOfFrame(wgp, frameSites());
    framePosition(wgp, s, p, !!(s && context(s).localAddresses), (q) => host?.notify("sites.position", q));
  },
  /** The site actor's "resume": the position to resume, from the host. */
  frameResume(wgp: any, duration: unknown): Promise<number | null> {
    const s = siteOfFrame(wgp, frameSites());
    return frameResume(wgp, s, duration, !!(s && context(s).localAddresses), (q) => (host ? host.request<number | null>("sites.resume", q) : Promise.resolve(null)));
  },
  /** « Afficher le dossier »: the app's folder shown in the file manager. */
  revealSite(id: string): void {
    if (typeof id !== "string" || !ID_SITE.test(id) || !dataDir) return;
    try {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(PathUtils.join(dataDir, "workspace", "sites", id));
      f.reveal();
    } catch (e) {
      console.warn("[sites] folder not shown:", e);
    }
  },
  /**
   * The open windows for the agent: `url` the page shown, `domaine` the app's current
   * one (its start address's), `empreinte` today's declaration's, to which the agent's grant is tied.
   */
  forAgent(): { id: string; name: string; url: string; domain: string; hash: string }[] {
    return [...open.values()]
      .filter((s) => !s.window.closed)
      .map((s) => {
        const url: string = s.view?.currentURI?.spec ?? "";
        return { id: s.site.id, name: s.site.declaration.name, url: url && url !== "about:blank" ? url : s.site.start, domain: httpHost(s.site.start) ?? "", hash: s.site.hash };
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
    if (s.viewState === "home") {
      const bar = win.document.getElementById("ressac-site-bar") as HTMLIFrameElement | null;
      const f = bar?.contentDocument?.querySelector('[data-testid="site-home-frame"]') as HTMLIFrameElement | null;
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
      (s.viewState === "home"
        ? home !== null
        : s.viewState === "site" && openDecision(url, context(s)) === "in-app" && host !== null && !hostInSite(host, context(s).login));
    return { win, name: s.site.declaration.name, viewState: s.viewState, browser: s.view, home, bounds, available };
  },
  /** A passing mention in the bar, gone after DUREE_AVIS_INFO_MS or at the next page; never over a blocked link's. */
  infoNotice(id: string, text: string): void {
    const s = open.get(id);
    if (!s || s.window.closed || s.notice.notice?.kind === "link-blocked") return;
    const notice: BarNotice = { kind: "info", text: text };
    s.hostNotice = notice;
    broadcast(s);
    setTimeout(() => {
      if (s.hostNotice !== notice) return;
      s.hostNotice = null;
      broadcast(s);
    }, INFO_NOTICE_DURATION_MS);
  },
  /** A load Ressac wants, on the app's domains only; kept for after the card. */
  navigateForAgent(id: string, url: string): "loaded" | "pending" | "refused" {
    const s = open.get(id);
    if (!s?.view || s.window.closed || openDecision(url, context(s)) !== "in-app") return "refused";
    if (s.viewState === "grant") {
      s.toLoad = url;
      s.agentToLoad = true;
      return "pending";
    }
    loadInView(s, url);
    s.viewState = "site";
    broadcast(s);
    return "loaded";
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
  routeOpen(id: string, url: string): "in-app" | "small-window" | "block" {
    const s = open.get(id);
    if (!s) return "block";
    const d = openDecision(url, context(s));
    if (d === "in-app") loadInView(s, url);
    if (d === "block") block(s, url);
    // Not Firefox's fall-through window: it would have every feature (a toolbar, so getTopWindow() would pick it).
    // shortcut: this window has no opener; upgrade if a sign-in opened by window.open without features needs one.
    if (d === "small-window") smallUrls.set(openInContainer(s.userContextId, null, "width=500,height=650"), url);
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
  /** The host's requests (host/sites.ts SitesChrome), positional params. */
  handlers: {
    "sites.open": ([site, frame, tweaks]: [SiteChrome, FrameBounds | null, TweaksRead]) => sites.open(site, frame, tweaks),
    "sites.close": ([id]: [string]) => sites.close(id),
    "sites.erase": ([id]: [string]) => sites.erase(id),
    "sites.update": ([site, tweaks]: [SiteChrome, TweaksRead]) => sites.update(site, tweaks),
    "sites.reloadView": ([id]: [string]) => sites.reloadView(id),
    "sites.errors": ([id]: [string]) => sites.errors(id),
    "sites.view": ([id]: [string]) => sites.viewOf(id),
    "sites.afterGrant": ([id, site]: [string, SiteChrome | null]) => sites.afterGrant(id, site),
    "sites.rebroadcast": ([id]: [string]) => sites.rebroadcast(id),
    "sites.openIds": () => sites.openIds(),
    // The home's files changed: served again; the bar's home frame reads homeUrl on the state broadcast.
    // Address follow.
    "sites.lookingUp": ([id, yes]: [string, boolean]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      s.searching = yes;
      broadcast(s);
    },
    "sites.notice": ([id, a]: [string, BarNotice | null]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      s.notice.clear();
      s.hostNotice = a;
      broadcast(s);
    },
    "sites.urlChanged": ([id, domains, start, to]: [string, string[], string, string]) => {
      const s = open.get(id);
      if (!s || s.window.closed) return;
      // The card's « suivis »: the domains added by the follow (the host recomputes the same list).
      const declared = new Set(s.site.declaration.domains.map((x) => x.toLowerCase()));
      const tracked = [...new Set(domains.map((x) => x.toLowerCase()).filter((x) => !declared.has(x)))];
      s.site = { ...s.site, domains: domains, start: start, request: { ...s.site.request, tracked: tracked } };
      if (s.viewState === "grant") {
        // The card is shown: the view loads nothing before the choice; a page already loaded was on the old domain.
        if (s.loaded) {
          s.toLoad = to;
          s.agentToLoad = false;
        }
        return broadcast(s);
      }
      loadInView(s, to);
      broadcast(s);
    },
    // The app's site.json, tweaks or grant changed: its essentials' tabs read them again (their next loads apply them).
    "sites.tabsChange": ([id]: [string]) => {
      for (const [b, t] of [...tabSites]) if (t.id === id && !gone(b)) void readTab(b, t);
    },
    // Served again at the next homeUrl; the essentials' tabs read their app again (a home that appeared or went).
    "sites.homeChange": ([id]: [string]) => {
      served.delete(id);
      for (const [b, t] of [...tabSites]) if (t.id === id && !gone(b)) void readTab(b, t);
      const s = open.get(id);
      if (!s || s.window.closed) return;
      broadcast(s);
    },
  },
};

export type SiteApps = typeof sites;

/** Started with the store: the host the windows report to, and where the served home copies live. */
export function bindSites(agent: AgentHost, dir: string, openInTab: (url: string) => void, d: NonNullable<typeof design>, locale: () => string, aura: () => AuraId, act: (a: Action) => void): void {
  dispatch = act;
  shownLocale = locale;
  activeAura = aura;
  host = agent;
  dataDir = dir;
  openTab = openInTab;
  design = d;
  agent.on("sites.memory", (p: { id?: unknown; message?: MessageToHome & { type: "memory" } }) => {
    if (typeof p?.id !== "string" || !p.message) return;
    for (const cb of memoryListeners.get(p.id) ?? []) cb(p.message);
  });
}
