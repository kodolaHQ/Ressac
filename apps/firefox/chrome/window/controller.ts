import type { MessageParcours, PanneauOnglets, Raccourci } from "../../../navigateur/src/commun/api";
import { LARGEUR_AGENT_MAX, LARGEUR_AGENT_MIN, type Cadre, type EtatNavigateur, type IdFenetre, type IdOnglet } from "../../../navigateur/src/commun/modele";
import { versUrl } from "../../../navigateur/src/main/adresse";
import { ParcoursOnglets } from "../../../navigateur/src/main/parcours-onglets";
import { versNieme } from "../../../navigateur/src/main/raccourcis";
import type { WebAiOsStore } from "../store";
import { visibleFrame } from "./frame";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor, type Shortcut } from "./keys";
import { TabSync } from "./tabs";

export interface WindowController {
  readonly fenetreId: IdFenetre;
  readonly store: WebAiOsStore;
  /** Electron's naviguer: versUrl(input, moteur); a tab with a XUL tab loads it, one without gets majOnglet{url}; null opens a new tab. */
  navigate(ongletId: IdOnglet | null, input: string): void;
  /**
   * The agent's naviguer: an http(s) URL loaded with a content principal of the tab's container, without taking the
   * keyboard (the user may be typing in the agent panel). A tab without a XUL tab gets majOnglet{url}.
   */
  navigateForAgent(ongletId: IdOnglet, url: string): void;
  /** The browser of a tab for the agent, its XUL tab created in the background if needed and loaded (TabSync.ensure). */
  ensure(ongletId: IdOnglet): Promise<any>;
  command(ongletId: IdOnglet, c: "reculer" | "avancer" | "recharger" | "rechargerSansCache" | "arreter"): void;
  /**
   * Electron's Vues.fermer: a tab the user closes. A page with unsaved changes (beforeunload) gets « Quitter ce site ? »
   * first; a page that does not answer within 5 s is closed anyway. A crashed tab or one without a XUL tab closes now.
   */
  closeTab(ongletId: IdOnglet): Promise<void>;
  /** Keyboard back to the displayed page (no-op when no web page is displayed). */
  focusPage(): void;
  /**
   * The UI iframe covers the whole window, agent panel included ("window": overlays, as Electron's single document),
   * the window left of the agent panel (true: empty and internal pages) or only its 240 px column (false).
   */
  setFullWindow(full: boolean | "window"): void;
  /**
   * Notes whether the terminal or the page has the keyboard (an agent card is about to take it) and returns what gives
   * it back: the UI document only knows its own focus, which is its body in both cases.
   */
  rememberFocus(): () => void;
  /** Width of the open agent panel while its handle is dragged (the saved width comes back from reglages). */
  setAgentWidth(px: number): void;
  /** Electron's surRaccourci: shortcuts the UI handles (⌘T, ⌘L, ⌘W). */
  onShortcut(cb: (r: Raccourci) => void): () => void;
  /** Electron's surPanneauOnglets: the ⌃Tab panel to show (null: closed). */
  onTabPanel(cb: (p: PanneauOnglets | null) => void): () => void;
  /** Electron's parcoursOnglets: mouse, Escape and ⌃ release from the ⌃Tab panel. */
  tabSwitch(m: MessageParcours): void;
}

