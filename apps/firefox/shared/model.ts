import type { DevRight, TabAccessState, Owner } from "@webaios/kernel";
import type { ExtensionCard } from "./extensions";

/** Internal Applications page: a tab without a web page, displayed by the UI. */
export const URL_APPLICATIONS = "webaios://applications";
/** Internal Extensions page (Store and agent), displayed by the UI. */
export const URL_EXTENSIONS = "webaios://extensions";
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
const ID_EXECUTION = /^[0-9TZ-]+(?:-essai)?$/;
export const urlAction = (id: string, execution?: string) => ACTION_PREFIX + id + (execution ? `/${execution}` : "");
/** The action (and execution) of an action page, or null if the URL is not one (never a path). */
export function actionOfUrl(url: string): { id: string; execution: string | null } | null {
  if (!url.startsWith(ACTION_PREFIX)) return null;
  const [id, execution, ...rest] = url.slice(ACTION_PREFIX.length).split("/");
  if (rest.length || !id || !ID_ACTION.test(id)) return null;
  if (execution === undefined) return { id, execution: null };
  return execution.length <= 64 && ID_EXECUTION.test(execution) ? { id, execution } : null;
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
  onglets: Record<TabId, TabAccessState>;
}
export type SpaceId = string;
export type WindowId = string;
export type SearchEngine = "google" | "duckduckgo" | "qwant";

export interface Tab {
  id: TabId;
  fenetreId: WindowId;
  espaceId: SpaceId;
  url: string;
  titre: string;
  favicon: string | null;
  /** Link to a persistent favorite: the tab materializes an essential or a pinned tab. */
  lien: { type: "essentiel" | "epingle"; id: string } | null;
  ouvertParAgent: boolean;
  chargement: boolean;
  peutReculer: boolean;
  peutAvancer: boolean;
  /** Facteur de zoom, 1 = 100 %. */
  zoom: number;
  /** The page's rendering process crashed. */
  plante: boolean;
  /** Page load failure (Chromium code, e.g. ERR_NAME_NOT_RESOLVED); volatile. */
  erreur: string | null;
}

/** Persistent favorite displayed in the sidebar even without an open tab (Arc/Zen model). */
export interface Favorite {
  id: string;
  url: string;
  titre: string;
  favicon: string | null;
}

/** A login profile: cookies, signed-in accounts and site permissions (one Chromium session). */
export type ProfileId = string;
/** The login profile from before configurable spaces (partition `persist:webaios`). */
export const DEFAULT_PROFILE: ProfileId = "defaut";
export interface ConnectionProfile {
  id: ProfileId;
}

export interface Space {
  id: SpaceId;
  nom: string;
  icone: string;
  epingles: Favorite[];
  /** Invisible to the agent: its tabs are neither listed, nor read, nor kept. */
  prive: boolean;
  profil: ProfileId;
}

export interface RecentlyClosed {
  url: string;
  espaceId: SpaceId;
}

