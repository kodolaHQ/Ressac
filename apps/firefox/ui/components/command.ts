import type { ApplicationShown } from "../../shared/api";
import type { TabId, Visit } from "../../shared/model";
import type { ActionShown } from "../../shared/actions";
import type { ShownSite } from "../../shared/sites";
import { normalize, suggestionsActions } from "./suggestions";

export type SourceTab = { id: TabId; title: string; url: string; favicon: string | null };
export type SiteApp = { kind: "projet" | "site"; id: string; name: string; action: "ouvrir" | "lancer"; favicon: string | null };
export type CommandSources = { actions: ActionShown[]; tabs: SourceTab[]; siteApps: SiteApp[]; history: Visit[] };
export type CommandLine =
  | { type: "defaut"; text: string; label: string }
  /** `parametre`: the label of the input the action declares (null: it expects none). */
  | { type: "action"; id: string; name: string; input: string | null; param: string | null }
  | { type: "onglet"; tab: SourceTab }
  | { type: "appli"; app: SiteApp }
  | { type: "historique"; url: string; title: string };

export const LIMITS = { actions: 3, tabs: 3, siteApps: 3, history: 5 } as const;
/** Empty field: what the bar offers before any keystroke. */
export const EMPTY_LIMITS = { actions: 4, tabs: 5 } as const;

/** The actions offered with an empty field: the most recently launched first, then the others by name; invalid ones dropped. */
function recentActions(actions: ActionShown[]): ActionShown[] {
  return actions
    .filter((a) => !a.error)
    .sort((x, y) => (y.last?.start ?? "").localeCompare(x.last?.start ?? "") || normalize(x.name).localeCompare(normalize(y.name)))
    .slice(0, EMPTY_LIMITS.actions);
}

/**
 * The command bar's rows, in order: default, actions, tabs, apps, history. Empty field: home first (Enter leads
 * there), then actions and the open tabs, without the shown tab (`shownTab`).
 */
export function commandLines(text: string, sources: CommandSources, urlActive: string | null, shownTab: TabId | null = null): CommandLine[] {
  const t = text.trim();
  const label = !t ? "Page d'accueil" : /^\S+\.\S+$/.test(t) ? `Ouvrir ${t}` : `Rechercher « ${t} »`;
  const lignes: CommandLine[] = [{ type: "defaut", text: t, label: label }];
  if (!t) {
    for (const a of recentActions(sources.actions)) lignes.push({ type: "action", id: a.id, name: a.name, input: null, param: a.input?.label ?? null });
    for (const tab of sources.tabs.filter((o) => o.id !== shownTab).slice(0, EMPTY_LIMITS.tabs)) lignes.push({ type: "onglet", tab: tab });
    return lignes;
  }
  if (urlActive !== null && t === urlActive) return lignes;

  const q = normalize(t);
  for (const a of suggestionsActions(t, sources.actions).slice(0, LIMITS.actions)) {
    const param = sources.actions.find((x) => x.id === a.id)?.input?.label ?? null;
    lignes.push({ type: "action", id: a.id, name: a.name, input: a.input, param: param });
  }
  const tabs = sources.tabs.filter((o) => normalize(o.title).includes(q) || normalize(o.url).includes(q)).slice(0, LIMITS.tabs);
  for (const tab of tabs) lignes.push({ type: "onglet", tab: tab });
  for (const app of sources.siteApps.filter((a) => normalize(a.name).includes(q)).slice(0, LIMITS.siteApps)) lignes.push({ type: "appli", app: app });
  const listed = new Set(tabs.map((o) => o.url));
  sources.history
    .filter((v) => v.url !== urlActive && !listed.has(v.url))
    .slice(0, LIMITS.history)
    .forEach((v) => lignes.push({ type: "historique", url: v.url, title: v.title }));
  return lignes;
}

export type Section = "actions" | "onglets" | "applis" | "historique";

export const SECTION_TITLES: Record<Section, string> = { actions: "Actions", onglets: "Onglets ouverts", applis: "Applis", historique: "Historique" };

/** A row's section: the default row has none, it stays first without a title. */
export function sectionOf(l: CommandLine): Section | null {
  return l.type === "defaut" ? null : l.type === "action" ? "actions" : l.type === "onglet" ? "onglets" : l.type === "appli" ? "applis" : "historique";
}

/** The title to put before row `i`: its section's when it opens one, null otherwise. */
export function titleBefore(lignes: CommandLine[], i: number): string | null {
  const s = sectionOf(lignes[i]!);
  return s !== null && (i === 0 || sectionOf(lignes[i - 1]!) !== s) ? SECTION_TITLES[s] : null;
}

/** An action missing its input: the bar asks for it before launching. */
export const paramRequest = (l: CommandLine): l is Extract<CommandLine, { type: "action" }> & { param: string } =>
  l.type === "action" && l.param !== null && l.input === null;

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

/** The length the actions service accepts for an input (ActionInputSchema). */
export const PARAM_MAX = 2000;

export function projectSiteApp(a: ApplicationShown): SiteApp | null {
  if (a.type === "sans-fiche") return null;
  return { kind: "projet", id: a.folder, name: a.name, action: a.state === "en-marche" ? "ouvrir" : "lancer", favicon: a.favicon ?? null };
}

export function siteSiteApp(s: ShownSite): SiteApp {
  return { kind: "site", id: s.id, name: s.name, action: "ouvrir", favicon: s.icon };
}
