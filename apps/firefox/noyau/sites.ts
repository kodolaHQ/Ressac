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
  accorderSite,
  startUrl,
  effectiveDomains,
  droitsDe,
  siteReadHash,
  ID_SITE,
  lireAccordsSites,
  readUrlState,
  readTweaks,
  lireSite,
  lireSites,
  SiteMemory,
  deleteSiteData,
  watchSites,
  type SpacePaths,
  type DeclarationSite,
  type DroitsSite,
  type SitesTools,
  type TweaksRead,
  type SiteLu,
} from "../../../packages/noyau/src/index.ts";
import { urlChanged, urlUnchanged, urlNotFound, ICON_MAX, editWithAgent, type ActionSite, type BarNotice, type SiteGrantRequest, type MessageToHome, type ShownSite } from "../shared/sites.ts";
import type { Cadre } from "../shared/modele.ts";
import type { TweakError, MemoryResponse, OpenableSite } from "../core/sites/injection.ts";
import { UrlTracking } from "../core/sites/suivi.ts";
import { openDecision } from "../core/sites/navigation.ts";
import { createPositions, memoryOp } from "./site-memory.ts";

// The site apps service on the host side.

/** The app as the chrome gets it: what opens, its grant card, and its hash (lister_onglets). */
export type SiteChrome = OpenableSite & { demande: SiteGrantRequest; empreinte: string };

const uniques = (l: string[]) => [...new Set(l)];

/** The hash of the rights the declaration asks for. */
export function rightsHash(d: DeclarationSite): string {
  return createHash("sha256").update(JSON.stringify(droitsDe(d))).digest("hex");
}

/** What the grant card shows. */
export function grantRequest(s: OpenableSite): SiteGrantRequest {
  const d = s.declaration;
  const declares = new Set(d.domaines.map((x) => x.toLowerCase()));
  return {
    nom: d.nom,
    domaines: [...d.domaines],
    connexion: [...d.connexion],
    cadres: uniques(d.retouches.flatMap((r) => (r.cadres === false ? [] : r.cadres))),
    reprise: d.reprise,
    fichiers: uniques(d.retouches.flatMap((r) => [...r.js, ...r.css])),
    correspond: uniques(d.retouches.flatMap((r) => r.correspond)),
    suivis: uniques(s.domaines.map((x) => x.toLowerCase()).filter((x) => !declares.has(x))),
    empreinte: rightsHash(d),
  };
}

/** Requests host -> chrome: the window itself lives in the chrome. */
export interface SitesChrome {
  ouvrir(s: SiteChrome, cadre: Cadre | null, tweaks: TweaksRead): Promise<boolean>;
  fermer(id: string): Promise<void>;
  effacer(id: string): Promise<void>;
  /** True if the page was reloaded. */
  mettreAJour(s: SiteChrome, tweaks: TweaksRead): Promise<boolean>;
  rechargerVue(id: string): Promise<void>;
  /** The tweaks' console of the open app. */
  erreurs(id: string): Promise<TweakError[]>;
  /** The view the window shows, or null if it is not open. */
  vue(id: string): Promise<"accueil" | "accord" | "site" | null>;
  /** The choice made on the card: `s` null for « Ouvrir sans retouches ». */
  apresAccord(id: string, s: SiteChrome | null): Promise<void>;
  /** The state broadcast again (the card up to date). */
  rediffuser(id: string): Promise<void>;
  ouvertes(): Promise<string[]>;
  accueilChange(id: string): void;
  /** A reading of the reference page starts or ends: the bar's button shows it. */
  cherche(id: string, yes: boolean): void;
  /** The bar's mention. */
  avis(id: string, a: BarNotice | null): void;
  /** The follow found the new address: the open app takes its domains and start address, and the view goes to `vers`. */
  adresseChangee(id: string, domains: string[], depart: string, to: string): void;
}