/** Binds this browser window to the state window it claimed (store.windows.claim). */
export function createController(
  gBrowser: any,
  frame: HTMLIFrameElement,
  agentFrame: HTMLIFrameElement,
  store: WebAiOsStore,
  fenetreId: IdFenetre,
): WindowController {
  const tabs = new TabSync(gBrowser, store, fenetreId);
  tabs.sync(store.state);
  // The store outlives the window (macOS keeps running without one): drop this window's listeners when it goes, then
  // its state window (its tabs leave with it).
  const unsubscribe = [store.subscribe((state) => tabs.sync(state))];
  applyFrame(store.state.fenetres.find((f) => f.id === fenetreId)?.cadre ?? null);
  // Size and position kept for the next start (grouped: a drag fires dozens of events), as Electron's noterCadre.
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  const recordFrame = () => {
    clearTimeout(frameTimer);
    if (window.windowState === window.STATE_FULLSCREEN || window.windowState === window.STATE_MINIMIZED) return;
    const cadre = { x: window.screenX, y: window.screenY, largeur: window.outerWidth, hauteur: window.outerHeight };
    const old = store.state.fenetres.find((f) => f.id === fenetreId)?.cadre;
    if (old && (Object.keys(cadre) as (keyof typeof cadre)[]).every((k) => old[k] === cadre[k])) return;
    store.dispatch({ type: "cadrerFenetre", id: fenetreId, cadre });
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
      store.windows.release(fenetreId);
    },
    { once: true },
  );
  // The agent panel: --webaios-agent is its width when open, 0 when closed (the page and the UI make room for it).
  const agentOpen = (state: EtatNavigateur) => !!state.fenetres.find((x) => x.id === fenetreId)?.panneauAgentOuvert;
  const showAgent = (state: EtatNavigateur) => {
    const open = agentOpen(state);
    // Closed while the terminal had the keyboard (⌘J, ✦): it goes back to the page, or to the UI when no page shows.
    if (!open && document.activeElement === agentFrame) {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
      else frame.focus();
    }
    agentFrame.hidden = !open;
    const width = Math.min(LARGEUR_AGENT_MAX, Math.max(LARGEUR_AGENT_MIN, state.reglages.largeurPanneauAgent));
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
  const browserOf = (id: IdOnglet) => tabs.tab(id)?.linkedBrowser;
  /**
   * A crashed browser loads nothing: any navigation or command on a crashed tab puts a new XUL tab in its place, at `url`
   * or the tab's own (as Electron's loadURL revives a crashed page). Back/forward history is lost with it.
   */
  const revive = (id: IdOnglet, url?: string): boolean => {
    if (!store.state.onglets[id]?.plante) return false;
    tabs.recreate(id);
    store.dispatch({ type: "majOnglet", id, champs: { plante: false, ...(url ? { url } : {}) } });
    return true;
  };
  const shortcutListeners = new Set<(r: Raccourci) => void>();
  const panelListeners = new Set<(p: PanneauOnglets | null) => void>();
  // ⌃Tab: recent order and the walk in progress, as in Electron. No page previews in step 2: cards show the icon.
  const walk = new ParcoursOnglets({
    etat: () => store.state,
    agir: (a) => store.dispatch(a),
    envoyer: (_, p) => {
      // Escape and the ⌃ release must reach the panel, as FondFige's capture does in Electron.
      if (p && document.activeElement !== frame) frame.focus();
      for (const cb of panelListeners) cb(p);
    },
    apercu: () => null,
    capturer: () => Promise.resolve(),
    // Once the UI has dropped the panel: a command bar still open keeps the keyboard (Electron: the view is hidden).
    rendreFocus: () => void setTimeout(() => !frame.hasAttribute("full") && controller.focusPage()),
    // Headless (e2e), no window ever has the focus: the walk is still tested there.
    estFocalisee: () => Services.focus.activeWindow === window || Services.env.exists("MOZ_HEADLESS"),
  });
  walk.surEtat(store.state);
  unsubscribe.push(store.subscribe((state) => walk.surEtat(state)));

  const run = (s: Shortcut) => {
    const state = store.state;
    const f = state.fenetres.find((x) => x.id === fenetreId);
    const active = f?.actif[f.espaceActif];
    // Electron's menu: ⌘W on the empty page closes the window, only if none of its spaces has a tab.
    if (s.type === "raccourci" && s.r === "fermerOnglet" && !active && !Object.values(state.onglets).some((o) => o.fenetreId === fenetreId))
      window.close();
    else if (s.type === "raccourci") {
      frame.focus(); // the UI field must get the keys typed next, even from a web page
      for (const cb of shortcutListeners) cb(s.r);
    } else if (s.type === "rouvrir") store.dispatch({ type: "rouvrirOngletFerme", fenetreId });
    else if (s.type === "nieme") {
      const action = versNieme(state, fenetreId, s.n);
      if (action) store.dispatch(action);
    } else if (s.type === "espace") {
      const espace = state.espaces[s.n - 1];
      if (espace) store.dispatch({ type: "activerEspace", fenetreId, id: espace.id });
    } else if (s.type === "naviguer") {
      if (active) controller.command(active, s.c);
    } else if (s.type === "parcourir") walk.parcourir(fenetreId, s.delta);
    else if (s.type === "agent") {
      // Electron's menu: toggle, then, opened from a web page, the keyboard goes to the terminal.
      store.dispatch({ type: "basculerPanneauAgent", fenetreId });
      if (agentOpen(store.state)) {
        agentFrame.focus();
        for (const cb of shortcutListeners) cb("agent");
      }
    } else if (s.type === "fenetre") window.OpenBrowserWindow();
    else if (s.type === "fermerFenetre") window.close();
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
    if (e.key === "Control") walk.toucheRelachee(fenetreId);
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  // The UI documents' events stop at their own window: listen there too, on each load.
  for (const f of [frame, agentFrame])
    f.addEventListener("load", () => {
      f.contentWindow!.addEventListener("keydown", onKeyDown, true);
      f.contentWindow!.addEventListener("keyup", onKeyUp, true);
    });
  // ⌘Tab to another app during a walk: it ends without a tab change. Not "blur": moving the keyboard from a page to the UI
  // blurs the window too.
  window.addEventListener("deactivate", () => walk.fenetreQuittee(fenetreId));
  // ⇧click asks Firefox for a new window: a page's link opens a background tab instead, as ⌘click (TabSync adopts it).
  const openLinkIn = window.openLinkIn;
  window.openLinkIn = (url, where, params) => {
    const fromTab = params?.openerBrowser && gBrowser.getTabForBrowser(params.openerBrowser)?.hasAttribute("webaios-tab-id");
    openLinkIn(url, where === "window" && fromTab ? "tab" : where, params);
  };
  // Quitting asks no page, as Electron. Every quit path asks each window (CanClose) right after quit-application-requested,
  // unless an observer cancelled it. Closing one window keeps Firefox's question.
  let quit: { data: boolean } | undefined;
  const quitObserver = { observe: (subject: any) => void (quit = subject.QueryInterface(Ci.nsISupportsPRBool)) };
  Services.obs.addObserver(quitObserver, "quit-application-requested");
  unsubscribe.push(() => Services.obs.removeObserver(quitObserver, "quit-application-requested"));
  const canCloseWindow = window.CanCloseWindow;
  window.CanCloseWindow = () => (quit && !quit.data) || canCloseWindow();
  /** Tabs whose page is being asked: a second ⌘W must not ask again. */
  const asking = new Set<IdOnglet>();
  for (const id of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS]) document.getElementById(id)?.setAttribute("disabled", "true");

  const controller: WindowController = {
    fenetreId,
    store,
    navigate(ongletId, input) {
      const url = versUrl(input, store.state.reglages.moteur);
      if (!url) return;
      if (!ongletId) return void store.dispatch({ type: "ouvrirOnglet", fenetreId, url });
      if (revive(ongletId, url)) return;
      const browser = browserOf(ongletId);
      if (!browser) return void store.dispatch({ type: "majOnglet", id: ongletId, champs: { url } });
      // What the user typed in the address bar: Firefox loads it with the system principal too.
      browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      browser.focus();
    },
    navigateForAgent(ongletId, url) {
      const uri = Services.io.newURI(url);
      if (!uri.schemeIs("http") && !uri.schemeIs("https")) throw new Error(`URL refusée (http ou https uniquement) : ${url}`);
      // Revived at its old URL, then loaded below like any agent load: never with the system principal.
      revive(ongletId);
      const tab = tabs.tab(ongletId);
      if (!tab) return void store.dispatch({ type: "majOnglet", id: ongletId, champs: { url } });
      const triggeringPrincipal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: tab.userContextId });
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal });
    },
    ensure: (ongletId) => tabs.ensure(ongletId),
    command(ongletId, c) {
      if (c !== "arreter" && revive(ongletId)) return;
      const browser = browserOf(ongletId);
      if (!browser) return;
      if (c === "reculer") browser.goBack();
      else if (c === "avancer") browser.goForward();
      else if (c === "recharger") browser.reload();
      else if (c === "rechargerSansCache") browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      else browser.stop();
    },
    async closeTab(ongletId) {
      const close = () => void store.dispatch({ type: "fermerOnglet", id: ongletId });
      const browser = browserOf(ongletId);
      if (!browser || store.state.onglets[ongletId]?.plante || !browser.hasBeforeUnload) return close();
      if (asking.has(ongletId)) return;
      asking.add(ongletId);
      try {
        // "dontUnload" only runs the page's beforeunload; false: it wants to ask. A failure (crash meanwhile) lets it go.
        const answer = browser.asyncPermitUnload("dontUnload").then((r: { permitUnload: boolean }) => r.permitUnload, () => true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const permit = await Promise.race([answer, new Promise<boolean>((r) => (timer = setTimeout(() => r(true), 5000)))]);
        clearTimeout(timer);
        if (permit) return close();
        // Firefox selects the tab its question opens on: the state follows, or the sidebar would show another tab as active.
        const f = store.state.fenetres.find((x) => x.id === fenetreId);
        const before = f?.actif[f.espaceActif];
        if (before !== ongletId) store.dispatch({ type: "activerOnglet", id: ongletId });
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
        // Rester changes nothing, as Electron's window-modal dialog: the tab shown before comes back.
        else if (before && before !== ongletId && store.state.onglets[before]) store.dispatch({ type: "activerOnglet", id: before });
      } finally {
        asking.delete(ongletId);
      }
    },
    focusPage() {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
    },
    setFullWindow(full) {
      frame.toggleAttribute("full", !!full);
      frame.toggleAttribute("over", full === "window");
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
    onShortcut(cb) {
      shortcutListeners.add(cb);
      return () => void shortcutListeners.delete(cb);
    },
    onTabPanel(cb) {
      panelListeners.add(cb);
      return () => void panelListeners.delete(cb);
    },
    tabSwitch: (m) => walk.message(fenetreId, m),
  };
  return controller;
}

/** Puts the window where the state last saw it, if that frame still overlaps a screen. */
function applyFrame(c: Cadre | null): void {
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
