import type { ApplicationShown } from "../../shared/api";
import type { TabId, Visite } from "../../shared/modele";
import type { ActionShown } from "../../shared/actions";
import type { ShownSite } from "../../shared/sites";
import { normalize, suggestionsActions } from "./suggestions";

export type SourceTab = { id: TabId; titre: string; url: string; favicon: string | null };
export type SiteApp = { genre: "projet" | "site"; id: string; nom: string; action: "ouvrir" | "lancer"; favicon: string | null };
export type CommandSources = { actions: ActionShown[]; onglets: SourceTab[]; applis: SiteApp[]; historique: Visite[] };
export type CommandLine =
  | { type: "defaut"; texte: string; libelle: string }
  /** `parametre`: the label of the input the action declares (null: it expects none). */
  | { type: "action"; id: string; nom: string; saisie: string | null; parametre: string | null }
  | { type: "onglet"; onglet: SourceTab }
  | { type: "appli"; appli: SiteApp }
  | { type: "historique"; url: string; titre: string };

export const LIMITS = { actions: 3, onglets: 3, applis: 3, historique: 5 } as const;
/** Empty field: what the bar offers before any keystroke. */
export const EMPTY_LIMITS = { actions: 4, onglets: 5 } as const;

/** The actions offered with an empty field: the most recently launched first, then the others by name; invalid ones dropped. */
function recentActions(actions: ActionShown[]): ActionShown[] {
  return actions
    .filter((a) => !a.erreur)
    .sort((x, y) => (y.dernier?.debut ?? "").localeCompare(x.dernier?.debut ?? "") || normalize(x.nom).localeCompare(normalize(y.nom)))
    .slice(0, EMPTY_LIMITS.actions);
}

/**
 * The command bar's rows, in order: default, actions, tabs, apps, history. Empty field: home first (Enter leads
 * there), then actions and the open tabs, without the shown tab (`ongletAffiche`).
 */
export function commandLines(text: string, sources: CommandSources, urlActive: string | null, shownTab: TabId | null = null): CommandLine[] {
  const t = text.trim();
  const label = !t ? "Page d'accueil" : /^\S+\.\S+$/.test(t) ? `Ouvrir ${t}` : `Rechercher « ${t} »`;
  const lignes: CommandLine[] = [{ type: "defaut", texte: t, libelle: label }];
  if (!t) {
    for (const a of recentActions(sources.actions)) lignes.push({ type: "action", id: a.id, nom: a.nom, saisie: null, parametre: a.saisie?.libelle ?? null });
    for (const tab of sources.onglets.filter((o) => o.id !== shownTab).slice(0, EMPTY_LIMITS.onglets)) lignes.push({ type: "onglet", onglet: tab });
    return lignes;
  }
  if (urlActive !== null && t === urlActive) return lignes;

  const q = normalize(t);
  for (const a of suggestionsActions(t, sources.actions).slice(0, LIMITS.actions)) {
    const param = sources.actions.find((x) => x.id === a.id)?.saisie?.libelle ?? null;
    lignes.push({ type: "action", id: a.id, nom: a.nom, saisie: a.saisie, parametre: param });
  }
  const tabs = sources.onglets.filter((o) => normalize(o.titre).includes(q) || normalize(o.url).includes(q)).slice(0, LIMITS.onglets);
  for (const tab of tabs) lignes.push({ type: "onglet", onglet: tab });
  for (const app of sources.applis.filter((a) => normalize(a.nom).includes(q)).slice(0, LIMITS.applis)) lignes.push({ type: "appli", appli: app });
  const listed = new Set(tabs.map((o) => o.url));
  sources.historique
    .filter((v) => v.url !== urlActive && !listed.has(v.url))
    .slice(0, LIMITS.historique)
    .forEach((v) => lignes.push({ type: "historique", url: v.url, titre: v.titre }));
  return lignes;
}

export type Section = "actions" | "onglets" | "applis" | "historique";

export const TITRES_SECTIONS: Record<Section, string> = { actions: "Actions", onglets: "Onglets ouverts", applis: "Applis", historique: "Historique" };

/** A row's section: the default row has none, it stays first without a title. */
export function sectionDe(l: CommandLine): Section | null {
  return l.type === "defaut" ? null : l.type === "action" ? "actions" : l.type === "onglet" ? "onglets" : l.type === "appli" ? "applis" : "historique";
}

/** The title to put before row `i`: its section's when it opens one, null otherwise. */
export function titleBefore(lignes: CommandLine[], i: number): string | null {
  const s = sectionDe(lignes[i]!);
  return s !== null && (i === 0 || sectionDe(lignes[i - 1]!) !== s) ? TITRES_SECTIONS[s] : null;
}

/** An action missing its input: the bar asks for it before launching. */
export const paramRequest = (l: CommandLine): l is Extract<CommandLine, { type: "action" }> & { parametre: string } =>
  l.type === "action" && l.parametre !== null && l.saisie === null;

/** The parameter proposed by default: the shown page's address, if it is a web page (without its anchor). */
export function defaultParam(url: string | null | undefined): string {
  if (!url) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.hash = "";
  // Credentials in the address are not sent to the action.
  u.username = "";
  u.password = "";
  const text = u.toString();
  return text.length <= PARAM_MAX ? text : "";
}

/** The length the actions service accepts for an input (SchemaSaisieAction). */
export const PARAM_MAX = 2000;

export function projectSiteApp(a: ApplicationShown): SiteApp | null {
  if (a.type === "sans-fiche") return null;
  return { genre: "projet", id: a.dossier, nom: a.nom, action: a.etat === "en-marche" ? "ouvrir" : "lancer", favicon: a.favicon ?? null };
}

export function siteSiteApp(s: ShownSite): SiteApp {
  return { genre: "site", id: s.id, nom: s.nom, action: "ouvrir", favicon: s.icone };
}
