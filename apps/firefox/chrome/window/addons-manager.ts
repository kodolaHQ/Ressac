/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WindowId, TabId } from "../../shared/model";
import type { WebAiOsStore } from "../store";
import type { TabSync } from "./tabs";

/** Replaces win.BrowserAddonUI.openAddonsMgr: about:addons is a WebAiOs tab of this window's active space. */
export function routeAddonsManager(win: Window, store: WebAiOsStore, windowId: WindowId, tabs: TabSync): void {
  (win as any).BrowserAddonUI.openAddonsMgr = async (view?: string): Promise<Window> => {
    const state = store.state;
    const f = state.windows.find((x) => x.id === windowId);
    const existing = f && (f.order[f.activeSpace] ?? []).find((id) => state.tabs[id]?.url.startsWith("about:addons"));
    const id: TabId = existing || crypto.randomUUID();
    if (existing) store.dispatch({ type: "activateTab", id });
    else store.dispatch({ type: "openTab", windowId: windowId, url: "about:addons" }, () => id);
    const browser = await tabs.ensure(id);
    // The page defines loadView once its script ran, after the load ensure waits for may have ended.
    for (const end = Date.now() + 5000; typeof browser.contentWindow?.loadView !== "function" && Date.now() < end; )
      await new Promise((r) => setTimeout(r, 50));
    browser.contentWindow.loadView(view ?? "addons://list/extension");
    return browser.contentWindow;
  };
}
