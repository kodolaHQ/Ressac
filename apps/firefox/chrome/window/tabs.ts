import type { Action } from "../../shared/api";
import { FAVICON_MAX, hasView, tabProfile, type BrowserState, type WindowId, type TabId, type Tab } from "../../shared/model";
import type { RessacStore } from "../store";

export const TAB_ID = "ressac-tab-id";
export const PARKING = "ressac-parking";
/** In adoptTab's options: TabSync itself moves the tab (refuseSiteTabs refuses any other move of a Ressac tab). */
export const OWN_ADOPT = "ressacOwnAdopt";
const { STATE_START, STATE_STOP, STATE_IS_NETWORK, LOCATION_CHANGE_ERROR_PAGE } = Ci.nsIWebProgressListener;
/** The errors refused before any request, by their about:neterror code (nsDocShell::DisplayLoadError); others keep the code. */
const REFUSED: Record<string, string> = {
  deniedPortAccess: "NS_ERROR_PORT_ACCESS_NOT_ALLOWED",
  malformedURI: "NS_ERROR_MALFORMED_URI",
  unknownProtocolFound: "NS_ERROR_UNKNOWN_PROTOCOL",
};
const errorName = (code: string | null) => (code ? (REFUSED[code] ?? code) : "Erreur");

type TabFields = Extract<Action, { type: "updateTab" }>["fields"];

/**
 * Keeps the XUL tabs of one window in line with its Ressac tabs: a XUL tab is created when its
 * Ressac tab first becomes active, kept until it leaves the state, and the startup tab parks the window (about:blank,
 * never removed) while no web page is displayed. Page events come back as majOnglet; tabs opened by pages and add-ons are adopted.
 */
export class TabSync {
  private readonly tabs = new Map<TabId, any>();
  /** XUL tabs whose Ressac tab moved to another window: kept, page running, until that window adopts them. */
  private readonly leaving = new Map<TabId, any>();
  private parking: any;
  private creating = false;
  /** While create() makes an app essential's XUL tab: its app, registered with the site store before the first load. */
  private siteApp: string | undefined;
  /** While a popup's link opens here: the Ressac tab behind the popup. */
  private fromPopup: TabId | undefined;
  /** While an add-on opens a tab here (tabs.create, its options page): they load with its principal. */
  private fromAddon = false;
  /** While about:preferences, shown in a tab of ours, opens one (saved passwords): it opens it with no opener. */
  private fromPreferences = false;
  /** While a link from another app opens here (Ressac as macOS's default browser): Firefox gives it no opener. */
  private fromExternal = false;
  /** While TabSync selects or removes a XUL tab: what Firefox selects then is not the user's choice. */
  private selecting = false;
  /** The status of each browser's last failed load, until its next one starts. */
  private readonly failures = new WeakMap<object, number>();

