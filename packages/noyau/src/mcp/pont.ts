import type { DroitDev } from "../acces/politique.js";
import type { ProfilCpu } from "../outils-dev/resumes.js";

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
  /** Affiche la carte de consentement ; renvoie les droits accordés (`[]` = refus). */
  demanderOutilsDev?(o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }): Promise<DroitDev[]>;
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
}

export class OngletIntrouvable extends Error {
  constructor(readonly id: string) {
    super(`Onglet introuvable : ${id}`);
    this.name = "OngletIntrouvable";
  }
}

export class OutilsDevOccupes extends Error {
  constructor() {
    super("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
    this.name = "OutilsDevOccupes";
  }
}
