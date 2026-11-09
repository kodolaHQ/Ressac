import type { DroitDev, TabAccessState, Owner } from "@webaios/noyau";
import type { CarteExtension } from "./extensions";

/** Internal Applications page: a tab without a web page, displayed by the UI. */
export const URL_APPLICATIONS = "webaios://applications";
/** Internal Extensions page (Store and agent), displayed by the UI. */
export const URL_EXTENSIONS = "webaios://extensions";
/** Internal « Voir le workflow » page of a widget: `webaios://workflow/<widget id>`. */
export const PREFIXE_WORKFLOW = "webaios://workflow/";
export const urlWorkflow = (id: string) => PREFIXE_WORKFLOW + id;
/** The widget of a « Voir le workflow » page, or null if the URL is not one. */
export function widgetDeUrlWorkflow(url: string): string | null {
  if (!url.startsWith(PREFIXE_WORKFLOW)) return null;
  const id = url.slice(PREFIXE_WORKFLOW.length);
  return /^[a-z0-9-]{1,100}$/.test(id) ? id : null;
}
/** Internal « Voir le workflow » page of an action: `webaios://workflow/action/<action id>`. */
export const PREFIXE_WORKFLOW_ACTION = "webaios://workflow/action/";
const ID_ACTION = /^[a-z0-9-]{1,60}$/;
/** What a « Voir le workflow » page opens (widget or action), or null if the URL is not one. */
export function cibleDeUrlWorkflow(url: string): Owner | null {
  if (url.startsWith(PREFIXE_WORKFLOW_ACTION)) {
    const id = url.slice(PREFIXE_WORKFLOW_ACTION.length);
    return ID_ACTION.test(id) ? { type: "action", id } : null;
  }
  const widget = widgetDeUrlWorkflow(url);
  return widget ? { type: "widget", id: widget } : null;
}
/** Internal « Actions » page: the list of actions. */
export const URL_ACTIONS = "webaios://actions";
/** Page of an action: `webaios://action/<id>` (the latest result) or `webaios://action/<id>/<execution>`. */
export const PREFIXE_ACTION = "webaios://action/";
const ID_EXECUTION = /^[0-9TZ-]+(?:-essai)?$/;
export const urlAction = (id: string, execution?: string) => PREFIXE_ACTION + id + (execution ? `/${execution}` : "");
/** The action (and execution) of an action page, or null if the URL is not one (never a path). */
export function actionDeUrl(url: string): { id: string; execution: string | null } | null {
  if (!url.startsWith(PREFIXE_ACTION)) return null;
  const [id, execution, ...reste] = url.slice(PREFIXE_ACTION.length).split("/");
  if (reste.length || !id || !ID_ACTION.test(id)) return null;
  if (execution === undefined) return { id, execution: null };
  return execution.length <= 64 && ID_EXECUTION.test(execution) ? { id, execution } : null;
}
/** An internal page (`webaios:`) has no view: the UI displays it, like the blank page. */
export const aUneVue = (url: string) => !url.startsWith("webaios:");

/** The site displayed for a request: the origin's host, or the text as is if it is not one (about:blank…). */
export function siteDe(origine: string): string {
  try {
    return new URL(origine).host || origine;
  } catch {
    return origine;
  }
}

export type IdOnglet = string;

/** The agent's access to tabs, with the name of the agent holding it. */
export interface EtatAcces {
  agent: string;
  onglets: Record<IdOnglet, TabAccessState>;
}
export type IdEspace = string;
export type IdFenetre = string;
export type MoteurRecherche = "google" | "duckduckgo" | "qwant";