  constructor(
    private readonly gBrowser: any,
    private readonly store: RessacStore,
    private readonly windowId: WindowId,
  ) {
    this.park(gBrowser.tabs[0]);
    // A popup's link reaches this window with no opener tab, only its popup's browser (TabOpen fires inside addTab).
    // shortcut: the tab lands in Firefox's most recent window, not always the source tab's; upgrade if several windows make it wrong in use
    const addTab = gBrowser.addTab.bind(gBrowser);
    gBrowser.addTab = (uri: string, options: { openerBrowser?: any; triggeringPrincipal?: any; userContextId?: number; fromExternal?: boolean } = {}) => {
      try {
        this.fromPopup = options.openerBrowser?.ownerDocument.defaultView?.ressacPopupSource;
        this.fromAddon = !!options.triggeringPrincipal?.addonId;
        // Our own creations (another space's tab, the parking tab) keep the container they ask for.
        const shown = gBrowser.selectedTab;
        this.fromPreferences = !this.creating && shown.hasAttribute(TAB_ID) && /^about:(preferences|settings)\b/.test(shown.linkedBrowser.currentURI?.spec ?? "");
        this.fromExternal = options.fromExternal === true;
        // An add-on's, the preferences' or another app's tab joins the active space: loaded in its container from the first
        // request (unless the add-on chose one; Firefox always passes the default container for an external link).
        if (((this.fromAddon || this.fromPreferences) && options.userContextId === undefined) || this.fromExternal) {
          const state = this.store.state;
          const f = state.windows.find((x) => x.id === this.windowId);
          const space = f && state.spaces.find((e) => e.id === f.activeSpace);
          if (space) options.userContextId = this.store.containerFor(space.profile);
        }
        return addTab(uri, options);
      } finally {
        this.fromPopup = undefined;
        this.fromAddon = false;
        this.fromPreferences = false;
        this.fromExternal = false;
      }
    };
    const strip = gBrowser.tabContainer;
    strip.addEventListener("TabOpen", (e: Event) => this.onOpen(e.target));
    strip.addEventListener("TabClose", (e: Event) => this.onClose(e.target));
    strip.addEventListener("TabSelect", (e: any) => {
      this.onSelect(e.target);
      // A tab left while it plays without sound (a muted video) has a media session too.
      this.watchPlayback(e.detail?.previousTab);
      // Shown again: a pause in the background is forgotten.
      this.watchPlayback(e.target);
    });
    strip.addEventListener("TabAttrModified", (e: CustomEvent) => {
      const changed: string[] = e.detail.changed;
      const tab: any = e.target;
      if (changed.includes("label") || changed.includes("image")) {
        // A page's inline icon can weigh 100 KB+ as data: and the state is cloned and saved on every action: over 16 KB, none.
        const icon: string = tab.getAttribute("image") || "";
        if (icon.length <= FAVICON_MAX) this.update(tab, { title: tab.label, favicon: icon || null });
        else {
          // A big icon (Gmail's is) is drawn again at 32 px rather than dropped, which left the page's initial. None meanwhile:
          // never the previous page's. Redrawn only when the icon itself changed, not on each title.
          this.update(tab, { title: tab.label, ...(changed.includes("image") ? { favicon: null } : {}) });
          if (changed.includes("image")) void shrinkIcon(icon).then((small) => {
            if (small && small.length <= FAVICON_MAX && tab.getAttribute("image") === icon) this.update(tab, { favicon: small });
          });
        }
      }
      if (changed.includes("soundplaying") || changed.includes("muted")) {
        this.update(tab, { sound: tab.hasAttribute("muted") ? "muted" : tab.hasAttribute("soundplaying") ? "playing" : null });
        this.watchPlayback(tab);
      }
    });
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser: any, progress: any, _request: unknown, location: any, flags: number) => {
        if (!progress.isTopLevel) return;
        // Only a load that ends on Firefox's error page shows our message: a download or a mailto: also stops with a failure.
        // Its failed STATE_STOP comes first; a load refused before it started (a banned port…) has none, its error page names it.
        const failure = this.failures.get(browser);
        this.failures.delete(browser); // read once: an older failure (a download) must not name a later error page
        const code = browser.documentURI ? new URL(browser.documentURI.spec).searchParams.get("e") : null;
        const error = flags & LOCATION_CHANGE_ERROR_PAGE ? (failure !== undefined ? ChromeUtils.getXPCOMErrorName(failure) : errorName(code)) : undefined;
        this.update(gBrowser.getTabForBrowser(browser), { url: location.spec, ...this.history(browser), ...(error ? { error: error, loading: false } : {}) });
      },
      onStateChange: (browser: any, progress: any, _request: unknown, flags: number, status: number) => {
        if (!progress.isTopLevel || !(flags & STATE_IS_NETWORK)) return;
        const tab = gBrowser.getTabForBrowser(browser);
        if (flags & STATE_START) {
          this.failures.delete(browser);
          this.update(tab, { loading: true, crashed: false, error: null });
        } else if (flags & STATE_STOP) {
          if (Components.isSuccessCode(status)) this.failures.delete(browser);
          else this.failures.set(browser, status);
          this.update(tab, { loading: false, ...this.history(browser) });
        }
      },
    });
    // Captured before Firefox's own handler, which would load about:tabcrashed: our UI shows its message instead.
    gBrowser.tabpanels.addEventListener(
      "oop-browser-crashed",
      (e: any) => {
        const tab = e.isTrusted && e.isTopFrame && gBrowser.getTabForBrowser(e.originalTarget);
        const id = tab?.getAttribute(TAB_ID);
        if (!id || this.tabs.get(id) !== tab) return;
        e.stopPropagation();
        this.update(tab, { crashed: true, loading: false });
      },
      true,
    );
  }

  /** Marks `tab` as the window's parking tab. Never empty to Firefox: it would load a page there (switchToTabHavingURI). */
  private park(tab: any): void {
    this.parking = tab;
    tab.setAttribute(PARKING, "");
    Object.defineProperties(tab, { isEmpty: { get: () => false }, isEmptyIgnoringLoad: { get: () => false } });
  }

  /** The XUL tab of a Ressac tab, if it has one. */
  tab(id: TabId): any {
    return this.tabs.get(id);
  }

  /**
   * The browser of a Ressac tab for the agent, even one never displayed: its XUL tab is created in the background
   * (not selected), then loaded (15 s at most).
   */
  async ensure(id: TabId): Promise<any> {
    const state = this.store.state;
    const o = state.tabs[id];
    if (!o) throw new Error(`Onglet introuvable : ${id}`);
    // shortcut: a XUL tab created for reading lives until its tab leaves the state, upgrade when memory matters.
    if (!this.tabs.has(id)) this.create(state, o);
    const browser = this.tabs.get(id).linkedBrowser;
    // A tab just created is still on its initial about:blank, its load not started yet.
    const pending = () => browser.webProgress?.isLoadingDocument || (browser.currentURI?.spec === "about:blank" && o.url !== "about:blank");
    if (!pending()) return browser;
    await this.waitLoad(id, browser, (flags) => !!(flags & STATE_STOP && flags & STATE_IS_NETWORK) && !pending());
    return browser;
  }

  /**
   * Resolves when `ends` says so for a top-level network state change of the browser, or at once when the tab closes or
   * crashes (a crashed browser never stops loading), or after 15 s.
   */
  private waitLoad(id: TabId, browser: any, ends: (flags: number) => boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      const unsubscribe = this.store.subscribe((s) => (!s.tabs[id] || s.tabs[id].crashed) && done());
      const listener = {
        onStateChange: (b: any, progress: any, _request: unknown, flags: number) => {
          if (b === browser && progress.isTopLevel && ends(flags)) done();
        },
      };
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        this.gBrowser.removeTabsProgressListener(listener);
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      this.gBrowser.addTabsProgressListener(listener);
    });
  }

  /**
   * Resolves when the load that the caller is about to start ends. Register it before starting the load. Started while
   * another load was in progress, the aborted one's stop does not count: only a stop after the new load's start does.
   */
  nextLoad(id: TabId, browser: any): Promise<void> {
    let started = !browser.webProgress?.isLoadingDocument;
    return this.waitLoad(id, browser, (flags) => {
      if (flags & STATE_START && flags & STATE_IS_NETWORK) started = true;
      return started && !!(flags & STATE_STOP && flags & STATE_IS_NETWORK);
    });
  }

  /** The Ressac tab displayed in the window, or null when the parking tab is. */
  displayed(): TabId | null {
    return this.gBrowser.selectedTab.getAttribute(TAB_ID);
  }

  sync(state: BrowserState): void {
    const f = state.windows.find((x) => x.id === this.windowId);
    const active = f && f.active[f.activeSpace];
    const tab = active ? state.tabs[active] : undefined;
    const web = tab && hasView(tab.url) ? tab : undefined;
    // Gone, or now in another container: the page reopens from scratch at the same URL.
    for (const [id, tab] of [...this.leaving]) {
      const o = state.tabs[id];
      if (o && o.windowId !== this.windowId) continue;
      this.leaving.delete(id);
      // Back before any window adopted it, or closed meanwhile.
      if (o) this.tabs.set(id, tab);
      else this.select(() => this.gBrowser.removeTab(tab, { skipPermitUnload: true, animate: false }));
    }
    for (const [id, tab] of [...this.tabs]) {
      const o = state.tabs[id];
      if (o && o.windowId !== this.windowId) {
        this.tabs.delete(id);
        this.leaving.set(id, tab);
        continue;
      }
      if (!o || o.unloaded || this.containerOf(state, o) !== tab.userContextId) this.remove(id, tab);
    }
    if (web && !this.tabs.has(web.id)) this.create(state, web);
    // Essentials stay loaded: their pages load in the background, without waiting to be shown.
    for (const o of Object.values(state.tabs))
      if (o.windowId === this.windowId && o.link?.type === "essential" && hasView(o.url) && !o.crashed && !o.error && !o.unloaded && !this.tabs.has(o.id)) this.create(state, o);
    // A crashed or failed page is replaced by the UI's message.
    const target = web && !web.crashed && !web.error ? this.tabs.get(web.id) : this.parking;
    if (this.gBrowser.selectedTab !== target) this.select(() => (this.gBrowser.selectedTab = target));
  }

  /** Drops the XUL tab of `id` (a crashed browser cannot reload): the next sync creates a new one at the tab's URL. */
  recreate(id: TabId): void {
    const tab = this.tabs.get(id);
    if (tab) this.remove(id, tab);
  }

  private containerOf(state: BrowserState, o: Tab): number {
    return this.store.containerFor(tabProfile(state, o));
  }

  private create(state: BrowserState, o: Tab): void {
    this.creating = true;
    try {
      const profile = tabProfile(state, o);
      const userContextId = this.store.containerFor(profile);
      // Only the essential itself is the app: tabs it opened share its container, not its tweaks or bridge.
      this.siteApp = o.link?.type === "essential" && profile.startsWith("site-") ? profile.slice("site-".length) : undefined;
      // The URL may come from the agent (open_tab, navigate on a tab without one): a web page is never loaded with the
      // system principal, whoever asked; internal pages (about:) need it.
      const triggeringPrincipal = /^https?:/i.test(o.url)
        ? Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(o.url), { userContextId })
        : Services.scriptSecurityManager.getSystemPrincipal();
      const tab = this.adopt(o.id) ?? this.gBrowser.addTab(o.url, { triggeringPrincipal, userContextId, skipAnimation: true });
      tab.setAttribute(TAB_ID, o.id);
      // Again once made: an adopted page may live in another <browser> than the one TabOpen saw (a no-op otherwise).
      if (this.siteApp) void this.store.sites.attachTab(this.siteApp, tab.linkedBrowser);
      // Firefox never unloads an essential to free memory.
      if (o.link?.type === "essential") tab.undiscardable = true;
      this.tabs.set(o.id, tab);
    } finally {
      this.creating = false;
      this.siteApp = undefined;
    }
  }

  /**
   * The tab's page, still running in the window it just left (moveTabToNewWindow): Firefox swaps it into a new XUL tab
   * here and closes the other. undefined when no window holds it; a refused swap closes the old page (it reloads here).
   */
  private adopt(id: TabId): any {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.gBrowser === this.gBrowser) continue;
      const old = w.gBrowser?.tabs.find((t: any) => t.getAttribute(TAB_ID) === id);
      if (!old) continue;
      const tab = this.gBrowser.adoptTab(old, { tabIndex: this.gBrowser.tabs.length, [OWN_ADOPT]: true });
      if (!tab) w.gBrowser.removeTab(old, { skipPermitUnload: true, animate: false });
      return tab ?? undefined;
    }
    return undefined;
  }

  private remove(id: TabId, tab: any): void {
    this.tabs.delete(id); // first: onClose then knows we closed it
    this.select(() => this.gBrowser.removeTab(tab, { skipPermitUnload: true, animate: false }));
  }

  private select(change: () => void): void {
    this.selecting = true;
    try {
      change();
    } finally {
      this.selecting = false;
    }
  }

  /** Firefox selected one of our tabs itself (switchToTabHavingURI: an options page already open): the state follows, space included. */
  private onSelect(tab: any): void {
    if (this.selecting) return;
    // Closing the selected tab, Firefox first selects a neighbour (#blurTab), maybe another space's, then sends TabClose:
    // by the microtask, onClose's closeTab has synced the selection back.
    queueMicrotask(() => {
      const id = tab.getAttribute(TAB_ID);
      if (!tab.selected || !id || this.tabs.get(id) !== tab) return;
      const state = this.store.state;
      const f = state.windows.find((x) => x.id === this.windowId);
      // Not yet in the state: a tab being adopted, its ouvrirOnglet follows.
      if (f && state.tabs[id] && f.active[f.activeSpace] !== id) this.store.dispatch({ type: "activateTab", id });
    });
  }

  /** The media sessions already listened to (one per page process). */
  private readonly sessions = new WeakSet<object>();

  /** Follows the tab's media session (Firefox's media keys' view of it): playing, paused in the background, or none. */
  private watchPlayback(tab: any): void {
    const session = tab?.linkedBrowser?.browsingContext?.mediaController;
    if (!session) return;
    const read = () => {
      // The tab may have moved on to another session (a new page process).
      if (tab.linkedBrowser?.browsingContext?.mediaController !== session) return;
      // Paused counts only for a background tab that was playing (paused from its bar, or by the page): a tab left
      // with nothing playing has no bar, whatever it played before.
      const shownPaused = !tab.selected && !!this.store.state.tabs[tab.getAttribute(TAB_ID)]?.playback;
      this.update(tab, { playback: session.isActive && session.isPlaying ? "playing" : session.isActive && shownPaused ? "paused" : null });
    };
    if (!this.sessions.has(session)) {
      this.sessions.add(session);
      for (const type of ["activated", "deactivated", "playbackstatechange"]) session.addEventListener(type, read);
    }
    read();
  }

  /** The media bar's play / pause. */
  togglePlayback(id: TabId): void {
    const session = this.tabs.get(id)?.linkedBrowser?.browsingContext?.mediaController;
    // pause() takes why the sound is lost: the user asked.
    if (session?.isActive) session.isPlaying ? session.pause("user") : session.play();
  }

  private history(browser: any): Pick<TabFields, "canGoBack" | "canGoForward"> {
    return { canGoBack: browser.canGoBack, canGoForward: browser.canGoForward };
  }

  private update(tab: any, fields: TabFields): void {
    const id = tab?.getAttribute(TAB_ID);
    if (id && this.tabs.get(id) === tab) this.store.dispatch({ type: "updateTab", id, fields });
  }

  private onOpen(tab: any): void {
    if (this.siteApp) void this.store.sites.attachTab(this.siteApp, tab.linkedBrowser);
    if (this.creating || tab.hasAttribute(TAB_ID)) return;
    // Firefox replaces a closing last tab: the replacement parks the window instead.
    if (this.parking.closing) {
      this.park(tab);
      return;
    }
    const opener = this.fromPopup ?? tab.openerTab?.getAttribute(TAB_ID);
    // Only pages and add-ons open tabs we adopt; any other (about:newtab from a menu…) is Firefox's own: keep our tab displayed.
    if (!opener && !this.fromAddon && !this.fromPreferences && !this.fromExternal) return void queueMicrotask(() => tab.selected && this.sync(this.store.state));
    // A page's tab opens next to its source; an add-on's, the preferences' or another app's in the window's active space.
    const f = this.store.state.windows.find((x) => x.id === this.windowId);
    const after = opener ?? f?.active[f.activeSpace];
    const id: TabId = crypto.randomUUID();
    tab.setAttribute(TAB_ID, id);
    this.tabs.set(id, tab);
    // Firefox selects a foreground tab right after TabOpen, in the same task: read it once that is done.
    queueMicrotask(() => {
      if (this.tabs.get(id) !== tab) return;
      // The URL addTab is loading: sync replaces a tab opened in another container than its space's before it loads.
      const url = tab.linkedBrowser.userTypedValue || (tab.linkedBrowser.currentURI?.spec ?? "about:blank");
      // A page in its own login profile (the agent's, an app essential's for its own pages) opens its tabs in that profile too.
      const profile = this.store.sites.childProfile(opener ? this.store.state.tabs[opener]?.profile : undefined, url);
      this.store.dispatch({ type: "openTab", windowId: this.windowId, url, after: after, activate: tab.selected, ...(profile ? { profile } : {}) }, () => id);
    });
  }

  private onClose(tab: any): void {
    this.store.sites.detachTab(tab.linkedBrowser);
    if (tab === this.parking) {
      // Not the last tab, so Firefox opened no replacement: park on a new one.
      queueMicrotask(() => {
        if (this.parking !== tab) return;
        this.creating = true;
        try {
          this.park(this.gBrowser.addTrustedTab("about:blank", { skipAnimation: true }));
        } finally {
          this.creating = false;
        }
      });
      return;
    }
    const id = tab.getAttribute(TAB_ID);
    // Adopted by the window it moved to: its page lives on there.
    if (id && this.leaving.get(id) === tab) return void this.leaving.delete(id);
    // A tab we did not remove ourselves: the page closed itself (window.close()).
    if (id && this.tabs.get(id) === tab) {
      this.tabs.delete(id);
      // Unless it was adopted before this window's sync saw it leave.
      if (this.store.state.tabs[id]?.windowId === this.windowId) this.store.dispatch({ type: "closeTab", id });
    }
  }
}

/** `url` drawn at 32 px as a PNG data: URL; null when it does not decode. */
async function shrinkIcon(url: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
    canvas.width = canvas.height = 32;
    // Fitted, centred: a wide or tall icon keeps its proportions.
    const k = 32 / Math.max(img.naturalWidth || 32, img.naturalHeight || 32);
    const w = (img.naturalWidth || 32) * k, h = (img.naturalHeight || 32) * k;
    canvas.getContext("2d")!.drawImage(img, (32 - w) / 2, (32 - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
