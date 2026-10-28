import type { DroitDev } from "../acces/politique.js";
import type { ProfilCpu } from "../outils-dev/resumes.js";
import type { PageLue } from "../widgets/protocole.js";

export interface OngletInfo {
  id: string;
  titre: string;
  url: string;
  espace: string;
  /** Dossier du projet, pour la fenêtre d'une application. */
  application?: string;
}

/** Ce que le navigateur (Electron, extension…) fournit au noyau. */
export interface PontNavigateur {
  ongletActif(): Promise<OngletInfo | null>;
  listerOnglets(): Promise<OngletInfo[]>;
  /** Lève OngletIntrouvable si l'id est inconnu (comme lireTexte, naviguer et capturer). */
  lireTexte(id: string): Promise<{ texte: string; selection?: string }>;
  ouvrirOnglet(url: string, espace?: string): Promise<OngletInfo>;
  naviguer(id: string, url: string): Promise<void>;
  /** Capture PNG de l'onglet. */
  capturer(id: string): Promise<Buffer>;
  /** Affiche la demande à l'utilisateur ; vrai s'il accepte. */
  demanderAutorisation(o: OngletInfo): Promise<boolean>;
  /** Outils de développement (absent si le navigateur ne les fournit pas). */
  outilsDev?: OutilsDevNavigateur;
  /**
   * Affiche la carte de consentement ; renvoie les droits accordés (`[]` = refus). `signal` levé : la carte n'a plus
   * d'objet (nouvelle conversation, noyau arrêté), elle est retirée et la demande répond `[]`.
   */
  demanderOutilsDev?(o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal): Promise<DroitDev[]>;
  /** L'onglet est dans un espace privé : absent de listerOnglets, l'agent n'y a pas accès. */
  estPrive?(id: string): boolean;
  /** L'onglet que l'utilisateur regarde est dans un espace privé (ongletActif renvoie alors null). */
  ongletActifPrive?(): boolean;
  /** Historique et texte retenu des pages, faits des seules visites non privées (absent : pas d'outils d'historique). */
  historique?: HistoriqueNavigateur;
  /**
   * Lit une page dans un onglet invisible, sans cliquer ni taper. `profil: null` : session vierge, sans aucun cookie ;
   * sinon le profil de connexion nommé. Lève ProfilRefuse si ce profil est inconnu ou utilisé par un espace privé.
   * Absent : pas de lecture de pages pour les widgets.
   */
  lirePageInvisible?(url: string, o: { profil: string | null }): Promise<PageLue>;
}

export interface MessageConsole {
  horodatage: number;
  niveau: "log" | "info" | "warn" | "error" | "debug";
  texte: string;
  pile?: string;
}

export interface RequeteReseau {
  id: string;
  horodatage: number;
  methode: string;
  url: string;
  statut?: number;
  dureeMs?: number;
  taille?: number;
  type?: string;
  enTetesRequete: Record<string, string>;
  enTetesReponse: Record<string, string>;
  erreur?: string;
}

/** Résultat d'`executer` : la valeur déjà sérialisée (JSON ou aperçu), non tronquée ; le noyau tronque. */
export type ResultatJs = { valeur: string } | { exception: string };

/** Ce que le navigateur fournit pour inspecter un onglet (Chrome DevTools Protocol côté Electron). */
export interface OutilsDevNavigateur {
  /** Lève OutilsDevOccupes ou OngletIntrouvable. */
  attacher(id: string): Promise<void>;
  detacher(id: string): Promise<void>;
  console(id: string): Promise<MessageConsole[]>;
  reseau(id: string): Promise<RequeteReseau[]>;
  corps(id: string, requete: string): Promise<{ corps: string; base64: boolean }>;
  profiler(
    id: string,
    o: { dureeMs?: number; recharger?: boolean },
    signal: AbortSignal,
  ): Promise<{ profil: ProfilCpu; metriques: Record<string, number> }>;
  /** Le `.heapsnapshot` brut. */
  instantaneMemoire(id: string, signal: AbortSignal): Promise<string>;
  executer(id: string, code: string, signal: AbortSignal): Promise<ResultatJs>;
  recharger(id: string, sansCache: boolean): Promise<void>;
  /** Onglets où le débogueur de l'agent est attaché, y compris par un noyau précédent. */
  attaches?(): string[];
  /**
   * Un accès réservé à un noyau (le navigateur garde ses outils d'un noyau à l'autre). En créer un révoque le précédent :
   * ses appels sont refusés et ses attachements tombent. `liberer` révoque celui-ci (noyau arrêté).
   */
  proprietaire?(): OutilsDevProprietaire;
}

export interface OutilsDevProprietaire extends OutilsDevNavigateur {
  liberer(): void;
}

export class OngletIntrouvable extends Error {
  constructor(readonly id: string) {
    super(`Onglet introuvable : ${id}`);
    this.name = "OngletIntrouvable";
  }
}

/** Une page de l'historique trouvée pour l'agent : une par URL, faite des seules visites non privées. */
export interface ResultatHistorique {
  url: string;
  titre: string;
  derniereVisite: string; // ISO
  visites: number;
  /** Environ 300 caractères du texte retenu autour des mots cherchés ; vide si la page n'a pas de texte trouvé. */
  extrait: string;
}

/** Une page dont le texte a été retenu, telle que lue par l'agent. */
export interface PageRetenue {
  url: string;
  titre: string;
  date: string; // ISO
  texte: string;
}

/** Ce que le navigateur fournit pour chercher dans l'historique : jamais une visite d'un espace privé. */
export interface HistoriqueNavigateur {
  /** `depuis` et `jusqua` : dates ISO déjà vérifiées par le noyau ; `limite` entre 1 et 50. */
  chercher(q: { requete: string; depuis?: string; jusqua?: string; limite: number }): Promise<ResultatHistorique[]>;
  /** Le texte retenu le plus récent de la page, ou null (inconnue, ou vue seulement dans un espace privé). */
  lire(url: string): Promise<PageRetenue | null>;
}

export const TEXTE_PRIVE = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

/** L'onglet est dans un espace privé : l'agent reçoit TEXTE_PRIVE, sans question posée à l'utilisateur. */
export class OngletPrive extends Error {
  constructor(readonly id: string) {
    super(TEXTE_PRIVE);
    this.name = "OngletPrive";
  }
}

export class OutilsDevOccupes extends Error {
  constructor() {
    super("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
    this.name = "OutilsDevOccupes";
  }
}

/** Le profil de connexion demandé pour une lecture est inconnu ou utilisé par un espace privé. */
export class ProfilRefuse extends Error {
  constructor(readonly profil: string) {
    super(`Profil de connexion refusé : ${profil}`);
    this.name = "ProfilRefuse";
  }
}
