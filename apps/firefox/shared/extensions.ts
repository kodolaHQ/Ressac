import type { SourceExtension } from "@ressac/kernel";

/** A row of the « Extensions » section of a space's settings (everything is displayed as text there). */
export interface SpaceExtensionLine {
  key: string;
  name: string;
  source: "store" | "agent";
  /** Active in this space's profile. */
  active: boolean;
  /** If active: the names of the other spaces of the same profile, where it also runs. */
  alsoIn: string[];
  /** Non null: the switch is disabled, and this sentence says why. */
  greyedOut: string | null;
  /** The profiles where it is active (to warn about what a private space changes). */
  profiles: string[];
}

/** What an extension's grant card shows (ExtensionRequest.svelte): everything is displayed as text there. */
export interface ExtensionCard {
  key: string;
  name: string;
  source: SourceExtension;
  version: string;
  /** Labels of the scope (`scopeLabels`), in their order. */
  rights: string[];
  sites: string[];
  allSites: boolean;
  /** Agent: domains it can send to (`[]`: nowhere); Store: null. */
  network: string[] | null;
  /** Hardened grant: a checkbox before « Activer ». */
  hardened: boolean;
  /** Name of the space where it is enabled. */
  space: string;
  /** Its id: the card drops if the space disappears (or, for the agent, if its profile becomes private). */
  spaceId: string;
  /** The other spaces of the same profile, where it will be active too. */
  otherSpaces: string[];
  /**
   * Agent: the spaces (of other profiles) where it already runs with a narrower grant; the new, wider version
   * will replace them too (« La nouvelle version remplacera aussi celle de … »).
   */
  alsoReplaces: string[];
  /** Update: the installed version. */
  update: { from: string } | null;
  /** `scopeHash` of the shown scope: the caller writes the grant only for a scope with the same hash. */
  hash: string;
}

/** The card's answer. */
export interface GrantResponse {
  accepted: boolean;
  /** The card dropped (or was not shown) without an answer from the user. */
  removed?: boolean;
}

/** A row of the Extensions page (everything is displayed as text there: it is data coming from a manifest or a console). */
export interface ExtensionLine {
  key: string;
  name: string;
  source: SourceExtension;
  version: string;
  /** Labels of the granted scope (`scopeLabels`). */
  rights: string[];
  sites: string[];
  allSites: boolean;
  /** The spaces whose profile enabled it. */
  spaces: { name: string; profile: string }[];
  /** Preparation, loading, update errors, and errors of its console. */
  errors: string[];
  /** Agent: last reloaded copy (ISO). */
  modifiedAt: string | null;
  /** The message of its deactivation (`DISABLED_CRASHES`, `DISABLED_SCOPE`), or null. */
  disabled: string | null;
  /** Store: the version of an update waiting for the user's grant. */
  pendingUpdate: string | null;
  /** Manifest rights and keys that Ressac does not support. */
  unsupported: string[];
  pinned: boolean;
  /** Agent: the user unlocked its console for the agent (in memory, until one of them closes it again). */
  consoleUnlocked: boolean;
  /** Store: the names of the site apps where it is active (the id if the name is missing). */
  siteApps: string[];
}

/** A row of a site app's « Extensions » menu (Store extensions only; everything is displayed as text there). */
export interface SiteExtensionLine {
  key: string;
  name: string;
  /** Enabled for the hash of the app's current domains. */
  active: boolean;
  /** Enabled, but for other domains (`DOMAINES_CHANGES_EXTENSION`): nothing is loaded. */
  domainsChanged: boolean;
  /** `ALL_CUT_AGENT`, `DISABLED_CRASHES`, `DISABLED_SCOPE`: the switch is greyed out; otherwise null. */
  unavailable: string | null;
}

/** A window's bar: the extensions loaded in the profile of its active space. */
export interface ExtensionsBar {
  /** Partition of the profile's session (`partition` attribute of the `<button is="browser-action">`). */
  partition: string;
  /** Id of the tab displayed for the library (its `webContents.id`), or null. */
  tab: number | null;
  actions: { key: string; addonId: string; name: string; pinned: boolean }[];
}
