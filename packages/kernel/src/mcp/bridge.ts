import type { DevRight } from "../access/policy.js";
import type { CpuProfile } from "../devtools/summaries.js";
import type { ChangeHost } from "../workflows/pacing.js";
import type { ReadPage } from "../workflows/protocol.js";
import type { Band } from "../search/sessions.js";

/** The options of an invisible page read (see `BrowserBridge.lirePageInvisible`). */
export interface PageReadOptions {
  profile: string | null;
  domains?: string[];
  localAddresses?: boolean;
  signal?: AbortSignal;
  changeHost?: ChangeHost;
  /** Screens to scroll before reading (1 to 20); absent: the page is read without scrolling. */
  scroll?: number;
}

/** Where a link sits on its page, best first for the agent. */
export type Zone = "main" | "other" | "aside" | "header" | "nav" | "footer" | "lang";

/** A link of a page, as the agent sees it. */
export interface PageLink {
  text: string;
  url: string;
  /** Absent: `other`. */
  zone?: Zone;
}

/** A block of visible text of a page, as rendered (invisible text never makes one). */
export interface PageBlock {
  text: string;
  /** Heading level 1-6 (by tag, role or visual weight), 0 for body text. */
  h: number;
  zone: Zone;
  /** Table row index: the cells of one row join on one line. */
  row?: number;
}

/** What a read of a tab gives: the text and links, and what only the browser knows of the page. */
export interface TabRead {
  text: string;
  selection?: string;
  links?: PageLink[];
  blocks?: PageBlock[];
  /** The structured data the page publishes for engines: parsed JSON-LD objects, `{ meta }`, `{ microdata }`. */
  structured?: unknown[];
  /** The reader mode's text of the main content, when it found one. */
  reader?: string;
  /** HTTP response status of the document. */
  status?: number;
  /** The addresses the document went through before this one. */
  redirects?: string[];
  contentType?: string;
  /** Visible password fields. */
  passwords?: number;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  space: string;
  /** Project folder, for an application's window. */
  app?: string;
  /**
   * Id of the site app, for its window (`site:<id>`): `titre` is then the app's name (never the page
   * title), and its read goes through the app's grant (`AccessPolicy.lectureSiteAccordee`), never through the origin.
   */
  site?: string;
  /**
   * Site app: its current domain (that of its start address, followed by the full address), the only one shown without
   * the grant, never the host of the displayed page (which may be a login domain).
   */
  domain?: string;
  /**
   * Site app: the `empreinte` of today's declaration (`empreinteLectureSite`: name, domains, login).
   * The agent's grant is only valid for the `empreinte` shown on its card.
   */
  hash?: string;
}

