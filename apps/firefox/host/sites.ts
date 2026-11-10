import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import fs, { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import {
  grantCovers,
  relativeUrl,
  urlOnDomain,
  grantNeeded,
  storeSiteGrant,
  startUrl,
  effectiveDomains,
  rightsOf,
  siteReadHash,
  ID_SITE,
  readSiteGrants,
  readUrlState,
  readTweaks,
  readSite,
  readSites,
  SiteMemory,
  deleteSiteData,
  watchSites,
  type SpacePaths,
  type DeclarationSite,
  type SiteRights,
  type SitesTools,
  type TweaksRead,
  type SiteRead,
} from "../../../packages/kernel/src/index.ts";
import { urlChanged, urlUnchanged, urlNotFound, ICON_MAX, editWithAgent, type ActionSite, type BarNotice, type SiteGrantRequest, type MessageToHome, type ShownSite } from "../shared/sites.ts";
import type { FrameBounds } from "../shared/model.ts";
import type { TweakError, MemoryResponse, OpenableSite } from "../core/sites/injection.ts";
import { UrlTracking } from "../core/sites/tracking.ts";
import { openDecision } from "../core/sites/navigation.ts";
import { createPositions, memoryOp } from "./site-memory.ts";

// The site apps service on the host side.

/** The app as the chrome gets it: what opens, its grant card, and its hash (list_tabs). */
export type SiteChrome = OpenableSite & { request: SiteGrantRequest; hash: string };

const uniques = (l: string[]) => [...new Set(l)];

/** The hash of the rights the declaration asks for. */
export function rightsHash(d: DeclarationSite): string {
  return createHash("sha256").update(JSON.stringify(rightsOf(d))).digest("hex");
}

/** What the grant card shows. */
export function grantRequest(s: OpenableSite): SiteGrantRequest {
  const d = s.declaration;
  const declares = new Set(d.domains.map((x) => x.toLowerCase()));
  return {
    name: d.name,
    domains: [...d.domains],
    login: [...d.login],
    frames: uniques(d.tweaks.flatMap((r) => (r.frames === false ? [] : r.frames))),
    resume: d.resume,
    files: uniques(d.tweaks.flatMap((r) => [...r.js, ...r.css])),
    matches: uniques(d.tweaks.flatMap((r) => r.matches)),
    tracked: uniques(s.domains.map((x) => x.toLowerCase()).filter((x) => !declares.has(x))),
    hash: rightsHash(d),
  };
}

/** Requests host -> chrome: the window itself lives in the chrome. */
export interface SitesChrome {
  open(s: SiteChrome, frame: FrameBounds | null, tweaks: TweaksRead): Promise<boolean>;
  close(id: string): Promise<void>;
  erase(id: string): Promise<void>;
  /** True if the page was reloaded. */
  update(s: SiteChrome, tweaks: TweaksRead): Promise<boolean>;
  reloadView(id: string): Promise<void>;
  /** The tweaks' console of the open app. */
  errors(id: string): Promise<TweakError[]>;
  /** The view the window shows, or null if it is not open. */
  view(id: string): Promise<"home" | "grant" | "site" | null>;
  /** The choice made on the card: `s` null for « Ouvrir sans retouches ». */
  afterGrant(id: string, s: SiteChrome | null): Promise<void>;
  /** The state broadcast again (the card up to date). */
  rebroadcast(id: string): Promise<void>;
  openSites(): Promise<string[]>;
  homeChange(id: string): void;
  /** A reading of the reference page starts or ends: the bar's button shows it. */
  search(id: string, yes: boolean): void;
  /** The bar's mention. */
  notice(id: string, a: BarNotice | null): void;
  /** The follow found the new address: the open app takes its domains and start address, and the view goes to `vers`. */
  urlChanged(id: string, domains: string[], start: string, to: string): void;
}

export interface SitesHost {
  list(): Promise<ShownSite[]>;
  agentList(): Promise<(ShownSite & { hash?: string })[]>;
  openById(id: string): Promise<boolean>;
  dispatch(id: string, action: ActionSite, win: string): Promise<void>;
  homeMemory(id: string): Promise<(MessageToHome & { type: "memory" }) | null>;
  note(id: string, x: { frame?: FrameBounds; favicon?: string }): void;
  closed(id: string): void;
  /** « Autoriser » / « Ouvrir sans retouches » on the card. */
  grant(id: string, yes: boolean, hash: string): Promise<void>;
  /** `webaiosSite` of an open app's main page; the chrome checked the sender, the grant and the address. */
  memoryOp(request: unknown): Promise<MemoryResponse>;
  /** A video position of an open app's page (`sites.position`), and the position to resume (`sites.resume`); the chrome checked the frame. */
  position(request: unknown): Promise<void>;
  resume(request: unknown): Promise<number | null>;
  /** « Chercher la nouvelle adresse », or a site that does not answer (`url`: the page aimed at, else the start address). */
  lookupAddress(id: string, url: string | null): Promise<void>;
  /** The open apps as last sent to the chrome. */
  openSites: Map<string, SiteChrome>;
  /** Is the address on the open app's domains? (a navigation the agent asks for) */
  urlAllowed(id: string, url: string): boolean;
  tools: SitesTools;
  resync(): Promise<void>;
  stop(): Promise<void>;
}

export interface SiteRecord {
  frame?: FrameBounds;
  lastLaunch?: string;
  favicon?: string;
}

/**
 * File `sites.json`, written 500 ms after a change: what the browser keeps
 * of each site app (window frame, favicon).
 */
export class SiteRecords {
  private data: Record<string, SiteRecord> = Object.create(null);
  private timer: NodeJS.Timeout | undefined;
  private modified = false;
  /** Chained writes, never simultaneous. */
  private writing: Promise<void> = Promise.resolve();
  private number = 0;

  constructor(
    private readonly folder: string,
    private readonly delayMs = 500,
    private readonly file = "sites.json",
  ) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(folder, file), "utf8"));
      // Without a prototype: an app name « __proto__ » or « constructor » stays a plain key.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = Object.assign(Object.create(null), parsed) as Record<string, SiteRecord>;
    } catch {
      // Absent or unreadable: start from zero (nothing essential is kept there).
    }
  }

  read(folder: string): SiteRecord {
    return this.data[folder] ?? {};
  }

  /** App deleted: nothing is kept of it anymore. */
  forget(folder: string): void {
    if (!(folder in this.data)) return;
    delete this.data[folder];
    this.modified = true;
    this.timer ??= setTimeout(() => void this.clear(), this.delayMs);
  }

  note(folder: string, s: SiteRecord): void {
    this.data[folder] = { ...this.data[folder], ...s };
    this.modified = true;
    this.timer ??= setTimeout(() => void this.clear(), this.delayMs);
  }

  /** Writes what changed; always waits for the end of the writes in progress. */
  clear(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.modified) {
      this.modified = false;
      const text = JSON.stringify(this.data, null, 2);
      this.writing = this.writing.then(() => this.write(text)).catch((e) => console.error("[applications] mémoire non écrite :", e));
    }
    return this.writing;
  }

  private async write(text: string): Promise<void> {
    const target = join(this.folder, this.file);
    const temp = `${target}.${process.pid}.${++this.number}.tmp`;
    await fs.mkdir(this.folder, { recursive: true });
    await fs.writeFile(temp, text);
    await fs.rename(temp, target);
  }
}

