import type { DroitDev, EtatAccesOnglet } from "@webaios/noyau";
import type { CarteExtension } from "./extensions";

/** Page interne des applications : un onglet sans page web, affiché par l'interface. */
export const URL_APPLICATIONS = "webaios://applications";
/** Page interne des extensions (Store et agent), affichée par l'interface. */
export const URL_EXTENSIONS = "webaios://extensions";
/** Page interne « Voir le workflow » d'un widget : `webaios://workflow/<id du widget>`. */
export const PREFIXE_WORKFLOW = "webaios://workflow/";
export const urlWorkflow = (id: string) => PREFIXE_WORKFLOW + id;
/** Le widget d'une page « Voir le workflow », ou null si l'URL n'en est pas une. */
export function widgetDeUrlWorkflow(url: string): string | null {
  if (!url.startsWith(PREFIXE_WORKFLOW)) return null;
  const id = url.slice(PREFIXE_WORKFLOW.length);
  return /^[a-z0-9-]{1,100}$/.test(id) ? id : null;
}
/** Une page interne (`webaios:`) n'a pas de vue : c'est l'interface qui l'affiche, comme la page vide. */
export const aUneVue = (url: string) => !url.startsWith("webaios:");

/** Le site affiché sur une demande : l'hôte de l'origine, ou le texte tel quel s'il n'en est pas une (about:blank…). */
export function siteDe(origine: string): string {
  try {
    return new URL(origine).host || origine;
  } catch {
    return origine;
  }
}

export type IdOnglet = string;

/** L'accès de l'agent aux onglets, avec le nom de l'agent qui le détient. */
export interface EtatAcces {
  agent: string;
  onglets: Record<IdOnglet, EtatAccesOnglet>;
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
  /** Lien vers un favori persistant : l'onglet matérialise un essentiel ou un épinglé. */
  lien: { type: "essentiel" | "epingle"; id: string } | null;
  ouvertParAgent: boolean;
  chargement: boolean;
  peutReculer: boolean;
  peutAvancer: boolean;
  /** Facteur de zoom, 1 = 100 %. */
  zoom: number;
  /** Le processus de rendu de la page a planté. */
  plante: boolean;
  /** Échec du chargement de la page (code Chromium, ex. ERR_NAME_NOT_RESOLVED) ; volatil. */
  erreur: string | null;
}

/** Favori persistant affiché dans la barre latérale même sans onglet ouvert (modèle Arc/Zen). */
export interface Favori {
  id: string;
  url: string;
  titre: string;
  favicon: string | null;
}

/** Un profil de connexion : cookies, comptes connectés et autorisations des sites (une session Chromium). */
export type IdProfil = string;
/** Le profil de connexion d'avant les espaces configurables (partition `persist:webaios`). */
export const PROFIL_DEFAUT: IdProfil = "defaut";

const PARTITION_DEFAUT = "persist:webaios";
/** Partition Electron d'un profil de connexion : celle de toujours pour le profil par défaut (aucune connexion perdue). */
export function partitionDe(id: IdProfil): string {
  return id === PROFIL_DEFAUT ? PARTITION_DEFAUT : `${PARTITION_DEFAUT}-${id}`;
}
export interface ProfilConnexion {
  id: IdProfil;
}

export interface Espace {
  id: IdEspace;
  nom: string;
  icone: string;
  epingles: Favori[];
  /** Invisible pour l'agent : ses onglets ne sont ni listés, ni lus, ni retenus. */
  prive: boolean;
  profil: IdProfil;
}

export interface FermeRecemment {
  url: string;
  espaceId: IdEspace;
}

/** Taille et position d'une fenêtre à l'écran, en points. */
export interface Cadre {
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
}

export interface EtatFenetre {
  id: IdFenetre;
  espaceActif: IdEspace;
  /** Onglets normaux de cette fenêtre, par espace. */
  ordre: Record<IdEspace, IdOnglet[]>;
  actif: Record<IdEspace, IdOnglet | null>;
  compact: boolean;
  panneauAgentOuvert: boolean;
  /** 20 au plus, le plus récent en tête. */
  fermesRecemment: FermeRecemment[];
  /** Dernier cadre connu ; null tant que la fenêtre n'a pas été déplacée ni redimensionnée. */
  cadre: Cadre | null;
}

export interface EtatNavigateur {
  version: 2;
  /** Au moins un espace. */
  espaces: Espace[];
  /** Les profils de connexion utilisés par au moins un espace. */
  profils: ProfilConnexion[];
  /** Communs à tous les espaces et à toutes les fenêtres. */
  essentiels: Favori[];
  onglets: Record<IdOnglet, Onglet>;
  fenetres: EtatFenetre[];
  reglages: { moteur: MoteurRecherche; /** Profil d'agent (fichier .webaios/profils/<id>.json). */ profilAgent: string;
    /** Largeur du panneau agent, en pixels (L'utilisateur la règle en tirant son bord gauche). */
    largeurPanneauAgent: number;
  };
}

/**
 * Deux espaces de même clé peuvent partager un onglet (un essentiel) : même profil de connexion, même caractère privé.
 * Un espace inconnu a une clé à lui, qui ne correspond à aucun espace existant.
 */
export function cleEspace(etat: EtatNavigateur, espaceId: IdEspace): string {
  const espace = etat.espaces.find((e) => e.id === espaceId);
  return espace ? `${espace.profil}|${espace.prive}` : `\0inconnu|${espaceId}`;
}

