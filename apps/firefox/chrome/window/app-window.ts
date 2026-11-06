// An agent app's window: browser.xhtml opened by store/apps.ts without a toolbar, marked from its creation, never a
// WebAiOs main window. One <browser> (the app view, in the app's container), Firefox's tabs and toolbars hidden.
import { memeOrigine, TAILLE_FAVICON } from "../../../navigateur/src/main/applications/favicon";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor } from "./keys";
import { protectView } from "./site-window";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// Keep in sync with store/apps.ts APP_WINDOW_KEY.
const APP_WINDOW_KEY = "webaios-app";

type Apps = typeof import("../store/apps").apps;
const appsModule = (): Apps => ChromeUtils.importESModule(STORE).apps;

/** The app dossier this window was opened for (window.arguments[1], set by apps.open), or null. */
export function appDossierOf(win: Window): string | null {
  const options = (win as any).arguments?.[1];
  return options instanceof Ci.nsIPropertyBag2 && options.hasKey(APP_WINDOW_KEY) ? options.getPropertyAsAString(APP_WINDOW_KEY) : null;
}

/**
 * Everything the app's pages would open elsewhere becomes a main window tab if it is http(s), nothing otherwise
 * (Electron's setWindowOpenHandler: deny, ouvrirOnglet): window.open, target=_blank and links from outside
 * (browserDOMWindow), ⌘click, middle click and the context menu (openLinkIn). Printing keeps Firefox's own path.
 */
function routeOpens(win: Window, apps: Apps): void {
  const firefox = (win as any).browserDOMWindow;
  const route = (uri: any, params: unknown, where: number, flags: number, name: string, inFrame: "createContentWindowInFrame" | "openURIInFrame") => {
    if (where === Ci.nsIBrowserDOMWindow.OPEN_PRINT_BROWSER) return firefox[inFrame](uri, params, where, flags, name);
    apps.toTab(uri?.spec ?? "");
    // Nothing opened by Firefox: window.open returns null, as Electron's denied open.
    throw Cr.NS_ERROR_ABORT;
  };
  (win as any).browserDOMWindow = {
    QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
    createContentWindowInFrame: (uri: any, params: unknown, where: number, flags: number, name: string) => route(uri, params, where, flags, name, "createContentWindowInFrame"),
    openURIInFrame: (uri: any, params: unknown, where: number, flags: number, name: string) => route(uri, params, where, flags, name, "openURIInFrame"),
    openURI: (uri: any) => {
      apps.toTab(uri?.spec ?? "");
      return null;
    },
    canClose: () => true,
    get tabCount() {
      return 1;
    },
  };
  const openLinkIn = win.openLinkIn;
  win.openLinkIn = (url, where, params) => {
    // In the view: the request guard and the view policy decide (another origin goes to a tab, file: is refused).
    if (where === "current") return openLinkIn(url, where, params);
    if (where !== "save") apps.toTab(url);
  };
}

/**
 * A window an app's page opened with features (window.open(url, name, "width=…")): Firefox makes it without asking
 * browserDOMWindow, in the app's container. Closed at once, whatever it loads (about:blank and blob: never meet the
 * request guard): Electron refuses every window an app opens. True if it was one.
 */
export function closeAppPopup(win: Window): boolean {
  const userContextId = Number(win.gBrowser?.selectedBrowser?.getAttribute("usercontextid") || 0);
  if (!userContextId || !appsModule().ownsContainer(userContextId)) return false;
  // Once its startup is done: closed earlier, its opening never completes (measured: the opener's click never returns).
  void win.delayedStartupPromise.then(() => win.close());
  return true;
}

/** Run at the window's DOMContentLoaded, before anything could claim it; the view is attached once Firefox's startup is done. */
export function setupAppWindow(win: Window, dossier: string): void {
  const apps = appsModule();
  const app = apps.appOf(win);
  // Closed (stopped) while its window was opening.
  if (app?.dossier !== dossier) return void win.close();
  const doc = win.document;
  doc.documentElement.setAttribute("webaios-app", dossier);
  doc.getElementById("navigator-toolbox")!.hidden = true;
  routeOpens(win, apps);
  // Firefox's tab, address and history keys do nothing here; ⌘R reloads the view; ⌘W and ⇧⌘W close the window; ⌘N
  // opens a main window. ⌥⌘I stays Firefox's (the view's dev tools, Electron's openDevTools).
  for (const k of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS, "goBackKb", "goForwardKb"]) doc.getElementById(k)?.setAttribute("disabled", "true");
  win.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const s = shortcutFor(e);
      if (!s) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (s.type === "fenetre") win.OpenBrowserWindow();
      else if (s.type === "fermerFenetre" || (s.type === "raccourci" && s.r === "fermerOnglet")) win.close();
      else if (s.type === "naviguer" && (s.c === "recharger" || s.c === "rechargerSansCache")) win.gBrowser.selectedBrowser.reload();
    },
    true,
  );
  // The app's code was not reviewed: its beforeunload never keeps the window from closing, nor the app from quitting.
  win.CanCloseWindow = () => true;
  // As a site app's view (spec §13.8): add-ons can neither add a tab here, nor close, move or detach the view.
  protectView(win, () => true);
  // The frame is noted as it moves (MozUpdateWindowPos, chrome only), is resized and closes.
  let pending: number | undefined;
  const noteSoon = () => {
    win.clearTimeout(pending);
    pending = win.setTimeout(() => apps.note(win, { frame: true }), 200);
  };
  win.windowRoot.addEventListener("MozUpdateWindowPos", noteSoon);
  win.addEventListener("resize", noteSoon);
  win.addEventListener(
    "unload",
    () => {
      win.clearTimeout(pending);
      apps.note(win, { frame: true });
    },
    { once: true },
  );
  void win.delayedStartupPromise.then(() => {
    const gBrowser = win.gBrowser;
    const view = gBrowser.selectedBrowser;
    // The page's title, else the app's name (never the address).
    gBrowser.getWindowTitleForBrowser = (b: any) => apps.titleOf({ nom: app.nom, view: b });
    gBrowser.updateTitlebar();
    // The favicon Firefox shows, with its source address: kept only from the app's origin, or given as data:image/ (iso
    // Electron's faviconEnDonnees), at most TAILLE_FAVICON once re-encoded.
    gBrowser.addTabsProgressListener({
      onLinkIconAvailable(_browser: unknown, iconURL: unknown, originalURL: unknown) {
        if (typeof iconURL !== "string" || !iconURL.startsWith("data:image/") || iconURL.length > TAILLE_FAVICON) return;
        const source = String(originalURL ?? "");
        if (memeOrigine(source, app.origin) || source.startsWith("data:image/")) apps.note(win, { favicon: iconURL });
      },
    });
    // Each new top document: the host's policy follows it. A page kept in the bfcache would come back without a request
    // (without the guard: an old port after a relaunch), so none is kept. Kept on the window: held weakly by the browser.
    const listener = ((win as any).webaiosAppProgress = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange(progress: any, _request: unknown, location: any, flags: number) {
        if (!progress.isTopLevel) return;
        view.browsingContext?.sessionHistory?.evictAllDocumentViewers();
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT || location?.spec === "about:blank") return;
        apps.navigated(win, location.spec);
      },
    });
    view.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
    apps.attach(win, view);
  });
}
