import type { TabCycleMessage, Panel, TabsPanel, ShortcutAction } from "../../shared/api";
import { workflowUrlTarget, historyContext, AGENT_WIDTH_MAX, AGENT_WIDTH_MIN, type FrameBounds, type BrowserState, type WindowId, type TabId } from "../../shared/model";
import { auraVariables, DEFAULT_AURA, type AuraId } from "../../shared/aura";
import { toUrl } from "../../core/url";
import { createHalo } from "../../core/halo";
import { TabCycle } from "../../core/tab-cycle";
import { toNeighbour, toNextSpace, toNth } from "../../core/shortcuts";
import { effectiveBindings } from "../../shared/shortcuts";
import { leftZone, exitZone, type LeftZone } from "../../shared/reveal";
import { mountCalls } from "./calls";
import type { WebAiOsStore } from "../store";
import { HOST_EXITED } from "../agent/host";
import { createAddons, type WindowAddons } from "./addons";
import { routeAddonsManager } from "./addons-manager";
import { setupAnchors } from "./anchor";
import { mountSiteBanner } from "./site-banner";
import { mountSearchBand } from "./search-band";
import { visibleFrame } from "./frame";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, SETTINGS_MENU_ITEMS, shortcutFor, type Shortcut } from "./keys";
import { TabSync } from "./tabs";
import { trackVisits } from "./visits";

