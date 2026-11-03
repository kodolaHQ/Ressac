/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WebAiOsStore } from "../store";
import { createController } from "./controller";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";

declare global {
  interface Window {
    gBrowser: any;
    gNotificationBox: any;
    delayedStartupPromise: Promise<void>;
    webaiosWindow?: import("./controller").WindowController;
  }
}

// Only the first full browser window is WebAiOs; popups (window.open with dimensions) stay plain Firefox windows.
const isMain = () =>
  window.toolbar.visible &&
  ![...Services.wm.getEnumerator("navigator:browser")].some((w: Window) => w !== window && w.document.documentElement.hasAttribute("webaios-main"));

window.addEventListener(
  "DOMContentLoaded",
  () => {
    if (!isMain()) return;
    document.documentElement.setAttribute("webaios-main", "");
    // The sidebar is a privileged HTML page in an iframe: browser.xhtml defaults to the XUL namespace,
    // where document.createElement would build XUL elements.
    const frame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
    frame.id = "webaios-sidebar";
    document.getElementById("browser")!.prepend(frame);
    // The agent panel, on the right: a second iframe, so that the web page between both keeps the mouse.
    const agentFrame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
    agentFrame.id = "webaios-agent";
    agentFrame.hidden = true;
    document.getElementById("browser")!.append(agentFrame);
    // The store is a shared module: imported at runtime, never bundled here (that would make a second copy).
    const ready: Promise<WebAiOsStore> = ChromeUtils.importESModule(STORE).ready;
    // After Firefox's own startup: a tab loaded before it (a restored tab) stays on about:blank.
    void Promise.all([ready, window.delayedStartupPromise]).then(([store]) => {
      window.webaiosWindow = createController(window.gBrowser, frame, agentFrame, store);
      // Once per start, in the main window only: the unreadable session was kept aside.
      if (store.setAside) {
        void window.gNotificationBox.appendNotification(
          "webaios-session-set-aside",
          {
            label: `WebAiOs repart avec une session neuve. L'ancienne est gardée dans ${store.setAside}`,
            priority: window.gNotificationBox.PRIORITY_WARNING_HIGH,
          },
          [],
        );
      }
      // The UI reads window.webaiosWindow as it loads.
      frame.src = "chrome://browser/content/webaios/sidebar.html";
      agentFrame.src = "chrome://browser/content/webaios/agent.html";
    });
  },
  { once: true },
);
