import type { TabId } from "../../shared/model";
import type { WebAiOsStore } from "../store";
import { TAB_ID } from "./tabs";

/**
 * The calls of this window's background tabs, for the sidebar's call bar: a tab that uses the camera or the microphone
 * when it is left gets `call` in the state, kept up to date by its actor until the call ends or the tab is shown again.
 * Returns the bar's buttons (`press`) and what takes the listeners down.
 */
export function mountCalls(win: any, store: WebAiOsStore): { press(id: TabId, which: "mic" | "camera"): void; dispose(): void } {
  const gBrowser = win.gBrowser;
  const idOf = (tab: any): TabId | null => tab?.getAttribute?.(TAB_ID) ?? null;
  const tabOf = (id: TabId) => gBrowser.tabs.find((t: any) => idOf(t) === id);
  const actor = (tab: any) => {
    try {
      return tab.linkedBrowser.browsingContext?.currentWindowGlobal?.getActor("WebAiOsCall");
    } catch {
      return undefined; // not an http(s) page
    }
  };
  /** Sites added without a build: pref `webaios.call.sites`, a JSON array of CallSite (shared/call-sites.ts). */
  const moreSites = (): unknown[] => {
    try {
      const more = JSON.parse(Services.prefs.getStringPref("webaios.call.sites", "[]"));
      return Array.isArray(more) ? more : [];
    } catch {
      return [];
    }
  };
  const set = (id: TabId, call: unknown) => void store.dispatch({ type: "setCall", id, call: (call as { mic: boolean; camera: boolean } | null) ?? null });

  const onSelect = (e: any) => {
    const [shown, left] = [idOf(e.target), idOf(e.detail?.previousTab)];
    if (shown && store.state.tabs[shown]?.call) {
      actor(e.target)?.sendAsyncMessage("call:unwatch");
      set(shown, null);
    }
    if (!left) return;
    void actor(e.detail.previousTab)
      ?.sendQuery("call:watch", moreSites())
      // Shown again meanwhile: its call needs no bar.
      .then((call: unknown) => (call && gBrowser.selectedTab !== e.detail.previousTab ? set(left, call) : actor(e.detail.previousTab)?.sendAsyncMessage("call:unwatch")))
      .catch(() => {});
  };
  gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  const observer = {
    observe(_subject: unknown, _topic: string, data: string) {
      const { browserId, call } = JSON.parse(data);
      const tab = gBrowser.tabs.find((t: any) => t.linkedBrowser?.browserId === browserId);
      const id = idOf(tab);
      if (!id || gBrowser.selectedTab === tab) return;
      if (!call) actor(tab)?.sendAsyncMessage("call:unwatch");
      set(id, call);
    },
  };
  Services.obs.addObserver(observer, "webaios-call-state");
  return {
    press(id, which) {
      if (store.state.tabs[id]?.call) actor(tabOf(id))?.sendAsyncMessage("call:press", which);
    },
    dispose() {
      gBrowser.tabContainer.removeEventListener("TabSelect", onSelect);
      Services.obs.removeObserver(observer, "webaios-call-state");
    },
  };
}
