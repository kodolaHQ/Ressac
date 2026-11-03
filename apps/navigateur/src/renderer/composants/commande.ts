import type { ApplicationAffichee } from "../../commun/api";
import type { IdOnglet, Visite } from "../../commun/modele";
import type { ActionAffichee } from "../../commun/actions";
import type { SiteAffiche } from "../../commun/sites";
import { normaliser, suggestionsActions } from "./suggestions";

export type OngletSource = { id: IdOnglet; titre: string; url: string; favicon: string | null };
export type AppliSource = { genre: "projet" | "site"; id: string; nom: string; action: "ouvrir" | "lancer"; favicon: string | null };
export type SourcesCommande = { actions: ActionAffichee[]; onglets: OngletSource[]; applis: AppliSource[]; historique: Visite[] };
export type LigneCommande =
  | { type: "defaut"; texte: string; libelle: string }
  | { type: "action"; id: string; nom: string; saisie: string | null }
  | { type: "onglet"; onglet: OngletSource }
  | { type: "appli"; appli: AppliSource }
  | { type: "historique"; url: string; titre: string };

export const LIMITES = { actions: 3, onglets: 3, applis: 3, historique: 5 } as const;

/** Les lignes de la barre de commande, dans l'ordre : défaut, actions, onglets, applis, historique. */
export function lignesCommande(texte: string, sources: SourcesCommande, urlActive: string | null): LigneCommande[] {
  const t = texte.trim();
  const libelle = !t ? "Page d'accueil" : /^\S+\.\S+$/.test(t) ? `Ouvrir ${t}` : `Rechercher « ${t} »`;
  const lignes: LigneCommande[] = [{ type: "defaut", texte: t, libelle }];
  if (!t || (urlActive !== null && t === urlActive)) return lignes;

  const q = normaliser(t);
  for (const a of suggestionsActions(t, sources.actions).slice(0, LIMITES.actions)) lignes.push({ type: "action", id: a.id, nom: a.nom, saisie: a.saisie });
  const onglets = sources.onglets.filter((o) => normaliser(o.titre).includes(q) || normaliser(o.url).includes(q)).slice(0, LIMITES.onglets);
  for (const onglet of onglets) lignes.push({ type: "onglet", onglet });
  for (const appli of sources.applis.filter((a) => normaliser(a.nom).includes(q)).slice(0, LIMITES.applis)) lignes.push({ type: "appli", appli });
  const listees = new Set(onglets.map((o) => o.url));
  sources.historique
    .filter((v) => v.url !== urlActive && !listees.has(v.url))
    .slice(0, LIMITES.historique)
    .forEach((v) => lignes.push({ type: "historique", url: v.url, titre: v.titre }));
  return lignes;
}

export function appliSourceDeProjet(a: ApplicationAffichee): AppliSource | null {
  if (a.type === "sans-fiche") return null;
  return { genre: "projet", id: a.dossier, nom: a.nom, action: a.etat === "en-marche" ? "ouvrir" : "lancer", favicon: a.favicon ?? null };
}

export function appliSourceDeSite(s: SiteAffiche): AppliSource {
  return { genre: "site", id: s.id, nom: s.nom, action: "ouvrir", favicon: s.icone };
}