export interface SitesHost {
  liste(): Promise<ShownSite[]>;
  listeAgent(): Promise<(ShownSite & { empreinte?: string })[]>;
  ouvrirParId(id: string): Promise<boolean>;
  agir(id: string, action: ActionSite, win: string): Promise<void>;
  memoireAccueil(id: string): Promise<(MessageToHome & { type: "memoire" }) | null>;
  noter(id: string, x: { cadre?: Cadre; favicon?: string }): void;
  fermee(id: string): void;
  /** « Autoriser » / « Ouvrir sans retouches » on the card. */
  accorder(id: string, yes: boolean, hash: string): Promise<void>;
  /** `webaiosSite` of an open app's main page; the chrome checked the sender, the grant and the address. */
  memoireOp(request: unknown): Promise<MemoryResponse>;
  /** A video position of an open app's page (`sites.position`), and the position to resume (`sites.reprise`); the chrome checked the frame. */
  position(request: unknown): Promise<void>;
  reprise(request: unknown): Promise<number | null>;
  /** « Chercher la nouvelle adresse », or a site that does not answer (`url`: the page aimed at, else the start address). */
  chercherAdresse(id: string, url: string | null): Promise<void>;
  /** The open apps as last sent to the chrome. */
  sitesOuverts: Map<string, SiteChrome>;
  /** Is the address on the open app's domains? (a navigation the agent asks for) */
  adressePermise(id: string, url: string): boolean;
  outils: SitesTools;
  resynchroniser(): Promise<void>;
  arreter(): Promise<void>;
}

export interface SouvenirSite {
  cadre?: Cadre;
  dernierLancement?: string;
  favicon?: string;
}

/**
 * File `sites.json`, written 500 ms after a change: what the browser keeps
 * of each site app (window frame, favicon).
 */
