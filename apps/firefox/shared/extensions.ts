import type { SourceExtension } from "@webaios/noyau";

/** Réponse à une saisie qui n'est ni un id d'extension, ni l'adresse de sa page du Chrome Web Store. */
export const SAISIE_INVALIDE = "Adresse ou identifiant du Chrome Web Store attendu";

// Dans un module sans dépendance au noyau : l'interface les importe (le noyau n'entre pas dans son bundle).
export {
  activeDans,
  APPLI_FERMEE,
  AUCUNE_EXTENSION_SITE,
  CONSOLE_DEBLOQUEE_PAGE,
  DESACTIVEE_PLANTAGES,
  DESACTIVEE_PORTEE,
  DOMAINES_CHANGES_EXTENSION,
  GERER_EXTENSIONS,
  LONGUEUR_RAISON_DEBLOCAGE,
  texteDeblocageConsole,
  VOIT_LES_PAGES_SITE,
} from "./extensions-messages";

/** Une ligne de la section « Extensions » des réglages d'un espace (tout y est affiché en texte). */
export interface LigneExtensionEspace {
  cle: string;
  nom: string;
  source: "store" | "agent";
  /** Active dans le profil de cet espace. */
  active: boolean;
  /** Si active : les noms des autres espaces du même profil, où elle tourne aussi. */
  aussiDans: string[];
  /** Non null : l'interrupteur est désactivé, et cette phrase dit pourquoi. */
  grisee: string | null;
  /** Les profils où elle est active (pour prévenir de ce que change un espace privé). */
  profils: string[];
}

/** Ce que montre la carte d'accord d'une extension (DemandeExtension.svelte) : tout y est affiché en texte. */
export interface CarteExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Libellés de la portée (`libellesPortee`), dans leur ordre. */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Agent : domaines où elle peut envoyer (`[]` : nulle part) ; Store : null. */
  reseau: string[] | null;
  /** Accord renforcé : une case à cocher avant « Activer ». */
  renforce: boolean;
  /** Nom de l'espace où elle est activée. */
  espace: string;
  /** Son id : la carte tombe si l'espace disparaît (ou, pour l'agent, si son profil devient privé). */
  espaceId: string;
  /** Les autres espaces du même profil, où elle sera active aussi. */
  autresEspaces: string[];
  /**
   * Agent : les espaces (d'autres profils) où elle tourne déjà avec un accord plus étroit ; la nouvelle version, plus
   * large, les remplacera aussi (« La nouvelle version remplacera aussi celle de … »).
   */
  remplaceAussi: string[];
  /** Mise à jour : la version installée. */
  maj: { de: string } | null;
  /** `empreintePortee` de la portée montrée : l'appelant n'écrit l'accord que pour une portée de même empreinte. */
  empreinte: string;
}

/** Réponse de la carte : `empreinte` est celle de la portée montrée (la première carte, si la demande l'a rejointe). */
export interface ReponseAccord {
  accepte: boolean;
  empreinte: string;
  /** La carte est tombée (ou n'a pas été montrée) sans réponse de l'utilisateur. */
  retiree?: boolean;
}

/** Une ligne de la page Extensions (tout y est affiché en texte : c'est de la donnée venue d'un manifeste ou d'une console). */
export interface LigneExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Libellés de la portée accordée (`libellesPortee`). */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Les espaces dont le profil l'a active. */
  espaces: { nom: string; profil: string }[];
  /** Erreurs de préparation, de chargement, de mise à jour, et erreurs de sa console. */
  erreurs: string[];
  /** Agent : dernière copie rechargée (ISO). */
  modifieeLe: string | null;
  /** Le message de sa désactivation (`DESACTIVEE_PLANTAGES`, `DESACTIVEE_PORTEE`), ou null. */
  desactivee: string | null;
  /** Store : la version d'une mise à jour qui attend l'accord de l'utilisateur. */
  majEnAttente: string | null;
  /** Droits et clés du manifeste que WebAiOs ne prend pas en charge. */
  nonPrisEnCharge: string[];
  epinglee: boolean;
  /** Agent : L'utilisateur a débloqué sa console pour l'agent (en mémoire, jusqu'à ce que l'un d'eux la referme). */
  consoleDebloquee: boolean;
  /** Store : les noms des applis de site où elle est active (l'id si le nom manque). */
  applis: string[];
}

/** Une ligne du menu « Extensions » d'une appli de site (extensions du Store seulement ; tout y est affiché en texte). */
export interface LigneExtensionSite {
  cle: string;
  nom: string;
  /** Activée pour l'empreinte des domaines de l'appli d'aujourd'hui. */
  active: boolean;
  /** Activée, mais pour d'autres domaines (`DOMAINES_CHANGES_EXTENSION`) : rien n'est chargé. */
  domainesChanges: boolean;
  /** `TOUTES_COUPEES_AGENT`, `DESACTIVEE_PLANTAGES`, `DESACTIVEE_PORTEE` : l'interrupteur est grisé ; sinon null. */
  indisponible: string | null;
}

/** La barre d'une fenêtre : les extensions chargées dans le profil de son espace actif. */
export interface BarreExtensions {
  /** Partition de la session du profil (attribut `partition` des `<button is="browser-action">`). */
  partition: string;
  /** Id de l'onglet affiché pour la bibliothèque (son `webContents.id`), ou null. */
  onglet: number | null;
  actions: { cle: string; idChrome: string; nom: string; epinglee: boolean }[];
}