/** What the browser gives the kernel. */
export interface BrowserBridge {
  activeTab(): Promise<TabInfo | null>;
  listTabs(): Promise<TabInfo[]>;
  /** Throws TabNotFound if the id is unknown (like lireTexte, naviguer and capturer). */
  /**
   * `capture`: also what only the browser knows (blocks, structured data, reader text, status…), which costs the page
   * a reader-mode parse: asked only for a search read, never for a read of the user's tab.
   */
  readText(id: string, o?: { capture?: boolean }): Promise<TabRead>;
  openTab(url: string, space?: string): Promise<TabInfo>;
  /**
   * `"pending"` (site app window only): the tweaks grant card is shown; the address will
   * load after the user's choice.
   */
  navigate(id: string, url: string): Promise<void | "pending">;
  /** PNG capture of the tab. */
  capture(id: string): Promise<Buffer>;
  /** Shows the request to the user; true if they accept. */
  askPermission(o: TabInfo): Promise<boolean>;
  /** Dev tools (absent if the browser does not provide them). */
  devTools?: BrowserDevTools;
  /**
   * Shows the consent card; returns the granted rights (`[]` = denial). `signal` raised: the card no longer has
   * a subject (new conversation, kernel stopped), it is removed and the request answers `[]`.
   */
  askDevTools?(o: TabInfo, d: { rights: DevRight[]; reason: string; agent: string }, signal?: AbortSignal): Promise<DevRight[]>;
  /**
   * Shows the card for an address the agent wrote itself (not a link it read) in the window of the search; true if the
   * user allows it. `signal` raised: the card is removed and the answer is false. Absent: such an address is refused.
   * `opinion`: the watcher's view, shown as one more line when present.
   */
  askAddress?(o: { url: string; reason: string; agent: string; opinion?: string }, window: string | undefined, signal?: AbortSignal): Promise<boolean>;
  /** The tab is in a private space: absent from listerOnglets, the agent has no access to it. */
  isPrivate?(id: string): boolean;
  /** The tab the user is looking at is in a private space (ongletActif then returns null). */
  activePrivateTab?(): boolean;
  /** History and kept text of the pages, made only of non-private visits (absent: no history tools). */
  history?: BrowserHistory;
  /** The user's bookmarks, http(s) only (absent: no bookmark tool). */
  bookmarks?: { find(q: { query: string; limit: number }): Promise<{ url: string; title: string }[]> };
  /**
   * Reads a page in an invisible tab, without clicking or typing. `profile: null`: blank session, without any cookie;
   * otherwise the named login profile. Throws ProfileDenied if this profile is unknown or used by a private space.
   * Absent: no page reading for the widgets.
   *
   * `domaines` (given for any read of a widget that reads with the user's account): allowed host names. The bridge
   * MUST block any navigation of the main frame (redirect, script, meta refresh) to a host outside this
   * list, before the request goes out: otherwise the profile's cookies, or the URL itself, would leak. The kernel also checks
   * `ReadPage.url` on return.
   *
   * The bridge also refuses any navigation of the main frame to a local address (`adresseLocale`), unless
   * `adressesLocales` is true (tests only: the kernel passes it when its own `adressesLocales` option is).
   *
   * `signal` raised (the run that reads is stopped or finished): the read, waiting or in progress, is abandoned, its
   * window closed, and the promise rejected with `signal.reason`.
   *
   * `changerHote` (given for a paced read, that of a `web` widget): before following a navigation of the main
   * frame (redirect, script, meta refresh) to another site (different `sitePacing`), the bridge holds it and
   * waits for `changerHote(host)`, which returns when this site's pacing allows it; rejected, the read fails.
   *
   * `defiler` (1 to 20): after the first calm, the page is scrolled one screen at a time (never a click, keystroke
   * or focus) as long as its height grows, at most `defiler` screens and within the same 30 s; the text read then goes
   * up to 100,000 characters and 1,000 links (20,000 and 400 without scrolling).
   */
  readPageInvisible?(url: string, o: PageReadOptions): Promise<ReadPage>;
  /**
   * The HTML of a public page (`document.documentElement.outerHTML`, 2 MB at most): always the public session,
   * emptied before the read, never a profile or an account. Same guards as `readPageInvisible` (http(s), local address
   * refused unless `adressesLocales`), same 30 s limit, same abandonment through `signal`; `url` is the final
   * address, which must remain allowed.
   */
  readHtmlInvisible?(url: string, o: { localAddresses?: boolean; signal?: AbortSignal }): Promise<{ url: string; html: string }>;
  /**
   * « donnees-widget » card: the agent asks to see the data of a widget that reads with the user's account. True
   * if they accept (for the current conversation). `signal` raised: the card no longer has a subject (new conversation,
   * kernel stopped), it is removed and the request answers false. `genre: "action"`: the results of an action, not of a
   * widget; `genre: "site"`: the pages and memory of a site app (`id` is the app's). Absent: the
   * request is refused.
   */
  askWidgetData?(o: { id: string; name: string; agent: string; kind?: "action" | "site" }, signal?: AbortSignal): Promise<boolean>;
  /**
   * Is the address on the domains of the open site app `site` (never those of its login)? False if its
   * window is not open. Absent: the agent navigates no site app.
   */
  siteUrlAllowed?(site: string, url: string): boolean;
  /** The agent's visible web search (absent: no `search_web` tool). */
  search?: {
    /**
     * Opens the search tab in `window` (the active one if undefined), in its active space, in AGENT_PROFILE, activated.
     * A query goes to the user's engine. Throws in a private space. With `reuse` (the id of the search tab), that tab is
     * navigated instead and nothing opens nor activates.
     */
    open(window: string | undefined, target: { query: string } | { url: string }, reuse?: string): Promise<TabInfo>;
    /** Opens `url` in a background tab of AGENT_PROFILE (`openedByAgent`, not activated), in the window and space of the search tab `searchTabId`. */
    openBackground(searchTabId: string, url: string): Promise<TabInfo>;
    /** Closes a tab opened by `open` or `openBackground`, at once (no « leave this site? » question). */
    close(tabId: string): Promise<void>;
    /** Shows or removes the band of the tab. */
    band(tabId: string, band: Band | null): Promise<void>;
  };
}

