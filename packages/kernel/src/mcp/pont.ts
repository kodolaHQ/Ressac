import type { DroitDev } from "../access/policy.js";
import type { CpuProfile } from "../devtools/summaries.js";
import type { ChangeHost } from "../workflows/pacing.js";
import type { PageLue } from "../workflows/protocole.js";

/** The options of an invisible page read (see `PontNavigateur.lirePageInvisible`). */
export interface OptionsLecturePage {
  profil: string | null;
  domaines?: string[];
  adressesLocales?: boolean;
  signal?: AbortSignal;
  changerHote?: ChangeHost;
  /** Screens to scroll before reading (1 to 20); absent: the page is read without scrolling. */
  defiler?: number;
}

export interface TabInfo {
  id: string;
  titre: string;
  url: string;
  espace: string;
  /** Project folder, for an application's window. */
  application?: string;
  /**
   * Id of the site app, for its window (`site:<id>`): `titre` is then the app's name (never the page
   * title), and its read goes through the app's grant (`PolitiqueAcces.lectureSiteAccordee`), never through the origin.
   */
  site?: string;
  /**
   * Site app: its current domain (that of its start address, followed by the full address), the only one shown without
   * the grant, never the host of the displayed page (which may be a login domain).
   */
  domaine?: string;
  /**
   * Site app: the `empreinte` of today's declaration (`empreinteLectureSite`: name, domains, login).
   * The agent's grant is only valid for the `empreinte` shown on its card.
   */
  empreinte?: string;
}

/** What the browser gives the kernel. */
export interface BrowserBridge {
  ongletActif(): Promise<TabInfo | null>;
  listerOnglets(): Promise<TabInfo[]>;
  /** Throws OngletIntrouvable if the id is unknown (like lireTexte, naviguer and capturer). */
  lireTexte(id: string): Promise<{ texte: string; selection?: string }>;
  ouvrirOnglet(url: string, space?: string): Promise<TabInfo>;
  /**
   * `"en-attente"` (site app window only): the tweaks grant card is shown; the address will
   * load after the user's choice.
   */
  naviguer(id: string, url: string): Promise<void | "en-attente">;
  /** PNG capture of the tab. */
  capturer(id: string): Promise<Buffer>;
  /** Shows the request to the user; true if they accept. */
  demanderAutorisation(o: TabInfo): Promise<boolean>;
  /** Dev tools (absent if the browser does not provide them). */
  outilsDev?: BrowserDevTools;
  /**
   * Shows the consent card; returns the granted rights (`[]` = denial). `signal` raised: the card no longer has
   * a subject (new conversation, kernel stopped), it is removed and the request answers `[]`.
   */
  demanderOutilsDev?(o: TabInfo, d: { droits: DroitDev[]; raison: string; agent: string }, signal?: AbortSignal): Promise<DroitDev[]>;
  /** The tab is in a private space: absent from listerOnglets, the agent has no access to it. */
  estPrive?(id: string): boolean;
  /** The tab the user is looking at is in a private space (ongletActif then returns null). */
  ongletActifPrive?(): boolean;
  /** History and kept text of the pages, made only of non-private visits (absent: no history tools). */
  historique?: BrowserHistory;
  /**
   * Reads a page in an invisible tab, without clicking or typing. `profil: null`: blank session, without any cookie;
   * otherwise the named login profile. Throws ProfilRefuse if this profile is unknown or used by a private space.
   * Absent: no page reading for the widgets.
   *
   * `domaines` (given for any read of a widget that reads with the user's account): allowed host names. The bridge
   * MUST block any navigation of the main frame (redirect, script, meta refresh) to a host outside this
   * list, before the request goes out: otherwise the profile's cookies, or the URL itself, would leak. The kernel also checks
   * `PageLue.url` on return.
   *
   * The bridge also refuses any navigation of the main frame to a local address (`adresseLocale`), unless
   * `adressesLocales` is true (tests only: the kernel passes it when its own `adressesLocales` option is).
   *
   * `signal` raised (the run that reads is stopped or finished): the read, waiting or in progress, is abandoned, its
   * window closed, and the promise rejected with `signal.reason`.
   *
   * `changerHote` (given for a paced read, that of a `web` widget): before following a navigation of the main
   * frame (redirect, script, meta refresh) to another site (different `siteMenage`), the bridge holds it and
   * waits for `changerHote(host)`, which returns when this site's pacing allows it; rejected, the read fails.
   *
   * `defiler` (1 to 20): after the first calm, the page is scrolled one screen at a time (never a click, keystroke
   * or focus) as long as its height grows, at most `defiler` screens and within the same 30 s; the text read then goes
   * up to 100,000 characters and 1,000 links (20,000 and 400 without scrolling).
   */
  lirePageInvisible?(url: string, o: OptionsLecturePage): Promise<PageLue>;
  /**
   * The HTML of a public page (`document.documentElement.outerHTML`, 2 MB at most): always the public session,
   * emptied before the read, never a profile or an account. Same guards as `lirePageInvisible` (http(s), local address
   * refused unless `adressesLocales`), same 30 s limit, same abandonment through `signal`; `url` is the final
   * address, which must remain allowed.
   */
  lireHtmlInvisible?(url: string, o: { adressesLocales?: boolean; signal?: AbortSignal }): Promise<{ url: string; html: string }>;
  /**
   * « donnees-widget » card: the agent asks to see the data of a widget that reads with the user's account. True
   * if they accept (for the current conversation). `signal` raised: the card no longer has a subject (new conversation,
   * kernel stopped), it is removed and the request answers false. `genre: "action"`: the results of an action, not of a
   * widget; `genre: "site"`: the pages and memory of a site app (`id` is the app's). Absent: the
   * request is refused.
   */
  demanderDonneesWidget?(o: { id: string; nom: string; agent: string; genre?: "action" | "site" }, signal?: AbortSignal): Promise<boolean>;
  /**
   * Is the address on the domains of the open site app `site` (never those of its login)? False if its
   * window is not open. Absent: the agent navigates no site app.
   */
  adresseSitePermise?(site: string, url: string): boolean;
}

