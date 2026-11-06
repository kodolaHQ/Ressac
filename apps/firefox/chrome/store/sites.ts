// Site app windows (prototype of plan 31's spike, taken over by its Tasks 3-4): the registry of open app windows, their
// containers, and the guard that keeps each app on its domains before any request leaves.
import { decisionNavigation, decisionOuverture, type ContexteNavigation } from "../../../navigateur/src/main/sites/navigation";
import type { SiteFrameData } from "../agent/site-actor";
import { containerFor } from "./containers";

// Keep in sync with agent/site-actor.ts SITE_FRAMES.
const SITE_FRAMES = "webaios-sites";
/** The window.arguments[1] key that marks a site app window from its creation (read before store.windows.claim). */
export const SITE_WINDOW_KEY = "webaios-site";

/** What the site actor runs in each frame of a container: published to every content process. */
export function publishSiteFrames(map: Map<number, SiteFrameData>): void {
  Services.ppmm.sharedData.set(SITE_FRAMES, map);
  Services.ppmm.sharedData.flush();
}

export interface SiteRules {
  id: string;
  nom: string;
  adresse: string;
  domaines: string[];
  connexion: string[];
}

interface OpenSite {
  rules: SiteRules;
  userContextId: number;
  window: Window;
  /** The app view's <browser>, once the window is set up. */
  view: any;
  /** browserIds of the sign-in windows (connexion) kept for this app. */
  small: Set<number>;
  /** The hosts of the blocked navigations and opens, in order (the bar's mention reads the last one). */
  blocked: string[];
}

const open = new Map<string, OpenSite>();
const byContainer = new Map<number, OpenSite>();

const context = (s: OpenSite): ContexteNavigation => ({
  domaines: s.rules.domaines,
  connexion: s.rules.connexion,
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
}

function loadInView(s: OpenSite, url: string): void {
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
 * is sent, with NS_BINDING_ABORTED so that the view stays on its page (no error page).
 * shortcut: preconnects and speculative connections never reach this observer (a TCP connection, no HTTP request);
 * upgrade if a blocked host must never see a connection.
 */
const observer = {
  observe(subject: any) {
    const ch = subject.QueryInterface(Ci.nsIHttpChannel);
    const li = ch.loadInfo;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) return;
    const s = byContainer.get(li.originAttributes.userContextId);
    if (!s) return;
    const url: string = ch.URI.spec;
    const bc = li.browsingContext;
    const browserId: number = ch.browserId || bc?.browserId;
    const ctx = context(s);
    if (browserId === s.view?.browserId || s.small.has(browserId)) {
      if (decisionNavigation(url, ctx) === "suivre") return;
      ch.cancel(Cr.NS_BINDING_ABORTED);
      return block(s, url);
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

/** Sign-in windows opened by sites.routeOpen, and the address each loads once set up (takeSmallUrl). */
const smallUrls = new Map<Window, string>();

export const sites = {
  /** Opens the app's window, or brings it to the front with the new rules (rules changed: its bfcache is dropped). */
  open(rules: SiteRules): Window {
    const known = open.get(rules.id);
    if (known && !known.window.closed) {
      known.rules = rules;
      known.view?.browsingContext?.sessionHistory?.evictAllDocumentViewers();
      known.window.focus();
      return known.window;
    }
    if (!observing) {
      observing = true;
      Services.obs.addObserver(observer, "http-on-modify-request");
    }
    const userContextId = containerFor(`site-${rules.id}`);
    // browser.js's window.arguments: [1] extra options (the marker), [5] the first tab's userContextId; no URL ([0]),
    // so nothing loads before the view is watched.
    const marker = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
    marker.setPropertyAsAString(SITE_WINDOW_KEY, rules.id);
    const win = openInContainer(userContextId, marker, "width=1200,height=800");
    const s: OpenSite = { rules, userContextId, window: win, view: null, small: new Set(), blocked: [] };
    open.set(rules.id, s);
    byContainer.set(userContextId, s);
    return win;
  },
  /** The window is set up (site-window.ts): its view is watched, then sent to the app's address. */
  attach(id: string, browser: any): void {
    const s = open.get(id);
    if (!s) return;
    s.view = browser;
    // On the loaded window: the about:blank document a new window starts with unloads too.
    browser.ownerDocument.defaultView.addEventListener(
      "unload",
      () => {
        if (open.get(id) === s) open.delete(id);
        if (byContainer.get(s.userContextId) === s) byContainer.delete(s.userContextId);
      },
      { once: true },
    );
    loadInView(s, s.rules.adresse);
  },
  /** window.open and target=_blank (the window's browserDOMWindow): the app view, a sign-in window, or blocked. */
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
  /** The app whose container this is, if its window is open. */
  ofContainer(userContextId: number): string | undefined {
    return byContainer.get(userContextId)?.rules.id;
  },
  /** The hosts blocked so far in the app's window (the spike reads them in place of the bar's mention). */
  blocked(id: string): string[] {
    return open.get(id)?.blocked ?? [];
  },
};
