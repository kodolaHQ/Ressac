import type { TabId } from "../../shared/model";

/**
 * The WebAiOs tab behind a popup: its opener's tab, or, for a popup opened by a popup (the steps of a sign-in),
 * the tab behind that one. None once the opener and its tab are gone.
 */
function popupSource(win: Window): TabId | undefined {
  let bc = win.gBrowser.selectedBrowser.browsingContext?.opener?.top;
  while (bc) {
    const browser = bc.embedderElement;
    const tabId = browser?.ownerDocument.defaultView?.gBrowser?.getTabForBrowser(browser)?.getAttribute("webaios-tab-id");
    if (tabId) return tabId;
    bc = bc.opener?.top;
  }
  return undefined;
}

/**
 * A popup stays a plain Firefox window (no address bar): its title always shows the site, against
 * phishing, and its target=_blank links become WebAiOs tabs right after the source tab. Run as the popup's document
 * loads, before its page can open anything.
 */
export function setupPopup(win: Window): void {
  const gBrowser = win.gBrowser;
  const title = gBrowser.getWindowTitleForBrowser.bind(gBrowser);
  gBrowser.getWindowTitleForBrowser = (browser: any) => {
    const uri = Services.io.createExposableURI(browser.currentURI);
    let site = "";
    try {
      site = uri.hostPort;
    } catch {
      // no host (about:blank, data:, blob:): what Firefox shows instead, never the page's own title alone
    }
    site ||= uri.schemeIs("about") ? uri.spec : uri.prePath;
    const t = (browser.contentTitle || title(browser)).replace(/\0/g, "");
    return t ? `${site} — ${t}` : site;
  };
  gBrowser.updateTitlebar();
  // Firefox sends a popup's new tabs to its most recent full window, with no opener tab: that window's TabSync reads
  // the source here (its addTab is given the popup's browser as openerBrowser).
  win.webaiosPopupSource = popupSource(win);
}
