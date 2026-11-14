import type { ApplicationShown } from "../../shared/api";
import type { TabId, Visit } from "../../shared/model";
import type { ActionShown } from "../../shared/actions";
import type { ShownSite } from "../../shared/sites";
import { format } from "../../shared/i18n";
import { normalize, suggestionsActions } from "./suggestions";

export type SourceTab = { id: TabId; title: string; url: string; favicon: string | null };
export type SiteApp = { kind: "project" | "site"; id: string; name: string; action: "open" | "launch"; favicon: string | null };
export type CommandSources = { actions: ActionShown[]; tabs: SourceTab[]; siteApps: SiteApp[]; history: Visit[]; bookmarks: { url: string; title: string }[] };
export type CommandLine =
  | { type: "default"; text: string; label: string }
  /** `parametre`: the label of the input the action declares (null: it expects none). */
  | { type: "action"; id: string; name: string; input: string | null; param: string | null }
  | { type: "tab"; tab: SourceTab }
  | { type: "app"; app: SiteApp }
  | { type: "history"; url: string; title: string }
  | { type: "bookmark"; url: string; title: string };

export const LIMITS = { actions: 3, tabs: 3, siteApps: 3, history: 5, bookmarks: 5 } as const;
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
export function commandLines(text: string, sources: CommandSources, urlActive: string | null, shownTab: TabId | null = null, locale = "fr"): CommandLine[] {
  const t = text.trim();
  const label = !t ? format(locale, "sidebar-command-home") : /^\S+\.\S+$/.test(t) ? format(locale, "sidebar-command-open", { target: t }) : format(locale, "sidebar-command-search", { query: t });
  const lines: CommandLine[] = [{ type: "default", text: t, label: label }];
  if (!t) {
    for (const a of recentActions(sources.actions)) lines.push({ type: "action", id: a.id, name: a.name, input: null, param: a.input?.label ?? null });
    for (const tab of sources.tabs.filter((o) => o.id !== shownTab).slice(0, EMPTY_LIMITS.tabs)) lines.push({ type: "tab", tab: tab });
    return lines;
  }
  if (urlActive !== null && t === urlActive) return lines;

  const q = normalize(t);
  for (const a of suggestionsActions(t, sources.actions).slice(0, LIMITS.actions)) {
    const param = sources.actions.find((x) => x.id === a.id)?.input?.label ?? null;
    lines.push({ type: "action", id: a.id, name: a.name, input: a.input, param: param });
  }
  const tabs = sources.tabs.filter((o) => normalize(o.title).includes(q) || normalize(o.url).includes(q)).slice(0, LIMITS.tabs);
  for (const tab of tabs) lines.push({ type: "tab", tab: tab });
  for (const app of sources.siteApps.filter((a) => normalize(a.name).includes(q)).slice(0, LIMITS.siteApps)) lines.push({ type: "app", app: app });
  const listed = new Set(tabs.map((o) => o.url));
  sources.history
    .filter((v) => v.url !== urlActive && !listed.has(v.url))
    .slice(0, LIMITS.history)
    .forEach((v) => lines.push({ type: "history", url: v.url, title: v.title }));
  // A bookmark already offered as an open tab or a history row is not repeated.
  const offered = new Set([...listed, ...lines.flatMap((l) => (l.type === "history" ? [l.url] : []))]);
  sources.bookmarks
    .filter((b) => b.url !== urlActive && !offered.has(b.url))
    .slice(0, LIMITS.bookmarks)
    .forEach((b) => lines.push({ type: "bookmark", url: b.url, title: b.title }));
  return lines;
}

export type Section = "actions" | "tabs" | "apps" | "history" | "bookmarks";

const SECTION_TITLES: Record<Section, string> = {
  actions: "sidebar-section-actions",
  tabs: "sidebar-section-tabs",
  apps: "sidebar-section-apps",
  history: "sidebar-section-history",
  bookmarks: "sidebar-section-bookmarks",
};

/** A row's section: the default row has none, it stays first without a title. */
export function sectionOf(l: CommandLine): Section | null {
  return l.type === "default" ? null : l.type === "action" ? "actions" : l.type === "tab" ? "tabs" : l.type === "app" ? "apps" : l.type === "history" ? "history" : "bookmarks";
}

/** The title to put before row `i`: its section's when it opens one, null otherwise. */
export function titleBefore(lines: CommandLine[], i: number, locale = "fr"): string | null {
  const s = sectionOf(lines[i]!);
  return s !== null && (i === 0 || sectionOf(lines[i - 1]!) !== s) ? format(locale, SECTION_TITLES[s]) : null;
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
  if (a.type === "no-manifest") return null;
  return { kind: "project", id: a.folder, name: a.name, action: a.state === "running" ? "open" : "launch", favicon: a.favicon ?? null };
}

export function siteSiteApp(s: ShownSite): SiteApp {
  return { kind: "site", id: s.id, name: s.name, action: "open", favicon: s.icon };
}
