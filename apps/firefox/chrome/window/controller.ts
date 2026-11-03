import type { IdFenetre, IdOnglet } from "../../../navigateur/src/commun/modele";
import { versUrl } from "../../../navigateur/src/main/adresse";
import type { WebAiOsStore } from "../store";
import { TabSync } from "./tabs";

export interface WindowController {
  readonly fenetreId: IdFenetre;
  readonly store: WebAiOsStore;
  /** Electron's naviguer: versUrl(input, moteur); a tab with a XUL tab loads it, one without gets majOnglet{url}; null opens a new tab. */
  navigate(ongletId: IdOnglet | null, input: string): void;
  command(ongletId: IdOnglet, c: "reculer" | "avancer" | "recharger" | "rechargerSansCache" | "arreter"): void;
  /** Keyboard back to the displayed page (no-op when no web page is displayed). */
  focusPage(): void;
  /** The UI iframe covers the whole window (overlays, empty page) or only its 240 px column. */
  setFullWindow(full: boolean): void;
}

/** Binds the main browser window to the first window of the state. */
export function createController(gBrowser: any, frame: Element, store: WebAiOsStore): WindowController {
  const fenetreId = store.state.fenetres[0]!.id;
  const tabs = new TabSync(gBrowser, store, fenetreId);
  tabs.sync(store.state);
  store.subscribe((state) => tabs.sync(state));
  const browserOf = (id: IdOnglet) => tabs.tab(id)?.linkedBrowser;
  return {
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
  };
}