/** The host of an address, or null. */
function host(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" };

/**
 * The icon declared by the app (`icone`, relative path to an image), as `data:`; null if it is missing, leaves the folder
 * (link, `..`), is a link, a pipe or exceeds `ICONE_MAX`.
 */
export async function readIcon(folder: string, path: string): Promise<string | null> {
  const type = ICON_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    const file = join(folder, path);
    // An ordinary file, not a link nor a named pipe: lstat before any open.
    if (!(await lstat(file)).isFile()) return null;
    // No folder of the path is a link that leaves the app's folder.
    const root = await realpath(folder);
    if (!(await realpath(file)).startsWith(root + sep)) return null;
    // Without following a link that became one since the lstat, and without waiting for a pipe.
    const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await f.stat();
      if (!st.isFile() || st.size > ICON_MAX) return null;
      const buffer = Buffer.alloc(st.size);
      const { bytesRead } = await f.read(buffer, 0, st.size, 0);
      return `data:${type};base64,${buffer.subarray(0, bytesRead).toString("base64")}`;
    } finally {
      await f.close();
    }
  } catch {
    return null;
  }
}

export function createSites(o: {
  paths: SpacePaths;
  /** The profile folder: `sites/<id>/` (memory, address), `sites.json`, `site-grants.json`. */
  dataDir: string;
  localAddresses: boolean;
  chrome: SitesChrome;
  /** The links of a reference page, read without the profile or any cookie (the bridge's public invisible read). */
  readLinks(page: string, signal?: AbortSignal): Promise<string[]>;
  /** The list or the state of the site apps changed (`sites.change`). */
  broadcast(): void;
  prefill(win: string, text: string): void;
  /** A home screen memory change (`sites.memory`), for the subscribed window. */
  notifyMemory(id: string, message: MessageToHome & { type: "memory" }): void;
  /** The app's window closed. */
  onClosed?(id: string): void;
  /** « Supprimer » begins: the agent's grant on the app falls. */
  onDeleted?(id: string): void;
  /** The deletion `surSupprimee` began is over (folder in the trash, or failed): a review snapshot taken meanwhile is erased. */
  afterDelete?(id: string): void;
}): SitesHost {
  const sitesFolder = join(o.dataDir, "sites");
  const siteRecords = new SiteRecords(o.dataDir);
  const memories = new Map<string, Promise<SiteMemory>>();
  const reading = { localAddresses: o.localAddresses };
  /** Windows open in the chrome: kept by `open`/`fermee`, recomputed by `resynchroniser`. */
  let opened = new Set<string>();
  /** The open apps as last sent to the chrome, and their tweaks' files. */
  const openSites = new Map<string, SiteChrome>();
  const tweaks = new Map<string, TweaksRead>();
  const subscriptions = new Map<string, () => void>();
  /** Address follow: the reading under way, the last notice, and the changes made (a reading begun before one is redone). */
  const searches = new Map<string, AbortController>();
  const lastNotices = new Map<string, BarNotice>();
  const changes = new Map<string, number>();
  const tracking = new UrlTracking({ readLinks: o.readLinks, sitesFolder: sitesFolder, localAddresses: o.localAddresses, now: () => Date.now() });
  const reviews = new Map<string, number>();
  /** Deletions in progress: a second request for the same app does nothing. */
  const deletions = new Set<string>();
  /** Deletions started per app: an opening started before one of them does not go to the end. */
  const startedDeletions = new Map<string, number>();
  /** Ids shown by the last `liste()`: a stale row (folder renamed since) still acts on what it showed. */
  let shownItems = new Set<string>();
  /** Last failed action per app (« Supprimer » without trash…), shown as text on its row. */
  const actionErrors = new Map<string, string>();

  // Checked again here, like memoireOp: only an open app whose tweaks are granted has positions.
  const granted = (id: string) => openSites.get(id)?.grantRequired === false;
  const positions = createPositions({ memory: (id) => (granted(id) ? memory(id) : Promise.reject(new Error("pas d'accord"))), granted: granted });

  const clearMemory = (id: string) =>
    memories
      .get(id)
      ?.then((m) => m.clear())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /**
   * The app as it opens and its tweak files, or null (absent, invalid site.json, folder whose name
   * is not exactly `id`, or `encore()` that became false after one of the reads).
   */
  async function prepare(id: string, still: () => boolean = () => true): Promise<{ site: SiteChrome; tweaks: TweaksRead } | null> {
    if (!ID_SITE.test(id)) return null;
    // A case-insensitive disk would find « MonSite » for « monsite »: only the exact name counts.
    const names = await readdir(o.paths.sites).catch(() => [] as string[]);
    if (!still() || !names.includes(id)) return null;
    const parsed = await readSite(o.paths, id, reading);
    if (!still() || !parsed || "error" in parsed) return null;
    const d = parsed.declaration;
    const state = await readUrlState(sitesFolder, id);
    if (!still()) return null;
    let grant: SiteRights | null = null;
    try {
      const grants = await readSiteGrants(o.dataDir);
      grant = Object.hasOwn(grants, id) ? (grants[id] ?? null) : null;
    } catch (e) {
      // Unreadable grants: the grant is asked again (nothing is injected without it).
      console.error("[sites] accords illisibles :", e);
    }
    if (!still()) return null;
    const files = await tweakFiles(parsed);
    if (!still()) return null;
    const site: OpenableSite = {
      id,
      declaration: d,
      hasHome: parsed.hasHome,
      domains: effectiveDomains(d, state),
      start: startUrl(d, state),
      grantRequired: grantNeeded(d) && !grantCovers(grant, d),
    };
    return { site: { ...site, request: grantRequest(site), hash: siteReadHash(d) }, tweaks: files };
  }

  /** The tweak files; none if one of them is missing or exceeds the bounds (the error is written). */
  async function tweakFiles(parsed: Extract<SiteRead, { declaration: unknown }>): Promise<TweaksRead> {
    if (parsed.declaration.tweaks.length === 0) return { js: {}, css: {} };
    const r = await readTweaks(parsed).catch((e: unknown) => ({ error: String(e) }));
    if (!("error" in r)) return r;
    console.warn(`[sites] ${parsed.id} : retouches non injectées : ${r.error}`);
    return { js: {}, css: {} };
  }

  /** The reference page says where the site is now; a notice says the result. */
  async function searchUrl(id: string, url: string | null): Promise<void> {
    const s = opened.has(id) ? openSites.get(id) : undefined;
    const d = s?.declaration;
    if (!s || !d?.urlTracking || deletions.has(id)) return;
    // A reading is already under way: the follow answers « trop-tot » without doubling it.
    const running = searches.has(id);
    const control = new AbortController();
    if (!running) {
      searches.set(id, control);
      o.chrome.search(id, true);
    }
    const r = await tracking.find(id, d, control.signal).catch((): { t: "not-found" } => ({ t: "not-found" }));
    if (!running) {
      if (searches.get(id) === control) searches.delete(id);
      if (!control.signal.aborted) o.chrome.search(id, false);
    }
    // Window closed (or app deleted) during the reading: what comes after is ignored.
    const current = opened.has(id) ? openSites.get(id) : undefined;
    if (control.signal.aborted || !current) return;
    const notify = (a: BarNotice) => {
      lastNotices.set(id, a);
      o.chrome.notice(id, a);
    };
    switch (r.t) {
      case "too-soon": {
        const last = lastNotices.get(id);
        if (last) o.chrome.notice(id, last);
        return;
      }
      case "not-found":
        return notify({ kind: "not-found", text: urlNotFound(host(d.urlTracking.page) ?? d.urlTracking.page) });
      case "unchanged":
        return notify({ kind: "unchanged", text: urlUnchanged(d.name) });
      case "change": {
        // Today's declaration (site.json may have been read again during the reading).
        const decl = current.declaration;
        const domains = effectiveDomains(decl, r.state);
        const start = startUrl(decl, r.state);
        // The same page on the new domain, else the start address.
        const relative = url ? relativeUrl(url, domains) : null;
        const to = (relative && urlOnDomain(relative, r.domain, domains, start, reading)) || start;
        changes.set(id, (changes.get(id) ?? 0) + 1);
        const site = { ...current, domains: domains, start: start };
        openSites.set(id, { ...site, request: grantRequest(site) });
        o.chrome.urlChanged(id, domains, start, to);
        notify({ kind: "url-changed", text: urlChanged(d.name, r.domain) });
        // The home shows the new domain.
        if (subscriptions.has(id)) void memory(id).then((m) => memoryMessage(id, m)).then((msg) => o.notifyMemory(id, msg), () => {});
      }
    }
  }

  /**
   * site.json or a tweak file changed: the open app is read again, then its page reloaded; only the last read counts.
   */
  async function reread(id: string): Promise<void> {
    if (!opened.has(id)) return;
    const n = (reviews.get(id) ?? 0) + 1;
    reviews.set(id, n);
    const changesBefore = changes.get(id) ?? 0;
    const p = await prepare(id).catch((e: unknown) => {
      console.error(`[sites] ${id} illisible :`, e);
      return null;
    });
    const before = openSites.get(id);
    if (reviews.get(id) !== n || !opened.has(id) || !before) return;
    // The site changed address during the reading: its domains would be the old ones, read again.
    if ((changes.get(id) ?? 0) !== changesBefore) return reread(id);
    // Became invalid: nothing is injected anymore (the window keeps what it had, without tweaks).
    const fresh = p ? p.tweaks : { js: {}, css: {} };
    // Nothing changed for the page (folder copied over, duplicate event): it is not reloaded.
    const same =
      JSON.stringify(fresh) === JSON.stringify(tweaks.get(id) ?? null) &&
      (!p || JSON.stringify({ ...p.site, hasHome: null }) === JSON.stringify({ ...before, hasHome: null }));
    tweaks.set(id, fresh);
    if (p) openSites.set(id, p.site);
    try {
      // The chrome holds its own copy of the tweaks map, so it gets the new one even
      // when site.json became invalid (with the app as it was). The card that comes back already reloads the page.
      const reloaded = await o.chrome.update(p?.site ?? before, fresh);
      if (reviews.get(id) === n && !same && !reloaded) await o.chrome.reloadView(id);
    } catch (e) {
      console.error(`[sites] ${id} non mise à jour :`, e);
    }
  }

  let stopWatching: () => Promise<void> = async () => {};
  try {
    stopWatching = watchSites(o.paths, (id, what) => {
      // The « Sites » section of the Applications page re-reads the list (app written, changed or removed by the agent).
      if (what === "declaration") o.broadcast();
      if (what === "home") {
        if (opened.has(id)) o.chrome.homeChange(id);
      } else void reread(id);
    });
  } catch (e) {
    console.error("[sites] surveillance non démarrée :", e);
  }

  function memory(id: string): Promise<SiteMemory> {
    // During a deletion, the memory is neither reopened nor written (memory.json does not come back).
    if (deletions.has(id)) return Promise.reject(new Error(`appli de site en cours de suppression : ${id}`));
    let m = memories.get(id);
    if (!m) {
      m = SiteMemory.open(sitesFolder, id);
      memories.set(id, m);
      // A refused id does not stay in the cache.
      m.catch(() => memories.delete(id));
    }
    return m;
  }

  /** The app's current domain (that of its start address). */
  async function currentDomain(id: string): Promise<string> {
    const parsed = await readSite(o.paths, id, reading).catch(() => null);
    if (!parsed || "error" in parsed) return "";
    return host(startUrl(parsed.declaration, await readUrlState(sitesFolder, id))) ?? "";
  }

  const memoryMessage = async (id: string, m: SiteMemory): Promise<MessageToHome & { type: "memory" }> => {
    const { values: values, positions } = m.content();
    return { type: "memory", values: values, positions, domain: await currentDomain(id) };
  };

  /** The app's folder exists, and it is a real folder (never a link). */
  async function realFolder(id: string): Promise<boolean> {
    try {
      return (await lstat(join(o.paths.sites, id))).isDirectory();
    } catch {
      return false;
    }
  }

  /** Is the app one of those the section shows: its folder exists, or did the last list show it? */
  async function known(id: string): Promise<boolean> {
    return (await realFolder(id)) || shownItems.has(id) || opened.has(id);
  }

  /**
   * « Oublier ce que l'appli a retenu »: the memory is erased (memory.json deleted; the open home receives an
   * empty memory). Without an open window, the memory is not kept.
   */
  async function forgetSite(id: string): Promise<void> {
    if (!(await known(id))) return;
    positions.cancelNotes(id);
    const m = await memory(id);
    await m.erase();
    if (!opened.has(id)) memories.delete(id);
  }

  /**
   * « Supprimer »: window closed (view destroyed) before its session is erased, then memory, address and grant
   * forgotten, finally the folder to the trash. A folder gone since the row was displayed: the data is erased
   * anyway. A failure of the trash is shown on the row.
   */
  async function remove(id: string): Promise<void> {
    if (deletions.has(id)) return;
    deletions.add(id);
    startedDeletions.set(id, (startedDeletions.get(id) ?? 0) + 1);
    let started = false;
    try {
      if (!(await known(id))) return;
      started = true;
      o.onDeleted?.(id);
      positions.cancelNotes(id);
      searches.get(id)?.abort();
      await o.chrome.close(id);
      opened.delete(id);
      forget(id);
      await o.chrome.erase(id);
      const m = memories.get(id);
      if (m) await m.then((x) => x.erase(), () => {});
      memories.delete(id);
      tracking.forget(id);
      await deleteSiteData(o.dataDir, id);
      siteRecords.forget(id);
      if (!(await realFolder(id))) return;
      try {
        const trash = join(o.paths.sites, ".trash");
        await mkdir(trash, { recursive: true });
        await rename(join(o.paths.sites, id), join(trash, `${id}-${Date.now()}`));
      } catch (e) {
        console.error(`[sites] ${id} : dossier non mis à la corbeille :`, e);
        actionErrors.set(id, "Dossier non mis à la corbeille : la connexion et la mémoire sont effacées, le dossier reste.");
      }
    } finally {
      deletions.delete(id);
      if (started) o.afterDelete?.(id);
      o.broadcast();
    }
  }

  async function openById(id: string): Promise<boolean> {
    // A deletion started during one of the reads (even finished since): nothing opens.
    const startedList = startedDeletions.get(id) ?? 0;
    const still = () => !deletions.has(id) && (startedDeletions.get(id) ?? 0) === startedList;
    if (!still()) return false;
    const p = await prepare(id, still);
    if (!p || !still()) return false;
    reviews.set(id, (reviews.get(id) ?? 0) + 1);
    // Before the window: its first page already asks for its tweaks.
    openSites.set(id, p.site);
    tweaks.set(id, p.tweaks);
    if (!(await o.chrome.open(p.site, siteRecords.read(id).frame ?? null, p.tweaks))) {
      if (!opened.has(id)) forget(id);
      return false;
    }
    // A deletion started while the chrome opened the window: close it again.
    if (!still()) {
      await o.chrome.close(id).catch(() => {});
      return false;
    }
    opened.add(id);
    o.broadcast();
    return true;
  }

  /** The rows of the « Sites » section, and the hash of each valid declaration (for the agent only). */
  async function lines(): Promise<(ShownSite & { hash?: string })[]> {
    const sites = await readSites(o.paths, reading);
    shownItems = new Set(sites.map((s) => s.id));
    return Promise.all(
      sites.map(async (s): Promise<ShownSite & { hash?: string }> => {
        const favicon = siteRecords.read(s.id).favicon ?? null;
        const actionError = actionErrors.get(s.id);
        // An id refused by ID_SITE (« MonSite ») can receive no action: the schema would reject them all.
        if ("error" in s)
          return { id: s.id, name: s.id, description: "", domain: null, icon: favicon, open: opened.has(s.id), error: s.error, ...(ID_SITE.test(s.id) ? {} : { noActions: true as const }), ...(actionError ? { actionError: actionError } : {}) };
        const state = ID_SITE.test(s.id) ? await readUrlState(sitesFolder, s.id) : null;
        const declared = s.declaration.icon ? await readIcon(s.folder, s.declaration.icon) : null;
        return {
          id: s.id,
          name: s.declaration.name,
          description: s.declaration.description,
          domain: host(startUrl(s.declaration, state)),
          icon: declared ?? favicon,
          open: opened.has(s.id),
          ...(actionError ? { actionError: actionError } : {}),
          hash: siteReadHash(s.declaration),
        };
      }),
    );
  }

  const subscribe = (id: string, m: SiteMemory) => {
    if (!subscriptions.has(id)) subscriptions.set(id, m.onChange(() => void memoryMessage(id, m).then((msg) => o.notifyMemory(id, msg), () => {})));
  };

  const list = async () => (await lines()).map(({ hash: _, ...l }) => l);

  function forget(id: string): void {
    openSites.delete(id);
    tweaks.delete(id);
  }

  return {
    list: list,
    agentList: lines,
    openById: openById,
    async dispatch(id, a, win) {
      if (!ID_SITE.test(id)) return;
      actionErrors.delete(id);
      switch (a) {
        case "open":
          if (!(await openById(id))) console.warn(`[sites] ${id} ne peut pas s'ouvrir`);
          return;
        case "edit":
          o.prefill(win, editWithAgent(id));
          return;
        case "forget":
          return forgetSite(id);
        case "delete":
          return remove(id);
        // "folder" and "review" are the UI's: no host work here.
        case "folder":
        case "review":
          return;
      }
    },
    async homeMemory(id) {
      try {
        const m = await memory(id);
        // Subscribed once per open window (unsubscribed at its close); a window already closed is not.
        if (opened.has(id)) subscribe(id, m);
        return await memoryMessage(id, m);
      } catch (e) {
        console.error(`[sites] mémoire de ${id} indisponible :`, e);
        return null;
      }
    },
    note(id, x) {
      // Nothing is kept for an app being deleted (frame, favicon): souvenirs.oublier passes after.
      if (deletions.has(id)) return;
      siteRecords.note(id, x);
      if (x.favicon !== undefined) o.broadcast();
    },
    closed(id) {
      positions.closed(id);
      opened.delete(id);
      forget(id);
      subscriptions.get(id)?.();
      subscriptions.delete(id);
      reviews.delete(id);
      searches.get(id)?.abort();
      searches.delete(id);
      lastNotices.delete(id);
      void clearMemory(id);
      o.broadcast();
      o.onClosed?.(id);
    },
    tools: {
      list: async () =>
        (await lines()).map((s) => ({
          id: s.id, name: s.name, domain: s.domain, open: s.open, ...(s.error !== undefined ? { error: s.error } : {}),
          ...(s.hash !== undefined ? { hash: s.hash } : {}),
        })),
      open: openById,
      memory: async (id) => {
        if (!(await list()).some((s) => s.id === id)) return null;
        return (await memory(id)).content();
      },
      errors: async (id) => {
        if (!(await list()).some((s) => s.id === id)) return null;
        return opened.has(id) ? o.chrome.errors(id).catch(() => []) : [];
      },
    },
    lookupAddress: searchUrl,
    openSites: openSites,
    urlAllowed(id, url) {
      const s = opened.has(id) ? openSites.get(id) : undefined;
      return !!s && openDecision(url, { domains: s.domains, login: s.declaration.login ?? [], localAddresses: o.localAddresses }) === "dans-l-appli";
    },
    async grant(id, yes, hash) {
      // Taken before any wait: site.json may grow between the card and the click.
      const shown = openSites.get(id);
      if (!shown || deletions.has(id) || (await o.chrome.view(id)) !== "grant") return;
      if (!yes) return o.chrome.afterGrant(id, null);
      // Granted only if its rights are the clicked card's (the agent picks its moment).
      const d = shown.declaration;
      if (rightsHash(d) !== hash) return o.chrome.rebroadcast(id);
      // A reading already under way read the grant from before: it is dropped (and redone once the grant is written).
      reviews.set(id, (reviews.get(id) ?? 0) + 1);
      await storeSiteGrant(o.dataDir, id, d);
      const s = openSites.get(id);
      // During a deletion nothing is granted (the grant would be that of an app that is leaving).
      if (!s || deletions.has(id)) return;
      const granted = rightsOf(d);
      const after = { ...s, grantRequired: grantNeeded(s.declaration) && !grantCovers(granted, s.declaration) };
      // The chrome's copy is this one: the reading below finds nothing changed and does not reload a second time.
      openSites.set(id, after);
      await o.chrome.afterGrant(id, after);
      void reread(id);
    },
    // Checked again here: only an open app whose tweaks are granted has a memory for its page.
    memoryOp: (d) => memoryOp((id) => (openSites.get(id)?.grantRequired === false ? memory(id) : Promise.reject(new Error("pas d'accord"))), d),
    position: (d) => positions.position(d),
    resume: (d) => positions.resume(d),
    async resync() {
      opened = new Set(await o.chrome.openSites());
      for (const id of [...openSites.keys()]) if (!opened.has(id)) forget(id);
      // A host that started again knows the open apps only by id: read again, as they were opened.
      for (const id of opened)
        if (!openSites.has(id)) {
          const p = await prepare(id).catch(() => null);
          if (p && opened.has(id)) {
            openSites.set(id, p.site);
            tweaks.set(id, p.tweaks);
          }
        }
      // A host that started again has no subscription: the windows already open keep their home's feed.
      for (const id of opened) await memory(id).then((m) => subscribe(id, m), () => {});
    },
    async stop() {
      try {
        for (const c of searches.values()) c.abort();
        await stopWatching().catch(() => {});
        await Promise.allSettled([...memories.keys()].map(clearMemory));
      } finally {
        await siteRecords.clear();
      }
    },
  };
}
