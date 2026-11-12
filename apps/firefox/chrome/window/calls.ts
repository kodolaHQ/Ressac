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
  const { PictureInPicture } = ChromeUtils.importESModule("moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs") as any;
  /** Asks the tab's frames for the call's video, a few times: the site shows it a moment after the camera starts. */
  const float = (tab: any) => {
    for (const ms of [300, 1000, 2500])
      win.setTimeout(() => {
        const browser = tab.linkedBrowser;
        // Not shown again meanwhile, and not a player the user closed.
        if (!browser?.browsingContext || gBrowser.selectedTab === tab || PictureInPicture.weakAutoPipBrowserClosedDeliberately.has(browser)) return;
        for (const context of browser.browsingContext.getAllBrowsingContextsInSubtree())
          try {
            context.currentWindowGlobal?.getActor("WebAiOsCall").sendAsyncMessage("call:leave");
          } catch {
            // not an http(s) frame
          }
      }, ms);
  };
  // A tab closed while its player was still opening leaves it behind (Firefox closes only a player already there).
  const onClose = (e: any) => {
    const browser = e.target.linkedBrowser;
    for (const ms of [0, 500, 2000])
      win.setTimeout(() => {
        for (const player of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
          const from = PictureInPicture.weakWinToBrowser.get(player);
          // Its tab's, or (last pass) one Firefox never tied to a tab: the tab went before the player was set up.
          if (from === browser || (ms === 2000 && !from?.isConnected)) player.close();
        }
      }, ms);
  };
  gBrowser.tabContainer.addEventListener("TabClose", onClose);
  gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  const observer = {
    observe(_subject: unknown, _topic: string, data: string) {
      const { browserId, call } = JSON.parse(data);
      const tab = gBrowser.tabs.find((t: any) => t.linkedBrowser?.browserId === browserId);
      const id = idOf(tab);
      if (!id || gBrowser.selectedTab === tab) return;
      // The camera is back on: its video floats again (the player closed with the video when the camera went off).
      if (call?.camera && store.state.tabs[id]?.call?.camera === false) float(tab);
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
      gBrowser.tabContainer.removeEventListener("TabClose", onClose);
      Services.obs.removeObserver(observer, "webaios-call-state");
    },
  };
}
