// A site app's window: browser.xhtml opened by store/sites.ts without a toolbar, marked from its creation, never a
// WebAiOs main window. One <browser> (the app view, in the app's container), Firefox's tabs and toolbars hidden, the
// bar's frame on top (sidebar.html?site=<id>, ui/SiteWindow.svelte).
import type { SiteWindowController } from "../store/sites";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor } from "./keys";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const XHTML = "http://www.w3.org/1999/xhtml";
// Keep in sync with store/sites.ts SITE_WINDOW_KEY.
const SITE_WINDOW_KEY = "webaios-site";

declare global {
  interface Window {
    /** In a site app's window: what its bar drives (ui/site-api.ts). */
    webaiosSiteWindow?: SiteWindowController;
  }
}

type Sites = typeof import("../store/sites").sites;
const sitesModule = (): Sites => ChromeUtils.importESModule(STORE).sites;

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
 * A sign-in window (`small`) opens nothing at all (Electron's equiperPetite).
 */
function routeOpens(win: Window, id: string, small = false): void {
  const firefox = (win as any).browserDOMWindow;
  const sites = sitesModule();
  const route = (uri: any, params: unknown, where: number, flags: number, name: string, inFrame: "createContentWindowInFrame" | "openURIInFrame") => {
    if (where === Ci.nsIBrowserDOMWindow.OPEN_PRINT_BROWSER) return firefox[inFrame](uri, params, where, flags, name);
    if (!small) sites.routeOpen(id, uri?.spec ?? "about:blank");
    // Nothing opened by Firefox: window.open returns null, as Electron's denied open.
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

/**
 * Run at the window's DOMContentLoaded, before anything could claim it: the bar's frame, the routing, the keys, closing
 * without a question, the title. The view is attached once Firefox's startup is done.
 */
export function setupSiteWindow(win: Window, id: string): SiteWindowController | null {
  const sites = sitesModule();
  const controller = sites.controller(id);
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
  };
  win.addEventListener("keydown", onKeyDown, true);
  bar.addEventListener("load", () => bar.contentWindow!.addEventListener("keydown", onKeyDown, true));
  // The site's code was not reviewed: its beforeunload never keeps the app from closing (Electron).
  win.CanCloseWindow = () => true;
  win.webaiosSiteWindow = controller;
  void win.delayedStartupPromise.then(() => {
    const gBrowser = win.gBrowser;
    // The title is the app's name, never the page's.
    gBrowser.getWindowTitleForBrowser = () => sites.siteOf(id)?.declaration.nom ?? "";
    gBrowser.updateTitlebar();
    sites.attach(id, gBrowser.selectedBrowser);
    bar.src = `chrome://browser/content/webaios/sidebar.html?site=${encodeURIComponent(id)}`;
  });
  return controller;
}

/**
 * A window an app's page opened (a sign-in window, in the app's container): Firefox's popup chrome (its read-only
 * address bar shows the site, against phishing), its own opens routed as the app's.
 */
export function setupSiteSmallWindow(win: Window, id: string): void {
  win.document.documentElement.setAttribute("webaios-site-small", id);
  // Now: Firefox's own browserDOMWindow (set before gBrowser, which this window already has) would open tabs elsewhere.
  routeOpens(win, id, true);
  void win.delayedStartupPromise.then(() => {
    const url = sitesModule().takeSmallUrl(win);
    if (url) win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  });
}

/**
 * Electron's home pages call `parent.postMessage`; from a sandboxed opaque frame Firefox refuses it towards a chrome
 * parent. Run first in the served copy (page world): `parent` (a [Replaceable] property) becomes an object whose
 * postMessage dispatches `webaios-home` on the frame's window, its detail the message as JSON, for the chrome to read.
 * Self-contained, serialized with toString().
 */
export function homeBridge(): void {
  const w = window as unknown as Record<string, any>;
  const stringify = JSON.stringify;
  const Custom = w.CustomEvent;
  const dispatch = w.dispatchEvent.bind(w);
  w.parent = Object.freeze({ postMessage: (m: unknown) => void dispatch(new Custom("webaios-home", { detail: stringify(m) })) });
}

export const HOME_BRIDGE = `<script>(${homeBridge.toString()})();</script>`;
