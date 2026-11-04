import type { IdOnglet } from "../../../navigateur/src/commun/modele";
import type { WebAiOsStore } from "../store";

/**
 * The WebAiOs tab behind a popup: its opener's tab, or, for a popup opened by a popup (the steps of a sign-in),
 * the tab behind that one.
 */
export function popupSource(win: Window, store: WebAiOsStore): IdOnglet | undefined {
  let bc = win.gBrowser.selectedBrowser.browsingContext.opener?.top;
  while (bc) {
    const browser = bc.embedderElement;
    const ongletId = browser?.ownerDocument.defaultView?.gBrowser?.getTabForBrowser(browser)?.getAttribute("webaios-tab-id");
    if (ongletId && store.state.onglets[ongletId]) return ongletId;
    bc = bc.opener?.top;
  }
  return undefined;
}

/**
 * A popup stays a plain Firefox window (no address bar), as in Electron: its title shows the site, against phishing,
 * and its target=_blank links become WebAiOs tabs right after the source tab.
 */
export function setupPopup(win: Window, source: IdOnglet): void {
  const gBrowser = win.gBrowser;
  const title = gBrowser.getWindowTitleForBrowser.bind(gBrowser);
  gBrowser.getWindowTitleForBrowser = (browser: any) => {
    let site = "";
    try {
      site = browser.currentURI.hostPort;
    } catch {
      // a URL without a host: the title alone
    }
    const t = browser.contentTitle || title(browser);
    return site ? `${site} — ${t}` : t;
  };
  gBrowser.updateTitlebar();
  // Firefox sends a popup's new tabs to its most recent full window, with no opener tab: that window's TabSync reads
  // the source here (its addTab is given the popup's browser as openerBrowser).
  win.webaiosPopupSource = source;
}
