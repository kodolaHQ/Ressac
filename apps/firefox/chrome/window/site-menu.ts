/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WindowId } from "../../shared/model";
import { tabProfile } from "../../shared/model";
import type { RessacStore } from "../store";

/**
 * The « Navigation » menu entry « Oublier les autorisations de ce site » (oublierAutorisations): forgets the
 * active tab's origin in its space's profile. A menu in this window's menu bar, before « Fenêtre » (spike P9).
 */
export function mountSiteMenu(win: Window, store: RessacStore, windowId: WindowId): void {
  const doc = win.document as Document & { createXULElement(tag: string): Element };
  const menu = doc.createXULElement("menu");
  menu.setAttribute("label", "Navigation");
  const popup = doc.createXULElement("menupopup");
  const item = doc.createXULElement("menuitem");
  item.id = "ressac-forget-permissions";
  item.setAttribute("label", "Oublier les autorisations de ce site");
  item.addEventListener("command", () => {
    const f = store.state.windows.find((x) => x.id === windowId);
    const tab = f && store.state.tabs[f.active[f.activeSpace] ?? ""];
    if (!tab) return;
    try {
      void store.sitePermissions.forget(tabProfile(store.state, tab), new URL(tab.url).origin);
    } catch {
      // A URL without an origin: nothing to forget.
    }
  });
  popup.append(item);
  menu.append(popup);
  doc.getElementById("main-menubar")!.insertBefore(menu, doc.getElementById("windowMenu"));
}
