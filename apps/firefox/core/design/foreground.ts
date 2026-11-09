import type { WindowId } from "../../shared/model";

export type DesignTarget = { type: "fenetre"; windowId: WindowId } | { type: "app"; folder: string } | { type: "site"; id: string };

export type DesignChoice = { type: "cible"; target: DesignTarget } | { type: "avis-site"; id: string } | { type: "rien" };

/**
 * The window targeted by ⌘⇧D, according to what is in the foreground (spec §4.3): an agent app window, then a
 * site app window, then a small window of a site app (the message goes in the parent app's bar,
 * nothing switches); another window that is not a main window targets nothing (never the tab of the main
 * window that is behind); otherwise, the active main window.
 */
export function chooseDesignTarget(o: { app?: string; site?: string; siteSmall?: string; otherWindow: boolean; activeWindow?: WindowId }): DesignChoice {
  if (o.app) return { type: "cible", target: { type: "app", folder: o.app } };
  if (o.site) return { type: "cible", target: { type: "site", id: o.site } };
  if (o.siteSmall) return { type: "avis-site", id: o.siteSmall };
  if (o.otherWindow) return { type: "rien" };
  if (o.activeWindow) return { type: "cible", target: { type: "fenetre", windowId: o.activeWindow } };
  return { type: "rien" };
}
