import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import fs, { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { z } from "zod";
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
import { adresseChangee, adresseInchangee, adresseIntrouvable, ICONE_MAX, modifierAvecAgent, type ActionSite, type AvisBarre, type DemandeAccordSite, type MessageVersLAccueil, type SiteAffiche } from "../../navigateur/src/commun/sites.ts";
import type { Cadre } from "../../navigateur/src/commun/modele.ts";
import type { ErreurRetouche, SiteOuvrable } from "../../navigateur/src/main/sites/fenetres.ts";
import type { ReponseMemoire } from "../../navigateur/src/main/sites/injection.ts";
import { SuiviAdresse } from "./site-follow.ts";
import { creerPositions, memoireOp } from "./site-memory.ts";

// The pure parts of Electron's main/sites/service.ts, copied: it imports electron, so the Node host cannot import it.
// Same guards, same counters, same messages. Left to plan 32's later tasks: address tracking, accord, extensions.

/** Electron's IPC schema of a site app action (commun/api.ts, which Node cannot import): test/sites-host.test.ts compares them. */
export const SchemaActionSite = z.object({
  id: z.string().regex(ID_SITE),
  action: z.enum(["ouvrir", "modifier", "oublier", "dossier", "supprimer", "relire"]),
});

/** The app as the chrome gets it: what opens, its accord card, and its fingerprint (lister_onglets). */
export type SiteChrome = SiteOuvrable & { demande: DemandeAccordSite; empreinte: string };

const uniques = (l: string[]) => [...new Set(l)];

/** Copy of Electron's empreinteDroits (main/sites/fenetres.ts): the fingerprint of the rights the declaration asks for. */
export function empreinteDroits(d: DeclarationSite): string {
  return createHash("sha256").update(JSON.stringify(droitsDe(d))).digest("hex");
}

/** Copy of Electron's demandeAccord (main/sites/fenetres.ts): what the accord card shows. */
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
  /** True if the page was reloaded (Electron's FenetresSites.mettreAJour). */
  mettreAJour(s: SiteChrome, retouches: RetouchesLues): Promise<boolean>;
  rechargerVue(id: string): Promise<void>;
  /** The retouches' console of the open app. */
  erreurs(id: string): Promise<ErreurRetouche[]>;
  /** The view the window shows, or null if it is not open. */
  vue(id: string): Promise<"accueil" | "accord" | "site" | null>;
  /** The choice made on the card (Electron's apresAccord): `s` null for « Ouvrir sans retouches ». */
  apresAccord(id: string, s: SiteChrome | null): Promise<void>;
  /** The state broadcast again (the card up to date). */
  rediffuser(id: string): Promise<void>;
  ouvertes(): Promise<string[]>;
  accueilChange(id: string): void;
  /** A reading of the reference page starts or ends: the bar's button shows it (Electron's FenetresSites.cherche). */
  cherche(id: string, oui: boolean): void;
  /** The bar's mention (Electron's FenetresSites.avis). */
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
  /** « Autoriser » / « Ouvrir sans retouches » on the card (Electron's SitesService.accorder). */
  accorder(id: string, oui: boolean, empreinte: string): Promise<void>;
  /** `webaiosSite` of an open app's main page; the chrome checked the sender, the accord and the address. */
  memoireOp(demande: unknown): Promise<ReponseMemoire>;
  /** A video position of an open app's page (`sites.position`), and the position to resume (`sites.reprise`); the chrome checked the frame. */
  position(demande: unknown): Promise<void>;
  reprise(demande: unknown): Promise<number | null>;
  /** « Chercher la nouvelle adresse », or a site that does not answer (`url`: the page aimed at, else the start address). */
  chercherAdresse(id: string, url: string | null): Promise<void>;
  /** The open apps as last sent to the chrome. */
  sitesOuverts: Map<string, SiteChrome>;
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
 * Copy of Electron's MemoireApplications (main/applications/service.ts), file `sites.json`, 500 ms: what the browser keeps
 * of each site app (window frame, favicon). test/sites-host.test.ts guards the drift.
 */
export class SiteSouvenirs {
  private donnees: Record<string, SouvenirSite> = Object.create(null);
  private minuterie: NodeJS.Timeout | undefined;
  private modifiee = false;
  /** Écritures enchaînées, jamais simultanées. */
  private ecriture: Promise<void> = Promise.resolve();
  private numero = 0;

  constructor(
    private readonly dossier: string,
    private readonly delaiMs = 500,
    private readonly fichier = "sites.json",
  ) {
    try {
      const lu: unknown = JSON.parse(readFileSync(join(dossier, fichier), "utf8"));
      // Sans prototype : un nom d'appli « __proto__ » ou « constructor » reste une simple clé.
      if (lu && typeof lu === "object" && !Array.isArray(lu)) this.donnees = Object.assign(Object.create(null), lu) as Record<string, SouvenirSite>;
    } catch {
      // Absent ou illisible : on repart de zéro (rien d'essentiel n'y est gardé).
    }
  }

  lire(dossier: string): SouvenirSite {
    return this.donnees[dossier] ?? {};
  }

  /** Appli supprimée : plus rien n'en est gardé. */
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

  /** Écrit ce qui a changé ; attend toujours la fin des écritures en cours. */
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

/** L'hôte d'une adresse, ou null. */
function hote(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

const TYPES_ICONE: Record<string, string> = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" };

/**
 * L'icône déclarée par l'appli (`icone`, chemin relatif vers une image), en `data:` ; null si elle manque, sort du dossier
 * (lien, `..`), est un lien, un tube ou dépasse `ICONE_MAX`.
 */
export async function lireIcone(dossier: string, chemin: string): Promise<string | null> {
  const type = TYPES_ICONE[extname(chemin).toLowerCase()];
  if (!type) return null;
  try {
    const fichier = join(dossier, chemin);
    // Un fichier ordinaire, pas un lien ni un tube nommé : lstat avant tout open.
    if (!(await lstat(fichier)).isFile()) return null;
    // Aucun dossier du chemin n'est un lien qui sort du dossier de l'appli.
    const racine = await realpath(dossier);
    if (!(await realpath(fichier)).startsWith(racine + sep)) return null;
    // Sans suivre un lien devenu tel depuis le lstat, et sans attendre un tube.
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
}): SitesHost {
  const dossierSites = join(o.dataDir, "sites");
  const souvenirs = new SiteSouvenirs(o.dataDir);
  const memoires = new Map<string, Promise<MemoireSite>>();
  const lecture = { adressesLocales: o.adressesLocales };
  /** Windows open in the chrome: kept by `ouvrir`/`fermee`, recomputed by `resynchroniser`. */
  let ouvertes = new Set<string>();
  /** The open apps as last sent to the chrome, and their retouches' files (Electron's `retouches`). */
  const sitesOuverts = new Map<string, SiteChrome>();
  const retouches = new Map<string, RetouchesLues>();
  const abonnements = new Map<string, () => void>();
  /** Address follow: the reading under way, the last notice, and the changes made (a reading begun before one is redone). */
  const recherches = new Map<string, AbortController>();
  const derniersAvis = new Map<string, AvisBarre>();
  const changements = new Map<string, number>();
  const suivi = new SuiviAdresse({ lireLiens: o.lireLiens, dossierSites, adressesLocales: o.adressesLocales, maintenant: () => Date.now() });
  const relectures = new Map<string, number>();
  /** Suppressions en cours : une seconde demande pour la même appli ne fait rien. */
  const suppressions = new Set<string>();
  /** Suppressions commencées par appli : une ouverture commencée avant l'une d'elles ne va pas au bout. */
  const suppressionsCommencees = new Map<string, number>();
  /** Ids montrés par la dernière `liste()` : une ligne périmée (dossier renommé depuis) agit encore sur ce qu'elle montrait. */
  let affiches = new Set<string>();
  /** Dernière action ratée par appli (« Supprimer » sans corbeille…), montrée en texte sur sa ligne. */
  const erreursActions = new Map<string, string>();

  // Checked again here, like memoireOp: only an open app whose retouches are granted has positions.
  const accordee = (id: string) => sitesOuverts.get(id)?.accordRequis === false;
  const positions = creerPositions({ memoire: (id) => (accordee(id) ? memoire(id) : Promise.reject(new Error("pas d'accord"))), accorde: accordee });

  const viderMemoire = (id: string) =>
    memoires
      .get(id)
      ?.then((m) => m.vider())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /**
   * L'appli telle qu'elle s'ouvre et ses fichiers de retouches, ou null (absente, site.json invalide, dossier dont le nom
   * n'est pas exactement `id`, ou `encore()` devenu faux après une des lectures).
   */
  async function preparer(id: string, encore: () => boolean = () => true): Promise<{ site: SiteChrome; retouches: RetouchesLues } | null> {
    if (!ID_SITE.test(id)) return null;
    // Un disque insensible à la casse trouverait « MonSite » pour « monsite » : seul le nom exact compte.
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
      // Accords illisibles : l'accord est redemandé (rien n'est injecté sans lui).
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

  /** Les fichiers des retouches ; aucun si l'un d'eux manque ou dépasse les bornes (l'erreur est écrite). */
  async function fichiersRetouches(lu: Extract<SiteLu, { declaration: unknown }>): Promise<RetouchesLues> {
    if (lu.declaration.retouches.length === 0) return { js: {}, css: {} };
    const r = await lireRetouches(lu).catch((e: unknown) => ({ erreur: String(e) }));
    if (!("erreur" in r)) return r;
    console.warn(`[sites] ${lu.id} : retouches non injectées : ${r.erreur}`);
    return { js: {}, css: {} };
  }

  /** Electron's chercherAdresse (service.ts): the reference page says where the site is now; a notice says the result. */
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
   * site.json ou un fichier de retouche a changé : l'appli ouverte est relue, puis sa page rechargée (Electron's relire,
   * without the address tracking and the extensions, later tasks); seule la dernière relecture compte.
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
    // Devenue invalide : plus rien n'est injecté (la fenêtre garde ce qu'elle avait, sans retouches).
    const nouvelles = p ? p.retouches : { js: {}, css: {} };
    // Rien de changé pour la page (dossier recopié, événement en double) : elle n'est pas rechargée.
    const pareil =
      JSON.stringify(nouvelles) === JSON.stringify(retouches.get(id) ?? null) &&
      (!p || JSON.stringify({ ...p.site, aAccueil: null }) === JSON.stringify({ ...avant, aAccueil: null }));
    retouches.set(id, nouvelles);
    if (p) sitesOuverts.set(id, p.site);
    try {
      // Electron reads its retouches map at each injection; the chrome holds its own copy, so it gets the new one even
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
      // La section « Sites » de la page Applications relit la liste (appli écrite, changée ou retirée par l'agent).
      if (quoi === "declaration") o.diffuser();
      if (quoi === "accueil") {
        if (ouvertes.has(id)) o.chrome.accueilChange(id);
      } else void relire(id);
    });
  } catch (e) {
    console.error("[sites] surveillance non démarrée :", e);
  }

  function memoire(id: string): Promise<MemoireSite> {
    // Pendant une suppression, la mémoire n'est ni rouverte ni écrite (memoire.json ne revient pas).
    if (suppressions.has(id)) return Promise.reject(new Error(`appli de site en cours de suppression : ${id}`));
    let m = memoires.get(id);
    if (!m) {
      m = MemoireSite.ouvrir(dossierSites, id);
      memoires.set(id, m);
      // Un id refusé ne reste pas en cache.
      m.catch(() => memoires.delete(id));
    }
    return m;
  }

  /** Le domaine actuel de l'appli (celui de son adresse de départ). */
  async function domaineActuel(id: string): Promise<string> {
    const lu = await lireSite(o.chemins, id, lecture).catch(() => null);
    if (!lu || "erreur" in lu) return "";
    return hote(adresseDeDepart(lu.declaration, await lireEtatAdresse(dossierSites, id))) ?? "";
  }

  const messageMemoire = async (id: string, m: MemoireSite): Promise<MessageVersLAccueil & { type: "memoire" }> => {
    const { valeurs, positions } = m.contenu();
    return { type: "memoire", valeurs, positions, domaine: await domaineActuel(id) };
  };

  /** Le dossier de l'appli existe, et c'est un vrai dossier (jamais un lien). */
  async function dossierReel(id: string): Promise<boolean> {
    try {
      return (await lstat(join(o.chemins.sites, id))).isDirectory();
    } catch {
      return false;
    }
  }

  /** L'appli est-elle une de celles que la section montre : son dossier existe, ou la dernière liste la montrait ? */
  async function connue(id: string): Promise<boolean> {
    return (await dossierReel(id)) || affiches.has(id) || ouvertes.has(id);
  }

  /**
   * « Oublier ce que l'appli a retenu » : la mémoire est effacée (memoire.json supprimé ; l'accueil ouvert reçoit une
   * mémoire vide). Sans fenêtre ouverte, la mémoire n'est pas gardée.
   */
  async function oublier(id: string): Promise<void> {
    if (!(await connue(id))) return;
    positions.annulerNotes(id);
    const m = await memoire(id);
    await m.effacer();
    if (!ouvertes.has(id)) memoires.delete(id);
  }

  /**
   * « Supprimer » : fenêtre fermée (vue détruite) avant que sa session soit effacée, puis mémoire, adresse et accord
   * oubliés, enfin le dossier à la corbeille. Un dossier disparu depuis l'affichage de la ligne : les données sont effacées
   * quand même. Un échec de la corbeille est montré sur la ligne.
   */
  async function supprimer(id: string): Promise<void> {
    if (suppressions.has(id)) return;
    suppressions.add(id);
    suppressionsCommencees.set(id, (suppressionsCommencees.get(id) ?? 0) + 1);
    try {
      if (!(await connue(id))) return;
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
      o.diffuser();
    }
  }

  async function ouvrirParId(id: string): Promise<boolean> {
    // Une suppression commencée pendant une des lectures (même finie depuis) : rien ne s'ouvre.
    const commencees = suppressionsCommencees.get(id) ?? 0;
    const encore = () => !suppressions.has(id) && (suppressionsCommencees.get(id) ?? 0) === commencees;
    if (!encore()) return false;
    const p = await preparer(id, encore);
    if (!p || !encore()) return false;
    relectures.set(id, (relectures.get(id) ?? 0) + 1);
    // Before the window: its first page already asks for its retouches.
    sitesOuverts.set(id, p.site);
    retouches.set(id, p.retouches);
    if (!(await o.chrome.ouvrir(p.site, souvenirs.lire(id).cadre ?? null, p.retouches))) {
      if (!ouvertes.has(id)) forget(id);
      return false;
    }
    // A deletion started while the chrome opened the window (Electron's open was synchronous): close it again.
    if (!encore()) {
      await o.chrome.fermer(id).catch(() => {});
      return false;
    }
    ouvertes.add(id);
    o.diffuser();
    return true;
  }

  /** Les lignes de la section « Sites », et l'empreinte de chaque déclaration valide (pour l'agent seulement). */
  async function lignes(): Promise<(SiteAffiche & { empreinte?: string })[]> {
    const sites = await lireSites(o.chemins, lecture);
    affiches = new Set(sites.map((s) => s.id));
    return Promise.all(
      sites.map(async (s): Promise<SiteAffiche & { empreinte?: string }> => {
        const favicon = souvenirs.lire(s.id).favicon ?? null;
        const erreurAction = erreursActions.get(s.id);
        // Un id refusé par ID_SITE (« MonSite ») ne peut recevoir aucune action : le schéma les rejetterait toutes.
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
        // Abonné une fois par fenêtre ouverte (désabonné à sa fermeture) ; une fenêtre déjà fermée ne l'est pas.
        if (ouvertes.has(id)) abonner(id, m);
        return await messageMemoire(id, m);
      } catch (e) {
        console.error(`[sites] mémoire de ${id} indisponible :`, e);
        return null;
      }
    },
    noter(id, x) {
      // Rien n'est retenu pour une appli en cours de suppression (cadre, favicon) : souvenirs.oublier passe après.
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
    async accorder(id, oui, empreinte) {
      // Taken before any wait: site.json may grow between the card and the click.
      const montree = sitesOuverts.get(id);
      if (!montree || suppressions.has(id) || (await o.chrome.vue(id)) !== "accord") return;
      if (!oui) return o.chrome.apresAccord(id, null);
      // Granted only if its rights are the clicked card's (the agent picks its moment).
      const d = montree.declaration;
      if (empreinteDroits(d) !== empreinte) return o.chrome.rediffuser(id);
      // A reading already under way read the accord from before: it is dropped (and redone once the accord is written).
      relectures.set(id, (relectures.get(id) ?? 0) + 1);
      await accorderSite(o.dataDir, id, d);
      const s = sitesOuverts.get(id);
      // During a deletion nothing is granted (the accord would be that of an app that is leaving).
      if (!s || suppressions.has(id)) return;
      const accorde = droitsDe(d);
      const apres = { ...s, accordRequis: accordNecessaire(s.declaration) && !accordCouvre(accorde, s.declaration) };
      // The chrome's copy is this one: the reading below finds nothing changed and does not reload a second time.
      sitesOuverts.set(id, apres);
      await o.chrome.apresAccord(id, apres);
      void relire(id);
    },
    // Checked again here: only an open app whose retouches are granted has a memory for its page.
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