/** Size and position of a window on screen, in points. */
export interface FrameBounds {
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

export interface WindowState {
  id: WindowId;
  espaceActif: SpaceId;
  /** Normal tabs of this window, per space. */
  ordre: Record<SpaceId, TabId[]>;
  actif: Record<SpaceId, TabId | null>;
  compact: boolean;
  panneauAgentOuvert: boolean;
  /** 20 at most, most recent first. */
  fermesRecemment: RecentlyClosed[];
  /** Last known frame; null until the window has been moved or resized. */
  cadre: FrameBounds | null;
}

export interface BrowserState {
  version: 2;
  /** Au moins un espace. */
  espaces: Space[];
  /** The login profiles used by at least one space. */
  profils: ConnectionProfile[];
  /** Shared by all spaces and all windows. */
  essentiels: Favorite[];
  onglets: Record<TabId, Tab>;
  fenetres: WindowState[];
  reglages: { moteur: SearchEngine; /** Profil d'agent (fichier .webaios/profils/<id>.json). */ profilAgent: string;
    /** Width of the agent panel, in pixels (the user sets it by dragging its left edge). */
    largeurPanneauAgent: number;
  };
}

/**
 * Two spaces with the same key can share a tab (an essential): same login profile, same privacy.
 * An unknown space has a key of its own, which matches no existing space.
 */
export function spaceKey(state: BrowserState, spaceId: SpaceId): string {
  const space = state.espaces.find((e) => e.id === spaceId);
  return space ? `${space.profil}|${space.prive}` : `\0inconnu|${spaceId}`;
}

/** The tab is in a private space; an unknown space counts as private. */
export function privateTab(state: BrowserState, tab: Tab): boolean {
  return state.espaces.find((e) => e.id === tab.espaceId)?.prive ?? true;
}

/** The login profiles in use: those of the state and those of its spaces. Only a profile outside this set is erased. */
export function profilesInUse(state: Pick<BrowserState, "profils" | "espaces">): Set<ProfileId> {
  return new Set([...state.profils.map((p) => p.id), ...state.espaces.map((e) => e.profil)]);
}

/**
 * The space where to count a visit (and the kept text) of the tab: the one that displays it in its window — a shared
 * essential is seen in the active space —, otherwise its own. Private if that space or the tab's is (unknown: private).
 */
export function historyContext(state: BrowserState, id: TabId): { espaceId: SpaceId; prive: boolean } | null {
  const o = state.onglets[id];
  if (!o) return null;
  const f = state.fenetres.find((x) => x.id === o.fenetreId);
  const spaceId = f && f.actif[f.espaceActif] === id ? f.espaceActif : o.espaceId;
  const isPrivate = (state.espaces.find((e) => e.id === spaceId)?.prive ?? true) || privateTab(state, o);
  return { espaceId: spaceId, prive: isPrivate };
}

/** The tab's login profile, that of its space (the default profile if the space is unknown). */
export function tabProfile(state: BrowserState, tab: Tab): ProfileId {
  return state.espaces.find((e) => e.id === tab.espaceId)?.profil ?? DEFAULT_PROFILE;
}

/** A history page: one row per URL and per space (`espaceId` empty: no space, old visits). */
export interface Visit {
  url: string;
  titre: string;
  derniereVisite: string; // ISO
  visites: number;
  espaceId: string;
  /** Seen in a private space (or a space that has become private since). */
  prive: boolean;
  /** This visit's text is kept in the agent's memory. */
  retenu: boolean;
}

export interface Download {
  id: string;
  nom: string;
  chemin: string;
  recus: number;
  total: number; // 0 si inconnu
  etat: "en-cours" | "termine" | "annule" | "interrompu";
}

export type Permission =
  | "media-camera"
  | "media-micro"
  | "notifications"
  | "geolocation"
  | "fullscreen"
  | "clipboard-sanitized-write"
  | "ouvrir-application"
  /** The agent wants to read a tab the user did not give it (spec §8.2). */
  | "lire-onglet"
  /** The agent asks for developer-tools rights on a tab (consent card). */
  | "outils-dev"
  /** The agent wants to see the data of a widget read with the user's account (for the current conversation). */
  | "donnees-widget"
  /** Enable (or update) an extension: the grant card, coming from a click by the user or by the agent. */
  | "extension"
  /** The agent wants to see the whole console of one of its extensions (temporary unlock, until it is done). */
  | "console-extension"
  | "autre";
export type Decision = "autoriser" | "refuser";
/** The outcome of a question: the user's decision, or « retiree » if it lapsed without their answer (timeout, stale…). */
export type Outcome = Decision | "retiree";
/** A question asked to the user: one or two permissions (camera and microphone together), a single answer. */
export interface Request {
  ongletId: TabId | null;
  origine: string;
  permissions: Permission[];
  /** « ouvrir-application »: the link to hand to another application (mailto:, zoommtg:…). */
  lien?: string;
  /** « lire-onglet »: title of the targeted tab; « donnees-widget », « console-extension »: name of the widget or extension, displayed as is. */
  titre?: string;
  /** « donnees-widget »: the id of the widget whose data the agent wants to see. */
  widget?: string;
  /** « donnees-widget »: the id of the action whose results the agent wants to see (instead of a widget). */
  action?: string;
  /** « donnees-widget »: the id of the site app the agent wants to see (its pages and its memory), instead of a widget. */
  site?: string;
  /** « lire-onglet »: the question is displayed only in this window (otherwise, according to `ongletId`). */
  fenetreId?: WindowId;
  /** « lire-onglet » and « outils-dev »: the targeted tab; if it is closed, the question is refused. */
  cible?: TabId;
  /** « outils-dev »: the rights requested by the agent, pre-checked. */
  droits?: DevRight[];
  /** « console-extension »: the spaces of the profiles where the extension is active (what the unlock covers). */
  espaces?: string[];
  /** « outils-dev », « console-extension »: the reason given by the agent. */
  raison?: string;
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

/** A project's Review page (plan 17): `webaios://relecture/<project>`, one per project and per window. */
export const REVIEW_PREFIX = "webaios://relecture/";
/** Copy of the kernel's `ID_PROJET` (the UI does not import its values); a test checks that they match. */
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
/** What the Review page displays in place of a file that cannot be displayed (copies of `FICHIER_BINAIRE`/`FICHIER_TROP_GROS`). */
export const NOT_DISPLAYABLE = { binaire: "fichier binaire", "trop-gros": "fichier trop gros pour la relecture" } as const;
/** What a comment displays when its lines changed (copy of the kernel's `LIGNE_CHANGEE`). */
export const PAGE_LINE_CHANGED = "la ligne a changé";
/** A comment covers displayed lines of a single block of the diff, without a gap (page and main process). */
export const RANGE_OUTSIDE_BLOCK = "Un commentaire porte sur des lignes d'un seul bloc du diff.";
