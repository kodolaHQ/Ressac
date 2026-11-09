import type { ApplicationAffichee } from "../../shared/api";
import type { IdOnglet, Visite } from "../../shared/modele";
import type { ActionAffichee } from "../../shared/actions";
import type { SiteAffiche } from "../../shared/sites";
import { normaliser, suggestionsActions } from "./suggestions";

export type OngletSource = { id: IdOnglet; titre: string; url: string; favicon: string | null };
export type AppliSource = { genre: "projet" | "site"; id: string; nom: string; action: "ouvrir" | "lancer"; favicon: string | null };
export type SourcesCommande = { actions: ActionAffichee[]; onglets: OngletSource[]; applis: AppliSource[]; historique: Visite[] };
export type LigneCommande =
  | { type: "defaut"; texte: string; libelle: string }
  /** `parametre` : le libellé de la saisie que l'action déclare (null : elle n'en attend pas). */
  | { type: "action"; id: string; nom: string; saisie: string | null; parametre: string | null }
  | { type: "onglet"; onglet: OngletSource }
  | { type: "appli"; appli: AppliSource }
  | { type: "historique"; url: string; titre: string };

export const LIMITES = { actions: 3, onglets: 3, applis: 3, historique: 5 } as const;
/** Champ vide : ce que la barre propose avant toute frappe. */
export const LIMITES_VIDE = { actions: 4, onglets: 5 } as const;

/** Les actions proposées champ vide : les dernières lancées d'abord, puis les autres par nom ; les invalides écartées. */
function actionsRecentes(actions: ActionAffichee[]): ActionAffichee[] {
  return actions
    .filter((a) => !a.erreur)
    .sort((x, y) => (y.dernier?.debut ?? "").localeCompare(x.dernier?.debut ?? "") || normaliser(x.nom).localeCompare(normaliser(y.nom)))
    .slice(0, LIMITES_VIDE.actions);
}

/**
 * Les lignes de la barre de commande, dans l'ordre : défaut, actions, onglets, applis, historique. Champ vide : l'accueil
 * en tête (Entrée y mène), puis des actions et les onglets ouverts, sans l'onglet affiché (`ongletAffiche`).
 */
export function lignesCommande(texte: string, sources: SourcesCommande, urlActive: string | null, ongletAffiche: IdOnglet | null = null): LigneCommande[] {
  const t = texte.trim();
  const libelle = !t ? "Page d'accueil" : /^\S+\.\S+$/.test(t) ? `Ouvrir ${t}` : `Rechercher « ${t} »`;
  const lignes: LigneCommande[] = [{ type: "defaut", texte: t, libelle }];
  if (!t) {
    for (const a of actionsRecentes(sources.actions)) lignes.push({ type: "action", id: a.id, nom: a.nom, saisie: null, parametre: a.saisie?.libelle ?? null });
    for (const onglet of sources.onglets.filter((o) => o.id !== ongletAffiche).slice(0, LIMITES_VIDE.onglets)) lignes.push({ type: "onglet", onglet });
    return lignes;
  }
  if (urlActive !== null && t === urlActive) return lignes;

  const q = normaliser(t);
  for (const a of suggestionsActions(t, sources.actions).slice(0, LIMITES.actions)) {
    const parametre = sources.actions.find((x) => x.id === a.id)?.saisie?.libelle ?? null;
    lignes.push({ type: "action", id: a.id, nom: a.nom, saisie: a.saisie, parametre });
  }
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

export type Section = "actions" | "onglets" | "applis" | "historique";

export const TITRES_SECTIONS: Record<Section, string> = { actions: "Actions", onglets: "Onglets ouverts", applis: "Applis", historique: "Historique" };

/** La section d'une ligne : la ligne par défaut n'en a pas, elle reste en tête sans titre. */
export function sectionDe(l: LigneCommande): Section | null {
  return l.type === "defaut" ? null : l.type === "action" ? "actions" : l.type === "onglet" ? "onglets" : l.type === "appli" ? "applis" : "historique";
}

/** Le titre à poser avant la ligne `i` : celui de sa section quand elle en ouvre une, null sinon. */
export function titreAvant(lignes: LigneCommande[], i: number): string | null {
  const s = sectionDe(lignes[i]!);
  return s !== null && (i === 0 || sectionDe(lignes[i - 1]!) !== s) ? TITRES_SECTIONS[s] : null;
}

/** Une action à qui il manque sa saisie : la barre la demande avant de lancer. */
export const demandeParametre = (l: LigneCommande): l is Extract<LigneCommande, { type: "action" }> & { parametre: string } =>
  l.type === "action" && l.parametre !== null && l.saisie === null;

/** Le paramètre proposé d'office : l'adresse de la page affichée, si c'est une page web (sans son ancre). */
export function parametreParDefaut(url: string | null | undefined): string {
  if (!url) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.hash = "";
  // Des identifiants dans l'adresse ne partent pas vers l'action.
  u.username = "";
  u.password = "";
  const texte = u.toString();
  return texte.length <= PARAMETRE_MAX ? texte : "";
}

/** La longueur que le service des actions accepte pour une saisie (SchemaSaisieAction). */
export const PARAMETRE_MAX = 2000;

export function appliSourceDeProjet(a: ApplicationAffichee): AppliSource | null {
  if (a.type === "sans-fiche") return null;
  return { genre: "projet", id: a.dossier, nom: a.nom, action: a.etat === "en-marche" ? "ouvrir" : "lancer", favicon: a.favicon ?? null };
}

export function appliSourceDeSite(s: SiteAffiche): AppliSource {
  return { genre: "site", id: s.id, nom: s.nom, action: "ouvrir", favicon: s.icone };
}
