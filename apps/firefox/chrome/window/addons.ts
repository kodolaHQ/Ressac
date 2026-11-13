/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WindowId } from "../../shared/model";
import type { RessacStore } from "../store";
import type { SiteWindowController } from "../store/sites";
import { setupAnchors, type Anchors, type Rect } from "./anchor";
import { PINNED_PREF, parsePinned, setPinned } from "./pinned";
import type { TabSync } from "./tabs";

const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
const ADDONS_LIST = "addons://list/extension";
// Keep in sync with host/extensions/firefox-copy.ts ID_SUFFIX.
const AGENT_SUFFIX = "@agent.ressac";

export interface AddonButton {
  id: string;
  name: string;
  /** The action's title for the displayed tab, else the add-on's name. */
  title: string;
  /** moz-extension: URL of the 32 px icon, or null (the UI shows the name's first letter). */
  icon: string | null;
  badge: string; // "" when none
  badgeColor: string | null; // css rgba(), from badgeBackgroundColor
  badgeTextColor: string | null;
  /** False while no web page is displayed (empty window, internal page), when the add-on disabled its action for the tab, or when it has none. */
  enabled: boolean;
  pinned: boolean;
}
export interface PendingUpdate {
  id: string;
  name: string;
}
export interface WindowAddons {
  /** Active, non-hidden extensions, in getActivePolicies order, an agent one only in the spaces where it runs; one without a browser action is never enabled. */
  buttons(): AddonButton[];
  /** ExtensionsUI.updates. */
  updates(): PendingUpdate[];
  onChange(cb: () => void): () => void;
  /** Opens the add-on's popup (or fires its onClicked) on the button at `rect` (sidebar coordinates); no-op when not enabled. */
  click(id: string, rect: Rect): void;
  pin(id: string, pinned: boolean): void;
  /** « Gérer les extensions »: about:addons, list of extensions. */
  manage(): void;
  /** « Trouver des modules »: a tab on https://addons.mozilla.org/fr/firefox/ in the active space. */
  findMore(): void;
  /** « Revoir la mise à jour »: ExtensionsUI.showUpdate for that add-on. */
  reviewUpdate(id: string): void;
}