export interface WindowController {
  readonly windowId: WindowId;
  readonly store: WebAiOsStore;
  /** toUrl(input, moteur); a tab with a XUL tab loads it, one without gets majOnglet{url}; null opens a new tab. */
  navigate(tabId: TabId | null, input: string): void;
  /**
   * The agent's naviguer: an http(s) URL loaded with a content principal of the tab's container, without taking the
   * keyboard (the user may be typing in the agent panel). A tab without a XUL tab gets majOnglet{url}, loaded the same
   * way when TabSync creates its XUL tab.
   */
  navigateForAgent(tabId: TabId, url: string): void;
  /** As `navigateForAgent`, resolved once the new address has finished loading (15 s at most): a read after it never sees the previous page. */
  navigateForAgentLoaded(tabId: TabId, url: string): Promise<void>;
  /** The browser of a tab for the agent, its XUL tab created in the background if needed and loaded (TabSync.ensure). */
  ensure(tabId: TabId): Promise<any>;
  command(tabId: TabId, c: "back" | "forward" | "reload" | "reloadHard" | "stop"): void;
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
  /** The first-launch welcome covers the window: our shortcuts (⌃Tab included) do nothing, but closing the window. */
  setWelcome(shown: boolean): void;
  /** Settings is waiting for a new key combination: our shortcuts do nothing meanwhile. */
  setCapturingShortcut(on: boolean): void;
  /** A window shortcut the vim mode asks for (vim-actor.ts), as its key would run it; nothing under the welcome or a capture. */
  shortcut(s: Shortcut): void;
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
  /** The call bar's microphone or camera button, for a background tab in a call. */
  pressCall(id: TabId, which: "mic" | "camera"): void;
  setAgentWidth(px: number): void;
  /** The sidebar's width while its edge is dragged; the state takes it at the drop. */
  setSidebarWidth(px: number): void;
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
  const unsubscribe = [store.subscribe((state) => tabs.sync(state)), mountSiteBanner(window, store, windowId), mountSearchBand(window, store, windowId)];
  applyFrame(store.state.windows.find((f) => f.id === windowId)?.frame ?? null);
  // Size and position kept for the next start (grouped: a drag fires dozens of events).
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const recordFrame = () => {
    clearTimeout(frameTimer);
    if (window.windowState === window.STATE_FULLSCREEN || window.windowState === window.STATE_MINIMIZED) return;
    const frame = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight };
    const old = store.state.windows.find((f) => f.id === windowId)?.frame;
    if (old && (Object.keys(frame) as (keyof typeof frame)[]).every((k) => old[k] === frame[k])) return;
    store.dispatch({ type: "frameWindow", id: windowId, frame: frame });
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
  const agentOpen = (state: BrowserState) => !!state.windows.find((x) => x.id === windowId)?.agentPanelOpen;
  // The slide's length in window.css (--webaios-slide, 380 ms), plus a few frames of margin.
  const SLIDE_MS = 450;
  let slideEnd: ReturnType<typeof setTimeout> | undefined;
  const showAgent = (state: BrowserState) => {
    const open = agentOpen(state);
    // Closed while the terminal had the keyboard (⌘J, ✦): it goes back to the page, or to the UI when no page shows.
    if (!open && document.activeElement === agentFrame) {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
      else frame.focus();
    }
    const root = document.documentElement;
    // A change of open state slides (window.css); a width change alone (the saved drag) does not. Closed, the panel
    // hides once it has slid out.
    if (open !== root.hasAttribute("webaios-agent-open")) {
      root.toggleAttribute("webaios-agent-open", open);
      root.setAttribute("webaios-agent-sliding", "");
      clearTimeout(slideEnd);
      slideEnd = setTimeout(() => {
        root.removeAttribute("webaios-agent-sliding");
        if (!agentOpen(store.state)) agentFrame.hidden = true;
      }, SLIDE_MS);
    }
    if (open) agentFrame.hidden = false;
    const width = Math.min(AGENT_WIDTH_MAX, Math.max(AGENT_WIDTH_MIN, state.settings.agentPanelWidth));
    root.style.setProperty("--webaios-agent-w", `${width}px`);
    root.style.setProperty("--webaios-agent", open ? `${width}px` : "0px");
    // Laid out now: the panel focuses its terminal right after this change, which needs the iframe visible.
    agentFrame.getBoundingClientRect();
  };
  showAgent(store.state);
  // Only on a change of its own: an unrelated action while the handle is dragged keeps the dragged width.
  unsubscribe.push(
    store.subscribe((state, previous) => {
      if (agentOpen(state) !== agentOpen(previous) || state.settings.agentPanelWidth !== previous.settings.agentPanelWidth) showAgent(state);
    }),
  );
  // The sidebar's side (window.css mirrors on webaios-sidebar-side). A switch swaps at once, in step with the UI pages
  // that read the same state, then fades in; reduced motion skips the fade.
  const FADE_MS = 150;
  let sideFade: ReturnType<typeof setTimeout> | undefined;
  const sideOf = (state: BrowserState) => state.settings.sidebarSide;
  const placeSide = (fade: boolean) => {
    const root = document.documentElement;
    root.setAttribute("webaios-sidebar-side", sideOf(store.state));
    clearTimeout(sideFade);
    root.removeAttribute("webaios-side-switch");
    if (!fade || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.setAttribute("webaios-side-switch", "in");
    sideFade = setTimeout(() => root.removeAttribute("webaios-side-switch"), FADE_MS);
  };
  placeSide(false);
  unsubscribe.push(
    store.subscribe((state, previous) => {
      if (sideOf(state) !== sideOf(previous)) placeSide(true);
    }),
  );
  // The active space's aura lights the window and both UI documents (each set again when it loads).
  const auraOf = (state: BrowserState) => {
    const f = state.windows.find((x) => x.id === windowId);
    return state.spaces.find((s) => s.id === f?.activeSpace)?.aura ?? DEFAULT_AURA;
  };
  const applyAura = (root: HTMLElement | undefined, id: AuraId) => {
    for (const [k, v] of Object.entries(auraVariables(id))) root?.style.setProperty(k, v);
  };
  const auraRoots = () => [document.documentElement, frame.contentDocument?.documentElement, agentFrame.contentDocument?.documentElement];
  for (const root of auraRoots()) applyAura(root, auraOf(store.state));
  unsubscribe.push(
    store.subscribe((state, previous) => {
      const id = auraOf(state);
      if (id !== auraOf(previous)) for (const root of auraRoots()) applyAura(root, id);
    }),
  );
  // The agent's halo: lit while one of its tools runs on the displayed tab (a tab or space switch is a state change).
  const halo = createHalo((on) => document.documentElement.toggleAttribute("webaios-agent-working", on));
  let haloTab: TabId | null | undefined;
  const updateHalo = () => {
    const f = store.state.windows.find((x) => x.id === windowId);
    const shown = f?.active[f.activeSpace];
    if (shown !== haloTab) halo.off();
    haloTab = shown;
    // In « à vous » the page is the user's: no halo.
    if (shown && store.state.tabs[shown]?.agentSearch?.state === "yours") halo.off();
    else halo.update(!!(shown && store.access.tabs[shown]?.running));
  };
  updateHalo();
  unsubscribe.push(store.subscribe(updateHalo), store.agent.on("access", updateHalo), store.agent.on(HOST_EXITED, updateHalo), () => halo.dispose());
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
    if (!store.state.tabs[id]?.crashed) return false;
    tabs.recreate(id);
    store.dispatch({ type: "updateTab", id, fields: { crashed: false, ...(url ? { url } : {}) } });
    return true;
  };
  const shortcutListeners = new Set<(r: ShortcutAction) => void>();
  const panelKeyListeners = new Set<(p: Panel) => void>();
  const panelListeners = new Set<(p: TabsPanel | null) => void>();
  const leftZoneListeners = new Set<(z: LeftZone) => void>();
  // ⌃Tab: recent order and the walk in progress. No page previews in step 2: cards show the icon.
  const walk = new TabCycle({
    state: () => store.state,
    dispatch: (a) => store.dispatch(a),
    send: (_, p) => {
      // Escape and the ⌃ release must reach the panel.
      if (p && document.activeElement !== frame) frame.focus();
      for (const cb of panelListeners) cb(p);
    },
    preview: () => null,
    capture: () => Promise.resolve(),
    // Once the UI has dropped the panel: a command bar still open keeps the keyboard (the page is not shown).
    restoreFocus: () => void setTimeout(() => !frame.hasAttribute("full") && controller.focusPage()),
    // Headless (e2e), no window ever has the focus: the walk is still tested there.
    isFocused: () => Services.focus.activeWindow === window || Services.env.exists("MOZ_HEADLESS"),
  });
  walk.onState(store.state);
  unsubscribe.push(store.subscribe((state) => walk.onState(state)));

