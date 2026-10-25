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
