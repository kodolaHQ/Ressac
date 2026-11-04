import type { History } from "../store/history";
import { TAB_ID } from "./tabs";

const { LOCATION_CHANGE_ERROR_PAGE, LOCATION_CHANGE_SAME_DOCUMENT, STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;

/** Electron's capture-texte.ts DELAI_CAPTURE: the page's text is read this long after it settled. */
const CAPTURE_DELAY_MS = 1500;

type Context = { espaceId: string; prive: boolean } | null;

/** Whether the response was asked for with an Authorization header (an HTTP-authenticated page: nothing retained). */
function authenticated(request: any): boolean {
  try {
    request.QueryInterface(Ci.nsIHttpChannel).getRequestHeader("Authorization");
    return true;
  } catch {
    return false;
  }
}

/**
 * Notes the visits of this window's WebAiOs tabs: each committed top-level location (a redirect gives only its target,
 * an in-page change or pushState each new URL), then the title as the tab's label settles. The parking tab has no TAB_ID.
 * Also retains the page's text for the agent's memory, CAPTURE_DELAY_MS after a page settles (Electron's brancherCapture):
 * never for a private space, an error page or an authenticated one; URL and space are checked again after the read.
 */
export function trackVisits(gBrowser: any, history: History, context: (id: string) => Context): void {
  const idOf = (tab: any): string | null => tab?.getAttribute(TAB_ID) ?? null;
  // Per browser: the pending read, and whether this page must not be retained (error page, authentication).
  const timers = new WeakMap<object, number>();
  const skipped = new WeakSet<object>();
  const cancel = (browser: any) => {
    window.clearTimeout(timers.get(browser));
    timers.delete(browser);
  };
  const plan = (browser: any) => {
    cancel(browser);
    const url: string = browser.currentURI?.spec ?? "";
    const id = idOf(gBrowser.getTabForBrowser(browser));
    const c = id && context(id);
    if (!c || c.prive || !/^https?:\/\//.test(url) || skipped.has(browser)) return;
    timers.set(browser, window.setTimeout(() => void retain(browser, id, url, c.espaceId).catch(() => {}), CAPTURE_DELAY_MS));
  };
  const retain = async (browser: any, id: string, url: string, espaceId: string) => {
    timers.delete(browser);
    const stillHere = () => {
      const c = context(id);
      return browser.currentURI?.spec === url && c && !c.prive && c.espaceId === espaceId;
    };
    if (!stillHere()) return;
    const r = await browser.browsingContext.currentWindowGlobal.getActor("WebAiOsPage").sendQuery("getText");
    const texte = String(r?.texte ?? "");
    if (stillHere() && texte.trim()) history.retain({ url, espaceId, titre: browser.contentTitle || url, texte });
  };
  gBrowser.addTabsProgressListener({
    onStateChange: (browser: any, progress: any, request: any, flags: number, status: number) => {
      if (!progress.isTopLevel || !(flags & STATE_IS_NETWORK)) return;
      if (flags & STATE_START) {
        cancel(browser);
        skipped.delete(browser);
      } else if (flags & STATE_STOP) {
        if (!Components.isSuccessCode(status) || authenticated(request)) skipped.add(browser);
        else plan(browser);
      }
    },
    onLocationChange: (browser: any, progress: any, _request: unknown, location: any, flags: number) => {
      if (progress.isTopLevel) {
        if (flags & LOCATION_CHANGE_ERROR_PAGE) skipped.add(browser);
        if (flags & LOCATION_CHANGE_SAME_DOCUMENT) plan(browser);
        else cancel(browser);
      }
      if (!progress.isTopLevel || flags & LOCATION_CHANGE_ERROR_PAGE) return;
      const tab = gBrowser.getTabForBrowser(browser);
      const id = idOf(tab);
      if (id) history.visit(id, location.spec, tab.label);
    },
  });
  gBrowser.tabContainer.addEventListener("TabAttrModified", (e: CustomEvent) => {
    const tab: any = e.target;
    const id = idOf(tab);
    if (id && e.detail.changed.includes("label")) history.title(id, tab.linkedBrowser.currentURI?.spec ?? "", tab.label);
  });
}