  let welcome = false;
  let capturing = false;
  const run = (s: Shortcut) => {
    const state = store.state;
    const f = state.windows.find((x) => x.id === windowId);
    const active = f?.active[f.activeSpace];
    // ⌘W on the empty page closes the window, only if none of its spaces has a tab.
    if (s.type === "shortcut" && s.r === "closeTab" && !active && !Object.values(state.tabs).some((o) => o.windowId === windowId))
      window.close();
    else if (s.type === "shortcut") {
      frame.focus(); // the UI field must get the keys typed next, even from a web page
      for (const cb of shortcutListeners) cb(s.r);
    } else if (s.type === "panel") {
      frame.focus();
      for (const cb of panelKeyListeners) cb(s.p);
    } else if (s.type === "reopen") store.dispatch({ type: "reopenClosedTab", windowId: windowId });
    else if (s.type === "nth") {
      const action = toNth(state, windowId, s.n);
      if (action) store.dispatch(action);
    } else if (s.type === "neighbour" || s.type === "nextSpace") {
      const action = (s.type === "neighbour" ? toNeighbour : toNextSpace)(state, windowId, s.delta);
      if (action) store.dispatch(action);
    } else if (s.type === "space") {
      const space = state.spaces[s.n - 1];
      if (space) store.dispatch({ type: "activateSpace", windowId: windowId, id: space.id });
    } else if (s.type === "navigate") {
      if (active) controller.command(active, s.c);
    } else if (s.type === "cycle") walk.browse(windowId, s.delta);
    else if (s.type === "agent") {
      // On a widget's builder tab: its Agent tab, beside the open panel (the agent shows in that tab). An action's
      // workflow tab shows the internal page (not ported): the plain toggle.
      if (active && workflowUrlTarget(state.tabs[active]?.url ?? "")?.type === "widget") return controller.openAgent();
      // Toggle, then, opened from a web page, the keyboard goes to the terminal.
      store.dispatch({ type: "toggleAgentPanel", windowId: windowId });
      if (agentOpen(store.state)) {
        agentFrame.focus();
        for (const cb of shortcutListeners) cb("agent");
      }
    } else if (s.type === "compact") store.dispatch({ type: "toggleCompact", windowId: windowId });
    else if (s.type === "window") window.OpenBrowserWindow();
    else if (s.type === "closeWindow") window.close();
    else if (s.type === "apps") store.dispatch({ type: "openApps", windowId: windowId });
    else if (s.type === "settings") store.dispatch({ type: "openSettings", windowId: windowId });
    else if (s.type === "design") store.design.shortcut(window);
  };
  // Capture on the window: our keys act before the page sees them (a page that swallows every key keeps none of them).
  const onKeyDown = (e: KeyboardEvent) => {
    // Settings is capturing a combination: it reads this key, not us.
    if (capturing) return;
    const s = shortcutFor(e, effectiveBindings(store.state.settings.shortcuts));
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!welcome || s.type === "closeWindow") run(s);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control") walk.keyReleased(windowId);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // Compact mode: the mouse in window px, noted on moves. The page may shift under a still mouse (the
  // sidebar revealed); its last real position is what counts when it leaves the window.
  let zone: LeftZone | null = null;
  let lastX = Infinity;
  /** The sidebar's width (px), and whether it holds a column beside the page (not in compact mode). */
  let barWidth = store.state.settings.sidebarWidth;
  let columnShown = true;
  const sendZone = (z: LeftZone) => {
    if (z !== zone) for (const cb of leftZoneListeners) cb(z);
  };
  const onMouseMove = (e: MouseEvent) => {
    lastX = e.screenX - window.mozInnerScreenX;
    // On the right, the zones count from the window's right edge.
    if (sideOf(store.state) === "right") lastX = window.innerWidth - lastX;
    const z = leftZone(lastX, barWidth);
    sendZone(z);
    zone = z;
  };
  const onMouseOut = (e: MouseEvent) => {
    if (e.relatedTarget) return;
    sendZone(exitZone(lastX, barWidth));
    zone = null; // the next move is sent even in the same zone
  };
  window.addEventListener("mousemove", onMouseMove, true);
  window.addEventListener("mouseout", onMouseOut, true);
  // The UI documents' events stop at their own window: listen there too, on each load.
  for (const f of [frame, agentFrame])
    f.addEventListener("load", () => {
      applyAura(f.contentDocument?.documentElement, auraOf(store.state));
      f.contentWindow!.addEventListener("keydown", onKeyDown, true);
      f.contentWindow!.addEventListener("keyup", onKeyUp, true);
      f.contentWindow!.addEventListener("mousemove", onMouseMove, true);
      f.contentWindow!.addEventListener("mouseout", onMouseOut, true);
    });
  // ⌘Tab to another app during a walk: it ends without a tab change. Not "blur": moving the keyboard from a page to the UI
  // blurs the window too.
  window.addEventListener("deactivate", () => walk.windowLeft(windowId));
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
  const calls = mountCalls(window, store);
  unsubscribe.push(calls.dispose);
  const showSidebarWidth = (px: number) => {
    barWidth = px;
    document.documentElement.style.setProperty("--webaios-sidebar-w", `${px}px`);
    if (columnShown) document.documentElement.style.setProperty("--webaios-sidebar", `${px}px`);
  };
  showSidebarWidth(barWidth);
  // Only on a change of its own, as for the agent panel: an unrelated action keeps a width being dragged.
  unsubscribe.push(
    store.subscribe((state, previous) => {
      if (state.settings.sidebarWidth !== previous.settings.sidebarWidth) showSidebarWidth(state.settings.sidebarWidth);
    }),
  );
  for (const id of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS]) document.getElementById(id)?.setAttribute("disabled", "true");
  // The Settings menu items open our page: stopPropagation keeps browser-menubar.js from opening about:preferences.
  for (const id of SETTINGS_MENU_ITEMS) {
    const item = document.getElementById(id);
    if (!item) continue;
    item.removeAttribute("disabled");
    const onCommand = (e: Event) => {
      e.stopPropagation();
      if (!welcome) store.dispatch({ type: "openSettings", windowId: windowId });
    };
    item.addEventListener("command", onCommand);
    unsubscribe.push(() => item.removeEventListener("command", onCommand));
  }
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
    windowId: windowId,
    store,
    navigate(tabId, input) {
      const url = toUrl(input, store.state.settings.engine);
      if (!url) return;
      if (!tabId) return void store.dispatch({ type: "openTab", windowId: windowId, url });
      if (revive(tabId, url)) return;
      const browser = browserOf(tabId);
      if (!browser) return void store.dispatch({ type: "updateTab", id: tabId, fields: { url } });
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
      if (!tab) return void store.dispatch({ type: "updateTab", id: tabId, fields: { url } });
      const triggeringPrincipal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: tab.userContextId });
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal });
    },
    async navigateForAgentLoaded(tabId, url) {
      const browser = tabs.tab(tabId)?.linkedBrowser;
      // Only the fragment changes: a same-document navigation, no load to wait for.
      const base = (u: string) => u.replace(/#.*/, "");
      const sameDocument = url.includes("#") && base(url) === base(browser?.currentURI?.spec ?? "");
      const loaded = browser && !sameDocument ? tabs.nextLoad(tabId, browser) : Promise.resolve();
      controller.navigateForAgent(tabId, url);
      await loaded;
    },
    ensure: (tabId) => tabs.ensure(tabId),
    command(tabId, c) {
      if (c !== "stop" && revive(tabId)) return;
      const browser = browserOf(tabId);
      if (!browser) return;
      if (c === "back") browser.goBack();
      else if (c === "forward") browser.goForward();
      else if (c === "reload") browser.reload();
      else if (c === "reloadHard") browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      else browser.stop();
    },
    async closeTab(tabId) {
      const close = () => void store.dispatch({ type: "closeTab", id: tabId });
      const browser = browserOf(tabId);
      if (!browser || store.state.tabs[tabId]?.crashed || !browser.hasBeforeUnload) return close();
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
        const f = store.state.windows.find((x) => x.id === windowId);
        const before = f?.active[f.activeSpace];
        if (before !== tabId) store.dispatch({ type: "activateTab", id: tabId });
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
        else if (before && before !== tabId && store.state.tabs[before]) store.dispatch({ type: "activateTab", id: before });
      } finally {
        asking.delete(tabId);
      }
    },
    focusPage() {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
    },
    setWelcome(shown) {
      welcome = shown;
    },
    setCapturingShortcut(on) {
      capturing = on;
    },
    shortcut(s) {
      if (!welcome && !capturing) run(s);
    },
    setFullWindow(full) {
      frame.toggleAttribute("full", !!full);
      frame.toggleAttribute("over", full === "window");
    },
    setSidebarColumn(shown) {
      columnShown = shown;
      document.documentElement.style.setProperty("--webaios-sidebar", `${shown ? barWidth : 0}px`);
    },
    setSidebarVisible(visible) {
      frame.toggleAttribute("folded", !visible);
      // They sit in the sidebar's first row: nothing else is under them.
      document.getElementById("webaios-window-buttons")!.toggleAttribute("hidden", !visible);
    },
    sidebarWidth: () => (columnShown ? barWidth : 0),
    setSidebarWidth: showSidebarWidth,
    onLeftZone(cb) {
      leftZoneListeners.add(cb);
      return () => void leftZoneListeners.delete(cb);
    },
    rememberFocus() {
      const had = document.activeElement;
      return () => {
        if (had === agentFrame && agentOpen(store.state)) agentFrame.focus();
        else if (had === frame) frame.focus();
        else controller.focusPage();
      };
    },
    pressCall: calls.press,
    setAgentWidth(px) {
      if (!agentOpen(store.state)) return;
      document.documentElement.removeAttribute("webaios-agent-sliding");
      document.documentElement.style.setProperty("--webaios-agent-w", `${px}px`);
      document.documentElement.style.setProperty("--webaios-agent", `${px}px`);
    },
    openAgent() {
      if (!agentOpen(store.state)) store.dispatch({ type: "toggleAgentPanel", windowId: windowId });
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
    addons: createAddons({ win: window, gBrowser, tabs, anchors, store, windowId: windowId }),
  };
  return controller;
}

/** Puts the window where the state last saw it, if that frame still overlaps a screen. */
function applyFrame(c: FrameBounds | null): void {
  if (!c) return;
  const screen = Cc["@mozilla.org/gfx/screenmanager;1"]
    .getService(Ci.nsIScreenManager)
    .screenForRect(Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height));
  const [x, y, width, height] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 0 }];
  screen.GetAvailRectDisplayPix(x, y, width, height);
  const frame = visibleFrame(c, [{ x: x.value, y: y.value, width: width.value, height: height.value }]);
  if (!frame) return;
  window.moveTo(frame.x, frame.y);
  window.resizeTo(frame.width, frame.height);
}
