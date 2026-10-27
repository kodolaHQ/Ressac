/** Page interne des applications : un onglet sans page web, affiché par l'interface. */
export const URL_APPLICATIONS = "webaios://applications";

export type IdOnglet = string;
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

export interface Espace {
  id: IdEspace;
  nom: string;
  icone: string;
  epingles: Favori[];
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
  version: 1;
  /** Au moins un espace. */
  espaces: Espace[];
  /** Communs à tous les espaces et à toutes les fenêtres. */
  essentiels: Favori[];
  onglets: Record<IdOnglet, Onglet>;
  fenetres: EtatFenetre[];
  reglages: { moteur: MoteurRecherche; /** Profil d'agent (fichier .webaios/profils/<id>.json). */ profilAgent: string;
    /** Largeur du panneau agent, en pixels (L'utilisateur la règle en tirant son bord gauche). */
    largeurPanneauAgent: number;
  };
}

/** Une URL de l'historique (une ligne par URL). */
export interface Visite {
  url: string;
  titre: string;
  derniereVisite: string; // ISO
  visites: number;
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
  | "autre";
export type Decision = "autoriser" | "refuser";
/** Une question posée à l'utilisateur : une ou deux permissions (caméra et micro ensemble), une seule réponse. */
export interface Demande {
  ongletId: IdOnglet | null;
  origine: string;
  permissions: Permission[];
  /** « ouvrir-application » : le lien à confier à une autre application (mailto:, zoommtg:…). */
  lien?: string;
  /** « lire-onglet » : titre de l'onglet visé. */
  titre?: string;
  /** « lire-onglet » : la question ne s'affiche que dans cette fenêtre (sinon, selon `ongletId`). */
  fenetreId?: IdFenetre;
  /** « lire-onglet » : l'onglet visé ; s'il est fermé, la question est refusée. */
  cible?: IdOnglet;
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
