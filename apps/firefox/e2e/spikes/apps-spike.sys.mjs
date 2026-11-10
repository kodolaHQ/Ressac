// Spike S8 (plan 35, docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md): an agent app's window, built
// the way store/sites.ts builds a site app's, with an origin rule (http://localhost:<port>) instead of domains.
// Throwaway: imported in the parent from resource://webaios-spike-apps/ by apps.e2e.ts. Not product code.

const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const PREFIX = "userContextIdInternal.webaios-app-";
const ICON_MAX = 64 * 1024;

/** dossier → { origin, userContextId, window, view } for the running apps. */
export const apps = new Map();
export const log = { cancelled: [], routed: [], rejected: [], icons: [] };

const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** containers.ts's containerFor, under the `webaios-app-` prefix. */
export function containerFor(folder) {
  const name = PREFIX + folder;
  const found = ContextualIdentityService.getPrivateIdentity(name);
  if (found) return found.userContextId;
  ContextualIdentityService.ensureDataReady();
  const userContextId = ++ContextualIdentityService._lastUserContextId;
  ContextualIdentityService._identities.push({ userContextId, public: false, name });
  ContextualIdentityService.saveSoon();
  return userContextId;
}

/** Any container of an app (running or not). */
export function isAppContainer(userContextId) {
  if (!userContextId) return false;
  ContextualIdentityService.ensureDataReady();
  return ContextualIdentityService._identities.some((i) => !i.public && i.userContextId === userContextId && i.name.startsWith(PREFIX));
}

const byContainer = (uc) => [...apps.values()].find((a) => a.userContextId === uc);

async function toTab(url) {
  if (!/^https?:\/\//.test(url)) return;
  log.routed.push(url);
  const store = await ChromeUtils.importESModule(STORE).ready;
  store.dispatch({ type: "openTab", windowId: store.state.windows[0].id, url });
}

function closeStray(browser) {
  const win = browser?.ownerDocument?.defaultView;
  if (!win || [...apps.values()].some((a) => a.view === browser)) return;
  Services.tm.dispatchToMainThread(() => {
    const tab = win.gBrowser?.getTabForBrowser(browser);
    if (tab && win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(tab);
    else win.close();
  });
}

/** sites.ts's request guard: a top-level document of an app container goes only to the app's origin, in its view. */
const observer = {
  observe(subject) {
    const ch = subject.QueryInterface(Ci.nsIHttpChannel);
    const li = ch.loadInfo;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT) return;
    const uc = li.originAttributes.userContextId;
    const url = ch.URI.spec;
    const a = byContainer(uc);
    if (!a) {
      if (isAppContainer(uc)) {
        ch.cancel(Cr.NS_BINDING_ABORTED);
        log.cancelled.push({ url, why: "stopped" });
      }
      return;
    }
    const browserId = ch.browserId || li.browsingContext?.browserId;
    const inView = browserId === a.view?.browserId;
    if (inView && sameOrigin(url, a.origin)) return;
    ch.cancel(Cr.NS_BINDING_ABORTED);
    log.cancelled.push({ url, why: inView ? "off-origin" : "other-browser", redirect: li.redirectChain.length > 0 });
    if (!inView) closeStray(li.browsingContext?.top?.embedderElement);
    void toTab(url);
  },
};

/** sites.ts's viewPolicy: an app view loads only http(s) documents (file:, data:, blob:, external schemes refused). */
const POLICY_CONTRACT = "@webaios/spike-app-view-policy;1";
const policy = {
  classID: Components.ID("{3b0e6a52-7c1d-4e8f-9a21-5d4c3b2a1f09}"),
  QueryInterface: ChromeUtils.generateQI(["nsIContentPolicy", "nsIFactory"]),
  createInstance: (iid) => policy.QueryInterface(iid),
  shouldLoad(location, li) {
    const accept = Ci.nsIContentPolicy.ACCEPT;
    if (li.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT || location.schemeIs("http") || location.schemeIs("https") || li.loadErrorPage) return accept;
    const browserId = li.browsingContext?.browserId;
    if (!browserId || ![...apps.values()].some((a) => a.view?.browserId === browserId)) return accept;
    log.rejected.push(String(location.spec).slice(0, 60));
    return Ci.nsIContentPolicy.REJECT_REQUEST;
  },
  shouldProcess: () => Ci.nsIContentPolicy.ACCEPT,
};

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  Services.obs.addObserver(observer, "http-on-modify-request");
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(policy.classID, "spike app view policy", POLICY_CONTRACT, policy);
  Services.catMan.addCategoryEntry("content-policy", POLICY_CONTRACT, POLICY_CONTRACT, false, true);
}

