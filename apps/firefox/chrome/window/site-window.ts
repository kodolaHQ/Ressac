// A site app's window (prototype of plan 31's spike, taken over by its Tasks 3-4): browser.xhtml opened by
// store/sites.ts without a toolbar, marked from its creation, never a WebAiOs main window. One <browser> (the app
// view, in the app's container), Firefox's tabs and toolbars hidden, the bar's frame on top.
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const XHTML = "http://www.w3.org/1999/xhtml";
// Keep in sync with store/sites.ts SITE_WINDOW_KEY.
const SITE_WINDOW_KEY = "webaios-site";

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
  return userContextId ? sitesModule().ofContainer(userContextId) : undefined;
}

/**
 * window.open and target=_blank from the app's pages (Firefox asks browserDOMWindow for what it would open as a tab):
 * the app view, a sign-in window opened by the store, or nothing. Printing keeps Firefox's own path.
 */
function routeOpens(win: Window, id: string): void {
  const firefox = (win as any).browserDOMWindow;
  const sites = sitesModule();
  const route = (uri: any, params: unknown, where: number, flags: number, name: string, inFrame: "createContentWindowInFrame" | "openURIInFrame") => {
    if (where === Ci.nsIBrowserDOMWindow.OPEN_PRINT_BROWSER) return firefox[inFrame](uri, params, where, flags, name);
    sites.routeOpen(id, uri?.spec ?? "about:blank");
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
}

/** Run at the window's DOMContentLoaded, before anything could claim it. */
export function setupSiteWindow(win: Window, id: string): void {
  const doc = win.document;
  doc.documentElement.setAttribute("webaios-site", id);
  doc.getElementById("navigator-toolbox")!.hidden = true;
  const bar = doc.createElementNS(XHTML, "iframe") as HTMLIFrameElement;
  bar.id = "webaios-site-bar";
  bar.style.cssText = "border: none; height: 36px; width: 100%; display: block;";
  doc.getElementById("browser")!.before(bar);
  routeOpens(win, id);
  void win.delayedStartupPromise.then(() => {
    const browser = win.gBrowser.selectedBrowser;
    // A page kept in the bfcache comes back without a request, so without the request guard (measured: history.back()
    // to a removed domain, zero request): none is kept, dropped at each location change and when the rules change.
    // Kept on the window: the browser holds its progress listeners weakly.
    const listener = ((win as any).webaiosSiteProgress = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(progress: any) {
        if (progress.isTopLevel) browser.browsingContext?.sessionHistory?.evictAllDocumentViewers();
      },
    });
    browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
    sitesModule().attach(id, browser);
    bar.src = `chrome://browser/content/webaios/sidebar.html?site=${encodeURIComponent(id)}`;
  });
}

/**
 * A window an app's page opened (a sign-in window, in the app's container): Firefox's popup chrome (its read-only
 * address bar shows the site, against phishing), its own opens routed as the app's.
 */
export function setupSiteSmallWindow(win: Window, id: string): void {
  win.document.documentElement.setAttribute("webaios-site-small", id);
  // Now: Firefox's own browserDOMWindow (set before gBrowser, which this window already has) would open tabs elsewhere.
  routeOpens(win, id);
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
