import type { AuraId } from "./aura";
import type { HintId } from "./hints";
import type { DevRight, TabAccessState, Owner } from "@webaios/kernel";
import type { Binding, ShortcutId } from "./shortcuts";
import type { ExtensionCard } from "./extensions";
import type { ClaudeEngine, CodexEngine, DecisionModel } from "./settings";

/** Internal Applications page: a tab without a web page, displayed by the UI. */
export const URL_APPLICATIONS = "webaios://apps";
/** Internal Extensions page (Store and agent), displayed by the UI. */
export const URL_EXTENSIONS = "webaios://extensions";
/** Internal Settings page, displayed by the UI. */
export const URL_SETTINGS = "webaios://settings";
/** Internal « Nouveautés » page (shared/release-notes.ts), displayed by the UI. */
export const URL_RELEASE_NOTES = "webaios://release-notes";
/** Internal « Voir le workflow » page of a widget: `webaios://workflow/<widget id>`. */
export const WORKFLOW_PREFIX = "webaios://workflow/";
export const urlWorkflow = (id: string) => WORKFLOW_PREFIX + id;
/** The widget of a « Voir le workflow » page, or null if the URL is not one. */
export function widgetOfWorkflowUrl(url: string): string | null {
  if (!url.startsWith(WORKFLOW_PREFIX)) return null;
  const id = url.slice(WORKFLOW_PREFIX.length);
  return /^[a-z0-9-]{1,100}$/.test(id) ? id : null;
}
/** Internal « Voir le workflow » page of an action: `webaios://workflow/action/<action id>`. */
export const WORKFLOW_ACTION_PREFIX = "webaios://workflow/action/";
const ID_ACTION = /^[a-z0-9-]{1,60}$/;
/** What a « Voir le workflow » page opens (widget or action), or null if the URL is not one. */
export function workflowUrlTarget(url: string): Owner | null {
  if (url.startsWith(WORKFLOW_ACTION_PREFIX)) {
    const id = url.slice(WORKFLOW_ACTION_PREFIX.length);
    return ID_ACTION.test(id) ? { type: "action", id } : null;
  }
  const widget = widgetOfWorkflowUrl(url);
  return widget ? { type: "widget", id: widget } : null;
}
/** Internal « Actions » page: the list of actions. */
export const URL_ACTIONS = "webaios://actions";
/** Page of an action: `webaios://action/<id>` (the latest result) or `webaios://action/<id>/<execution>`. */
export const ACTION_PREFIX = "webaios://action/";
const ID_EXECUTION = /^[0-9TZ-]+(?:-attempt)?$/;
export const urlAction = (id: string, execution?: string) => ACTION_PREFIX + id + (execution ? `/${execution}` : "");
/** The action (and execution) of an action page, or null if the URL is not one (never a path). */
export function actionOfUrl(url: string): { id: string; run: string | null } | null {
  if (!url.startsWith(ACTION_PREFIX)) return null;
  const [id, run, ...rest] = url.slice(ACTION_PREFIX.length).split("/");
  if (rest.length || !id || !ID_ACTION.test(id)) return null;
  if (run === undefined) return { id, run: null };
  return run.length <= 64 && ID_EXECUTION.test(run) ? { id, run } : null;
}
/** An internal page (`webaios:`) has no view: the UI displays it, like the blank page. */
export const hasView = (url: string) => !url.startsWith("webaios:");

/** The site displayed for a request: the origin's host, or the text as is if it is not one (about:blank…). */
export function siteOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export type TabId = string;

/** The agent's access to tabs, with the name of the agent holding it. */
export interface AccessState {
  agent: string;
  tabs: Record<TabId, TabAccessState>;
}
export type SpaceId = string;
export type WindowId = string;
export type SearchEngine = "google" | "duckduckgo" | "qwant";

export interface Tab {
  id: TabId;
  windowId: WindowId;
  spaceId: SpaceId;
  url: string;
  title: string;
  favicon: string | null;
  /** Link to a persistent favorite: the tab materializes an essential or a pinned tab. */
  link: { type: "essential" | "pinned"; id: string } | null;
  openedByAgent: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Facteur de zoom, 1 = 100 %. */
  zoom: number;
  /** The page's rendering process crashed. */
  crashed: boolean;
  /** Page load failure (Chromium code, e.g. ERR_NAME_NOT_RESOLVED); volatile. */
  error: string | null;
}

/** Persistent favorite displayed in the sidebar even without an open tab (Arc/Zen model). */
export interface Favorite {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  /** A pinned tab only: the folder of its space it sits in. */
  folder?: string;
}

/** A folder of pinned tabs in a space's sidebar (one level, Arc/Zen model). */
export interface Folder {
  id: string;
  name: string;
  collapsed: boolean;
}

