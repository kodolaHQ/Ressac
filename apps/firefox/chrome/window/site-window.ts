// A site app's window: browser.xhtml opened by store/sites.ts without a toolbar, marked from its creation, never a
// WebAiOs main window. One <browser> (the app view, in the app's container), Firefox's tabs and toolbars hidden, the
// bar's frame on top (sidebar.html?site=<id>, ui/SiteWindow.svelte).
import type { SiteWindowController } from "../store/sites";
import { createSiteAddons, type WindowAddons } from "./addons";
import { cutFrameNetwork } from "./frame-network";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor } from "./keys";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const XHTML = "http://www.w3.org/1999/xhtml";
// Keep in sync with store/sites.ts SITE_WINDOW_KEY.
const SITE_WINDOW_KEY = "webaios-site";

declare global {
  interface Window {
    /** In a site app's window: what its bar drives (ui/site-api.ts), and its add-on buttons once Firefox's startup is done. */
    webaiosSiteWindow?: SiteWindowController & { addons?: WindowAddons };
  }
}

type Sites = typeof import("../store/sites").sites;
const sitesModule = (): Sites => ChromeUtils.importESModule(STORE).sites;
const designShortcut = (win: Window) => void ChromeUtils.importESModule(STORE).ready.then((store: import("../store").WebAiOsStore) => store.design.shortcut(win));

/** The app id this window was opened for (window.arguments[1], set by sites.open), or null. */
export function siteIdOf(win: Window): string | null {
  const options = (win as any).arguments?.[1];
  return options instanceof Ci.nsIPropertyBag2 && options.hasKey(SITE_WINDOW_KEY) ? options.getPropertyAsAString(SITE_WINDOW_KEY) : null;
}

/** The app whose container this window's first browser is in (a window the app's pages opened), or undefined. */
export function siteOfContainer(win: Window): string | undefined {
  const userContextId = Number(win.gBrowser?.selectedBrowser?.getAttribute("usercontextid") || 0);
  return userContextId ? sitesModule().siteOfContainer(userContextId) : undefined;
}

/**
 * Everything the app's pages would open elsewhere goes through the app's rules (sites.routeOpen): the app view, a
 * sign-in window opened by the store, or nothing.
 * - window.open and target=_blank: Firefox asks browserDOMWindow for what it would open as a tab. Printing keeps
 *   Firefox's own path.
 * - ⌘click, middle click and the context menu's « open in a tab/window »: openLinkIn, which would put a tab in the
 *   main window, in the app's container. Alt+click's « save » does nothing.
 * A sign-in window (`small`) opens nothing at all.
 */
function routeOpens(win: Window, id: string, small = false): void {
  const firefox = (win as any).browserDOMWindow;
  const sites = sitesModule();
  const route = (uri: any, params: unknown, where: number, flags: number, name: string, inFrame: "createContentWindowInFrame" | "openURIInFrame") => {
    if (where === Ci.nsIBrowserDOMWindow.OPEN_PRINT_BROWSER) return firefox[inFrame](uri, params, where, flags, name);
    if (!small) sites.routeOpen(id, uri?.spec ?? "about:blank");
    // Nothing opened by Firefox: window.open returns null, as for any denied open.
    throw Cr.NS_ERROR_ABORT;
  };
  (win as any).browserDOMWindow = {
    QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
    createContentWindowInFrame: (uri: any, params: unknown, where: number, flags: number, name: string) => route(uri, params, where, flags, name, "createContentWindowInFrame"),
    openURIInFrame: (uri: any, params: unknown, where: number, flags: number, name: string) => route(uri, params, where, flags, name, "openURIInFrame"),
    // Links from outside (the OS, another app) never land in an app window.
    openURI: () => null,
    canClose: () => true,
    get tabCount() {
      return 1;
    },
  };
  const openLinkIn = win.openLinkIn;
  win.openLinkIn = (url, where, params) => {
    if (where === "current") return openLinkIn(url, where, params);
    if (where !== "save" && !small) sites.routeOpen(id, url);
  };
}

// The errors an add-on's tabs call receives. Thrown as plain objects: Firefox's extension code passes their
// message on, where an Error from this window would reach the add-on as « An unexpected error occurred ».
const PROTECTED = { message: "Onglet protégé par WebAiOs" };
const REFUSED = { message: "Chargement refusé par WebAiOs" };

// An agent app's view too (its window: window/app-window.ts).
const isSiteTab = (tab: any) => !!tab?.ownerDocument?.documentElement && ["webaios-site", "webaios-app"].some((x) => tab.ownerDocument.documentElement.hasAttribute(x));

/**
 * The app view is never a tab add-ons can close, move out, add to, or send off the web (spec §4.9). Its window has one
 * tab, the view: removing or detaching it is refused, and so is any new tab. tabs.update goes through
 * fixupAndLoadURIString: refused unless the view shows the site (never the page hidden under the home or
 * the accord card) and the address is http(s). WebAiOs's own loads (the system principal) pass. Its reload, goBack and
 * goForward are stopped by the request guard (store/sites.ts). windows.remove of this window is refused;
 * WebAiOs's own close() calls, ⌘W and the window's close button still close it.
 * `showsPage`: may an add-on load in the view now (an agent app's window: always; the guard keeps it on its origin)?
 */