export interface Onglet {
  id: IdOnglet;
  fenetreId: IdFenetre;
  espaceId: IdEspace;
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
export interface Favori {
  id: string;
  url: string;
  titre: string;
  favicon: string | null;
}

/** A login profile: cookies, signed-in accounts and site permissions (one Chromium session). */
export type IdProfil = string;
/** The login profile from before configurable spaces (partition `persist:webaios`). */
export const PROFIL_DEFAUT: IdProfil = "defaut";
export interface ProfilConnexion {
  id: IdProfil;
}

export interface Espace {
  id: IdEspace;
  nom: string;
  icone: string;
  epingles: Favori[];
  /** Invisible to the agent: its tabs are neither listed, nor read, nor kept. */
  prive: boolean;
  profil: IdProfil;
}

export interface FermeRecemment {
  url: string;
  espaceId: IdEspace;
}

/** Size and position of a window on screen, in points. */
export interface Cadre {
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

export interface EtatFenetre {
  id: IdFenetre;
  espaceActif: IdEspace;
  /** Normal tabs of this window, per space. */
  ordre: Record<IdEspace, IdOnglet[]>;
  actif: Record<IdEspace, IdOnglet | null>;
  compact: boolean;
  panneauAgentOuvert: boolean;
  /** 20 at most, most recent first. */
  fermesRecemment: FermeRecemment[];
  /** Last known frame; null until the window has been moved or resized. */
  cadre: Cadre | null;
}

export interface EtatNavigateur {
  version: 2;
  /** Au moins un espace. */
  espaces: Espace[];
  /** The login profiles used by at least one space. */
  profils: ProfilConnexion[];
  /** Shared by all spaces and all windows. */
  essentiels: Favori[];
  onglets: Record<IdOnglet, Onglet>;
  fenetres: EtatFenetre[];
  reglages: { moteur: MoteurRecherche; /** Profil d'agent (fichier .webaios/profils/<id>.json). */ profilAgent: string;
    /** Width of the agent panel, in pixels (the user sets it by dragging its left edge). */
    largeurPanneauAgent: number;
  };
}

/**
 * Two spaces with the same key can share a tab (an essential): same login profile, same privacy.
 * An unknown space has a key of its own, which matches no existing space.
 */
export function cleEspace(etat: EtatNavigateur, espaceId: IdEspace): string {
  const espace = etat.espaces.find((e) => e.id === espaceId);
  return espace ? `${espace.profil}|${espace.prive}` : `\0inconnu|${espaceId}`;
}

/** The tab is in a private space; an unknown space counts as private. */
export function ongletPrive(etat: EtatNavigateur, onglet: Onglet): boolean {
  return etat.espaces.find((e) => e.id === onglet.espaceId)?.prive ?? true;
}

/** The login profiles in use: those of the state and those of its spaces. Only a profile outside this set is erased. */
export function profilsEnUsage(etat: Pick<EtatNavigateur, "profils" | "espaces">): Set<IdProfil> {
  return new Set([...etat.profils.map((p) => p.id), ...etat.espaces.map((e) => e.profil)]);
}

/**
 * The space where to count a visit (and the kept text) of the tab: the one that displays it in its window — a shared
 * essential is seen in the active space —, otherwise its own. Private if that space or the tab's is (unknown: private).
 */
export function contexteHistorique(etat: EtatNavigateur, id: IdOnglet): { espaceId: IdEspace; prive: boolean } | null {
  const o = etat.onglets[id];
  if (!o) return null;
  const f = etat.fenetres.find((x) => x.id === o.fenetreId);
  const espaceId = f && f.actif[f.espaceActif] === id ? f.espaceActif : o.espaceId;
  const prive = (etat.espaces.find((e) => e.id === espaceId)?.prive ?? true) || ongletPrive(etat, o);
  return { espaceId, prive };
}

/** The tab's login profile, that of its space (the default profile if the space is unknown). */
export function profilDOnglet(etat: EtatNavigateur, onglet: Onglet): IdProfil {
  return etat.espaces.find((e) => e.id === onglet.espaceId)?.profil ?? PROFIL_DEFAUT;
}

/** A history page: one row per URL and per space (`espaceId` empty: no space, old visits). */
export interface Visite {
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

export interface Telechargement {
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
export type Issue = Decision | "retiree";
/** A question asked to the user: one or two permissions (camera and microphone together), a single answer. */
export interface Demande {
  ongletId: IdOnglet | null;
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
  fenetreId?: IdFenetre;
  /** « lire-onglet » and « outils-dev »: the targeted tab; if it is closed, the question is refused. */
  cible?: IdOnglet;
  /** « outils-dev »: the rights requested by the agent, pre-checked. */
  droits?: DroitDev[];
  /** « console-extension »: the spaces of the profiles where the extension is active (what the unlock covers). */
  espaces?: string[];
  /** « outils-dev », « console-extension »: the reason given by the agent. */
  raison?: string;
  /** « outils-dev » and « donnees-widget »: the agent's name, displayed as is. */
  agent?: string;
  /** « extension »: the grant card, displayed as text. */
  extension?: CarteExtension;
}
export interface DemandeEnAttente extends Demande {
  id: string;
}

/** Bounds of the agent panel width: enough for a readable terminal, never the whole window. */
export const LARGEUR_AGENT_MIN = 280;
export const LARGEUR_AGENT_MAX = 1000;

/** Compact mode: the sidebar reappears when the mouse enters this strip of the left edge (px). */
export const BORD_REVELATION = 16;
/** …or when it leaves the page through the left from this distance: a fast gesture skips the strip. */
export const SORTIE_GAUCHE = 60;
/** Width of the sidebar (px), that of its column in App.svelte. */
export const LARGEUR_BARRE = 240;
/** Once revealed, the bar stays open as long as the mouse does not go beyond its width by more than this margin (px). */
export const MARGE_BARRE = 40;

/** A project's Review page (plan 17): `webaios://relecture/<project>`, one per project and per window. */
export const PREFIXE_RELECTURE = "webaios://relecture/";
/** Copy of the kernel's `ID_PROJET` (the UI does not import its values); a test checks that they match. */
const ID_PROJET_PAGE = /^(app-[A-Za-z0-9][A-Za-z0-9._-]*|ext-[0-9a-f]{16}|demo-\d{1,5}|site-[a-z0-9][a-z0-9-]{0,59})$/;
export const urlRelecture = (projet: string) => PREFIXE_RELECTURE + projet;
/** The project of a Review page, or null if the URL is not one (never a path). */
export function projetDeUrlRelecture(url: string): string | null {
  if (!url.startsWith(PREFIXE_RELECTURE)) return null;
  const p = url.slice(PREFIXE_RELECTURE.length);
  return ID_PROJET_PAGE.test(p) ? p : null;
}
/** Context lines loaded at once by « déplier » on the Review page. */
export const LIGNES_DEPLIEES = 20;
/** What the Review page displays in place of a file that cannot be displayed (copies of `FICHIER_BINAIRE`/`FICHIER_TROP_GROS`). */
export const NON_AFFICHABLE = { binaire: "fichier binaire", "trop-gros": "fichier trop gros pour la relecture" } as const;
/** What a comment displays when its lines changed (copy of the kernel's `LIGNE_CHANGEE`). */
export const LIGNE_CHANGEE_PAGE = "la ligne a changé";
/** A comment covers displayed lines of a single block of the diff, without a gap (page and main process). */
export const PLAGE_HORS_BLOC = "Un commentaire porte sur des lignes d'un seul bloc du diff.";
