import type { TabId } from "../../shared/model";
import { FIREFOX_COMMANDS } from "./keys";

/**
 * The Ressac tab behind a popup: its opener's tab, or, for a popup opened by a popup (the steps of a sign-in),
 * the tab behind that one. None once the opener and its tab are gone.
 */
function popupSource(win: Window): TabId | undefined {
  // The chain can loop: window.open(url, name) to an existing window makes the caller its opener (nsWindowWatcher).
  const seen = new Set();
  for (let bc = win.gBrowser.selectedBrowser.browsingContext?.opener?.top; bc && !seen.has(bc); bc = bc.opener?.top) {
    const browser = bc.embedderElement;
    const tabId = browser?.ownerDocument.defaultView?.gBrowser?.getTabForBrowser(browser)?.getAttribute("ressac-tab-id");
    if (tabId) return tabId;
    seen.add(bc);
  }
  return undefined;
}

/**
 * A popup stays a plain Firefox window (no address bar): its title always shows the site, against
 * phishing, and its target=_blank links become Ressac tabs right after the source tab. Run as the popup's document
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
  win.ressacPopupSource = popupSource(win);
  // Still Firefox's window (sign-in pages), but never a way to Firefox's own windows and pages; ⌘W still closes it.
  for (const id of [...FIREFOX_COMMANDS.filter((c) => c !== "cmd_close"), "View:PageSource"])
    win.document.getElementById(id)?.setAttribute("disabled", "true");
}
