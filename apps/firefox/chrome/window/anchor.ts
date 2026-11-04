/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchors {
  /** #webaios-anchor: prompts of add-ons and sites, on the sidebar's address bar. */
  readonly prompt: Element;
  /** #webaios-action-anchor: add-on popups, moved onto the clicked button. */
  readonly action: Element;
  /** Puts the action anchor on `rect`, given in the sidebar iframe's coordinates. */
  placeAction(rect: Rect): void;
}

/**
 * Creates both anchors in browser.xhtml and hooks gUnifiedExtensions, PopupNotifications and PanelUI. Firefox anchors
 * these on its toolbar, which WebAiOs hides: without the hooks a prompt opens at the window's (0, 0), with no arrow.
 * Call after delayedStartupPromise (PopupNotifications is a lazy getter). The hooks go with the window.
 */
export function setupAnchors(win: Window, frame: HTMLIFrameElement): Anchors {
  const w = win as any;
  const doc = win.document;
  const box = (id: string) => {
    const el = (doc as any).createXULElement("box") as HTMLElement;
    el.id = id;
    el.style.cssText = "position: fixed; pointer-events: none; left: 0; top: 0; width: 0; height: 0;";
    doc.documentElement.append(el);
    return el;
  };
  const prompt = box("webaios-anchor");
  const action = box("webaios-action-anchor");
  /** `rect` in the iframe's coordinates, onto `el` in the window's. */
  const place = (el: HTMLElement, rect: Rect) => {
    const f = frame.getBoundingClientRect();
    Object.assign(el.style, {
      left: `${f.x + frame.clientLeft + rect.x}px`,
      top: `${f.y + frame.clientTop + rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  // On the address bar as it is now (the sidebar moves and resizes); without one, along the iframe's top edge.
  const placePrompt = () => {
    const bar = frame.contentDocument?.querySelector('[data-testid="barre-adresse"]');
    place(prompt, bar?.getBoundingClientRect() ?? { x: 0, y: 0, width: frame.clientWidth, height: 0 });
    return prompt;
  };

  w.gUnifiedExtensions.getPopupAnchorID = (browser: any) => {
    browser["webaios-anchorpopupnotificationanchor"] = placePrompt();
    return "webaios-anchor";
  };
  // Not Firefox's own fallback chain (PopupNotificationsBeforeAnchor, gURLBar): those all sit in the hidden toolbar.
  w.PopupNotifications._getVisibleAnchorElement = (el: Element | null) => {
    const anchor = placePrompt();
    return el?.checkVisibility({ visibilityProperty: true }) ? el : anchor;
  };
  // Stock Firefox dismisses the open prompt on a tab switch, which cancels a removeOnDismissal one (upstream test
  // browser_permissions_dismiss.js, test_tab_switch_dismiss); a dismissed prompt is then reached from its urlbar icon.
  // WebAiOs has no urlbar icon, so it keeps every prompt (sites' too) and it comes back with its tab: hidden here without
  // dismissal. Relies on the private _hidePanel/_ignoreDismissal: re-check on Firefox upgrades.
  w.gBrowser.tabContainer.addEventListener("TabSelect", () => w.PopupNotifications.isPanelOpen && w.PopupNotifications._hidePanel(), true);
  const panelAnchor = w.PanelUI._getPanelAnchor;
  w.PanelUI._getPanelAnchor = (c: Element) => (c === w.PanelUI.menuButton ? placePrompt() : panelAnchor.call(w.PanelUI, c));

  return { prompt, action, placeAction: (rect) => place(action, rect) };
}
