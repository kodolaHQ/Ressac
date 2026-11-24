import { composeText, isYoutubeVideo, type PageParts } from "../../shared/page-text";
import type { History } from "../store/history";
import { TAB_ID } from "./tabs";

const { LOCATION_CHANGE_ERROR_PAGE, LOCATION_CHANGE_SAME_DOCUMENT, STATE_START, STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;

/** The page's text is read this long after it settled. */
const CAPTURE_DELAY_MS = 1500;
/** A page's own URL changes (pushState, #) are noted at most this often per tab, then its latest one. */
const SAME_DOCUMENT_GAP_MS = 3000;
/** After its own URL change, a page the user is not looking at has its text read at most this often, then the latest URL's: a pushState loop in a forgotten tab would keep a page per change. */
const SAME_DOCUMENT_TEXT_GAP_MS = 30_000;

type Context = { spaceId: string; private: boolean; byAgent: boolean } | null;

/**
 * For a top-level document response: its browser, and whether it is HTTP-authenticated (sent an Authorization header
 * or got a 401): the text of a signed-in page is never kept. Parent-side: the progress
 * listener only sees a RemoteWebProgressRequest, which has no request headers.
 */
function topDocumentResponse(subject: any): { browser: any; auth: boolean } | null {
  const channel = subject.QueryInterface(Ci.nsIHttpChannel);
  const bc = channel.loadInfo.browsingContext;
  if (!channel.isDocument || !bc || bc.parent || !bc.embedderElement) return null;
  let auth = channel.responseStatus === 401;
  try {
    auth ||= !!channel.getRequestHeader("Authorization");
  } catch {}
  return { browser: bc.embedderElement, auth };
}

/**
 * Notes the visits of this window's Ressac tabs: each committed top-level location (a redirect gives only its target,
 * an in-page change or pushState each new URL), then the title as the tab's label settles. The parking tab has no TAB_ID.
 * Also retains the page's text for the agent's memory, CAPTURE_DELAY_MS after a page settles:
 * never for a private space, an error page or an authenticated one; URL and space are checked again after the read.
 */
/** What the tab's state learns of its top-level loads (the masking flag, spec § 5.3), before the visit is noted. */
type LoadNote =
  | { type: "locationCommitted"; id: string; url: string; history: boolean; sameDocument: boolean }
  | { type: "loadStopped"; id: string };

export function trackVisits(gBrowser: any, history: History, context: (id: string) => Context, note: (a: LoadNote) => void): void {
  const idOf = (tab: any): string | null => tab?.getAttribute(TAB_ID) ?? null;
  // Per browser: the pending read, and whether this page must not be retained (error page, authentication).
  const timers = new WeakMap<object, number>();
  const readAt = new WeakMap<object, number>();
  const skipped = new WeakSet<object>();
  // Per browser, whether its last top-level document response was authenticated. Separate from `skipped`: the response
  // comes before the parent's STATE_START, which resets `skipped`.
  const authenticated = new WeakSet<object>();
  // Per browser: when a same-document change was last noted, and the one held for the end of the gap.
  const sameDocumentAt = new WeakMap<object, number>();
  const held = new WeakMap<object, { timer: number; note: () => void }>();
  /** Notes the held change now (end of the gap, or a new page loads: it is older than that page). */
  const flushHeld = (browser: any) => {
    const h = held.get(browser);
    if (!h) return;
    window.clearTimeout(h.timer);
    held.delete(browser);
    sameDocumentAt.set(browser, Date.now());
    h.note();
  };
  /** A page calling pushState in a loop would otherwise add a visit per call (Firefox allows 20 a second). */
  const noteSameDocument = (browser: any, note: () => void) => {
    window.clearTimeout(held.get(browser)?.timer);
    held.delete(browser);
    const wait = (sameDocumentAt.get(browser) ?? -Infinity) + SAME_DOCUMENT_GAP_MS - Date.now();
    if (wait <= 0) {
      sameDocumentAt.set(browser, Date.now());
      note();
    } else held.set(browser, { timer: window.setTimeout(() => flushHeld(browser), wait), note });
  };
  const cancel = (browser: any) => {
    window.clearTimeout(timers.get(browser));
    timers.delete(browser);
  };
  const observer = {
    observe(subject: any) {
      const r = topDocumentResponse(subject);
      if (r?.auth) authenticated.add(r.browser);
      else if (r) authenticated.delete(r.browser);
    },
  };
  Services.obs.addObserver(observer, "http-on-examine-response");
  window.addEventListener("unload", () => Services.obs.removeObserver(observer, "http-on-examine-response"), { once: true });
  const plan = (browser: any, delay = CAPTURE_DELAY_MS) => {
    cancel(browser);
    const url: string = browser.currentURI?.spec ?? "";
    const id = idOf(gBrowser.getTabForBrowser(browser));
    const c = id && context(id);
    if (!c || c.private || !/^https?:\/\//.test(url) || skipped.has(browser)) return;
    const read = () => {
      readAt.set(browser, Date.now());
      void retain(browser, id, url, c.spaceId, c.byAgent).catch(() => {});
    };
    timers.set(browser, window.setTimeout(read, delay));
  };
  /** `byAgent`: the tab's flag when the read was planned; the agent's then or now, the text is the agent's. */
  const retain = async (browser: any, id: string, url: string, spaceId: string, byAgent: boolean) => {
    timers.delete(browser);
    const stillHere = () => {
      const c = context(id);
      return browser.currentURI?.spec === url && c && !c.private && c.spaceId === spaceId;
    };
    if (!stillHere()) return;
    const actor = browser.browsingContext.currentWindowGlobal.getActor("RessacPage");
    const parts: PageParts | undefined = await actor.sendQuery("getParts", { video: isYoutubeVideo(url) });
    // An actor built before getParts existed answers nothing: fall back to the body text alone.
    const text = parts ? composeText(parts) : String((await actor.sendQuery("getText"))?.text ?? "");
    if (stillHere() && text.trim()) history.retain({ url, spaceId: spaceId, title: browser.contentTitle || url, text: text, byAgent: byAgent || context(id)?.byAgent !== false });
  };
  gBrowser.addTabsProgressListener({
    onStateChange: (browser: any, progress: any, _request: unknown, flags: number, status: number) => {
      if (!progress.isTopLevel || !(flags & STATE_IS_NETWORK)) return;
      if (flags & STATE_START) {
        cancel(browser);
        skipped.delete(browser);
      } else if (flags & STATE_STOP) {
        const id = idOf(gBrowser.getTabForBrowser(browser));
        if (id) note({ type: "loadStopped", id });
        if (!Components.isSuccessCode(status) || authenticated.has(browser)) skipped.add(browser);
        else plan(browser);
      }
    },
    onLocationChange: (browser: any, progress: any, request: any, location: any, flags: number) => {
      const loadId = progress.isTopLevel ? idOf(gBrowser.getTabForBrowser(browser)) : null;
      if (loadId) {
        // The load's address before its redirects: a user load is recognised by it. None known: never the user's.
        let original = "";
        try {
          original = request?.QueryInterface(Ci.nsIChannel).originalURI?.spec ?? "";
        } catch {}
        const historyLoad = !!(progress.loadType & Ci.nsIDocShell.LOAD_CMD_HISTORY);
        note({ type: "locationCommitted", id: loadId, url: original, history: historyLoad, sameDocument: !!(flags & LOCATION_CHANGE_SAME_DOCUMENT) });
      }
      if (progress.isTopLevel) {
        if (flags & LOCATION_CHANGE_ERROR_PAGE) skipped.add(browser);
        // The tab in front of the user keeps every page they browse; a tab left behind is held to the gap.
        const watched = browser === gBrowser.selectedBrowser && window.document.hasFocus();
        if (flags & LOCATION_CHANGE_SAME_DOCUMENT)
          plan(browser, watched ? CAPTURE_DELAY_MS : Math.max(CAPTURE_DELAY_MS, (readAt.get(browser) ?? -Infinity) + SAME_DOCUMENT_TEXT_GAP_MS - Date.now()));
        else cancel(browser);
      }
      if (!progress.isTopLevel || flags & LOCATION_CHANGE_ERROR_PAGE) return;
      const tab = gBrowser.getTabForBrowser(browser);
      const id = idOf(tab);
      if (!id) return;
      // A held note takes the tab's title if the tab still shows its URL (a single-page site sets it after pushState), else
      // the title it had then: flushed by a new page, it must not take that page's.
      // A held note keeps the tab's flag of now: flushed after the user takes the tab back, it is still the agent's.
      const [url, title, byAgent] = [location.spec, tab.label, context(id)?.byAgent !== false];
      if (flags & LOCATION_CHANGE_SAME_DOCUMENT)
        noteSameDocument(browser, () => history.visit(id, url, browser.currentURI?.spec === url ? tab.label : title, byAgent));
      else {
        flushHeld(browser);
        history.visit(id, url, title);
      }
    },
  });
  gBrowser.tabContainer.addEventListener("TabAttrModified", (e: CustomEvent) => {
    const tab: any = e.target;
    const id = idOf(tab);
    if (id && e.detail.changed.includes("label")) history.title(id, tab.linkedBrowser.currentURI?.spec ?? "", tab.label);
    if (id && e.detail.changed.includes("image")) history.icon(id, tab.linkedBrowser.currentURI?.spec ?? "", tab.getAttribute("image") ?? "");
  });
}