export function protectView(win: Window, showsPage: () => boolean): void {
  const close = win.close;
  win.close = function () {
    // ext-windows.js's windows.remove calls window.close(): no other way to tell an add-on's call from WebAiOs's.
    if (new Error().stack?.includes("/ext-windows.js")) throw PROTECTED;
    return close.call(this);
  };
  const g = win.gBrowser;
  for (const name of ["removeTab", "removeTabs", "replaceTabWithWindow", "replaceTabsWithWindow"])
    g[name] = () => {
      throw PROTECTED;
    };
  for (const name of ["addTab", "addTrustedTab"])
    g[name] = () => {
      throw REFUSED;
    };
  const browser = g.selectedBrowser;
  const load = browser.fixupAndLoadURIString;
  browser.fixupAndLoadURIString = function (url: string, options: any) {
    if (!options?.triggeringPrincipal?.isSystemPrincipal && (!showsPage() || !/^https?:/i.test(url))) throw REFUSED;
    return load.call(this, url, options);
  };
}

/**
 * Any other window (main, popup): a site app's or an agent app's view never comes into it. Neither by adoptTab (an add-on's tabs.move to
 * this window) nor as the tab a new window adopts (windows.create({ tabId })): that one opens empty. Run at
 * DOMContentLoaded (window.js comes after browser-main.js, whose DOMContentLoaded made gBrowser), before
 * browser-init.js's onLoad swaps the adopted tab in.
 */
export function refuseSiteTabs(win: Window): void {
  const init = (win as any).gBrowserInit;
  if (isSiteTab(init?.getTabToAdopt())) init._clearTabToAdopt();
  const g = win.gBrowser;
  const adopt = g.adoptTab;
  g.adoptTab = function (tab: any, options: unknown) {
    if (isSiteTab(tab)) throw PROTECTED;
    return adopt.call(this, tab, options);
  };
}

/**
 * Run at the window's DOMContentLoaded, before anything could claim it: the bar's frame, the routing, the keys, closing
 * without a question, the title. The view is attached once Firefox's startup is done.
 */
export function setupSiteWindow(win: Window, id: string): SiteWindowController | null {
  const sites = sitesModule();
  const controller: (SiteWindowController & { addons?: WindowAddons }) | undefined = sites.controller(id);
  // An app closed (deleted) while its window was opening.
  if (!controller) {
    win.close();
    return null;
  }
  const doc = win.document;
  doc.documentElement.setAttribute("webaios-site", id);
  doc.getElementById("navigator-toolbox")!.hidden = true;
  const bar = doc.createElementNS(XHTML, "iframe") as HTMLIFrameElement;
  bar.id = "webaios-site-bar";
  doc.getElementById("browser")!.before(bar);
  const mayLoad = cutFrameNetwork(bar);
  routeOpens(win, id);
  // Firefox's tab, address and history keys and menu commands do nothing here; ⌘W closes the window, never its one
  // tab; ⌘N opens a main window. Back and forward go through the bar.
  for (const k of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS, "goBackKb", "goForwardKb"]) doc.getElementById(k)?.setAttribute("disabled", "true");
  const onKeyDown = (e: KeyboardEvent) => {
    const s = shortcutFor(e);
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (s.type === "fenetre") win.OpenBrowserWindow();
    else if (s.type === "fermerFenetre" || (s.type === "raccourci" && s.r === "fermerOnglet")) win.close();
    else if (s.type === "design") designShortcut(win);
  };
  win.addEventListener("keydown", onKeyDown, true);
  bar.addEventListener("load", () => bar.contentWindow!.addEventListener("keydown", onKeyDown, true));
  // The site's code was not reviewed: its beforeunload never keeps the app from closing.
  win.CanCloseWindow = () => true;
  win.webaiosSiteWindow = controller;
  // Now: gBrowser and its one browser, the view, exist (browser-main.js's DOMContentLoaded ran before this one).
  protectView(win, () => controller.state().vue === "site");
  void win.delayedStartupPromise.then(() => {
    const gBrowser = win.gBrowser;
    // The title is the app's name, never the page's.
    gBrowser.getWindowTitleForBrowser = () => sites.siteOf(id)?.declaration.nom ?? "";
    gBrowser.updateTitlebar();
    sites.attach(id, gBrowser.selectedBrowser);
    controller.addons = createSiteAddons(win, controller);
    if (mayLoad) bar.src = `chrome://browser/content/webaios/sidebar.html?site=${encodeURIComponent(id)}`;
  });
  return controller;
}

/**
 * A window an app's page opened (a sign-in window, in the app's container): Firefox's popup chrome (its read-only
 * address bar shows the site, against phishing), its own opens routed as the app's.
 */
export function setupSiteSmallWindow(win: Window, id: string): void {
  win.document.documentElement.setAttribute("webaios-site-small", id);
  // ⇧⌘D: the avis in the app's bar (store.design.shortcut), never Firefox's « bookmark all tabs »; no other key is taken.
  for (const k of ["bookmarkAllTabsKb", "Browser:BookmarkAllTabs"]) win.document.getElementById(k)?.setAttribute("disabled", "true");
  win.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (shortcutFor(e)?.type !== "design") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      designShortcut(win);
    },
    true,
  );
  // Now: Firefox's own browserDOMWindow (set before gBrowser, which this window already has) would open tabs elsewhere.
  routeOpens(win, id, true);
  void win.delayedStartupPromise.then(() => {
    const url = sitesModule().takeSmallUrl(win);
    if (url) win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  });
}
