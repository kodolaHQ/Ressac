import type { TabCycleMessage, Panel, TabsPanel, ShortcutAction } from "../../shared/api";
import { workflowUrlTarget, historyContext, AGENT_WIDTH_MAX, AGENT_WIDTH_MIN, BAR_WIDTH, type FrameBounds, type BrowserState, type WindowId, type TabId } from "../../shared/model";
import { toUrl } from "../../core/url";
import { TabCycle } from "../../core/tab-cycle";
import { toNth } from "../../core/raccourcis";
import { leftZone, exitZone, type LeftZone } from "../../shared/revelation";
import type { WebAiOsStore } from "../store";
import { createAddons, type WindowAddons } from "./addons";
import { routeAddonsManager } from "./addons-manager";
import { setupAnchors } from "./anchor";
import { mountSiteBanner } from "./site-banner";
import { visibleFrame } from "./frame";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor, type Shortcut } from "./keys";
import { TabSync } from "./tabs";
import { trackVisits } from "./visits";

export interface WindowController {
  readonly fenetreId: WindowId;
  readonly store: WebAiOsStore;
  /** versUrl(input, moteur); a tab with a XUL tab loads it, one without gets majOnglet{url}; null opens a new tab. */
  navigate(tabId: TabId | null, input: string): void;
  /**
   * The agent's naviguer: an http(s) URL loaded with a content principal of the tab's container, without taking the
   * keyboard (the user may be typing in the agent panel). A tab without a XUL tab gets majOnglet{url}, loaded the same
   * way when TabSync creates its XUL tab.
   */
  navigateForAgent(tabId: TabId, url: string): void;
  /** The browser of a tab for the agent, its XUL tab created in the background if needed and loaded (TabSync.ensure). */
  ensure(tabId: TabId): Promise<any>;
  command(tabId: TabId, c: "reculer" | "avancer" | "recharger" | "rechargerSansCache" | "arreter"): void;
  /**
   * A tab the user closes. A page with unsaved changes (beforeunload) gets « Quitter ce site ? »
   * first; a page that does not answer within 5 s is closed anyway. A crashed tab or one without a XUL tab closes now.
   */
  closeTab(tabId: TabId): Promise<void>;
  /** Keyboard back to the displayed page (no-op when no web page is displayed). */
  focusPage(): void;
  /**
   * The UI iframe covers the whole window, agent panel included ("window": overlays, one document for the whole UI),
   * the window left of the agent panel (true: empty and internal pages) or only its 240 px column (false).
   */
  setFullWindow(full: boolean | "window"): void;
  /** Compact mode: the page takes the sidebar's column, and the sidebar floats over it. */
  setSidebarColumn(shown: boolean): void;
  /** Whether the sidebar shows; hidden, the iframe folds once the sidebar has slid out. */
  setSidebarVisible(visible: boolean): void;
  /** Width of the sidebar's column: 0 in compact mode. */
  sidebarWidth(): number;
  /** Where the mouse is against the left edge, sent when that changes. */
  onLeftZone(cb: (z: LeftZone) => void): () => void;
  /**
   * Notes whether the terminal or the page has the keyboard (an agent card is about to take it) and returns what gives
   * it back: the UI document only knows its own focus, which is its body in both cases.
   */
  rememberFocus(): () => void;
  /** Width of the open agent panel while its handle is dragged (the saved width comes back from reglages). */
  setAgentWidth(px: number): void;
  /** Opens the agent panel if it is closed (never closes it), gives it the keyboard and tells the UIs ("agent"). */
  openAgent(): void;
  /** Shortcuts the UI handles (⌘T, ⌘L, ⌘W). */
  onShortcut(cb: (r: ShortcutAction) => void): () => void;
  /** ⌘Y, ⇧⌘J (a second press closes it, the UI toggles). */
  onPanel(cb: (p: Panel) => void): () => void;
  /** The ⌃Tab panel to show (null: closed). */
  onTabPanel(cb: (p: TabsPanel | null) => void): () => void;
  /** Mouse, Escape and ⌃ release from the ⌃Tab panel. */
  tabSwitch(m: TabCycleMessage): void;
  /** The sidebar's add-on strip: buttons, pins, popups and pending updates. */
  readonly addons: WindowAddons;
}