/** A login profile: cookies, signed-in accounts and site permissions (one Chromium session). */
export type ProfileId = string;
/** The login profile from before configurable spaces (partition `persist:webaios`). */
export const DEFAULT_PROFILE: ProfileId = "default";
export interface ConnectionProfile {
  id: ProfileId;
}

export interface Space {
  id: SpaceId;
  name: string;
  icon: string;
  pinned: Favorite[];
  /** Shown above the pinned tabs outside any folder, in this order. */
  folders: Folder[];
  /** Invisible to the agent: its tabs are neither listed, nor read, nor kept. */
  private: boolean;
  profile: ProfileId;
  aura: AuraId;
}

export interface RecentlyClosed {
  url: string;
  spaceId: SpaceId;
}

/** Size and position of a window on screen, in points. */
export interface FrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  id: WindowId;
  activeSpace: SpaceId;
  /** Normal tabs of this window, per space. */
  order: Record<SpaceId, TabId[]>;
  active: Record<SpaceId, TabId | null>;
  compact: boolean;
  agentPanelOpen: boolean;
  /** 20 at most, most recent first. */
  recentlyClosed: RecentlyClosed[];
  /** Last known frame; null until the window has been moved or resized. */
  frame: FrameBounds | null;
}

export interface BrowserState {
  version: 3;
  /** Au moins un espace. */
  spaces: Space[];
  /** The login profiles used by at least one space. */
  profiles: ConnectionProfile[];
  /** Shared by all spaces and all windows. */
  essentials: Favorite[];
  tabs: Record<TabId, Tab>;
  windows: WindowState[];
  settings: { engine: SearchEngine; /** Profil d'agent (fichier .webaios/profiles/<id>.json). */ agentProfile: string;
    /** Width of the agent panel, in pixels (the user sets it by dragging its left edge). */
    agentPanelWidth: number;
    /** The model that decides the workflows' watch notices. */
    decisionModel: DecisionModel;
    /** The engine Codex runs on (account, local Ollama or compatible API). */
    codexEngine: CodexEngine;
    claudeEngine: ClaudeEngine;
    /** False until the first-launch welcome is finished (or skipped). */
    onboarded: boolean;
    /** The WebAiOs version of the last launch; null before any launch that records it. */
    seenVersion: string | null;
    /** Tips and first-time notes: shown while enabled, each at most once. */
    hints: { enabled: boolean; seen: HintId[] };
    /** Which side of the window the navigation sidebar sits on. */
    sidebarSide: "left" | "right";
    /** Vim keys in web tabs (off by default). */
    vimMode: boolean;
    /** The user's own bindings; an action absent here keeps its default (shared/shortcuts.ts). */
    shortcuts: Partial<Record<ShortcutId, Binding>>;
  };
}

/**
 * Two spaces with the same key can share a tab (an essential): same login profile, same privacy.
 * An unknown space has a key of its own, which matches no existing space.
 */
export function spaceKey(state: BrowserState, spaceId: SpaceId): string {
  const space = state.spaces.find((e) => e.id === spaceId);
  return space ? `${space.profile}|${space.private}` : `\0inconnu|${spaceId}`;
}

/** The tab is in a private space; an unknown space counts as private. */
export function privateTab(state: BrowserState, tab: Tab): boolean {
  return state.spaces.find((e) => e.id === tab.spaceId)?.private ?? true;
}

/** The login profiles in use: those of the state and those of its spaces. Only a profile outside this set is erased. */
export function profilesInUse(state: Pick<BrowserState, "profiles" | "spaces">): Set<ProfileId> {
  return new Set([...state.profiles.map((p) => p.id), ...state.spaces.map((e) => e.profile)]);
}

/**
 * The space where to count a visit (and the kept text) of the tab: the one that displays it in its window — a shared
 * essential is seen in the active space —, otherwise its own. Private if that space or the tab's is (unknown: private).
 */
export function historyContext(state: BrowserState, id: TabId): { spaceId: SpaceId; private: boolean } | null {
  const o = state.tabs[id];
  if (!o) return null;
  const f = state.windows.find((x) => x.id === o.windowId);
  const spaceId = f && f.active[f.activeSpace] === id ? f.activeSpace : o.spaceId;
  const isPrivate = (state.spaces.find((e) => e.id === spaceId)?.private ?? true) || privateTab(state, o);
  return { spaceId: spaceId, private: isPrivate };
}

/** The tab's login profile, that of its space (the default profile if the space is unknown). */
export function tabProfile(state: BrowserState, tab: Tab): ProfileId {
  return state.spaces.find((e) => e.id === tab.spaceId)?.profile ?? DEFAULT_PROFILE;
}

/** A history page: one row per URL and per space (`spaceId` empty: no space). */
export interface Visit {
  url: string;
  title: string;
  lastVisit: string; // ISO
  visits: number;
  spaceId: string;
  /** Seen in a private space (or a space that has become private since). */
  private: boolean;
  /** This visit's text is kept in the agent's memory. */
  kept: boolean;
}