/** L'onglet est dans un espace privé ; un espace inconnu compte comme privé. */
export function ongletPrive(etat: EtatNavigateur, onglet: Onglet): boolean {
  return etat.espaces.find((e) => e.id === onglet.espaceId)?.prive ?? true;
}

/** Les profils de connexion en usage : ceux de l'état et ceux de ses espaces. Seul un profil hors de cet ensemble s'efface. */
export function profilsEnUsage(etat: Pick<EtatNavigateur, "profils" | "espaces">): Set<IdProfil> {
  return new Set([...etat.profils.map((p) => p.id), ...etat.espaces.map((e) => e.profil)]);
}

/** Les profils de connexion en usage ont changé (comparés par identifiant, pas par référence). */
export function profilsChanges(avant: EtatNavigateur, apres: EtatNavigateur): boolean {
  const a = profilsEnUsage(avant);
  const b = profilsEnUsage(apres);
  return a.size !== b.size || [...a].some((id) => !b.has(id));
}

/**
 * L'espace où compter une visite (et le texte retenu) de l'onglet : celui qui l'affiche dans sa fenêtre — un essentiel
 * partagé est vu dans l'espace actif —, sinon le sien. Privé si cet espace ou celui de l'onglet l'est (inconnu : privé).
 */
export function contexteHistorique(etat: EtatNavigateur, id: IdOnglet): { espaceId: IdEspace; prive: boolean } | null {
  const o = etat.onglets[id];
  if (!o) return null;
  const f = etat.fenetres.find((x) => x.id === o.fenetreId);
  const espaceId = f && f.actif[f.espaceActif] === id ? f.espaceActif : o.espaceId;
  const prive = (etat.espaces.find((e) => e.id === espaceId)?.prive ?? true) || ongletPrive(etat, o);
  return { espaceId, prive };
}

/** Le profil de connexion de l'onglet, celui de son espace (le profil par défaut si l'espace est inconnu). */
export function profilDOnglet(etat: EtatNavigateur, onglet: Onglet): IdProfil {
  return etat.espaces.find((e) => e.id === onglet.espaceId)?.profil ?? PROFIL_DEFAUT;
}

/** Une page de l'historique : une ligne par URL et par espace (`espaceId` vide : aucun espace, anciennes visites). */
export interface Visite {
  url: string;
  titre: string;
  derniereVisite: string; // ISO
  visites: number;
  espaceId: string;
  /** Vue dans un espace privé (ou espace devenu privé depuis). */
  prive: boolean;
  /** Le texte de cette visite est retenu dans la mémoire de l'agent. */
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
  /** L'agent veut lire un onglet que l'utilisateur ne lui a pas donné (spec §8.2). */
  | "lire-onglet"
  /** L'agent demande des droits d'outils de développement sur un onglet (carte de consentement). */
  | "outils-dev"
  /** L'agent veut voir les données d'un widget lues avec le compte de l'utilisateur (pour la conversation en cours). */
  | "donnees-widget"
  /** Activer (ou mettre à jour) une extension : la carte d'accord, venue d'un clic de l'utilisateur ou de l'agent. */
  | "extension"
  /** L'agent veut voir toute la console d'une de ses extensions (déblocage temporaire, jusqu'à ce qu'il ait fini). */
  | "console-extension"
  | "autre";
export type Decision = "autoriser" | "refuser";
/** Une question posée à l'utilisateur : une ou deux permissions (caméra et micro ensemble), une seule réponse. */
export interface Demande {
  ongletId: IdOnglet | null;
  origine: string;
  permissions: Permission[];
  /** « ouvrir-application » : le lien à confier à une autre application (mailto:, zoommtg:…). */
  lien?: string;
  /** « lire-onglet » : titre de l'onglet visé ; « donnees-widget », « console-extension » : nom du widget ou de l'extension, affiché tel quel. */
  titre?: string;
  /** « donnees-widget » : l'id du widget dont l'agent veut voir les données. */
  widget?: string;
  /** « lire-onglet » : la question ne s'affiche que dans cette fenêtre (sinon, selon `ongletId`). */
  fenetreId?: IdFenetre;
  /** « lire-onglet » et « outils-dev » : l'onglet visé ; s'il est fermé, la question est refusée. */
  cible?: IdOnglet;
  /** « outils-dev » : les droits demandés par l'agent, pré-cochés. */
  droits?: DroitDev[];
  /** « outils-dev », « console-extension » : la raison donnée par l'agent. */
  raison?: string;
  /** « outils-dev » et « donnees-widget » : le nom de l'agent, affiché tel quel. */
  agent?: string;
  /** « extension » : la carte d'accord, affichée en texte. */
  extension?: CarteExtension;
}
export interface DemandeEnAttente extends Demande {
  id: string;
}

/** Bornes de la largeur du panneau agent : assez pour un terminal lisible, jamais toute la fenêtre. */
export const LARGEUR_AGENT_MIN = 280;
export const LARGEUR_AGENT_MAX = 1000;

/** Mode compact : la barre latérale réapparaît quand la souris entre dans cette bande du bord gauche (px). */
export const BORD_REVELATION = 16;
/** …ou quand elle quitte la page par la gauche depuis cette distance : un geste rapide saute la bande. */
export const SORTIE_GAUCHE = 60;
/** Largeur de la barre latérale (px), celle de sa colonne dans App.svelte. */
export const LARGEUR_BARRE = 240;
/** Révélée, la barre reste ouverte tant que la souris ne dépasse pas sa largeur de plus de cette marge (px). */
export const MARGE_BARRE = 40;