/** Binds this browser window to the state window it claimed (store.windows.claim). */
export function createController(
  gBrowser: any,
  frame: HTMLIFrameElement,
  agentFrame: HTMLIFrameElement,
  store: WebAiOsStore,
  windowId: WindowId,
): WindowController {
  const tabs = new TabSync(gBrowser, store, windowId);
  trackVisits(gBrowser, store.history, (id) => historyContext(store.state, id));
  // Prompts and add-on popups anchor on the sidebar, Firefox's toolbar being hidden (the action anchor: add-on popups).
  const anchors = setupAnchors(window, frame);
  routeAddonsManager(window, store, windowId, tabs);
  tabs.sync(store.state);
  // The store outlives the window (macOS keeps running without one): drop this window's listeners when it goes, then
  // its state window (its tabs leave with it).
  const unsubscribe = [store.subscribe((state) => tabs.sync(state)), mountSiteBanner(window, store, windowId)];
  applyFrame(store.state.fenetres.find((f) => f.id === windowId)?.cadre ?? null);
  // Size and position kept for the next start (grouped: a drag fires dozens of events).
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const recordFrame = () => {
    clearTimeout(frameTimer);
    if (window.windowState === window.STATE_FULLSCREEN || window.windowState === window.STATE_MINIMIZED) return;
    const frame = { x: window.screenX, y: window.screenY, largeur: window.outerWidth, hauteur: window.outerHeight };
    const old = store.state.fenetres.find((f) => f.id === windowId)?.cadre;
    if (old && (Object.keys(frame) as (keyof typeof frame)[]).every((k) => old[k] === frame[k])) return;
    store.dispatch({ type: "cadrerFenetre", id: windowId, cadre: frame });
  };
  const planFrame = () => {
    clearTimeout(frameTimer);
    frameTimer = setTimeout(recordFrame, 300);
  };
  window.addEventListener("resize", planFrame);
  // A move fires no DOM event on the window itself: the app window sends this chrome event to its root.
  window.windowRoot.addEventListener("MozUpdateWindowPos", planFrame);
  window.addEventListener(
    "unload",
    () => {
      unsubscribe.forEach((u) => u());
      // ⌘Q: the session is written after the windows close, their frame must be in it.
      recordFrame();
      store.windows.release(windowId);
    },
    { once: true },
  );
  // The agent panel: --webaios-agent is its width when open, 0 when closed (the page and the UI make room for it).
  const agentOpen = (state: BrowserState) => !!state.fenetres.find((x) => x.id === windowId)?.panneauAgentOuvert;
  const showAgent = (state: BrowserState) => {
    const open = agentOpen(state);
    // Closed while the terminal had the keyboard (⌘J, ✦): it goes back to the page, or to the UI when no page shows.
    if (!open && document.activeElement === agentFrame) {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
      else frame.focus();
    }
    agentFrame.hidden = !open;
    const width = Math.min(AGENT_WIDTH_MAX, Math.max(AGENT_WIDTH_MIN, state.reglages.largeurPanneauAgent));
    document.documentElement.style.setProperty("--webaios-agent", open ? `${width}px` : "0px");
    // Laid out now: the panel focuses its terminal right after this change, which needs the iframe visible.
    agentFrame.getBoundingClientRect();
  };
  showAgent(store.state);
  // Only on a change of its own: an unrelated action while the handle is dragged keeps the dragged width.
  unsubscribe.push(
    store.subscribe((state, previous) => {
      if (agentOpen(state) !== agentOpen(previous) || state.reglages.largeurPanneauAgent !== previous.reglages.largeurPanneauAgent) showAgent(state);
    }),
  );
  // After a tab switch Firefox gives the keyboard to the selected browser; the parking tab is no page, the UI keeps it.
  window.addEventListener("TabSwitchDone", () => {
    if (!tabs.displayed()) frame.focus();
  });
  const browserOf = (id: TabId) => tabs.tab(id)?.linkedBrowser;
  /**
   * A crashed browser loads nothing: any navigation or command on a crashed tab puts a new XUL tab in its place, at `url`
   * or the tab's own (a crashed page comes back by loading it again). Back/forward history is lost with it.
   */
  const revive = (id: TabId, url?: string): boolean => {
    if (!store.state.onglets[id]?.plante) return false;
    tabs.recreate(id);
    store.dispatch({ type: "majOnglet", id, champs: { plante: false, ...(url ? { url } : {}) } });
    return true;
  };
  const shortcutListeners = new Set<(r: ShortcutAction) => void>();
  const panelKeyListeners = new Set<(p: Panel) => void>();
  const panelListeners = new Set<(p: TabsPanel | null) => void>();
  const leftZoneListeners = new Set<(z: LeftZone) => void>();
  // ⌃Tab: recent order and the walk in progress. No page previews in step 2: cards show the icon.
  const walk = new TabCycle({
    etat: () => store.state,
    agir: (a) => store.dispatch(a),
    envoyer: (_, p) => {
      // Escape and the ⌃ release must reach the panel.
      if (p && document.activeElement !== frame) frame.focus();
      for (const cb of panelListeners) cb(p);
    },
    apercu: () => null,
    capturer: () => Promise.resolve(),
    // Once the UI has dropped the panel: a command bar still open keeps the keyboard (the page is not shown).
    rendreFocus: () => void setTimeout(() => !frame.hasAttribute("full") && controller.focusPage()),
    // Headless (e2e), no window ever has the focus: the walk is still tested there.
    estFocalisee: () => Services.focus.activeWindow === window || Services.env.exists("MOZ_HEADLESS"),
  });
  walk.surEtat(store.state);
  unsubscribe.push(store.subscribe((state) => walk.surEtat(state)));

  const run = (s: Shortcut) => {
    const state = store.state;
    const f = state.fenetres.find((x) => x.id === windowId);
    const active = f?.actif[f.espaceActif];
    // ⌘W on the empty page closes the window, only if none of its spaces has a tab.
    if (s.type === "raccourci" && s.r === "fermerOnglet" && !active && !Object.values(state.onglets).some((o) => o.fenetreId === windowId))
      window.close();
    else if (s.type === "raccourci") {
      frame.focus(); // the UI field must get the keys typed next, even from a web page
      for (const cb of shortcutListeners) cb(s.r);
    } else if (s.type === "panneau") {
      frame.focus();
      for (const cb of panelKeyListeners) cb(s.p);
    } else if (s.type === "rouvrir") store.dispatch({ type: "rouvrirOngletFerme", fenetreId: windowId });
    else if (s.type === "nieme") {
      const action = toNth(state, windowId, s.n);
      if (action) store.dispatch(action);
    } else if (s.type === "espace") {
      const space = state.espaces[s.n - 1];
      if (space) store.dispatch({ type: "activerEspace", fenetreId: windowId, id: space.id });
    } else if (s.type === "naviguer") {
      if (active) controller.command(active, s.c);
    } else if (s.type === "parcourir") walk.parcourir(windowId, s.delta);
    else if (s.type === "agent") {
      // On a widget's builder tab: its Agent tab, beside the open panel (the agent shows in that tab). An action's
      // workflow tab shows the internal page (not ported): the plain toggle.
      if (active && workflowUrlTarget(state.onglets[active]?.url ?? "")?.type === "widget") return controller.openAgent();
      // Toggle, then, opened from a web page, the keyboard goes to the terminal.
      store.dispatch({ type: "basculerPanneauAgent", fenetreId: windowId });
      if (agentOpen(store.state)) {
        agentFrame.focus();
        for (const cb of shortcutListeners) cb("agent");
      }
    } else if (s.type === "compact") store.dispatch({ type: "basculerCompact", fenetreId: windowId });
    else if (s.type === "fenetre") window.OpenBrowserWindow();
    else if (s.type === "fermerFenetre") window.close();
    else if (s.type === "applications") store.dispatch({ type: "ouvrirApplications", fenetreId: windowId });
    else if (s.type === "design") store.design.shortcut(window);
  };
  // Capture on the window: our keys act before the page sees them (a page that swallows every key keeps none of them).
  const onKeyDown = (e: KeyboardEvent) => {
    const s = shortcutFor(e);
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    run(s);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control") walk.toucheRelachee(windowId);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Compact mode: the mouse in window px, noted on moves. The page may shift under a still mouse (the
  // sidebar revealed); its last real position is what counts when it leaves the window.
  let zone: LeftZone | null = null;
  let lastX = Infinity;
  const sendZone = (z: LeftZone) => {
    if (z !== zone) for (const cb of leftZoneListeners) cb(z);
  };
  const onMouseMove = (e: MouseEvent) => {
    lastX = e.screenX - window.mozInnerScreenX;
    const z = leftZone(lastX);
    sendZone(z);
    zone = z;
  };
  const onMouseOut = (e: MouseEvent) => {
    if (e.relatedTarget) return;
    sendZone(exitZone(lastX));
    zone = null; // the next move is sent even in the same zone
  };
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseout", onMouseOut, true);
  // The UI documents' events stop at their own window: listen there too, on each load.
  for (const f of [frame, agentFrame])
    f.addEventListener("load", () => {
      f.contentWindow!.addEventListener("keydown", onKeyDown, true);
      f.contentWindow!.addEventListener("keyup", onKeyUp, true);
      f.contentWindow!.addEventListener("mousemove", onMouseMove, true);
      f.contentWindow!.addEventListener("mouseout", onMouseOut, true);
    });
  // ⌘Tab to another app during a walk: it ends without a tab change. Not "blur": moving the keyboard from a page to the UI
  // blurs the window too.
  window.addEventListener("deactivate", () => walk.fenetreQuittee(windowId));
  // ⇧click asks Firefox for a new window: a page's link opens a background tab instead, as ⌘click (TabSync adopts it).
  const openLinkIn = window.openLinkIn;
  window.openLinkIn = (url, where, params) => {
    const fromTab = params?.openerBrowser && gBrowser.getTabForBrowser(params.openerBrowser)?.hasAttribute("webaios-tab-id");
    openLinkIn(url, where === "window" && fromTab ? "tab" : where, params);
  };
  // Quitting asks no page. Every quit path asks each window (CanClose) right after quit-application-requested,
  // unless an observer cancelled it. Closing one window keeps Firefox's question.
  let quit: { data: boolean } | undefined;
  // Every quit path calls Quit in the same task as its request (nsAppStartup::Quit, MacApplicationDelegate): a quit that a
  // window keeps (its page's « Rester ») must not skip the questions of the next window close. A beforeunload prompt of a
  // Firefox window spins the event loop first: the flag may go early, then our pages are asked (asks more, loses nothing).
  const quitObserver = {
    observe: (subject: any) => {
      quit = subject.QueryInterface(Ci.nsISupportsPRBool);
      Services.tm.dispatchToMainThread(() => (quit = undefined));
    },
  };
  Services.obs.addObserver(quitObserver, "quit-application-requested");
  unsubscribe.push(() => Services.obs.removeObserver(quitObserver, "quit-application-requested"));
  const canCloseWindow = window.CanCloseWindow;
  window.CanCloseWindow = () => (quit && !quit.data) || canCloseWindow();
  /** Tabs whose page is being asked: a second ⌘W must not ask again. */
  const asking = new Set<TabId>();
  let sidebarWidth = BAR_WIDTH;
  for (const id of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS]) document.getElementById(id)?.setAttribute("disabled", "true");
  // The macOS menu bar fires View › Sidebar items by their own key (⇧⌘H) even with the <key> disabled; WebAiOs has
  // no native sidebar, so every item is off, including the ones SidebarController adds or re-enables later.
  const sidebarMenu = document.getElementById("viewSidebarMenu");
  if (sidebarMenu) {
    const disableItems = () => {
      for (const item of sidebarMenu.children) if (item.getAttribute("disabled") !== "true") item.setAttribute("disabled", "true");
    };
    disableItems();
    const observer = new MutationObserver(disableItems);
    observer.observe(sidebarMenu, { childList: true, subtree: true, attributeFilter: ["disabled"] });
    unsubscribe.push(() => observer.disconnect());
  }

  const controller: WindowController = {
    fenetreId: windowId,
    store,
    navigate(tabId, input) {
      const url = toUrl(input, store.state.reglages.moteur);
      if (!url) return;
      if (!tabId) return void store.dispatch({ type: "ouvrirOnglet", fenetreId: windowId, url });
      if (revive(tabId, url)) return;
      const browser = browserOf(tabId);
      if (!browser) return void store.dispatch({ type: "majOnglet", id: tabId, champs: { url } });
      // What the user typed in the address bar: Firefox loads it with the system principal too.
      browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      browser.focus();
    },
    navigateForAgent(tabId, url) {
      const uri = Services.io.newURI(url);
      if (!uri.schemeIs("http") && !uri.schemeIs("https")) throw new Error(`URL refusée (http ou https uniquement) : ${url}`);
      // Revived at its old URL, then loaded below like any agent load: never with the system principal.
      revive(tabId);
      const tab = tabs.tab(tabId);
      if (!tab) return void store.dispatch({ type: "majOnglet", id: tabId, champs: { url } });
      const triggeringPrincipal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: tab.userContextId });
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal });
    },
    ensure: (tabId) => tabs.ensure(tabId),
    command(tabId, c) {
      if (c !== "arreter" && revive(tabId)) return;
      const browser = browserOf(tabId);
      if (!browser) return;
      if (c === "reculer") browser.goBack();
      else if (c === "avancer") browser.goForward();
      else if (c === "recharger") browser.reload();
      else if (c === "rechargerSansCache") browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      else browser.stop();
    },
    async closeTab(tabId) {
      const close = () => void store.dispatch({ type: "fermerOnglet", id: tabId });
      const browser = browserOf(tabId);
      if (!browser || store.state.onglets[tabId]?.plante || !browser.hasBeforeUnload) return close();
      if (asking.has(tabId)) return;
      asking.add(tabId);
      try {
        // "dontUnload" only runs the page's beforeunload; false: it wants to ask. A failure (crash meanwhile) lets it go.
        const answer = browser.asyncPermitUnload("dontUnload").then((r: { permitUnload: boolean }) => r.permitUnload, () => true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const permit = await Promise.race([answer, new Promise<boolean>((r) => (timer = setTimeout(() => r(true), 5000)))]);
        clearTimeout(timer);
        if (permit) return close();
        // Firefox selects the tab its question opens on: the state follows, or the sidebar would show another tab as active.
        const f = store.state.fenetres.find((x) => x.id === windowId);
        const before = f?.actif[f.espaceActif];
        if (before !== tabId) store.dispatch({ type: "activerOnglet", id: tabId });
        const { prompt } = Services;
        const flags =
          prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1_DEFAULT;
        // Rejected when the tab navigates or the window closes meanwhile: as Rester.
        const result = await prompt.asyncConfirmEx(
          browser.browsingContext,
          prompt.MODAL_TYPE_TAB,
          "Quitter ce site ?",
          "Les modifications que vous avez faites ne seront peut-être pas enregistrées.",
          flags,
          "Quitter",
          "Rester",
          null,
          null,
          {},
        ).catch(() => null);
        if (result?.getProperty("buttonNumClicked") === 0) close();
        // Rester changes nothing, as a window-modal dialog: the tab shown before comes back.
        else if (before && before !== tabId && store.state.onglets[before]) store.dispatch({ type: "activerOnglet", id: before });
      } finally {
        asking.delete(tabId);
      }
    },
    focusPage() {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
    },
    setFullWindow(full) {
      frame.toggleAttribute("full", !!full);
      frame.toggleAttribute("over", full === "window");
    },
    setSidebarColumn(shown) {
      sidebarWidth = shown ? BAR_WIDTH : 0;
      document.documentElement.style.setProperty("--webaios-sidebar", `${sidebarWidth}px`);
    },
    setSidebarVisible(visible) {
      frame.toggleAttribute("folded", !visible);
      // They sit in the sidebar's first row: nothing else is under them.
      document.getElementById("webaios-window-buttons")!.toggleAttribute("hidden", !visible);
    },
    sidebarWidth: () => sidebarWidth,
    onLeftZone(cb) {
      leftZoneListeners.add(cb);
      return () => void leftZoneListeners.delete(cb);
    },
    rememberFocus() {
      const had = document.activeElement;
      return () => {
        if (had === agentFrame && agentOpen(store.state)) agentFrame.focus();
        else if (had !== frame) controller.focusPage();
      };
    },
    setAgentWidth(px) {
      if (agentOpen(store.state)) document.documentElement.style.setProperty("--webaios-agent", `${px}px`);
    },
    openAgent() {
      if (!agentOpen(store.state)) store.dispatch({ type: "basculerPanneauAgent", fenetreId: windowId });
      agentFrame.focus();
      for (const cb of shortcutListeners) cb("agent");
    },
    onShortcut(cb) {
      shortcutListeners.add(cb);
      return () => void shortcutListeners.delete(cb);
    },
    onPanel(cb) {
      panelKeyListeners.add(cb);
      return () => void panelKeyListeners.delete(cb);
    },
    onTabPanel(cb) {
      panelListeners.add(cb);
      return () => void panelListeners.delete(cb);
    },
    tabSwitch: (m) => walk.message(windowId, m),
    addons: createAddons({ win: window, gBrowser, tabs, anchors, store, fenetreId: windowId }),
  };
  return controller;
}

/** Puts the window where the state last saw it, if that frame still overlaps a screen. */
function applyFrame(c: FrameBounds | null): void {
  if (!c) return;
  const screen = Cc["@mozilla.org/gfx/screenmanager;1"]
    .getService(Ci.nsIScreenManager)
    .screenForRect(Math.round(c.x), Math.round(c.y), Math.round(c.largeur), Math.round(c.hauteur));
  const [x, y, width, height] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
  screen.GetAvailRectDisplayPix(x, y, width, height);
  const frame = visibleFrame(c, [{ x: x.value, y: y.value, width: width.value, height: height.value }]);
  if (!frame) return;
  window.moveTo(frame.x, frame.y);
  window.resizeTo(frame.largeur, frame.hauteur);
}