export interface MessageConsole {
  timestamp: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  stack?: string;
}

export interface NetworkRequest {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  size?: number;
  type?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  error?: string;
}

/** Result of `run`: the value already serialized (JSON or preview), not truncated; the kernel truncates. */
export type JsResult = { value: string } | { exception: string };

/** What the browser gives to inspect a tab. */
export interface BrowserDevTools {
  /** Throws DevToolsBusy or TabNotFound. */
  attach(id: string): Promise<void>;
  detach(id: string): Promise<void>;
  console(id: string): Promise<MessageConsole[]>;
  network(id: string): Promise<NetworkRequest[]>;
  body(id: string, request: string): Promise<{ body: string; base64: boolean }>;
  profile(
    id: string,
    o: { durationMs?: number; reload?: boolean },
    signal: AbortSignal,
  ): Promise<{ profile: CpuProfile; metrics: Record<string, number> }>;
  /** The raw `.heapsnapshot`. */
  memorySnapshot(id: string, signal: AbortSignal): Promise<string>;
  run(id: string, code: string, signal: AbortSignal): Promise<JsResult>;
  reload(id: string, noCache: boolean): Promise<void>;
  /**
   * Access reserved to a kernel (the browser keeps its tools from one kernel to the next). Creating one revokes the previous:
   * its calls are refused and its attachments drop. `liberer` revokes this one (kernel stopped).
   */
  owner?(): DevToolsOwner;
}

export interface DevToolsOwner extends BrowserDevTools {
  release(): void;
}

export class TabNotFound extends Error {
  constructor(readonly id: string) {
    super(`Onglet introuvable : ${id}`);
    this.name = "TabNotFound";
  }
}

/** A history page found for the agent: one per URL, made only of non-private visits. */
export interface HistoryResult {
  url: string;
  title: string;
  lastVisit: string; // ISO
  visits: number;
  /** About 300 characters of the kept text around the searched words; empty if the page has no text found. */
  excerpt: string;
}

/** A page whose text was kept, as read by the agent. */
export interface KeptPage {
  url: string;
  title: string;
  date: string; // ISO
  text: string;
}

/** What the browser provides to search the history: never a visit from a private space. */
export interface BrowserHistory {
  /** `since` and `until`: ISO dates already checked by the kernel; `limit` between 1 and 50. */
  find(q: { query: string; since?: string; until?: string; limit: number }): Promise<HistoryResult[]>;
  /** The most recent kept text of the page, or null (unknown, or seen only in a private space). */
  read(url: string): Promise<KeptPage | null>;
}

export const PRIVATE_TEXT = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

/** The tab is in a private space: the agent receives PRIVATE_TEXT, with no question asked to the user. */
export class PrivateTab extends Error {
  constructor(readonly id: string) {
    super(PRIVATE_TEXT);
    this.name = "PrivateTab";
  }
}

export class DevToolsBusy extends Error {
  constructor() {
    super("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
    this.name = "DevToolsBusy";
  }
}

/** The tab went to another origin during the read (an engine redirect, a click): nothing read is returned. */
export class SiteChanged extends Error {
  constructor(readonly id: string) {
    super("L'onglet a changé de site pendant la lecture : rien n'est rendu.");
    this.name = "SiteChanged";
  }
}

/** The login profile requested for a read is unknown or used by a private space. */
export class ProfileDenied extends Error {
  constructor(readonly profile: string) {
    super(`Profil de connexion refusé : ${profile}`);
    this.name = "ProfileDenied";
  }
}
