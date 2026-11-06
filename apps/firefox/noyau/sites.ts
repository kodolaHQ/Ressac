import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import fs, { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { z } from "zod";
import {
  accordCouvre,
  accordNecessaire,
  adresseDeDepart,
  domainesEffectifs,
  empreinteLectureSite,
  ID_SITE,
  lireAccordsSites,
  lireEtatAdresse,
  lireSite,
  lireSites,
  MemoireSite,
  supprimerDonneesSite,
  surveillerSites,
  type CheminsEspace,
  type DroitsSite,
  type OutilsSites,
} from "../../../packages/noyau/src/index.ts";
import { ICONE_MAX, modifierAvecAgent, type ActionSite, type MessageVersLAccueil, type SiteAffiche } from "../../navigateur/src/commun/sites.ts";
import type { Cadre } from "../../navigateur/src/commun/modele.ts";
import type { SiteOuvrable } from "../../navigateur/src/main/sites/fenetres.ts";

// The pure parts of Electron's main/sites/service.ts, copied: it imports electron, so the Node host cannot import it.
// Same guards, same counters, same messages. Left to plan 32: retouches, injection, address tracking, accord, extensions.

/** Electron's IPC schema of a site app action (commun/api.ts, which Node cannot import): test/sites-host.test.ts compares them. */
export const SchemaActionSite = z.object({
  id: z.string().regex(ID_SITE),
  action: z.enum(["ouvrir", "modifier", "oublier", "dossier", "supprimer", "relire"]),
});

/** Requests host -> chrome: the window itself lives in the chrome. */
export interface SitesChrome {
  ouvrir(s: SiteOuvrable, cadre?: Cadre): Promise<boolean>;
  fermer(id: string): Promise<void>;
  effacer(id: string): Promise<void>;
  mettreAJour(s: SiteOuvrable): Promise<void>;
  ouvertes(): Promise<string[]>;
  accueilChange(id: string): void;
}

export interface SitesHost {
  liste(): Promise<SiteAffiche[]>;
  listeAgent(): Promise<(SiteAffiche & { empreinte?: string })[]>;
  ouvrirParId(id: string): Promise<boolean>;
  agir(id: string, action: ActionSite, fenetre: string): Promise<void>;
  memoireAccueil(id: string): Promise<(MessageVersLAccueil & { type: "memoire" }) | null>;
  noter(id: string, x: { cadre?: Cadre; favicon?: string }): void;
  fermee(id: string): void;
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
  const abonnements = new Map<string, () => void>();
  const relectures = new Map<string, number>();
  /** Suppressions en cours : une seconde demande pour la même appli ne fait rien. */
  const suppressions = new Set<string>();
  /** Suppressions commencées par appli : une ouverture commencée avant l'une d'elles ne va pas au bout. */
  const suppressionsCommencees = new Map<string, number>();
  /** Ids montrés par la dernière `liste()` : une ligne périmée (dossier renommé depuis) agit encore sur ce qu'elle montrait. */
  let affiches = new Set<string>();
  /** Dernière action ratée par appli (« Supprimer » sans corbeille…), montrée en texte sur sa ligne. */
  const erreursActions = new Map<string, string>();

  const viderMemoire = (id: string) =>
    memoires
      .get(id)
      ?.then((m) => m.vider())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /** L'appli telle qu'elle s'ouvre, ou null (absente, site.json invalide, dossier dont le nom n'est pas exactement `id`, ou `encore()` devenu faux). */
  async function preparer(id: string, encore: () => boolean = () => true): Promise<SiteOuvrable | null> {
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
    return {
      id,
      declaration: d,
      aAccueil: lu.aAccueil,
      domaines: domainesEffectifs(d, etat),
      depart: adresseDeDepart(d, etat),
      accordRequis: accordNecessaire(d) && !accordCouvre(accord, d),
    };
  }

  /** site.json a changé : l'appli ouverte est relue et la fenêtre mise à jour ; seule la dernière relecture compte. */
  async function relire(id: string): Promise<void> {
    if (!ouvertes.has(id)) return;
    const n = (relectures.get(id) ?? 0) + 1;
    relectures.set(id, n);
    const p = await preparer(id).catch((e: unknown) => {
      console.error(`[sites] ${id} illisible :`, e);
      return null;
    });
    if (relectures.get(id) !== n || !ouvertes.has(id) || !p) return;
    await o.chrome.mettreAJour(p).catch((e) => console.error(`[sites] ${id} non mise à jour :`, e));
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
      await o.chrome.fermer(id);
      ouvertes.delete(id);
      await o.chrome.effacer(id);
      const m = memoires.get(id);
      if (m) await m.then((x) => x.effacer(), () => {});
      memoires.delete(id);
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
    const site = await preparer(id, encore);
    if (!site || !encore()) return false;
    relectures.set(id, (relectures.get(id) ?? 0) + 1);
    if (!(await o.chrome.ouvrir(site, souvenirs.lire(id).cadre))) return false;
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

  const liste = async () => (await lignes()).map(({ empreinte: _, ...l }) => l);

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
        if (!abonnements.has(id) && ouvertes.has(id)) {
          abonnements.set(
            id,
            m.surChange(() => void messageMemoire(id, m).then((msg) => o.notifierMemoire(id, msg), () => {})),
          );
        }
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
      ouvertes.delete(id);
      abonnements.get(id)?.();
      abonnements.delete(id);
      relectures.delete(id);
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
      // Retouches are plan 32: no console yet.
      erreurs: async (id) => ((await liste()).some((s) => s.id === id) ? [] : null),
    },
    async resynchroniser() {
      ouvertes = new Set(await o.chrome.ouvertes());
    },
    async arreter() {
      try {
        await arreterSurveillance().catch(() => {});
        await Promise.allSettled([...memoires.keys()].map(viderMemoire));
      } finally {
        await souvenirs.vider();
      }
    },
  };
}