/** sites.ts's openInContainer: browser.xhtml without a toolbar, its first tab in the container, no URL yet. */
function openInContainer(userContextId) {
  const container = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(Ci.nsISupportsPRUint32);
  container.data = userContextId;
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  for (const x of [null, null, null, null, null, container]) args.appendElement(x);
  return Services.ww.openWindow(null, "chrome://browser/content/browser.xhtml", "_blank", "chrome,dialog=no,non-private,resizable,minimizable,titlebar,close,width=900,height=700", args);
}

/** Opens app `dossier` (served at `origin`) in its window; resolves once its page has loaded. */
export async function open(folder, origin, path = "/") {
  install();
  const userContextId = containerFor(folder);
  const win = openInContainer(userContextId);
  const a = { folder, origin, userContextId, window: win, view: null };
  apps.set(folder, a);
  await new Promise((r) => win.addEventListener("load", r, { once: true }));
  await win.delayedStartupPromise;
  win.document.documentElement.setAttribute("webaios-spike-app", folder);
  win.document.getElementById("navigator-toolbox").hidden = true;
  win.CanCloseWindow = () => true;
  // site-window.ts's routeOpens: window.open and target=_blank become a main window tab; nothing opens here.
  win.browserDOMWindow = {
    QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
    createContentWindowInFrame: (uri) => {
      void toTab(uri?.spec ?? "");
      throw Components.Exception("", Cr.NS_ERROR_ABORT);
    },
    openURIInFrame: (uri) => {
      void toTab(uri?.spec ?? "");
      throw Components.Exception("", Cr.NS_ERROR_ABORT);
    },
    openURI: () => null,
    canClose: () => true,
    get tabCount() {
      return 1;
    },
  };
  a.view = win.gBrowser.selectedBrowser;
  // The favicon Firefox shows, with its source address (onLinkIconAvailable's originalURL, Tabbrowser.setIcon).
  win.gBrowser.addTabsProgressListener({
    onLinkIconAvailable(browser, iconURL, originalURL) {
      const kept = typeof iconURL === "string" && iconURL.startsWith("data:image/") && iconURL.length <= ICON_MAX && sameOrigin(originalURL, origin);
      log.icons.push({ folder, page: browser.currentURI.spec, originalURL, icon: String(iconURL).slice(0, 22), length: String(iconURL).length, kept });
    },
  });
  win.addEventListener("unload", () => apps.get(folder) === a && apps.delete(folder), { once: true });
  await load(folder, origin + path);
  return { userContextId, browserId: a.view.browserId };
}

/** WebAiOs's own load in the view (the system principal), resolved when it stops. */
export function load(folder, url) {
  const view = apps.get(folder).view;
  return new Promise((resolve) => {
    const l = {
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onStateChange(p, _r, flags) {
        if (p.isTopLevel && flags & Ci.nsIWebProgressListener.STATE_STOP && flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK) {
          view.removeProgressListener(l);
          resolve(view.currentURI.spec);
        }
      },
    };
    view.addProgressListener(l, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
    view.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  });
}

/** The app is stopped: its window closes, it leaves the map (its container stays, as a deleted-later app's would). */
export async function stop(folder) {
  const a = apps.get(folder);
  apps.delete(folder);
  if (a && !a.window.closed) {
    const closed = new Promise((r) => a.window.addEventListener("unload", r, { once: true }));
    a.window.close();
    await closed;
  }
}

/** The badge: a chrome frame at the top right of the app window's #browser. */
export async function badge(folder, w = 48, h = 28) {
  const win = apps.get(folder).window;
  const doc = win.document;
  let f = doc.getElementById("spike-pastille");
  if (!f) {
    f = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
    f.id = "spike-pastille";
    // Out of the flow before it is appended: in #browser's flex row, a default iframe (300×150) pushes the view aside
    // for a layout (measured: the view at 304..900 until the style lands).
    f.style.cssText = "position:fixed;z-index:3;border:none;background:transparent;width:0;height:0";
    doc.getElementById("browser").append(f);
    await new Promise((r) => win.setTimeout(r, 100));
    const d = f.contentDocument;
    d.documentElement.innerHTML =
      '<head><style>html,body{margin:0;background:transparent}#b{width:100%;height:100%;background:rgb(109,94,252);border-radius:14px}</style></head><body><div id="b"></div></body>';
    f.contentWindow.clicks = 0;
    d.addEventListener("mousedown", () => f.contentWindow.clicks++);
  }
  const br = apps.get(folder).view.getBoundingClientRect();
  f.style.cssText = `position:fixed;z-index:3;border:none;background:transparent;left:${br.right - 12 - w}px;top:${br.top + 12}px;width:${w}px;height:${h}px`;
  await new Promise((r) => win.requestAnimationFrame(() => win.requestAnimationFrame(r)));
  const r = f.getBoundingClientRect();
  return { browser: [br.left, br.top, br.width, br.height], frame: [r.left, r.top, r.width, r.height] };
}
