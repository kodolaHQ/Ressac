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
}

export interface EtatNavigateur {
  version: 1;
  /** Au moins un espace. */
  espaces: Espace[];
  /** Communs à tous les espaces et à toutes les fenêtres. */
  essentiels: Favori[];
  onglets: Record<IdOnglet, Onglet>;
  fenetres: EtatFenetre[];
  reglages: { moteur: MoteurRecherche };
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
  | "autre";
export type Decision = "autoriser" | "refuser";
/** Une question posée à l'utilisateur : une ou deux permissions (caméra et micro ensemble), une seule réponse. */
export interface Demande {
  ongletId: IdOnglet | null;
  origine: string;
  permissions: Permission[];
  /** « ouvrir-application » : le lien à confier à une autre application (mailto:, zoommtg:…). */
  lien?: string;
}
export interface DemandeEnAttente extends Demande {
  id: string;
}
