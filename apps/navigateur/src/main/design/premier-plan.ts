import type { IdFenetre } from "../../commun/modele";

export type CibleDesign = { type: "fenetre"; fenetreId: IdFenetre } | { type: "app"; dossier: string } | { type: "site"; id: string };

export type ChoixDesign = { type: "cible"; cible: CibleDesign } | { type: "avis-site"; id: string } | { type: "rien" };

/**
 * La fenêtre que vise ⌘⇧D, d'après ce qui est au premier plan (spec §4.3) : une fenêtre d'appli de l'agent, puis une
 * fenêtre d'appli de site, puis une petite fenêtre d'une appli de site (le message va dans la barre de l'appli parente,
 * rien ne bascule) ; une autre fenêtre qui n'est pas une fenêtre principale ne vise rien (jamais l'onglet de la fenêtre
 * principale qui est derrière) ; sinon, la fenêtre principale active.
 */
export function choisirCibleDesign(o: { appli?: string; site?: string; petiteDeSite?: string; autreFenetre: boolean; fenetreActive?: IdFenetre }): ChoixDesign {
  if (o.appli) return { type: "cible", cible: { type: "app", dossier: o.appli } };
  if (o.site) return { type: "cible", cible: { type: "site", id: o.site } };
  if (o.petiteDeSite) return { type: "avis-site", id: o.petiteDeSite };
  if (o.autreFenetre) return { type: "rien" };
  if (o.fenetreActive) return { type: "cible", cible: { type: "fenetre", fenetreId: o.fenetreActive } };
  return { type: "rien" };
}
