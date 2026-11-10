/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WebAiOsStore } from "../store";
import { appFolderOf, closeAppPopup, setupAppWindow } from "./app-window";
import { createController } from "./controller";
import { cutFrameNetwork } from "./frame-network";
import { setupPopup } from "./popup";
import { mountSiteMenu } from "./site-menu";
import { refuseSiteTabs, setupSiteSmallWindow, setupSiteWindow, siteIdOf, siteOfContainer } from "./site-window";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const { PrivateBrowsingUtils } = ChromeUtils.importESModule("resource://gre/modules/PrivateBrowsingUtils.sys.mjs");

declare global {
  interface Window {
    gBrowser: any;
    gNotificationBox: any;
    delayedStartupPromise: Promise<void>;
    OpenBrowserWindow(): Window;
    openLinkIn(url: string, where: string, params: any): void;
    /** browser.js: asks each tab's page before the window closes or the app quits (BrowserDOMWindow.canClose). */
    CanCloseWindow(): boolean;
    readonly windowState: number;
    readonly STATE_MINIMIZED: number;
    readonly STATE_FULLSCREEN: number;
    readonly windowRoot: EventTarget;
    readonly mozInnerScreenX: number;
    /** In a popup: the WebAiOs tab it was opened from (setupPopup). */
    webaiosPopupSource?: import("../../shared/model").TabId;
    webaiosWindow?: import("./controller").WindowController;
  }
}

window.addEventListener(
  "DOMContentLoaded",
  () => {
    // Every full browser window is WebAiOs; popups (window.open with dimensions) stay plain Firefox windows, and a
    // private window (Dock, ⇧⌘P) stays Firefox's: it must not take the session's windows into private browsing.
    if (PrivateBrowsingUtils.isWindowPrivate(window)) return;
    // An agent app's window: never a main window, never a plain popup.
    const app = appFolderOf(window);
    if (app) return setupAppWindow(window, app);
    // A site app's window, or a window its pages opened (its container): never a main window, never a plain popup.
    const site = siteIdOf(window);
    if (site) return setupSiteWindow(window, site);
    refuseSiteTabs(window);
    // A window an app's page opened with features (after refuseSiteTabs: windows.create({ tabId }) would adopt its view).
    if (closeAppPopup(window)) return;
    const opener = siteOfContainer(window);
    if (opener) {
      setupSiteSmallWindow(window, opener);
      return setupPopup(window);
    }
    if (!window.toolbar.visible) return setupPopup(window);
    document.documentElement.setAttribute("webaios-main", "");
    // The sidebar is a privileged HTML page in an iframe: browser.xhtml defaults to the XUL namespace,
    // where document.createElement would build XUL elements.
    const frame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
    frame.id = "webaios-sidebar";
    document.getElementById("browser")!.prepend(frame);
    const sidebarMayLoad = cutFrameNetwork(frame);
    // Dragging regions only count in the top document unless its docShell allows them: the sidebar has the window's.
    (frame.contentWindow as any).docShell.windowDraggingAllowed = true;
    // macOS places the window buttons on this box, and hides them without one (the toolbox holding Firefox's is hidden).
    const windowButtons = (document as any).createXULElement("hbox") as HTMLElement;
    windowButtons.id = "webaios-window-buttons";
    document.getElementById("browser")!.append(windowButtons);
    // The agent panel, on the right: a second iframe, so that the web page between both keeps the mouse.
    const agentFrame = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
    agentFrame.id = "webaios-agent";
    agentFrame.hidden = true;
    document.getElementById("browser")!.append(agentFrame);
    const agentMayLoad = cutFrameNetwork(agentFrame);
    // The store is a shared module: imported at runtime, never bundled here (that would make a second copy).
    const ready: Promise<WebAiOsStore> = ChromeUtils.importESModule(STORE).ready;
    // After Firefox's own startup: a tab loaded before it (a restored tab) stays on about:blank.
    void Promise.all([ready, window.delayedStartupPromise]).then(([store]) => {
      const { windowId: windowId, first } = store.windows.claim(window);
      try {
        window.webaiosWindow = createController(window.gBrowser, frame, agentFrame, store, windowId);
      } catch (e) {
        // Not a WebAiOs window after all: its state window must not stay bound to it.
        store.windows.release(windowId);
        throw e;
      }
      mountSiteMenu(window, store, windowId);
      // Once per start, in the first window only: the unreadable session was kept aside.
      if (first && store.setAside) {
        void window.gNotificationBox.appendNotification(
          "webaios-session-set-aside",
          {
            label: `WebAiOs repart avec une session neuve. L'ancienne est gardée dans ${store.setAside}`,
            priority: window.gNotificationBox.PRIORITY_WARNING_HIGH,
          },
          [],
        );
      }
      if (first && store.dataSetAside) {
        const { backup, reason } = store.dataSetAside;
        void window.gNotificationBox.appendNotification(
          "webaios-data-set-aside",
          {
            label:
              reason === "reset"
                ? `WebAiOs repart à neuf. Ses anciennes données sont gardées dans ${backup} (Réglages › Données). Vos projets n'ont pas bougé.`
                : `WebAiOs ne reconnaît pas le format de ses données : il repart à neuf et les garde dans ${backup}. Vos projets n'ont pas bougé.`,
            priority: reason === "reset" ? window.gNotificationBox.PRIORITY_INFO_HIGH : window.gNotificationBox.PRIORITY_WARNING_HIGH,
          },
          [],
        );
      }
      // Once ever: error reports go out, and how to turn them off.
      if (first && store.telemetryActive && !Services.prefs.getBoolPref("webaios.telemetry.noticeShown", false)) {
        Services.prefs.setBoolPref("webaios.telemetry.noticeShown", true);
        void window.gNotificationBox.appendNotification(
          "webaios-telemetry",
          {
            label: "WebAiOs envoie à son développeur les plantages et les erreurs, sans adresse de page, pour corriger les bugs de la bêta. Un plantage peut contenir des fragments de mémoire.",
            priority: window.gNotificationBox.PRIORITY_INFO_HIGH,
          },
          [
            { label: "Couper l'envoi", callback: () => Services.prefs.setBoolPref("webaios.telemetry.enabled", false) },
            { label: "D'accord", callback: () => {} },
          ],
        );
      }
      // The UI reads window.webaiosWindow as it loads. Without the UI's network guard, neither loads.
      if (!sidebarMayLoad || !agentMayLoad) return;
      frame.src = "chrome://browser/content/webaios/sidebar.html";
      agentFrame.src = "chrome://browser/content/webaios/agent.html";
    });
  },
  { once: true },
);
