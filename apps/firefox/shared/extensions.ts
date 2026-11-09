import type { SourceExtension } from "@webaios/kernel";

// In a module with no dependency on the kernel: the UI imports them (the kernel does not enter its bundle).
export {
  activeDans,
  APP_CLOSED as APPLI_FERMEE,
  NO_SITE_EXTENSION as AUCUNE_EXTENSION_SITE,
  CONSOLE_UNLOCKED_PAGE as CONSOLE_DEBLOQUEE_PAGE,
  DISABLED_CRASHES as DESACTIVEE_PLANTAGES,
  DISABLED_SCOPE as DESACTIVEE_PORTEE,
  EXTENSION_CHANGED_DOMAINS as DOMAINES_CHANGES_EXTENSION,
  MANAGE_EXTENSIONS as GERER_EXTENSIONS,
  UNLOCK_REASON_LENGTH as LONGUEUR_RAISON_DEBLOCAGE,
  unlockedConsoleText as texteDeblocageConsole,
  SEES_SITE_PAGES as VOIT_LES_PAGES_SITE,
} from "./extensions-messages";

/** A row of the « Extensions » section of a space's settings (everything is displayed as text there). */
export interface SpaceExtensionLine {
  cle: string;
  nom: string;
  source: "store" | "agent";
  /** Active in this space's profile. */
  active: boolean;
  /** If active: the names of the other spaces of the same profile, where it also runs. */
  aussiDans: string[];
  /** Non null: the switch is disabled, and this sentence says why. */
  grisee: string | null;
  /** The profiles where it is active (to warn about what a private space changes). */
  profils: string[];
}

/** What an extension's grant card shows (DemandeExtension.svelte): everything is displayed as text there. */
export interface CarteExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Labels of the scope (`libellesPortee`), in their order. */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** Agent: domains it can send to (`[]`: nowhere); Store: null. */
  reseau: string[] | null;
  /** Hardened grant: a checkbox before « Activer ». */
  renforce: boolean;
  /** Name of the space where it is enabled. */
  espace: string;
  /** Its id: the card drops if the space disappears (or, for the agent, if its profile becomes private). */
  espaceId: string;
  /** The other spaces of the same profile, where it will be active too. */
  autresEspaces: string[];
  /**
   * Agent: the spaces (of other profiles) where it already runs with a narrower grant; the new, wider version
   * will replace them too (« La nouvelle version remplacera aussi celle de … »).
   */
  remplaceAussi: string[];
  /** Update: the installed version. */
  maj: { de: string } | null;
  /** `empreintePortee` of the shown scope: the caller writes the grant only for a scope with the same hash. */
  empreinte: string;
}

/** The card's answer: `empreinte` is that of the shown scope (the first card, if the request joined it). */
export interface GrantResponse {
  accepte: boolean;
  empreinte: string;
  /** The card dropped (or was not shown) without an answer from the user. */
  retiree?: boolean;
}

/** A row of the Extensions page (everything is displayed as text there: it is data coming from a manifest or a console). */
export interface LigneExtension {
  cle: string;
  nom: string;
  source: SourceExtension;
  version: string;
  /** Labels of the granted scope (`libellesPortee`). */
  droits: string[];
  sites: string[];
  tousLesSites: boolean;
  /** The spaces whose profile enabled it. */
  espaces: { nom: string; profil: string }[];
  /** Preparation, loading, update errors, and errors of its console. */
  erreurs: string[];
  /** Agent: last reloaded copy (ISO). */
  modifieeLe: string | null;
  /** The message of its deactivation (`DESACTIVEE_PLANTAGES`, `DESACTIVEE_PORTEE`), or null. */
  desactivee: string | null;
  /** Store: the version of an update waiting for the user's grant. */
  majEnAttente: string | null;
  /** Manifest rights and keys that WebAiOs does not support. */
  nonPrisEnCharge: string[];
  epinglee: boolean;
  /** Agent: the user unlocked its console for the agent (in memory, until one of them closes it again). */
  consoleDebloquee: boolean;
  /** Store: the names of the site apps where it is active (the id if the name is missing). */
  applis: string[];
}

/** A row of a site app's « Extensions » menu (Store extensions only; everything is displayed as text there). */
export interface LigneExtensionSite {
  cle: string;
  nom: string;
  /** Enabled for the hash of the app's current domains. */
  active: boolean;
  /** Enabled, but for other domains (`DOMAINES_CHANGES_EXTENSION`): nothing is loaded. */
  domainesChanges: boolean;
  /** `TOUTES_COUPEES_AGENT`, `DESACTIVEE_PLANTAGES`, `DESACTIVEE_PORTEE`: the switch is greyed out; otherwise null. */
  indisponible: string | null;
}

/** A window's bar: the extensions loaded in the profile of its active space. */
export interface ExtensionsBar {
  /** Partition of the profile's session (`partition` attribute of the `<button is="browser-action">`). */
  partition: string;
  /** Id of the tab displayed for the library (its `webContents.id`), or null. */
  onglet: number | null;
  actions: { cle: string; idChrome: string; nom: string; epinglee: boolean }[];
}
