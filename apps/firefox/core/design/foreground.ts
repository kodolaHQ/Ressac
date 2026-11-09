import type { WindowId } from "../../shared/model";

export type DesignTarget = { type: "fenetre"; fenetreId: WindowId } | { type: "app"; dossier: string } | { type: "site"; id: string };

export type DesignChoice = { type: "cible"; cible: DesignTarget } | { type: "avis-site"; id: string } | { type: "rien" };

/**
 * The window targeted by ⌘⇧D, according to what is in the foreground (spec §4.3): an agent app window, then a
 * site app window, then a small window of a site app (the message goes in the parent app's bar,
 * nothing switches); another window that is not a main window targets nothing (never the tab of the main
 * window that is behind); otherwise, the active main window.
 */
export function chooseDesignTarget(o: { appli?: string; site?: string; petiteDeSite?: string; autreFenetre: boolean; fenetreActive?: WindowId }): DesignChoice {
  if (o.appli) return { type: "cible", cible: { type: "app", dossier: o.appli } };
  if (o.site) return { type: "cible", cible: { type: "site", id: o.site } };
  if (o.petiteDeSite) return { type: "avis-site", id: o.petiteDeSite };
  if (o.autreFenetre) return { type: "rien" };
  if (o.fenetreActive) return { type: "cible", cible: { type: "fenetre", fenetreId: o.fenetreActive } };
  return { type: "rien" };
}
