import type { Action } from "../../shared/api";
import type { BrowserState, WindowId, TabId, Tab } from "../../shared/model";
import { hasView, tabProfile } from "../../shared/model";
import type { WebAiOsStore } from "../store";

export const TAB_ID = "webaios-tab-id";
export const PARKING = "webaios-parking";
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
 * Keeps the XUL tabs of one window in line with its WebAiOs tabs: a XUL tab is created when its
 * WebAiOs tab first becomes active, kept until it leaves the state, and the startup tab parks the window (about:blank,
 * never removed) while no web page is displayed. Page events come back as majOnglet; tabs opened by pages and add-ons are adopted.
 */
export class TabSync {
  private readonly tabs = new Map<TabId, any>();
  private parking: any;
  private creating = false;
  /** While a popup's link opens here: the WebAiOs tab behind the popup. */
  private fromPopup: TabId | undefined;
  /** While an add-on opens a tab here (tabs.create, its options page): they load with its principal. */
  private fromAddon = false;
  /** While about:preferences, shown in a tab of ours, opens one (saved passwords): it opens it with no opener. */
  private fromPreferences = false;
  /** While TabSync selects or removes a XUL tab: what Firefox selects then is not the user's choice. */
  private selecting = false;
  /** The status of each browser's last failed load, until its next one starts. */
  private readonly failures = new WeakMap<object, number>();

  constructor(
    private readonly gBrowser: any,
    private readonly store: WebAiOsStore,
    private readonly windowId: WindowId,
  ) {
    this.park(gBrowser.tabs[0]);
    // A popup's link reaches this window with no opener tab, only its popup's browser (TabOpen fires inside addTab).
    // shortcut: the tab lands in Firefox's most recent window, not always the source tab's; upgrade if several windows make it wrong in use
    const addTab = gBrowser.addTab.bind(gBrowser);
    gBrowser.addTab = (uri: string, options: { openerBrowser?: any; triggeringPrincipal?: any; userContextId?: number } = {}) => {
      try {
        this.fromPopup = options.openerBrowser?.ownerDocument.defaultView?.webaiosPopupSource;
        this.fromAddon = !!options.triggeringPrincipal?.addonId;
        // Our own creations (another space's tab, the parking tab) keep the container they ask for.
        const shown = gBrowser.selectedTab;
        this.fromPreferences = !this.creating && shown.hasAttribute(TAB_ID) && /^about:(preferences|settings)\b/.test(shown.linkedBrowser.currentURI?.spec ?? "");
        // An add-on's or the preferences' tab joins the active space: loaded in its container from the first request (unless the add-on chose one).
        if ((this.fromAddon || this.fromPreferences) && options.userContextId === undefined) {
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
      }
    };
    const strip = gBrowser.tabContainer;
    strip.addEventListener("TabOpen", (e: Event) => this.onOpen(e.target));
    strip.addEventListener("TabClose", (e: Event) => this.onClose(e.target));
    strip.addEventListener("TabSelect", (e: Event) => this.onSelect(e.target));
    strip.addEventListener("TabAttrModified", (e: CustomEvent) => {
      const changed: string[] = e.detail.changed;
      const tab: any = e.target;
      if (changed.includes("label") || changed.includes("image")) this.update(tab, { title: tab.label, favicon: tab.getAttribute("image") || null });
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

  /** The XUL tab of a WebAiOs tab, if it has one. */
  tab(id: TabId): any {
    return this.tabs.get(id);
  }

  /**
   * The browser of a WebAiOs tab for the agent, even one never displayed: its XUL tab is created in the background
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
    await new Promise<void>((resolve) => {
      // A crashed browser never stops loading, a closed tab neither: no need to wait the 15 s.
      const unsubscribe = this.store.subscribe((s) => (!s.tabs[id] || s.tabs[id].crashed) && done());
      const listener = {
        onStateChange: (b: any, progress: any, _request: unknown, flags: number) => {
          if (b === browser && progress.isTopLevel && flags & STATE_STOP && flags & STATE_IS_NETWORK && !pending()) done();
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
    return browser;
  }

  /** The WebAiOs tab displayed in the window, or null when the parking tab is. */
  displayed(): TabId | null {
    return this.gBrowser.selectedTab.getAttribute(TAB_ID);
  }

  sync(state: BrowserState): void {
    const f = state.windows.find((x) => x.id === this.windowId);
    const active = f && f.active[f.activeSpace];
    const tab = active ? state.tabs[active] : undefined;
    const web = tab && hasView(tab.url) ? tab : undefined;
    // Gone, or now in another container: the page reopens from scratch at the same URL.
    for (const [id, tab] of [...this.tabs]) {
      const o = state.tabs[id];
      if (!o || this.containerOf(state, o) !== tab.userContextId) this.remove(id, tab);
    }
    if (web && !this.tabs.has(web.id)) this.create(state, web);
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
      const userContextId = this.containerOf(state, o);
      // The URL may come from the agent (open_tab, navigate on a tab without one): a web page is never loaded with the
      // system principal, whoever asked; internal pages (about:) need it.
      const triggeringPrincipal = /^https?:/i.test(o.url)
        ? Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(o.url), { userContextId })
        : Services.scriptSecurityManager.getSystemPrincipal();
      const tab = this.gBrowser.addTab(o.url, { triggeringPrincipal, userContextId, skipAnimation: true });
      tab.setAttribute(TAB_ID, o.id);
      this.tabs.set(o.id, tab);
    } finally {
      this.creating = false;
    }
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

  private history(browser: any): Pick<TabFields, "canGoBack" | "canGoForward"> {
    return { canGoBack: browser.canGoBack, canGoForward: browser.canGoForward };
  }

  private update(tab: any, fields: TabFields): void {
    const id = tab?.getAttribute(TAB_ID);
    if (id && this.tabs.get(id) === tab) this.store.dispatch({ type: "updateTab", id, fields });
  }

  private onOpen(tab: any): void {
    if (this.creating || tab.hasAttribute(TAB_ID)) return;
    // Firefox replaces a closing last tab: the replacement parks the window instead.
    if (this.parking.closing) {
      this.park(tab);
      return;
    }
    const opener = this.fromPopup ?? tab.openerTab?.getAttribute(TAB_ID);
    // Only pages and add-ons open tabs we adopt; any other (about:newtab from a menu…) is Firefox's own: keep our tab displayed.
    if (!opener && !this.fromAddon && !this.fromPreferences) return void queueMicrotask(() => tab.selected && this.sync(this.store.state));
    // A page's tab opens next to its source; an add-on's or the preferences' in the window's active space.
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
      this.store.dispatch({ type: "openTab", windowId: this.windowId, url, after: after, activate: tab.selected }, () => id);
    });
  }

  private onClose(tab: any): void {
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
    // A tab we did not remove ourselves: the page closed itself (window.close()).
    if (id && this.tabs.get(id) === tab) {
      this.tabs.delete(id);
      this.store.dispatch({ type: "closeTab", id });
    }
  }
}