export interface Download {
  id: string;
  name: string;
  path: string;
  received: number;
  total: number; // 0 si inconnu
  state: "in-progress" | "done" | "canceled" | "interrupted";
}

export type Permission =
  | "media-camera"
  | "media-micro"
  | "notifications"
  | "geolocation"
  | "fullscreen"
  | "clipboard-sanitized-write"
  | "open-app"
  /** The agent wants to read a tab the user did not give it (spec §8.2). */
  | "read-tab"
  /** The agent asks for developer-tools rights on a tab (consent card). */
  | "devtools"
  /** The agent wants to see the data of a widget read with the user's account (for the current conversation). */
  | "widget-data"
  /** Enable (or update) an extension: the grant card, coming from a click by the user or by the agent. */
  | "extension"
  /** The agent wants to see the whole console of one of its extensions (temporary unlock, until it is done). */
  | "extension-console"
  | "other";
export type Decision = "allow" | "deny";
/** The outcome of a question: the user's decision, or `withdrawn` if it lapsed without their answer (timeout, stale…). */
export type Outcome = Decision | "withdrawn";
/** A question asked to the user: one or two permissions (camera and microphone together), a single answer. */
export interface Request {
  tabId: TabId | null;
  origin: string;
  permissions: Permission[];
  /** « ouvrir-application »: the link to hand to another application (mailto:, zoommtg:…). */
  link?: string;
  /** « lire-onglet »: title of the targeted tab; « donnees-widget », « console-extension »: name of the widget or extension, displayed as is. */
  title?: string;
  /** « donnees-widget »: the id of the widget whose data the agent wants to see. */
  widget?: string;
  /** « donnees-widget »: the id of the action whose results the agent wants to see (instead of a widget). */
  action?: string;
  /** « donnees-widget »: the id of the site app the agent wants to see (its pages and its memory), instead of a widget. */
  site?: string;
  /** « lire-onglet »: the question is displayed only in this window (otherwise, according to `ongletId`). */
  windowId?: WindowId;
  /** « lire-onglet » and « outils-dev »: the targeted tab; if it is closed, the question is refused. */
  target?: TabId;
  /** « outils-dev »: the rights requested by the agent, pre-checked. */
  rights?: DevRight[];
  /** « console-extension »: the spaces of the profiles where the extension is active (what the unlock covers). */
  spaces?: string[];
  /** « outils-dev », « console-extension »: the reason given by the agent. */
  reason?: string;
  /** « outils-dev » and « donnees-widget »: the agent's name, displayed as is. */
  agent?: string;
  /** « extension »: the grant card, displayed as text. */
  extension?: ExtensionCard;
}
export interface PendingRequest extends Request {
  id: string;
}

/** Bounds of the agent panel width: enough for a readable terminal, never the whole window. */
export const AGENT_WIDTH_MIN = 280;
export const AGENT_WIDTH_MAX = 1000;

/** Compact mode: the sidebar reappears when the mouse enters this strip of the left edge (px). */
export const REVEAL_EDGE = 16;
/** …or when it leaves the page through the left from this distance: a fast gesture skips the strip. */
export const LEFT_EXIT = 60;
/** Width of the sidebar (px), that of its column in App.svelte. */
export const BAR_WIDTH = 240;
/** Once revealed, the bar stays open as long as the mouse does not go beyond its width by more than this margin (px). */
export const BAR_MARGIN = 40;

/** A project's Review page (plan 17): `webaios://review/<project>`, one per project and per window. */
export const REVIEW_PREFIX = "webaios://review/";
/** Copy of the kernel's `PROJECT_ID` (the UI does not import its values); a test checks that they match. */
const PAGE_PROJECT_ID = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5}|site-[a-z0-9][a-z0-9-]{0,59})$/;
export const reviewUrl = (project: string) => REVIEW_PREFIX + project;
/** The project of a Review page, or null if the URL is not one (never a path). */
export function reviewUrlProject(url: string): string | null {
  if (!url.startsWith(REVIEW_PREFIX)) return null;
  const p = url.slice(REVIEW_PREFIX.length);
  return PAGE_PROJECT_ID.test(p) ? p : null;
}
/** Context lines loaded at once by « déplier » on the Review page. */
export const EXPANDED_LINES = 20;
/** What the Review page displays in place of a file that cannot be displayed (copies of `BINARY_FILE`/`FILE_TOO_BIG`). */
export const NOT_DISPLAYABLE = { binary: "fichier binaire", "too-big": "fichier trop gros pour la relecture" } as const;
/** What a comment displays when its lines changed (copy of the kernel's `LIGNE_CHANGEE`). */
export const PAGE_LINE_CHANGED = "la ligne a changé";
/** A comment covers displayed lines of a single block of the diff, without a gap (page and main process). */
export const RANGE_OUTSIDE_BLOCK = "Un commentaire porte sur des lignes d'un seul bloc du diff.";
