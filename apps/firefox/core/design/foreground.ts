import type { WindowId } from "../../shared/model";

export type DesignTarget = { type: "window"; windowId: WindowId } | { type: "app"; folder: string } | { type: "site"; id: string };

export type DesignChoice = { type: "target"; target: DesignTarget } | { type: "site-notice"; id: string } | { type: "none" };

/**
 * The window targeted by ⌘⇧D, according to what is in the foreground (spec §4.3): an agent app window, then a
 * site app window, then a small window of a site app (the message goes in the parent app's bar,
 * nothing switches); another window that is not a main window targets nothing (never the tab of the main
 * window that is behind); otherwise, the active main window.
 */
export function chooseDesignTarget(o: { app?: string; site?: string; siteSmall?: string; otherWindow: boolean; activeWindow?: WindowId }): DesignChoice {
  if (o.app) return { type: "target", target: { type: "app", folder: o.app } };
  if (o.site) return { type: "target", target: { type: "site", id: o.site } };
  if (o.siteSmall) return { type: "site-notice", id: o.siteSmall };
  if (o.otherWindow) return { type: "none" };
  if (o.activeWindow) return { type: "target", target: { type: "window", windowId: o.activeWindow } };
  return { type: "none" };
}