const rgba = (c: number[] | null | undefined) => (c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]! / 255})` : null);

export function createAddons(o: {
  win: Window;
  gBrowser: any;
  tabs: TabSync;
  anchors: Anchors;
  store: RessacStore;
  windowId: WindowId;
}): WindowAddons {
  const activeSpace = () => {
    const f = o.store.state.windows.find((x) => x.id === o.windowId);
    return f ? o.store.state.spaces.find((e) => e.id === f.activeSpace) : undefined;
  };
  return addonsCore({
    win: o.win,
    gBrowser: o.gBrowser,
    anchors: o.anchors,
    shown(id) {
      const space = activeSpace();
      return !space || o.store.agentExtensions.shownIn(id, space.profile, space.private);
    },
    page: () => !!o.tabs.displayed(),
    watch: [
      (notify) => o.store.agentExtensions.onScopes(notify),
      (notify) => {
        // Another space, or the same one turned private or given another profile.
        let lastSpace = "";
        return o.store.subscribe(() => {
          const e = activeSpace();
          const key = e ? `${e.id}|${e.profile}|${e.private}` : "";
          if (key !== lastSpace) (lastSpace = key), notify();
        });
      },
    ],
    manage: () => void (o.win as any).BrowserAddonUI.openAddonsMgr(ADDONS_LIST),
    findMore: () => void o.store.dispatch({ type: "openTab", windowId: o.windowId, url: "https://addons.mozilla.org/fr/firefox/" }),
  });
}

/**
 * A site app's window (store/sites.ts): the add-ons' buttons for its one tab, the app view. Never an agent extension's
 * (they never run in an app, spec §4.9); enabled in the « site » view on a web page only.
 * Its popups open on the app's bar; about:addons opens in a main window (the app window takes no tab).
 */
export function createSiteAddons(win: Window, view: SiteWindowController): WindowAddons {
  const w = win as any;
  const bar = win.document.getElementById("ressac-site-bar") as HTMLIFrameElement;
  return addonsCore({
    win,
    gBrowser: w.gBrowser,
    anchors: setupAnchors(win, bar),
    shown: (id) => !id.endsWith(AGENT_SUFFIX),
    page: () => view.state().viewState === "site" && /^https?:/.test(w.gBrowser.selectedBrowser.currentURI?.spec ?? ""),
    watch: [(notify) => view.onState(notify)],
    manage() {
      const main = BrowserWindowTracker.getTopWindow() ?? w.OpenBrowserWindow();
      void main.delayedStartupPromise.then(() => {
        main.BrowserAddonUI.openAddonsMgr(ADDONS_LIST);
        main.focus();
      });
    },
    // The site bar has no extensions menu.
    findMore: () => {},
  });
}

/** What both kinds of window share: Firefox's add-ons and their buttons in this window. */
function addonsCore(o: {
  win: Window;
  gBrowser: any;
  anchors: Anchors;
  /** Is this add-on listed in this window? */
  shown(addonId: string): boolean;
  /** Is a web page displayed (the buttons can be enabled)? */
  page(): boolean;
  /** Other sources of change: each subscribes `notify` and returns its unsubscribe, called at unload. */
  watch: ((notify: () => void) => () => void)[];
  manage(): void;
  findMore(): void;
}): WindowAddons {
  const w = o.win as any;
  const listeners = new Set<() => void>();
  let queued = false;
  // Once per microtask: an uninstall fires shutdown, onUninstalled and a button update together.
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const cb of listeners) cb();
    });
  };
  /** By add-on id: an observer on its button node in this window, which updateButton rewrites (badge, title, icon, disabled). */
  const watched = new Map<string, { node: Element; observer: MutationObserver }>();
  /** The browser action of `policy`, its button in this window watched. Per window: dies with it, wraps nothing shared. */
  const actionOf = (policy: any) => {
    const ba = w.gUnifiedExtensions.browserActionFor(policy);
    const node = ba?.widget.forWindow(o.win).node;
    // A restarted add-on (enable, update) has a new node: the old one's observer goes.
    if (node && watched.get(policy.id)?.node !== node) {
      unwatch(policy.id);
      const observer = new w.MutationObserver(notify);
      observer.observe(node, { attributes: true, subtree: true });
      watched.set(policy.id, { node, observer });
    }
    return ba;
  };
  /** A shut-down extension's button goes with its action: the next start makes a new one. */
  const unwatch = (id: string) => {
    watched.get(id)?.observer.disconnect();
    watched.delete(id);
  };
  const pinned = () => parsePinned(Services.prefs.getStringPref(PINNED_PREF, "[]"));

  const buttons = (): AddonButton[] => {
    const tab = o.gBrowser.selectedTab;
    const page = o.page();
    const pins = pinned();
    return w.gUnifiedExtensions.getActivePolicies().flatMap((policy: any) => {
      if (!o.shown(policy.id)) return [];
      const ba = actionOf(policy);
      const { extension } = policy;
      // As Firefox's own panel: an add-on without a button (content scripts only) is listed, greyed.
      if (!ba)
        return [
          {
            id: policy.id,
            name: extension.name,
            title: extension.name,
            icon: ExtensionParent.IconDetails.getPreferredIcon(extension.manifest.icons ?? {}, extension, 32).icon ?? null,
            badge: "",
            badgeColor: null,
            badgeTextColor: null,
            enabled: false,
            pinned: pins.includes(policy.id),
          },
        ];
      const data = ba.action.getContextData(tab);
      return [
        {
          id: policy.id,
          name: extension.name,
          title: data.title || extension.name,
          icon: ExtensionParent.IconDetails.getPreferredIcon(data.icon, extension, 32).icon ?? null,
          badge: data.badgeText ?? "",
          badgeColor: rgba(data.badgeBackgroundColor),
          badgeTextColor: data.badgeBackgroundColor ? rgba(ba.action.getTextColor(data)) : null,
          enabled: page && !!data.enabled,
          pinned: pins.includes(policy.id),
        },
      ];
    });
  };

  // Firefox opens the panel leftward from the anchor's right edge (bottomright topright): ours starts at the button.
  const onShown = (e: Event) => {
    const panel = e.target as any;
    if (panel.anchorNode === o.anchors.action) panel.moveToAnchor(o.anchors.action, "bottomleft topleft");
  };
  const extensionListener = () => notify();
  const shutdownListener = (_: string, extension: { id: string }) => {
    unwatch(extension.id);
    notify();
  };
  const addonListener = { onEnabled: notify, onDisabled: notify, onUninstalled: notify };
  const prefObserver = { observe: notify };
  ExtensionParent.apiManager.on("ready", extensionListener);
  ExtensionParent.apiManager.on("shutdown", shutdownListener);
  AddonManager.addAddonListener(addonListener);
  ExtensionsUI.on("change", extensionListener);
  Services.prefs.addObserver(PINNED_PREF, prefObserver);
  o.gBrowser.tabContainer.addEventListener("TabSelect", notify);
  const offs = o.watch.map((watch) => watch(notify));
  w.addEventListener("popupshown", onShown, true);
  w.addEventListener(
    "unload",
    () => {
      ExtensionParent.apiManager.off("ready", extensionListener);
      ExtensionParent.apiManager.off("shutdown", shutdownListener);
      AddonManager.removeAddonListener(addonListener);
      ExtensionsUI.off("change", extensionListener);
      Services.prefs.removeObserver(PINNED_PREF, prefObserver);
      for (const off of offs) off();
      for (const id of [...watched.keys()]) unwatch(id);
      listeners.clear();
    },
    { once: true },
  );

  return {
    buttons,
    updates: () => [...ExtensionsUI.updates].map((u: any) => ({ id: u.addon.id, name: u.addon.name })),
    onChange(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    click(id, rect) {
      if (!buttons().find((b) => b.id === id)?.enabled) return;
      const ba = actionOf(w.WebExtensionPolicy.getByID(id));
      o.anchors.placeAction(rect);
      // What the widget's onBeforeCommand records for a left click; its onViewShowing then opens the popup or fires onClicked.
      ba.lastClickInfo = { button: 0, modifiers: [] };
      ba.openPopupWithoutUserInteraction = false;
      void w.PanelUI.showSubView(ba.viewId, o.anchors.action);
    },
    pin(id, on) {
      Services.prefs.setStringPref(PINNED_PREF, JSON.stringify(setPinned(pinned(), id, on)));
    },
    manage: o.manage,
    findMore: o.findMore,
    reviewUpdate(id) {
      const update = [...ExtensionsUI.updates].find((u: any) => u.addon.id === id);
      if (update) ExtensionsUI.showUpdate(o.gBrowser, update);
    },
  };
}
