import type { DroitDev } from "../acces/politique.js";
import type { ProfilCpu } from "../outils-dev/resumes.js";
import type { ChangerHote } from "../workflows/menagement.js";
import type { PageLue } from "../workflows/protocole.js";

/** Les options d'une lecture de page invisible (voir `PontNavigateur.lirePageInvisible`). */
export interface OptionsLecturePage {
  profil: string | null;
  domaines?: string[];
  adressesLocales?: boolean;
  signal?: AbortSignal;
  changerHote?: ChangerHote;
  /** Écrans à faire défiler avant la lecture (1 à 20) ; absent : la page est lue sans défiler. */
  defiler?: number;
}

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
   *
   * `domaines` (donné pour toute lecture d'un widget qui lit avec le compte de l'utilisateur) : noms d'hôte permis. Le pont
   * DOIT bloquer toute navigation du cadre principal (redirection, script, meta refresh) vers un hôte hors de cette
   * liste, avant que la requête parte : sinon les cookies du profil, ou l'URL elle-même, sortiraient. Le noyau vérifie
   * en plus `PageLue.url` au retour.
   *
   * Le pont refuse aussi toute navigation du cadre principal vers une adresse locale (`adresseLocale`), sauf si
   * `adressesLocales` est vrai (tests seulement : le noyau le passe quand sa propre option `adressesLocales` l'est).
   *
   * `signal` levé (l'exécution qui lit est arrêtée ou finie) : la lecture, en attente ou en cours, est abandonnée, sa
   * fenêtre fermée, et la promesse rejetée avec `signal.reason`.
   *
   * `changerHote` (donné pour une lecture ménagée, celle d'un widget `web`) : avant de suivre une navigation du cadre
   * principal (redirection, script, meta refresh) vers un autre site (`siteMenage` différent), le pont la retient et
   * attend `changerHote(hôte)`, qui rend la main quand le ménagement de ce site le permet ; rejetée, la lecture échoue.
   *
   * `defiler` (1 à 20) : après le premier calme, la page est défilée d'un écran à la fois (jamais de clic, de frappe
   * ni de focus) tant que sa hauteur grandit, au plus `defiler` écrans et dans les mêmes 30 s ; le texte lu va
   * alors jusqu'à 100 000 caractères et 1 000 liens (20 000 et 400 sans défiler).
   */
  lirePageInvisible?(url: string, o: OptionsLecturePage): Promise<PageLue>;
  /**
   * Le HTML d'une page publique (`document.documentElement.outerHTML`, 2 Mo au plus) : toujours la session publique,
   * vidée avant la lecture, jamais un profil ni un compte. Mêmes gardes que `lirePageInvisible` (http(s), adresse
   * locale refusée sauf `adressesLocales`), même limite de 30 s, même abandon par `signal` ; `url` est l'adresse
   * finale, qui doit rester permise.
   */
  lireHtmlInvisible?(url: string, o: { adressesLocales?: boolean; signal?: AbortSignal }): Promise<{ url: string; html: string }>;
  /**
   * Carte « donnees-widget » : l'agent demande à voir les données d'un widget qui lit avec le compte de l'utilisateur. Vrai
   * s'il accepte (pour la conversation en cours). `signal` levé : la carte n'a plus d'objet (nouvelle conversation,
   * noyau arrêté), elle est retirée et la demande répond faux. `genre: "action"` : les résultats d'une action, non d'un
   * widget. Absent : la demande est refusée.
   */
  demanderDonneesWidget?(o: { id: string; nom: string; agent: string; genre?: "action" }, signal?: AbortSignal): Promise<boolean>;
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
