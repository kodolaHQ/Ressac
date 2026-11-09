import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import fs, { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import {
  accordCouvre,
  adresseRelative,
  adresseSurDomaine,
  accordNecessaire,
  accorderSite,
  adresseDeDepart,
  domainesEffectifs,
  droitsDe,
  empreinteLectureSite,
  ID_SITE,
  lireAccordsSites,
  lireEtatAdresse,
  lireRetouches,
  lireSite,
  lireSites,
  MemoireSite,
  supprimerDonneesSite,
  surveillerSites,
  type CheminsEspace,
  type DeclarationSite,
  type DroitsSite,
  type OutilsSites,
  type RetouchesLues,
  type SiteLu,
} from "../../../packages/noyau/src/index.ts";
import { adresseChangee, adresseInchangee, adresseIntrouvable, ICONE_MAX, modifierAvecAgent, type ActionSite, type AvisBarre, type DemandeAccordSite, type MessageVersLAccueil, type SiteAffiche } from "../shared/sites.ts";
import type { Cadre } from "../shared/modele.ts";
import type { ErreurRetouche, ReponseMemoire, SiteOuvrable } from "../core/sites/injection.ts";
import { SuiviAdresse } from "../core/sites/suivi.ts";
import { decisionOuverture } from "../core/sites/navigation.ts";
import { creerPositions, memoireOp } from "./site-memory.ts";

// The site apps service on the host side.

/** The app as the chrome gets it: what opens, its grant card, and its fingerprint (lister_onglets). */
export type SiteChrome = SiteOuvrable & { demande: DemandeAccordSite; empreinte: string };

const uniques = (l: string[]) => [...new Set(l)];

/** The fingerprint of the rights the declaration asks for. */
export function empreinteDroits(d: DeclarationSite): string {
  return createHash("sha256").update(JSON.stringify(droitsDe(d))).digest("hex");
}

/** What the grant card shows. */
export function demandeAccord(s: SiteOuvrable): DemandeAccordSite {
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
    empreinte: empreinteDroits(d),
  };
}

/** Requests host -> chrome: the window itself lives in the chrome. */
export interface SitesChrome {
  ouvrir(s: SiteChrome, cadre: Cadre | null, retouches: RetouchesLues): Promise<boolean>;
  fermer(id: string): Promise<void>;
  effacer(id: string): Promise<void>;
  /** True if the page was reloaded. */
  mettreAJour(s: SiteChrome, retouches: RetouchesLues): Promise<boolean>;
  rechargerVue(id: string): Promise<void>;
  /** The tweaks' console of the open app. */
  erreurs(id: string): Promise<ErreurRetouche[]>;
  /** The view the window shows, or null if it is not open. */
  vue(id: string): Promise<"accueil" | "accord" | "site" | null>;
  /** The choice made on the card: `s` null for « Ouvrir sans retouches ». */
  apresAccord(id: string, s: SiteChrome | null): Promise<void>;
  /** The state broadcast again (the card up to date). */
  rediffuser(id: string): Promise<void>;
  ouvertes(): Promise<string[]>;
  accueilChange(id: string): void;
  /** A reading of the reference page starts or ends: the bar's button shows it. */
  cherche(id: string, oui: boolean): void;
  /** The bar's mention. */
  avis(id: string, a: AvisBarre | null): void;
  /** The follow found the new address: the open app takes its domains and start address, and the view goes to `vers`. */
  adresseChangee(id: string, domaines: string[], depart: string, vers: string): void;
}

