import type { MessageParcours, PanneauOnglets, Raccourci } from "../../../navigateur/src/commun/api";
import type { IdFenetre, IdOnglet } from "../../../navigateur/src/commun/modele";
import { versUrl } from "../../../navigateur/src/main/adresse";
import { ParcoursOnglets } from "../../../navigateur/src/main/parcours-onglets";
import { versNieme } from "../../../navigateur/src/main/raccourcis";
import type { WebAiOsStore } from "../store";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor, type Shortcut } from "./keys";
import { TabSync } from "./tabs";

export interface WindowController {
  readonly fenetreId: IdFenetre;
  readonly store: WebAiOsStore;
  /** Electron's naviguer: versUrl(input, moteur); a tab with a XUL tab loads it, one without gets majOnglet{url}; null opens a new tab. */
  navigate(ongletId: IdOnglet | null, input: string): void;
  /** The browser of a tab for the agent, its XUL tab created in the background if needed and loaded (TabSync.ensure). */
  ensure(ongletId: IdOnglet): Promise<any>;
  command(ongletId: IdOnglet, c: "reculer" | "avancer" | "recharger" | "rechargerSansCache" | "arreter"): void;
  /** Keyboard back to the displayed page (no-op when no web page is displayed). */
  focusPage(): void;
  /** The UI iframe covers the whole window (overlays, empty page) or only its 240 px column. */
  setFullWindow(full: boolean): void;
  /** Electron's surRaccourci: shortcuts the UI handles (⌘T, ⌘L, ⌘W). */
  onShortcut(cb: (r: Raccourci) => void): () => void;
  /** Electron's surPanneauOnglets: the ⌃Tab panel to show (null: closed). */
  onTabPanel(cb: (p: PanneauOnglets | null) => void): () => void;
  /** Electron's parcoursOnglets: mouse, Escape and ⌃ release from the ⌃Tab panel. */
  tabSwitch(m: MessageParcours): void;
}

/** Binds the main browser window to the first window of the state. */
export function createController(gBrowser: any, frame: HTMLIFrameElement, store: WebAiOsStore): WindowController {
  const fenetreId = store.state.fenetres[0]!.id;
  const tabs = new TabSync(gBrowser, store, fenetreId);
  tabs.sync(store.state);
  // The store outlives the window (macOS keeps running without one): drop this window's listeners when it goes.
  const unsubscribe = [store.subscribe((state) => tabs.sync(state))];
  window.addEventListener("unload", () => unsubscribe.forEach((u) => u()), { once: true });
  // After a tab switch Firefox gives the keyboard to the selected browser; the parking tab is no page, the UI keeps it.
  window.addEventListener("TabSwitchDone", () => {
    if (!tabs.displayed()) frame.focus();
  });
  const browserOf = (id: IdOnglet) => tabs.tab(id)?.linkedBrowser;
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
    if (s.type === "raccourci") {
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
    // ⌘N ("rien") is single-window: it does nothing.
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
  // The UI document's events stop at its own window: listen there too, on each load.
  frame.addEventListener("load", () => {
    frame.contentWindow!.addEventListener("keydown", onKeyDown, true);
    frame.contentWindow!.addEventListener("keyup", onKeyUp, true);
  });
  // ⌘Tab to another app during a walk: it ends without a tab change. Not "blur": moving the keyboard from a page to the UI
  // blurs the window too.
  window.addEventListener("deactivate", () => walk.fenetreQuittee(fenetreId));
  for (const id of [...FIREFOX_KEYS, ...FIREFOX_COMMANDS]) document.getElementById(id)?.setAttribute("disabled", "true");

  const controller: WindowController = {
    fenetreId,
    store,
    navigate(ongletId, input) {
      const url = versUrl(input, store.state.reglages.moteur);
      if (!url) return;
      if (!ongletId) return void store.dispatch({ type: "ouvrirOnglet", fenetreId, url });
      const browser = browserOf(ongletId);
      if (!browser) return void store.dispatch({ type: "majOnglet", id: ongletId, champs: { url } });
      // What the user typed in the address bar: Firefox loads it with the system principal too.
      browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      browser.focus();
    },
    ensure: (ongletId) => tabs.ensure(ongletId),
    command(ongletId, c) {
      const browser = browserOf(ongletId);
      if (!browser) return;
      if (c === "reculer") browser.goBack();
      else if (c === "avancer") browser.goForward();
      else if (c === "recharger") browser.reload();
      else if (c === "rechargerSansCache") browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
      else browser.stop();
    },
    focusPage() {
      if (tabs.displayed()) gBrowser.selectedBrowser.focus();
    },
    setFullWindow(full) {
      frame.toggleAttribute("full", full);
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
