import type { Action } from "../../../navigateur/src/commun/api";
import type { EtatNavigateur, IdFenetre, IdOnglet, Onglet } from "../../../navigateur/src/commun/modele";
import { aUneVue, profilDOnglet } from "../../../navigateur/src/commun/modele";
import type { WebAiOsStore } from "../store";

const ID = "webaios-tab-id";
const PARKING = "webaios-parking";
const { STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;

type Champs = Extract<Action, { type: "majOnglet" }>["champs"];

/**
 * Keeps the XUL tabs of one window in line with its WebAiOs tabs, like Electron's views: a XUL tab is created when its
 * WebAiOs tab first becomes active, kept until it leaves the state, and the startup tab parks the window (about:blank,
 * never removed) while no web page is displayed. Page events come back as majOnglet; tabs opened by pages are adopted.
 */
export class TabSync {
  private readonly tabs = new Map<IdOnglet, any>();
  private parking: any;
  private creating = false;

  constructor(
    private readonly gBrowser: any,
    private readonly store: WebAiOsStore,
    private readonly fenetreId: IdFenetre,
  ) {
    this.parking = gBrowser.tabs[0];
    this.parking.setAttribute(PARKING, "");
    const strip = gBrowser.tabContainer;
    strip.addEventListener("TabOpen", (e: Event) => this.onOpen(e.target));
    strip.addEventListener("TabClose", (e: Event) => this.onClose(e.target));
    strip.addEventListener("TabAttrModified", (e: CustomEvent) => {
      const changed: string[] = e.detail.changed;
      const tab: any = e.target;
      if (changed.includes("label") || changed.includes("image")) this.update(tab, { titre: tab.label, favicon: tab.getAttribute("image") || null });
    });
    gBrowser.addTabsProgressListener({
      onLocationChange: (browser: any, progress: any, _request: unknown, location: any) => {
        if (progress.isTopLevel) this.update(gBrowser.getTabForBrowser(browser), { url: location.spec, ...this.history(browser) });
      },
      onStateChange: (browser: any, progress: any, _request: unknown, flags: number) => {
        if (!progress.isTopLevel || !(flags & STATE_IS_NETWORK)) return;
        const tab = gBrowser.getTabForBrowser(browser);
        if (flags & STATE_START) this.update(tab, { chargement: true });
        else if (flags & STATE_STOP) this.update(tab, { chargement: false, ...this.history(browser) });
      },
    });
  }

  /** The XUL tab of a WebAiOs tab, if it has one. */
  tab(id: IdOnglet): any {
    return this.tabs.get(id);
  }

  /** The WebAiOs tab displayed in the window, or null when the parking tab is. */
  displayed(): IdOnglet | null {
    return this.gBrowser.selectedTab.getAttribute(ID);
  }

  sync(state: EtatNavigateur): void {
    const f = state.fenetres.find((x) => x.id === this.fenetreId);
    const active = f && f.actif[f.espaceActif];
    const onglet = active ? state.onglets[active] : undefined;
    const web = onglet && aUneVue(onglet.url) ? onglet : undefined;
    // Gone, or now in another container: the page reopens from scratch at the same URL (Electron does the same).
    for (const [id, tab] of [...this.tabs]) {
      const o = state.onglets[id];
      if (!o || this.containerOf(state, o) !== tab.userContextId) this.remove(id, tab);
    }
    if (web && !this.tabs.has(web.id)) this.create(state, web);
    const target = web ? this.tabs.get(web.id) : this.parking;
    if (this.gBrowser.selectedTab !== target) this.gBrowser.selectedTab = target;
  }

  private containerOf(state: EtatNavigateur, o: Onglet): number {
    return this.store.containerFor(profilDOnglet(state, o));
  }

  private create(state: EtatNavigateur, o: Onglet): void {
    this.creating = true;
    try {
      const tab = this.gBrowser.addTrustedTab(o.url, { userContextId: this.containerOf(state, o), skipAnimation: true });
      tab.setAttribute(ID, o.id);
      this.tabs.set(o.id, tab);
    } finally {
      this.creating = false;
    }
  }

  private remove(id: IdOnglet, tab: any): void {
    this.tabs.delete(id); // first: onClose then knows we closed it
    this.gBrowser.removeTab(tab, { skipPermitUnload: true, animate: false });
  }

  private history(browser: any): Pick<Champs, "peutReculer" | "peutAvancer"> {
    return { peutReculer: browser.canGoBack, peutAvancer: browser.canGoForward };
  }

  private update(tab: any, champs: Champs): void {
    const id = tab?.getAttribute(ID);
    if (id && this.tabs.get(id) === tab) this.store.dispatch({ type: "majOnglet", id, champs });
  }

  private onOpen(tab: any): void {
    if (this.creating || tab.hasAttribute(ID)) return;
    // Firefox replaces a closing last tab: the replacement parks the window instead.
    if (this.parking.closing) {
      this.parking = tab;
      tab.setAttribute(PARKING, "");
      return;
    }
    const apres = tab.openerTab?.getAttribute(ID);
    // Only pages open tabs we adopt; any other (about:newtab from a menu…) is Firefox's own: keep our tab displayed.
    if (!apres) return void queueMicrotask(() => tab.selected && this.sync(this.store.state));
    const id: IdOnglet = crypto.randomUUID();
    tab.setAttribute(ID, id);
    this.tabs.set(id, tab);
    // Firefox selects a foreground tab right after TabOpen, in the same task: read it once that is done.
    queueMicrotask(() => {
      if (this.tabs.get(id) !== tab) return;
      const url = tab.linkedBrowser.currentURI?.spec ?? "about:blank";
      this.store.dispatch({ type: "ouvrirOnglet", fenetreId: this.fenetreId, url, apres, activer: tab.selected }, () => id);
    });
  }

  private onClose(tab: any): void {
    if (tab === this.parking) {
      // Not the last tab, so Firefox opened no replacement: park on a new one.
      queueMicrotask(() => {
        if (this.parking !== tab) return;
        this.creating = true;
        try {
          this.parking = this.gBrowser.addTrustedTab("about:blank", { skipAnimation: true });
          this.parking.setAttribute(PARKING, "");
        } finally {
          this.creating = false;
        }
      });
      return;
    }
    const id = tab.getAttribute(ID);
    // A tab we did not remove ourselves: the page closed itself (window.close()).
    if (id && this.tabs.get(id) === tab) {
      this.tabs.delete(id);
      this.store.dispatch({ type: "fermerOnglet", id });
    }
  }
}