export interface SitesHost {
  liste(): Promise<SiteAffiche[]>;
  listeAgent(): Promise<(SiteAffiche & { empreinte?: string })[]>;
  ouvrirParId(id: string): Promise<boolean>;
  agir(id: string, action: ActionSite, fenetre: string): Promise<void>;
  memoireAccueil(id: string): Promise<(MessageVersLAccueil & { type: "memoire" }) | null>;
  noter(id: string, x: { cadre?: Cadre; favicon?: string }): void;
  fermee(id: string): void;
  /** « Autoriser » / « Ouvrir sans retouches » on the card. */
  accorder(id: string, oui: boolean, empreinte: string): Promise<void>;
  /** `webaiosSite` of an open app's main page; the chrome checked the sender, the grant and the address. */
  memoireOp(demande: unknown): Promise<ReponseMemoire>;
  /** A video position of an open app's page (`sites.position`), and the position to resume (`sites.reprise`); the chrome checked the frame. */
  position(demande: unknown): Promise<void>;
  reprise(demande: unknown): Promise<number | null>;
  /** « Chercher la nouvelle adresse », or a site that does not answer (`url`: the page aimed at, else the start address). */
  chercherAdresse(id: string, url: string | null): Promise<void>;
  /** The open apps as last sent to the chrome. */
  sitesOuverts: Map<string, SiteChrome>;
  /** Is the address on the open app's domains? (a navigation the agent asks for) */
  adressePermise(id: string, url: string): boolean;
  outils: OutilsSites;
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
      const texte = JSON.stringify(this.donnees, null, 2);
      this.ecriture = this.ecriture.then(() => this.ecrire(texte)).catch((e) => console.error("[applications] mémoire non écrite :", e));
    }
    return this.ecriture;
  }

  private async ecrire(texte: string): Promise<void> {
    const cible = join(this.dossier, this.fichier);
    const temporaire = `${cible}.${process.pid}.${++this.numero}.tmp`;
    await fs.mkdir(this.dossier, { recursive: true });
    await fs.writeFile(temporaire, texte);
    await fs.rename(temporaire, cible);
  }
}