export interface MessageConsole {
  horodatage: number;
  niveau: "log" | "info" | "warn" | "error" | "debug";
  texte: string;
  pile?: string;
}

export interface NetworkRequest {
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

/** Result of `executer`: the value already serialized (JSON or preview), not truncated; the kernel truncates. */
export type JsResult = { valeur: string } | { exception: string };

/** What the browser gives to inspect a tab. */
export interface BrowserDevTools {
  /** Throws OutilsDevOccupes or OngletIntrouvable. */
  attacher(id: string): Promise<void>;
  detacher(id: string): Promise<void>;
  console(id: string): Promise<MessageConsole[]>;
  reseau(id: string): Promise<NetworkRequest[]>;
  corps(id: string, request: string): Promise<{ corps: string; base64: boolean }>;
  profiler(
    id: string,
    o: { dureeMs?: number; recharger?: boolean },
    signal: AbortSignal,
  ): Promise<{ profil: CpuProfile; metriques: Record<string, number> }>;
  /** The raw `.heapsnapshot`. */
  instantaneMemoire(id: string, signal: AbortSignal): Promise<string>;
  executer(id: string, code: string, signal: AbortSignal): Promise<JsResult>;
  recharger(id: string, sansCache: boolean): Promise<void>;
  /**
   * Access reserved to a kernel (the browser keeps its tools from one kernel to the next). Creating one revokes the previous:
   * its calls are refused and its attachments drop. `liberer` revokes this one (kernel stopped).
   */
  proprietaire?(): DevToolsOwner;
}

export interface DevToolsOwner extends BrowserDevTools {
  liberer(): void;
}

export class TabNotFound extends Error {
  constructor(readonly id: string) {
    super(`Onglet introuvable : ${id}`);
    this.name = "OngletIntrouvable";
  }
}

/** A history page found for the agent: one per URL, made only of non-private visits. */
export interface HistoryResult {
  url: string;
  titre: string;
  derniereVisite: string; // ISO
  visites: number;
  /** About 300 characters of the kept text around the searched words; empty if the page has no text found. */
  extrait: string;
}

/** A page whose text was kept, as read by the agent. */
export interface KeptPage {
  url: string;
  titre: string;
  date: string; // ISO
  texte: string;
}

/** What the browser provides to search the history: never a visit from a private space. */
export interface BrowserHistory {
  /** `depuis` and `jusqua`: ISO dates already checked by the kernel; `limite` between 1 and 50. */
  chercher(q: { requete: string; depuis?: string; jusqua?: string; limite: number }): Promise<HistoryResult[]>;
  /** The most recent kept text of the page, or null (unknown, or seen only in a private space). */
  lire(url: string): Promise<KeptPage | null>;
}

export const PRIVATE_TEXT = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

/** The tab is in a private space: the agent receives TEXTE_PRIVE, with no question asked to the user. */
export class PrivateTab extends Error {
  constructor(readonly id: string) {
    super(PRIVATE_TEXT);
    this.name = "OngletPrive";
  }
}

export class DevToolsBusy extends Error {
  constructor() {
    super("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
    this.name = "OutilsDevOccupes";
  }
}

/** The login profile requested for a read is unknown or used by a private space. */
export class ProfileDenied extends Error {
  constructor(readonly profil: string) {
    super(`Profil de connexion refusé : ${profil}`);
    this.name = "ProfilRefuse";
  }
}
