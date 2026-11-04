import type { History } from "../store/history";
import { TAB_ID } from "./tabs";

const { LOCATION_CHANGE_ERROR_PAGE } = Ci.nsIWebProgressListener;

/**
 * Notes the visits of this window's WebAiOs tabs: each committed top-level location (a redirect gives only its target,
 * an in-page change or pushState each new URL), then the title as the tab's label settles. The parking tab has no TAB_ID.
 */
export function trackVisits(gBrowser: any, history: History): void {
  const idOf = (tab: any): string | null => tab?.getAttribute(TAB_ID) ?? null;
  gBrowser.addTabsProgressListener({
    onLocationChange: (browser: any, progress: any, _request: unknown, location: any, flags: number) => {
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