/** The host of an address, or null. */
function hote(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const TYPES_ICONE: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" };

/**
 * The icon declared by the app (`icone`, relative path to an image), as `data:`; null if it is missing, leaves the folder
 * (link, `..`), is a link, a pipe or exceeds `ICONE_MAX`.
 */
export async function lireIcone(dossier: string, chemin: string): Promise<string | null> {
  const type = TYPES_ICONE[extname(chemin).toLowerCase()];
  if (!type) return null;
  try {
    const fichier = join(dossier, chemin);
    // An ordinary file, not a link nor a named pipe: lstat before any open.
    if (!(await lstat(fichier)).isFile()) return null;
    // No folder of the path is a link that leaves the app's folder.
    const racine = await realpath(dossier);
    if (!(await realpath(fichier)).startsWith(racine + sep)) return null;
    // Without following a link that became one since the lstat, and without waiting for a pipe.
    const f = await open(fichier, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await f.stat();
      if (!st.isFile() || st.size > ICONE_MAX) return null;
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
  chemins: CheminsEspace;
  /** The profile folder: `sites/<id>/` (memory, address), `sites.json`, `sites-accords.json`. */
  dataDir: string;
  adressesLocales: boolean;
  chrome: SitesChrome;
  /** The links of a reference page, read without the profile or any cookie (the bridge's public invisible read). */
  lireLiens(page: string, signal?: AbortSignal): Promise<string[]>;
  /** The list or the state of the site apps changed (`sites.change`). */
  diffuser(): void;
  preRemplir(fenetre: string, texte: string): void;
  /** A home screen memory change (`sites.memoire`), for the subscribed window. */
  notifierMemoire(id: string, message: MessageVersLAccueil & { type: "memoire" }): void;
  /** The app's window closed. */
  surFermee?(id: string): void;
  /** « Supprimer » begins: the agent's grant on the app falls. */
  surSupprimee?(id: string): void;
  /** The deletion `surSupprimee` began is over (folder in the trash, or failed): a review snapshot taken meanwhile is erased. */
  apresSuppression?(id: string): void;
}): SitesHost {
  const dossierSites = join(o.dataDir, "sites");
  const souvenirs = new SiteSouvenirs(o.dataDir);
  const memoires = new Map<string, Promise<MemoireSite>>();
  const lecture = { adressesLocales: o.adressesLocales };
  /** Windows open in the chrome: kept by `ouvrir`/`fermee`, recomputed by `resynchroniser`. */
  let ouvertes = new Set<string>();
  /** The open apps as last sent to the chrome, and their tweaks' files. */
  const sitesOuverts = new Map<string, SiteChrome>();
  const retouches = new Map<string, RetouchesLues>();
  const abonnements = new Map<string, () => void>();
  /** Address follow: the reading under way, the last notice, and the changes made (a reading begun before one is redone). */
  const recherches = new Map<string, AbortController>();
  const derniersAvis = new Map<string, AvisBarre>();
  const changements = new Map<string, number>();
  const suivi = new SuiviAdresse({ lireLiens: o.lireLiens, dossierSites, adressesLocales: o.adressesLocales, maintenant: () => Date.now() });
  const relectures = new Map<string, number>();
  /** Deletions in progress: a second request for the same app does nothing. */
  const suppressions = new Set<string>();
  /** Deletions started per app: an opening started before one of them does not go to the end. */
  const suppressionsCommencees = new Map<string, number>();
  /** Ids shown by the last `liste()`: a stale row (folder renamed since) still acts on what it showed. */
  let affiches = new Set<string>();
  /** Last failed action per app (« Supprimer » without trash…), shown as text on its row. */
  const erreursActions = new Map<string, string>();

  // Checked again here, like memoireOp: only an open app whose tweaks are granted has positions.
  const accordee = (id: string) => sitesOuverts.get(id)?.accordRequis === false;
  const positions = creerPositions({ memoire: (id) => (accordee(id) ? memoire(id) : Promise.reject(new Error("pas d'accord"))), accorde: accordee });

  const viderMemoire = (id: string) =>
    memoires
      .get(id)
      ?.then((m) => m.vider())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /**
   * The app as it opens and its tweak files, or null (absent, invalid site.json, folder whose name
   * is not exactly `id`, or `encore()` that became false after one of the reads).
   */
  async function preparer(id: string, encore: () => boolean = () => true): Promise<{ site: SiteChrome; retouches: RetouchesLues } | null> {
    if (!ID_SITE.test(id)) return null;
    // A case-insensitive disk would find « MonSite » for « monsite »: only the exact name counts.
    const noms = await readdir(o.chemins.sites).catch(() => [] as string[]);
    if (!encore() || !noms.includes(id)) return null;
    const lu = await lireSite(o.chemins, id, lecture);
    if (!encore() || !lu || "erreur" in lu) return null;
    const d = lu.declaration;
    const etat = await lireEtatAdresse(dossierSites, id);
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
    const fichiers = await fichiersRetouches(lu);
    if (!encore()) return null;
    const site: SiteOuvrable = {
      id,
      declaration: d,
      aAccueil: lu.aAccueil,
      domaines: domainesEffectifs(d, etat),
      depart: adresseDeDepart(d, etat),
      accordRequis: accordNecessaire(d) && !accordCouvre(accord, d),
    };
    return { site: { ...site, demande: demandeAccord(site), empreinte: empreinteLectureSite(d) }, retouches: fichiers };
  }

  /** The tweak files; none if one of them is missing or exceeds the bounds (the error is written). */
  async function fichiersRetouches(lu: Extract<SiteLu, { declaration: unknown }>): Promise<RetouchesLues> {
    if (lu.declaration.retouches.length === 0) return { js: {}, css: {} };
    const r = await lireRetouches(lu).catch((e: unknown) => ({ erreur: String(e) }));
    if (!("erreur" in r)) return r;
    console.warn(`[sites] ${lu.id} : retouches non injectées : ${r.erreur}`);
    return { js: {}, css: {} };
  }

  /** The reference page says where the site is now; a notice says the result. */
  async function chercherAdresse(id: string, url: string | null): Promise<void> {
    const s = ouvertes.has(id) ? sitesOuverts.get(id) : undefined;
    const d = s?.declaration;
    if (!s || !d?.suiviAdresse || suppressions.has(id)) return;
    // A reading is already under way: the follow answers « trop-tot » without doubling it.
    const enCours = recherches.has(id);
    const controle = new AbortController();
    if (!enCours) {
      recherches.set(id, controle);
      o.chrome.cherche(id, true);
    }
    const r = await suivi.chercher(id, d, controle.signal).catch((): { t: "introuvable" } => ({ t: "introuvable" }));
    if (!enCours) {
      if (recherches.get(id) === controle) recherches.delete(id);
      if (!controle.signal.aborted) o.chrome.cherche(id, false);
    }
    // Window closed (or app deleted) during the reading: what comes after is ignored.
    const courante = ouvertes.has(id) ? sitesOuverts.get(id) : undefined;
    if (controle.signal.aborted || !courante) return;
    const notifier = (a: AvisBarre) => {
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
        return notifier({ genre: "introuvable", texte: adresseIntrouvable(hote(d.suiviAdresse.page) ?? d.suiviAdresse.page) });
      case "inchangee":
        return notifier({ genre: "inchangee", texte: adresseInchangee(d.nom) });
      case "change": {
        // Today's declaration (site.json may have been read again during the reading).
        const decl = courante.declaration;
        const domaines = domainesEffectifs(decl, r.etat);
        const depart = adresseDeDepart(decl, r.etat);
        // The same page on the new domain, else the start address.
        const relative = url ? adresseRelative(url, domaines) : null;
        const vers = (relative && adresseSurDomaine(relative, r.domaine, domaines, depart, lecture)) || depart;
        changements.set(id, (changements.get(id) ?? 0) + 1);
        const site = { ...courante, domaines, depart };
        sitesOuverts.set(id, { ...site, demande: demandeAccord(site) });
        o.chrome.adresseChangee(id, domaines, depart, vers);
        notifier({ genre: "adresse-changee", texte: adresseChangee(d.nom, r.domaine) });
        // The home shows the new domain.
        if (abonnements.has(id)) void memoire(id).then((m) => messageMemoire(id, m)).then((msg) => o.notifierMemoire(id, msg), () => {});
      }
    }
  }

  /**
   * site.json or a tweak file changed: the open app is read again, then its page reloaded; only the last read counts.
   */
  async function relire(id: string): Promise<void> {
    if (!ouvertes.has(id)) return;
    const n = (relectures.get(id) ?? 0) + 1;
    relectures.set(id, n);
    const changementsAvant = changements.get(id) ?? 0;
    const p = await preparer(id).catch((e: unknown) => {
      console.error(`[sites] ${id} illisible :`, e);
      return null;
    });
    const avant = sitesOuverts.get(id);
    if (relectures.get(id) !== n || !ouvertes.has(id) || !avant) return;
    // The site changed address during the reading: its domains would be the old ones, read again.
    if ((changements.get(id) ?? 0) !== changementsAvant) return relire(id);
    // Became invalid: nothing is injected anymore (the window keeps what it had, without tweaks).
    const nouvelles = p ? p.retouches : { js: {}, css: {} };
    // Nothing changed for the page (folder copied over, duplicate event): it is not reloaded.
    const pareil =
      JSON.stringify(nouvelles) === JSON.stringify(retouches.get(id) ?? null) &&
      (!p || JSON.stringify({ ...p.site, aAccueil: null }) === JSON.stringify({ ...avant, aAccueil: null }));
    retouches.set(id, nouvelles);
    if (p) sitesOuverts.set(id, p.site);
    try {
      // The chrome holds its own copy of the tweaks map, so it gets the new one even
      // when site.json became invalid (with the app as it was). The card that comes back already reloads the page.
      const rechargee = await o.chrome.mettreAJour(p?.site ?? avant, nouvelles);
      if (relectures.get(id) === n && !pareil && !rechargee) await o.chrome.rechargerVue(id);
    } catch (e) {
      console.error(`[sites] ${id} non mise à jour :`, e);
    }
  }

  let arreterSurveillance: () => Promise<void> = async () => {};
  try {
    arreterSurveillance = surveillerSites(o.chemins, (id, quoi) => {
      // The « Sites » section of the Applications page re-reads the list (app written, changed or removed by the agent).
      if (quoi === "declaration") o.diffuser();
      if (quoi === "accueil") {
        if (ouvertes.has(id)) o.chrome.accueilChange(id);
      } else void relire(id);
    });
  } catch (e) {
    console.error("[sites] surveillance non démarrée :", e);
  }

  function memoire(id: string): Promise<MemoireSite> {
    // During a deletion, the memory is neither reopened nor written (memoire.json does not come back).
    if (suppressions.has(id)) return Promise.reject(new Error(`appli de site en cours de suppression : ${id}`));
    let m = memoires.get(id);
    if (!m) {
      m = MemoireSite.ouvrir(dossierSites, id);
      memoires.set(id, m);
      // A refused id does not stay in the cache.
      m.catch(() => memoires.delete(id));
    }
    return m;
  }

  /** The app's current domain (that of its start address). */
  async function domaineActuel(id: string): Promise<string> {
    const lu = await lireSite(o.chemins, id, lecture).catch(() => null);
    if (!lu || "erreur" in lu) return "";
    return hote(adresseDeDepart(lu.declaration, await lireEtatAdresse(dossierSites, id))) ?? "";
  }

  const messageMemoire = async (id: string, m: MemoireSite): Promise<MessageVersLAccueil & { type: "memoire" }> => {
    const { valeurs, positions } = m.contenu();
    return { type: "memoire", valeurs, positions, domaine: await domaineActuel(id) };
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
  async function connue(id: string): Promise<boolean> {
    return (await dossierReel(id)) || affiches.has(id) || ouvertes.has(id);
  }

  /**
   * « Oublier ce que l'appli a retenu »: the memory is erased (memoire.json deleted; the open home receives an
   * empty memory). Without an open window, the memory is not kept.
   */
  async function oublier(id: string): Promise<void> {
    if (!(await connue(id))) return;
    positions.annulerNotes(id);
    const m = await memoire(id);
    await m.effacer();
    if (!ouvertes.has(id)) memoires.delete(id);
  }

  /**
   * « Supprimer »: window closed (view destroyed) before its session is erased, then memory, address and grant
   * forgotten, finally the folder to the trash. A folder gone since the row was displayed: the data is erased
   * anyway. A failure of the trash is shown on the row.
   */
  async function supprimer(id: string): Promise<void> {
    if (suppressions.has(id)) return;
    suppressions.add(id);
    suppressionsCommencees.set(id, (suppressionsCommencees.get(id) ?? 0) + 1);
    let commencee = false;
    try {
      if (!(await connue(id))) return;
      commencee = true;
      o.surSupprimee?.(id);
      positions.annulerNotes(id);
      recherches.get(id)?.abort();
      await o.chrome.fermer(id);
      ouvertes.delete(id);
      forget(id);
      await o.chrome.effacer(id);
      const m = memoires.get(id);
      if (m) await m.then((x) => x.effacer(), () => {});
      memoires.delete(id);
      suivi.oublier(id);
      await supprimerDonneesSite(o.dataDir, id);
      souvenirs.oublier(id);
      if (!(await dossierReel(id))) return;
      try {
        const corbeille = join(o.chemins.sites, ".corbeille");
        await mkdir(corbeille, { recursive: true });
        await rename(join(o.chemins.sites, id), join(corbeille, `${id}-${Date.now()}`));
      } catch (e) {
        console.error(`[sites] ${id} : dossier non mis à la corbeille :`, e);
        erreursActions.set(id, "Dossier non mis à la corbeille : la connexion et la mémoire sont effacées, le dossier reste.");
      }
    } finally {
      suppressions.delete(id);
      if (commencee) o.apresSuppression?.(id);
      o.diffuser();
    }
  }

  async function ouvrirParId(id: string): Promise<boolean> {
    // A deletion started during one of the reads (even finished since): nothing opens.
    const commencees = suppressionsCommencees.get(id) ?? 0;
    const encore = () => !suppressions.has(id) && (suppressionsCommencees.get(id) ?? 0) === commencees;
    if (!encore()) return false;
    const p = await preparer(id, encore);
    if (!p || !encore()) return false;
    relectures.set(id, (relectures.get(id) ?? 0) + 1);
    // Before the window: its first page already asks for its tweaks.
    sitesOuverts.set(id, p.site);
    retouches.set(id, p.retouches);
    if (!(await o.chrome.ouvrir(p.site, souvenirs.lire(id).cadre ?? null, p.retouches))) {
      if (!ouvertes.has(id)) forget(id);
      return false;
    }
    // A deletion started while the chrome opened the window: close it again.
    if (!encore()) {
      await o.chrome.fermer(id).catch(() => {});
      return false;
    }
    ouvertes.add(id);
    o.diffuser();
    return true;
  }

  /** The rows of the « Sites » section, and the hash of each valid declaration (for the agent only). */
  async function lignes(): Promise<(SiteAffiche & { empreinte?: string })[]> {
    const sites = await lireSites(o.chemins, lecture);
    affiches = new Set(sites.map((s) => s.id));
    return Promise.all(
      sites.map(async (s): Promise<SiteAffiche & { empreinte?: string }> => {
        const favicon = souvenirs.lire(s.id).favicon ?? null;
        const erreurAction = erreursActions.get(s.id);
        // An id refused by ID_SITE (« MonSite ») can receive no action: the schema would reject them all.
        if ("erreur" in s)
          return { id: s.id, nom: s.id, description: "", domaine: null, icone: favicon, ouverte: ouvertes.has(s.id), erreur: s.erreur, ...(ID_SITE.test(s.id) ? {} : { sansActions: true as const }), ...(erreurAction ? { erreurAction } : {}) };
        const etat = ID_SITE.test(s.id) ? await lireEtatAdresse(dossierSites, s.id) : null;
        const declaree = s.declaration.icone ? await lireIcone(s.dossier, s.declaration.icone) : null;
        return {
          id: s.id,
          nom: s.declaration.nom,
          description: s.declaration.description,
          domaine: hote(adresseDeDepart(s.declaration, etat)),
          icone: declaree ?? favicon,
          ouverte: ouvertes.has(s.id),
          ...(erreurAction ? { erreurAction } : {}),
          empreinte: empreinteLectureSite(s.declaration),
        };
      }),
    );
  }

  const abonner = (id: string, m: MemoireSite) => {
    if (!abonnements.has(id)) abonnements.set(id, m.surChange(() => void messageMemoire(id, m).then((msg) => o.notifierMemoire(id, msg), () => {})));
  };

  const liste = async () => (await lignes()).map(({ empreinte: _, ...l }) => l);

  function forget(id: string): void {
    sitesOuverts.delete(id);
    retouches.delete(id);
  }

  return {
    liste,
    listeAgent: lignes,
    ouvrirParId,
    async agir(id, a, fenetre) {
      if (!ID_SITE.test(id)) return;
      erreursActions.delete(id);
      switch (a) {
        case "ouvrir":
          if (!(await ouvrirParId(id))) console.warn(`[sites] ${id} ne peut pas s'ouvrir`);
          return;
        case "modifier":
          o.preRemplir(fenetre, modifierAvecAgent(id));
          return;
        case "oublier":
          return oublier(id);
        case "supprimer":
          return supprimer(id);
        // "dossier" and "relire" are the UI's: no host work here.
        case "dossier":
        case "relire":
          return;
      }
    },
    async memoireAccueil(id) {
      try {
        const m = await memoire(id);
        // Subscribed once per open window (unsubscribed at its close); a window already closed is not.
        if (ouvertes.has(id)) abonner(id, m);
        return await messageMemoire(id, m);
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
      ouvertes.delete(id);
      forget(id);
      abonnements.get(id)?.();
      abonnements.delete(id);
      relectures.delete(id);
      recherches.get(id)?.abort();
      recherches.delete(id);
      derniersAvis.delete(id);
      void viderMemoire(id);
      o.diffuser();
      o.surFermee?.(id);
    },
    outils: {
      lister: async () =>
        (await lignes()).map((s) => ({
          id: s.id, nom: s.nom, domaine: s.domaine, ouverte: s.ouverte, ...(s.erreur !== undefined ? { erreur: s.erreur } : {}),
          ...(s.empreinte !== undefined ? { empreinte: s.empreinte } : {}),
        })),
      ouvrir: ouvrirParId,
      memoire: async (id) => {
        if (!(await liste()).some((s) => s.id === id)) return null;
        return (await memoire(id)).contenu();
      },
      erreurs: async (id) => {
        if (!(await liste()).some((s) => s.id === id)) return null;
        return ouvertes.has(id) ? o.chrome.erreurs(id).catch(() => []) : [];
      },
    },
    chercherAdresse,
    sitesOuverts,
    adressePermise(id, url) {
      const s = ouvertes.has(id) ? sitesOuverts.get(id) : undefined;
      return !!s && decisionOuverture(url, { domaines: s.domaines, connexion: s.declaration.connexion ?? [], adressesLocales: o.adressesLocales }) === "dans-l-appli";
    },
    async accorder(id, oui, empreinte) {
      // Taken before any wait: site.json may grow between the card and the click.
      const montree = sitesOuverts.get(id);
      if (!montree || suppressions.has(id) || (await o.chrome.vue(id)) !== "accord") return;
      if (!oui) return o.chrome.apresAccord(id, null);
      // Granted only if its rights are the clicked card's (the agent picks its moment).
      const d = montree.declaration;
      if (empreinteDroits(d) !== empreinte) return o.chrome.rediffuser(id);
      // A reading already under way read the grant from before: it is dropped (and redone once the grant is written).
      relectures.set(id, (relectures.get(id) ?? 0) + 1);
      await accorderSite(o.dataDir, id, d);
      const s = sitesOuverts.get(id);
      // During a deletion nothing is granted (the grant would be that of an app that is leaving).
      if (!s || suppressions.has(id)) return;
      const accorde = droitsDe(d);
      const apres = { ...s, accordRequis: accordNecessaire(s.declaration) && !accordCouvre(accorde, s.declaration) };
      // The chrome's copy is this one: the reading below finds nothing changed and does not reload a second time.
      sitesOuverts.set(id, apres);
      await o.chrome.apresAccord(id, apres);
      void relire(id);
    },
    // Checked again here: only an open app whose tweaks are granted has a memory for its page.
    memoireOp: (d) => memoireOp((id) => (sitesOuverts.get(id)?.accordRequis === false ? memoire(id) : Promise.reject(new Error("pas d'accord"))), d),
    position: (d) => positions.position(d),
    reprise: (d) => positions.reprise(d),
    async resynchroniser() {
      ouvertes = new Set(await o.chrome.ouvertes());
      for (const id of [...sitesOuverts.keys()]) if (!ouvertes.has(id)) forget(id);
      // A host that started again knows the open apps only by id: read again, as they were opened.
      for (const id of ouvertes)
        if (!sitesOuverts.has(id)) {
          const p = await preparer(id).catch(() => null);
          if (p && ouvertes.has(id)) {
            sitesOuverts.set(id, p.site);
            retouches.set(id, p.retouches);
          }
        }
      // A host that started again has no subscription: the windows already open keep their home's feed.
      for (const id of ouvertes) await memoire(id).then((m) => abonner(id, m), () => {});
    },
    async arreter() {
      try {
        for (const c of recherches.values()) c.abort();
        await arreterSurveillance().catch(() => {});
        await Promise.allSettled([...memoires.keys()].map(viderMemoire));
      } finally {
        await souvenirs.vider();
      }
    },
  };
}
