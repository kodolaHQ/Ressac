import { z } from "zod";
import type { MemoryEntry, PositionVideo } from "@webaios/kernel";

/** Messages and types of a site app's window, also read by the UI (`site.html`, Applications page). */

/** Height of a site app window's bar, in px: the site view is placed right below it. */
export const SITE_BAR_HEIGHT = 36;

/** Maximum height, in px, of the bar's « Extensions » menu panel (plan 16): it pushes the site view down by as much. */
export const EXTENSIONS_PANEL_MAX = 320;

/** At most one read of the reference page per minute and per app. */
export const TRACKING_INTERVAL_MS = 60_000;

/** Maximum size of the icon declared by a site app. */
export const ICON_MAX = 256 * 1024;

export const ENTER_THE_SITE = "Entrer dans le site";
export const blockedLink = (domain: string) => `Lien vers ${domain} bloqué`;
export const OPEN_IN_A_TAB = "Ouvrir dans un onglet";
export const SEARCH_URL = "Chercher la nouvelle adresse";
/** `hote` : celui de `suiviAdresse.page`. */
export const urlNotFound = (host: string) => `Adresse introuvable sur ${host}`;
export const urlChanged = (name: string, domain: string) => `${name} a changé d'adresse : ${domain}. Il faudra peut-être te reconnecter.`;
export const urlUnchanged = (name: string) => `${name} ne répond pas, et sa page de référence donne toujours la même adresse`;
export const tweaksGrantTitle = (name: string) => `Autoriser les retouches de « ${name} » ?`;
export const ALLOW = "Autoriser";
export const NO_TWEAKS = "Ouvrir sans retouches";
export const FORGET_MEMORY = "Oublier ce que l'appli a retenu";
export const confirmForget = (name: string) => `Oublier tout ce que « ${name} » a retenu (séries, positions des vidéos) ?`;
export const confirmSiteDeletion = (name: string) =>
  `Supprimer « ${name} » ? Sa connexion et sa mémoire sont effacées, son dossier va à la corbeille.`;
export const editWithAgent = (id: string) => `Appli de site ~/WebAiOs/sites/${id}/ : `;

export type BarNotice =
  | { kind: "link-blocked"; domain: string } // the blocked URL stays in the main process
  | { kind: "url-changed" | "not-found" | "unchanged"; text: string }
  /** A transient notice (design mode unavailable here…), cleared after `DUREE_AVIS_INFO_MS` or at the next page. */
  | { kind: "info"; text: string };

/** Display duration of an `info` notice in the bar, in ms. */
export const INFO_NOTICE_DURATION_MS = 5000;

export type SiteGrantRequest = {
  name: string;
  domains: string[];
  login: string[];
  frames: string[];
  resume: boolean;
  files: string[];
  matches: string[];
  /** Domains where the site was found again by address tracking (outside `domaines`): the tweaks run there too. */
  tracked: string[];
  /** sha256 (hex) of the requested rights (`droitsDe`): « Autoriser » only applies to those the card showed. */
  hash: string;
};

export type SiteWindowState = {
  id: string;
  name: string;
  viewState: "grant" | "home" | "site";
  hasHome: boolean;
  domain: string;
  canGoBack: boolean;
  canGoForward: boolean;
  tracking: boolean;
  /** A read of the reference page is in progress (the « Chercher la nouvelle adresse » button is waiting). */
  search: boolean;
  notice: BarNotice | null;
  grant: SiteGrantRequest | null;
};

/** Maximum length of an address requested by the home (open, image). */
export const HOME_URL_MAX = 2000;

/** Home screen scheme: `webaios-site://<id>/<path in accueil/>`. */
export const SCHEMA_SITE = "webaios-site";
/** Maximum size of a site image requested by the home (rendered as `data:`). */
export const IMAGE_SITE_MAX = 2 * 1024 * 1024;
/** Minimum gap between two addresses opened by the home. */
export const HOME_OPEN_GAP_MS = 1000;

/** What the home (isolated frame, the agent's code) may request: nothing else is relayed. */
export const HomeMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({ type: z.literal("open"), url: z.string().max(HOME_URL_MAX) }),
  z.strictObject({ type: z.literal("image"), n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), url: z.string().max(HOME_URL_MAX) }),
]);
export type HomeMessage = z.infer<typeof HomeMessage>;

export type MessageToHome =
  | { type: "memory"; values: Record<string, MemoryEntry>; positions: Record<string, PositionVideo>; domain: string }
  | { type: "image"; n: number; data: string | null };

/** Console errors of the tweaks kept per open app (the most recent). */
export const MAX_TWEAK_ERRORS = 50;
/** Kept length of the text of a tweak console message, and of its source. */
export const CONSOLE_TWEAK_TEXT_MAX = 2000;
export const CONSOLE_TWEAK_SOURCE_MAX = 500;
/** Total of the kept texts per open app: beyond it, the oldest are forgotten. */
export const CONSOLE_TWEAKS_TOTAL = 32_000;
/** Prefix of the tweaks' sources (`webaios-tweak://<id>/<file>`), to recognize their console messages. */
export const tweakSource = (id: string, file: string) => `webaios-tweak://${id}/${file}`;

/**
 * What the site actor (chrome/agent/site-actor.ts) puts into a frame of a site app's view. `pont`: `webaiosSite` in the
 * tweaks' world (main frame on the site only); `reprise`: the video resume (WebAiOs's code).
 */
export type FrameInjection = { css: string[]; js: { code: string; name: string }[]; guard: string | null; hosts: string[]; bridge: boolean; resume: boolean };

export type ShownSite = { id: string; name: string; description: string; domain: string | null; icon: string | null; open: boolean; error?: string; actionError?: string; noActions?: true };

export type ActionSite = "open" | "edit" | "forget" | "folder" | "delete" | "review";
