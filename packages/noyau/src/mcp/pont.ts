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
}

export class OngletIntrouvable extends Error {
  constructor(readonly id: string) {
    super(`Onglet introuvable : ${id}`);
    this.name = "OngletIntrouvable";
  }
}