export class SiteSouvenirs {
  private donnees: Record<string, SouvenirSite> = Object.create(null);
  private minuterie: NodeJS.Timeout | undefined;
  private modifiee = false;
  /** Chained writes, never simultaneous. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
    private readonly fichier = "sites.json",
  ) {
    try {
      const lu: unknown = JSON.parse(readFileSync(join(dossier, fichier), "utf8"));
      // Without a prototype: an app name « __proto__ » or « constructor » stays a plain key.
      if (lu && typeof lu === "object" && !Array.isArray(lu)) this.donnees = Object.assign(Object.create(null), lu) as Record<string, SouvenirSite>;
    } catch {
      // Absent or unreadable: start from zero (nothing essential is kept there).
    }
  }

  lire(dossier: string): SouvenirSite {
    return this.donnees[dossier] ?? {};
  }

  /** App deleted: nothing is kept of it anymore. */
  oublier(dossier: string): void {
    if (!(dossier in this.donnees)) return;
    delete this.donnees[dossier];
    this.modifiee = true;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  noter(dossier: string, s: SouvenirSite): void {
    this.donnees[dossier] = { ...this.donnees[dossier], ...s };
    this.modifiee = true;
    this.minuterie ??= setTimeout(() => void this.vider(), this.delaiMs);
  }

  /** Writes what changed; always waits for the end of the writes in progress. */
  vider(): Promise<void> {
    clearTimeout(this.minuterie);
    this.minuterie = undefined;
    if (this.modifiee) {
      this.modifiee = false;
      const text = JSON.stringify(this.donnees, null, 2);
      this.ecriture = this.ecriture.then(() => this.ecrire(text)).catch((e) => console.error("[applications] mémoire non écrite :", e));
    }
    return this.ecriture;
  }

  private async ecrire(text: string): Promise<void> {
    const target = join(this.dossier, this.fichier);
    const temp = `${target}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
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
export async function readIcon(dossier: string, path: string): Promise<string | null> {
  const type = ICON_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  try {
    const file = join(dossier, path);
    // An ordinary file, not a link nor a named pipe: lstat before any open.
    if (!(await lstat(file)).isFile()) return null;
    // No folder of the path is a link that leaves the app's folder.
    const root = await realpath(dossier);
    if (!(await realpath(file)).startsWith(root + sep)) return null;
    // Without following a link that became one since the lstat, and without waiting for a pipe.
    const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await f.stat();
      if (!st.isFile() || st.size > ICON_MAX) return null;
      const tampon = Buffer.alloc(st.size);
      const { bytesRead } = await f.read(tampon, 0, st.size, 0);
      return `data:${type};base64,${tampon.subarray(0, bytesRead).toString("base64")}`;
    } finally {
      await f.close();
    }
  } catch {
    return null;
  }
}

export function createSites(o: {
  chemins: SpacePaths;
  /** The profile folder: `sites/<id>/` (memory, address), `sites.json`, `sites-accords.json`. */
  dataDir: string;
  adressesLocales: boolean;
  chrome: SitesChrome;
  /** The links of a reference page, read without the profile or any cookie (the bridge's public invisible read). */
  lireLiens(page: string, signal?: AbortSignal): Promise<string[]>;
  /** The list or the state of the site apps changed (`sites.change`). */
  diffuser(): void;
  preRemplir(win: string, text: string): void;
  /** A home screen memory change (`sites.memoire`), for the subscribed window. */
  notifierMemoire(id: string, message: MessageToHome & { type: "memoire" }): void;
  /** The app's window closed. */
  surFermee?(id: string): void;
  /** « Supprimer » begins: the agent's grant on the app falls. */
  surSupprimee?(id: string): void;
  /** The deletion `surSupprimee` began is over (folder in the trash, or failed): a review snapshot taken meanwhile is erased. */
  apresSuppression?(id: string): void;
}): SitesHost {
  const dossierSites = join(o.dataDir, "sites");
  const souvenirs = new SiteSouvenirs(o.dataDir);
  const memories = new Map<string, Promise<SiteMemory>>();
  const lecture = { adressesLocales: o.adressesLocales };
  /** Windows open in the chrome: kept by `ouvrir`/`fermee`, recomputed by `resynchroniser`. */
  let opened = new Set<string>();
  /** The open apps as last sent to the chrome, and their tweaks' files. */
  const openSites = new Map<string, SiteChrome>();
  const tweaks = new Map<string, TweaksRead>();
  const subscriptions = new Map<string, () => void>();
  /** Address follow: the reading under way, the last notice, and the changes made (a reading begun before one is redone). */
  const recherches = new Map<string, AbortController>();
  const derniersAvis = new Map<string, BarNotice>();
  const changements = new Map<string, number>();
  const tracking = new UrlTracking({ lireLiens: o.lireLiens, dossierSites, adressesLocales: o.adressesLocales, maintenant: () => Date.now() });
  const reviews = new Map<string, number>();
  /** Deletions in progress: a second request for the same app does nothing. */
  const suppressions = new Set<string>();
  /** Deletions started per app: an opening started before one of them does not go to the end. */
  const startedDeletions = new Map<string, number>();
  /** Ids shown by the last `liste()`: a stale row (folder renamed since) still acts on what it showed. */
  let shownItems = new Set<string>();
  /** Last failed action per app (« Supprimer » without trash…), shown as text on its row. */
  const actionErrors = new Map<string, string>();

  // Checked again here, like memoireOp: only an open app whose tweaks are granted has positions.
  const granted = (id: string) => openSites.get(id)?.accordRequis === false;
  const positions = createPositions({ memoire: (id) => (granted(id) ? memory(id) : Promise.reject(new Error("pas d'accord"))), accorde: granted });

  const clearMemory = (id: string) =>
    memories
      .get(id)
      ?.then((m) => m.vider())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /**
   * The app as it opens and its tweak files, or null (absent, invalid site.json, folder whose name
   * is not exactly `id`, or `encore()` that became false after one of the reads).
   */
  async function preparer(id: string, encore: () => boolean = () => true): Promise<{ site: SiteChrome; retouches: TweaksRead } | null> {
    if (!ID_SITE.test(id)) return null;
    // A case-insensitive disk would find « MonSite » for « monsite »: only the exact name counts.
    const names = await readdir(o.chemins.sites).catch(() => [] as string[]);
    if (!encore() || !names.includes(id)) return null;
    const lu = await lireSite(o.chemins, id, lecture);
    if (!encore() || !lu || "erreur" in lu) return null;
    const d = lu.declaration;
    const state = await readUrlState(dossierSites, id);
    if (!encore()) return null;
    let accord: DroitsSite | null = null;
    try {
      const accords = await lireAccordsSites(o.dataDir);
      accord = Object.hasOwn(accords, id) ? (accords[id] ?? null) : null;
    } catch (e) {
      // Unreadable grants: the grant is asked again (nothing is injected without it).
      console.error("[sites] accords illisibles :", e);
    }
    if (!encore()) return null;
    const files = await tweakFiles(lu);
    if (!encore()) return null;
    const site: OpenableSite = {
      id,
      declaration: d,
      aAccueil: lu.aAccueil,
      domaines: effectiveDomains(d, state),
      depart: startUrl(d, state),
      accordRequis: grantNeeded(d) && !grantCovers(accord, d),
    };
    return { site: { ...site, demande: grantRequest(site), empreinte: siteReadHash(d) }, retouches: files };
  }

  /** The tweak files; none if one of them is missing or exceeds the bounds (the error is written). */
  async function tweakFiles(lu: Extract<SiteLu, { declaration: unknown }>): Promise<TweaksRead> {
    if (lu.declaration.retouches.length === 0) return { js: {}, css: {} };
    const r = await readTweaks(lu).catch((e: unknown) => ({ erreur: String(e) }));
    if (!("erreur" in r)) return r;
    console.warn(`[sites] ${lu.id} : retouches non injectées : ${r.erreur}`);
    return { js: {}, css: {} };
  }

  /** The reference page says where the site is now; a notice says the result. */
  async function searchUrl(id: string, url: string | null): Promise<void> {
    const s = opened.has(id) ? openSites.get(id) : undefined;
    const d = s?.declaration;
    if (!s || !d?.suiviAdresse || suppressions.has(id)) return;
    // A reading is already under way: the follow answers « trop-tot » without doubling it.
    const enCours = recherches.has(id);
    const control = new AbortController();
    if (!enCours) {
      recherches.set(id, control);
      o.chrome.cherche(id, true);
    }
    const r = await tracking.chercher(id, d, control.signal).catch((): { t: "introuvable" } => ({ t: "introuvable" }));
    if (!enCours) {
      if (recherches.get(id) === control) recherches.delete(id);
      if (!control.signal.aborted) o.chrome.cherche(id, false);
    }
    // Window closed (or app deleted) during the reading: what comes after is ignored.
    const courante = opened.has(id) ? openSites.get(id) : undefined;
    if (control.signal.aborted || !courante) return;
    const notifier = (a: BarNotice) => {
      derniersAvis.set(id, a);
      o.chrome.avis(id, a);
    };
    switch (r.t) {
      case "trop-tot": {
        const dernier = derniersAvis.get(id);
        if (dernier) o.chrome.avis(id, dernier);
        return;
      }
      case "introuvable":
        return notifier({ genre: "introuvable", texte: urlNotFound(host(d.suiviAdresse.page) ?? d.suiviAdresse.page) });
      case "inchangee":
        return notifier({ genre: "inchangee", texte: urlUnchanged(d.nom) });
      case "change": {
        // Today's declaration (site.json may have been read again during the reading).
        const decl = courante.declaration;
        const domains = effectiveDomains(decl, r.etat);
        const depart = startUrl(decl, r.etat);
        // The same page on the new domain, else the start address.
        const relative = url ? relativeUrl(url, domains) : null;
        const to = (relative && urlOnDomain(relative, r.domaine, domains, depart, lecture)) || depart;
        changements.set(id, (changements.get(id) ?? 0) + 1);
        const site = { ...courante, domaines: domains, depart };
        openSites.set(id, { ...site, demande: grantRequest(site) });
        o.chrome.adresseChangee(id, domains, depart, to);
        notifier({ genre: "adresse-changee", texte: urlChanged(d.nom, r.domaine) });
        // The home shows the new domain.
        if (subscriptions.has(id)) void memory(id).then((m) => memoryMessage(id, m)).then((msg) => o.notifierMemoire(id, msg), () => {});
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
    const changesBefore = changements.get(id) ?? 0;
    const p = await preparer(id).catch((e: unknown) => {
      console.error(`[sites] ${id} illisible :`, e);
      return null;
    });
    const before = openSites.get(id);
    if (reviews.get(id) !== n || !opened.has(id) || !before) return;
    // The site changed address during the reading: its domains would be the old ones, read again.
    if ((changements.get(id) ?? 0) !== changesBefore) return reread(id);
    // Became invalid: nothing is injected anymore (the window keeps what it had, without tweaks).
    const fresh = p ? p.retouches : { js: {}, css: {} };
    // Nothing changed for the page (folder copied over, duplicate event): it is not reloaded.
    const same =
      JSON.stringify(fresh) === JSON.stringify(tweaks.get(id) ?? null) &&
      (!p || JSON.stringify({ ...p.site, aAccueil: null }) === JSON.stringify({ ...before, aAccueil: null }));
    tweaks.set(id, fresh);
    if (p) openSites.set(id, p.site);
    try {
      // The chrome holds its own copy of the tweaks map, so it gets the new one even
      // when site.json became invalid (with the app as it was). The card that comes back already reloads the page.
      const reloaded = await o.chrome.mettreAJour(p?.site ?? before, fresh);
      if (reviews.get(id) === n && !same && !reloaded) await o.chrome.rechargerVue(id);
    } catch (e) {
      console.error(`[sites] ${id} non mise à jour :`, e);
    }
  }

  let stopWatching: () => Promise<void> = async () => {};
  try {
    stopWatching = watchSites(o.chemins, (id, what) => {
      // The « Sites » section of the Applications page re-reads the list (app written, changed or removed by the agent).
      if (what === "declaration") o.diffuser();
      if (what === "accueil") {
        if (opened.has(id)) o.chrome.accueilChange(id);
      } else void reread(id);
    });
  } catch (e) {
    console.error("[sites] surveillance non démarrée :", e);
  }

  function memory(id: string): Promise<SiteMemory> {
    // During a deletion, the memory is neither reopened nor written (memoire.json does not come back).
    if (suppressions.has(id)) return Promise.reject(new Error(`appli de site en cours de suppression : ${id}`));
    let m = memories.get(id);
    if (!m) {
      m = SiteMemory.ouvrir(dossierSites, id);
      memories.set(id, m);
      // A refused id does not stay in the cache.
      m.catch(() => memories.delete(id));
    }
    return m;
  }

  /** The app's current domain (that of its start address). */
  async function currentDomain(id: string): Promise<string> {
    const lu = await lireSite(o.chemins, id, lecture).catch(() => null);
    if (!lu || "erreur" in lu) return "";
    return host(startUrl(lu.declaration, await readUrlState(dossierSites, id))) ?? "";
  }

  const memoryMessage = async (id: string, m: SiteMemory): Promise<MessageToHome & { type: "memoire" }> => {
    const { valeurs, positions } = m.contenu();
    return { type: "memoire", valeurs, positions, domaine: await currentDomain(id) };
  };

  /** The app's folder exists, and it is a real folder (never a link). */
  async function dossierReel(id: string): Promise<boolean> {
    try {
      return (await lstat(join(o.chemins.sites, id))).isDirectory();
    } catch {
      return false;
    }
  }

  /** Is the app one of those the section shows: its folder exists, or did the last list show it? */
  async function known(id: string): Promise<boolean> {
    return (await dossierReel(id)) || shownItems.has(id) || opened.has(id);
  }

  /**
   * « Oublier ce que l'appli a retenu »: the memory is erased (memoire.json deleted; the open home receives an
   * empty memory). Without an open window, the memory is not kept.
   */
  async function forgetSite(id: string): Promise<void> {
    if (!(await known(id))) return;
    positions.annulerNotes(id);
    const m = await memory(id);
    await m.effacer();
    if (!opened.has(id)) memories.delete(id);
  }

  /**
   * « Supprimer »: window closed (view destroyed) before its session is erased, then memory, address and grant
   * forgotten, finally the folder to the trash. A folder gone since the row was displayed: the data is erased
   * anyway. A failure of the trash is shown on the row.
   */
  async function remove(id: string): Promise<void> {
    if (suppressions.has(id)) return;
    suppressions.add(id);
    startedDeletions.set(id, (startedDeletions.get(id) ?? 0) + 1);
    let started = false;
    try {
      if (!(await known(id))) return;
      started = true;
      o.surSupprimee?.(id);
      positions.annulerNotes(id);
      recherches.get(id)?.abort();
      await o.chrome.fermer(id);
      opened.delete(id);
      forget(id);
      await o.chrome.effacer(id);
      const m = memories.get(id);
      if (m) await m.then((x) => x.effacer(), () => {});
      memories.delete(id);
      tracking.oublier(id);
      await deleteSiteData(o.dataDir, id);
      souvenirs.oublier(id);
      if (!(await dossierReel(id))) return;
      try {
        const trash = join(o.chemins.sites, ".corbeille");
        await mkdir(trash, { recursive: true });
        await rename(join(o.chemins.sites, id), join(trash, `${id}-${Date.now()}`));
      } catch (e) {
        console.error(`[sites] ${id} : dossier non mis à la corbeille :`, e);
        actionErrors.set(id, "Dossier non mis à la corbeille : la connexion et la mémoire sont effacées, le dossier reste.");
      }
    } finally {
      suppressions.delete(id);
      if (started) o.apresSuppression?.(id);
      o.diffuser();
    }
  }

  async function openById(id: string): Promise<boolean> {
    // A deletion started during one of the reads (even finished since): nothing opens.
    const startedList = startedDeletions.get(id) ?? 0;
    const encore = () => !suppressions.has(id) && (startedDeletions.get(id) ?? 0) === startedList;
    if (!encore()) return false;
    const p = await preparer(id, encore);
    if (!p || !encore()) return false;
    reviews.set(id, (reviews.get(id) ?? 0) + 1);
    // Before the window: its first page already asks for its tweaks.
    openSites.set(id, p.site);
    tweaks.set(id, p.retouches);
    if (!(await o.chrome.ouvrir(p.site, souvenirs.lire(id).cadre ?? null, p.retouches))) {
      if (!opened.has(id)) forget(id);
      return false;
    }
    // A deletion started while the chrome opened the window: close it again.
    if (!encore()) {
      await o.chrome.fermer(id).catch(() => {});
      return false;
    }
    opened.add(id);
    o.diffuser();
    return true;
  }

  /** The rows of the « Sites » section, and the hash of each valid declaration (for the agent only). */
  async function lignes(): Promise<(ShownSite & { empreinte?: string })[]> {
    const sites = await lireSites(o.chemins, lecture);
    shownItems = new Set(sites.map((s) => s.id));
    return Promise.all(
      sites.map(async (s): Promise<ShownSite & { empreinte?: string }> => {
        const favicon = souvenirs.lire(s.id).favicon ?? null;
        const actionError = actionErrors.get(s.id);
        // An id refused by ID_SITE (« MonSite ») can receive no action: the schema would reject them all.
        if ("erreur" in s)
          return { id: s.id, nom: s.id, description: "", domaine: null, icone: favicon, ouverte: opened.has(s.id), erreur: s.erreur, ...(ID_SITE.test(s.id) ? {} : { sansActions: true as const }), ...(actionError ? { erreurAction: actionError } : {}) };
        const state = ID_SITE.test(s.id) ? await readUrlState(dossierSites, s.id) : null;
        const declared = s.declaration.icone ? await readIcon(s.dossier, s.declaration.icone) : null;
        return {
          id: s.id,
          nom: s.declaration.nom,
          description: s.declaration.description,
          domaine: host(startUrl(s.declaration, state)),
          icone: declared ?? favicon,
          ouverte: opened.has(s.id),
          ...(actionError ? { erreurAction: actionError } : {}),
          empreinte: siteReadHash(s.declaration),
        };
      }),
    );
  }

  const subscribe = (id: string, m: SiteMemory) => {
    if (!subscriptions.has(id)) subscriptions.set(id, m.surChange(() => void memoryMessage(id, m).then((msg) => o.notifierMemoire(id, msg), () => {})));
  };

  const list = async () => (await lignes()).map(({ empreinte: _, ...l }) => l);

  function forget(id: string): void {
    openSites.delete(id);
    tweaks.delete(id);
  }

  return {
    liste: list,
    listeAgent: lignes,
    ouvrirParId: openById,
    async agir(id, a, win) {
      if (!ID_SITE.test(id)) return;
      actionErrors.delete(id);
      switch (a) {
        case "ouvrir":
          if (!(await openById(id))) console.warn(`[sites] ${id} ne peut pas s'ouvrir`);
          return;
        case "modifier":
          o.preRemplir(win, editWithAgent(id));
          return;
        case "oublier":
          return forgetSite(id);
        case "supprimer":
          return remove(id);
        // "dossier" and "relire" are the UI's: no host work here.
        case "dossier":
        case "relire":
          return;
      }
    },
    async memoireAccueil(id) {
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
    noter(id, x) {
      // Nothing is kept for an app being deleted (frame, favicon): souvenirs.oublier passes after.
      if (suppressions.has(id)) return;
      souvenirs.noter(id, x);
      if (x.favicon !== undefined) o.diffuser();
    },
    fermee(id) {
      positions.fermee(id);
      opened.delete(id);
      forget(id);
      subscriptions.get(id)?.();
      subscriptions.delete(id);
      reviews.delete(id);
      recherches.get(id)?.abort();
      recherches.delete(id);
      derniersAvis.delete(id);
      void clearMemory(id);
      o.diffuser();
      o.surFermee?.(id);
    },
    outils: {
      lister: async () =>
        (await lignes()).map((s) => ({
          id: s.id, nom: s.nom, domaine: s.domaine, ouverte: s.ouverte, ...(s.erreur !== undefined ? { erreur: s.erreur } : {}),
          ...(s.empreinte !== undefined ? { empreinte: s.empreinte } : {}),
        })),
      ouvrir: openById,
      memoire: async (id) => {
        if (!(await list()).some((s) => s.id === id)) return null;
        return (await memory(id)).contenu();
      },
      erreurs: async (id) => {
        if (!(await list()).some((s) => s.id === id)) return null;
        return opened.has(id) ? o.chrome.erreurs(id).catch(() => []) : [];
      },
    },
    chercherAdresse: searchUrl,
    sitesOuverts: openSites,
    adressePermise(id, url) {
      const s = opened.has(id) ? openSites.get(id) : undefined;
      return !!s && openDecision(url, { domaines: s.domaines, connexion: s.declaration.connexion ?? [], adressesLocales: o.adressesLocales }) === "dans-l-appli";
    },
    async accorder(id, yes, hash) {
      // Taken before any wait: site.json may grow between the card and the click.
      const shown = openSites.get(id);
      if (!shown || suppressions.has(id) || (await o.chrome.vue(id)) !== "accord") return;
      if (!yes) return o.chrome.apresAccord(id, null);
      // Granted only if its rights are the clicked card's (the agent picks its moment).
      const d = shown.declaration;
      if (rightsHash(d) !== hash) return o.chrome.rediffuser(id);
      // A reading already under way read the grant from before: it is dropped (and redone once the grant is written).
      reviews.set(id, (reviews.get(id) ?? 0) + 1);
      await accorderSite(o.dataDir, id, d);
      const s = openSites.get(id);
      // During a deletion nothing is granted (the grant would be that of an app that is leaving).
      if (!s || suppressions.has(id)) return;
      const granted = droitsDe(d);
      const after = { ...s, accordRequis: grantNeeded(s.declaration) && !grantCovers(granted, s.declaration) };
      // The chrome's copy is this one: the reading below finds nothing changed and does not reload a second time.
      openSites.set(id, after);
      await o.chrome.apresAccord(id, after);
      void reread(id);
    },
    // Checked again here: only an open app whose tweaks are granted has a memory for its page.
    memoireOp: (d) => memoryOp((id) => (openSites.get(id)?.accordRequis === false ? memory(id) : Promise.reject(new Error("pas d'accord"))), d),
    position: (d) => positions.position(d),
    reprise: (d) => positions.reprise(d),
    async resynchroniser() {
      opened = new Set(await o.chrome.ouvertes());
      for (const id of [...openSites.keys()]) if (!opened.has(id)) forget(id);
      // A host that started again knows the open apps only by id: read again, as they were opened.
      for (const id of opened)
        if (!openSites.has(id)) {
          const p = await preparer(id).catch(() => null);
          if (p && opened.has(id)) {
            openSites.set(id, p.site);
            tweaks.set(id, p.retouches);
          }
        }
      // A host that started again has no subscription: the windows already open keep their home's feed.
      for (const id of opened) await memory(id).then((m) => subscribe(id, m), () => {});
    },
    async arreter() {
      try {
        for (const c of recherches.values()) c.abort();
        await stopWatching().catch(() => {});
        await Promise.allSettled([...memories.keys()].map(clearMemory));
      } finally {
        await souvenirs.vider();
      }
    },
  };
}
