import { readFileSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { shell } from "electron";
import {
  accordCouvre,
  accordNecessaire,
  accorderSite,
  droitsDe,
  empreinteExtensionsSite,
  empreinteLectureSite,
  adresseDeDepart,
  adresseRelative,
  adresseSurDomaine,
  domainesEffectifs,
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
  type DroitsSite,
  type RetouchesLues,
  type SiteLu,
} from "@webaios/noyau";
import { CANAUX } from "../../commun/canaux";
import { type AvisBarre, adresseChangee, adresseInchangee, adresseIntrouvable, ECART_OUVERTURE_ACCUEIL_MS, ICONE_MAX, modifierAvecAgent, type ActionSite, type MessageVersLAccueil, type SiteAffiche } from "../../commun/sites";
import { lirePageInvisible } from "../agent/lecture-invisible";
import { imageSite } from "./accueil";
import { requetesDe } from "../image-distante";
import { gardienGestes } from "../agent/geste-widget";
import type { IdFenetre } from "../../commun/modele";
import { MemoireApplications } from "../applications/service";
import type { BrowserWindow, WebContents } from "electron";
import { detruireVue, empreinteDroits, FenetresSites, type ErreurRetouche, type SiteOuvrable } from "./fenetres";
import { brancherInjection, injectionPour, repriseDansCadre } from "./injection";
import { effacerSessionSite, fixerPreloadSite, sessionSite, siteDeSession } from "./session";
import { SuiviAdresse } from "./suivi";

export type { ErreurRetouche };

export interface ServiceSites {
  fenetres: FenetresSites;
  /** Ce que montre la section « Sites » de la page Applications. */
  liste(): Promise<SiteAffiche[]>;
  /**
   * Le nom de chaque appli valide, par id (la page Extensions : « Active dans : … »). Sans effet de bord (C11) : les
   * ids montrés par la section « Sites » ne changent pas.
   */
  noms(): Promise<Record<string, string>>;
  /**
   * La même liste pour l'agent (`lister_sites`, `memoire_site`…), avec l'empreinte de chaque déclaration valide
   * d'aujourd'hui (`empreinteLectureSite`), relue à chaque appel.
   */
  listeAgent(): Promise<(SiteAffiche & { empreinte?: string })[]>;
  /** Une action de la page Applications, venue de la fenêtre `fenetreId`. */
  agir(id: string, a: ActionSite, fenetreId: IdFenetre): Promise<void>;
  /** Ouvre la fenêtre de l'appli (ou la remet devant) ; faux si l'appli n'existe pas ou que son site.json est invalide. */
  ouvrirParId(id: string): Promise<boolean>;
  /** La mémoire de l'appli, ouverte une fois et gardée (écrite à la fermeture de sa fenêtre et à la sortie). */
  memoire(id: string): Promise<MemoireSite>;
  /** La console des retouches de l'appli ouverte (au plus `ERREURS_RETOUCHES_MAX`, gardée jusqu'à sa fermeture). */
  erreurs(id: string): ErreurRetouche[];
  /** L'adresse est-elle sur les domaines de l'appli ouverte ? (navigation demandée par l'agent) */
  adressePermise(id: string, url: string): boolean;
  /**
   * Pour l'écran d'accueil de l'appli ouverte : sa mémoire (valeurs et positions, en lecture) et son domaine actuel. Ses
   * changements sont ensuite envoyés à l'interface de la fenêtre tant qu'elle reste ouverte.
   */
  memoireAccueil(id: string): Promise<MessageVersLAccueil & { type: "memoire" }>;
  /**
   * L'accueil demande une adresse : sur le domaine actuel, juste après un vrai geste de l'utilisateur dans l'accueil (consommé),
   * une par `ECART_OUVERTURE_ACCUEIL_MS` ; faux si refusée (sans geste, en silence).
   */
  ouvrirDepuisAccueil(id: string, adresse: string): boolean;
  /**
   * La carte d'accord des retouches de l'appli ouverte. oui : si `empreinte` (celle de la carte cliquée) est encore celle
   * des droits de la déclaration, ils sont retenus (`<profil>/sites-accords.json`), puis la vue suivante avec retouches ;
   * sinon rien n'est accordé et la carte à jour est rediffusée. non : la vue suivante sans retouches ni reprise, pour
   * cette ouverture seulement. Rien si la carte n'est pas affichée.
   */
  accorder(id: string, oui: boolean, empreinte: string): Promise<void>;
  /** Vrai appui de l'utilisateur dans le cadre de l'accueil de l'appli (vu par le preload de ce cadre). */
  gesteAccueil(id: string): void;
  /** Une image d'un domaine de l'appli, en `data:` (session de l'appli) ; null si refusée. */
  imageAccueil(id: string, url: string): Promise<string | null>;
  /** À la sortie : fenêtres fermées (cadres notés), mémoires écrites. */
  arreter(): Promise<void>;
}

/** Images de l'accueil chargées en même temps par appli ; les autres attendent leur tour. */
const IMAGES_EN_MEME_TEMPS = 4;
/** Demandes d'images en attente par appli : au-delà, refusées (un accueil qui en demande des milliers). */
const IMAGES_EN_ATTENTE_MAX = 200;

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

/**
 * Les applis de site de l'espace (`~/WebAiOs/sites/<id>/`, écrites par l'agent, jamais par WebAiOs) et leurs fenêtres.
 * Ce que WebAiOs en retient est dans le profil : `<profil>/sites/<id>/` (mémoire, adresse actuelle), `<profil>/sites.json`
 * (cadre de fenêtre, favicon) et `<profil>/sites-accords.json`.
 */
export function demarrerSites(o: {
  chemins: CheminsEspace;
  dossierProfil: string;
  /** `out/preload/site.js`, enregistré sur les seules sessions `persist:site-<id>`. */
  preloadSite: string;
  /** La garde des extensions de l'agent (`webaios-garde-page.js` du noyau), lue une fois, posée avant les retouches. */
  cheminGarde: string;
  /** Tests (`WEBAIOS_TEST_ADRESSES_LOCALES=1`) : http et hôtes locaux permis. */
  adressesLocales: boolean;
  /** Ouvre l'URL dans un onglet de la fenêtre principale active (« Ouvrir dans un onglet »). */
  ouvrirOnglet(url: string): void;
  /** Pré-remplit le terminal de l'agent de la fenêtre (« Modifier avec l'agent »). */
  deboguer(fenetreId: IdFenetre, texte: string): void;
  /** La liste ou l'état des applis de site a changé. */
  diffuser(): void;
  /** La fenêtre de l'appli s'est fermée (l'agent perd ses outils de développement dessus, ses cartes tombent). */
  surFermee?(id: string): void;
  /** Une suppression commence : l'accord de lecture de l'agent sur l'appli tombe (une appli recréée le redemande). */
  surSupprimee?(id: string): void;
  /** Ce que montre la fenêtre de l'appli change sous le mode design (accueil, carte, plein écran, menu « Extensions »). */
  surInterruption?(id: string): void;
  /**
   * Les extensions du Store activées dans l'appli (plan 16, `ServiceExtensions`). `ouverture` : l'appli s'ouvre, ou
   * les domaines de son site.json changent (`empreinteExtensionsSite`) ; attendue, sans limite de temps, avant la
   * première page. `fermeture` : la fenêtre est fermée (ou l'ouverture abandonnée, C3). `suppression` : « Supprimer »,
   * entre la fermeture de la fenêtre et l'effacement de la session. `surVue` : la vue du site, son seul onglet (C2).
   */
  extensions?: {
    ouverture(id: string, empreinte: string): Promise<void>;
    fermeture(id: string): void;
    suppression(id: string): Promise<void>;
    surVue?(id: string, quoi: "creee" | "detruite", wc: WebContents, fenetre: BrowserWindow): void;
  };
}): ServiceSites {
  fixerPreloadSite(o.preloadSite);
  const garde = readFileSync(o.cheminGarde, "utf8");
  const dossierSites = join(o.dossierProfil, "sites");
  const souvenirs = new MemoireApplications(o.dossierProfil, 500, "sites.json");
  const memoires = new Map<string, Promise<MemoireSite>>();
  const lecture = { adressesLocales: o.adressesLocales };

  const viderMemoire = (id: string) =>
    memoires
      .get(id)
      ?.then((m) => m.vider())
      .catch((e) => console.error(`[sites] mémoire de ${id} non écrite :`, e));

  /** Désabonnements des changements de mémoire envoyés à l'accueil, par appli ouverte. */
  const abonnements = new Map<string, () => void>();
  /** Derniers vrais gestes de l'utilisateur dans l'accueil, par appli (un geste permet une seule ouverture). */
  const gestes = gardienGestes<string>();
  /** Dernière adresse ouverte par l'accueil, par appli. */
  const derniereOuverture = new Map<string, number>();
  /** Images de l'accueil : chargements en cours et en attente, par appli. */
  const images = new Map<string, { enCours: number; attente: (() => void)[] }>();
  /** Les fichiers des retouches de chaque appli ouverte, lus à l'ouverture et à chaque changement (l'injection est synchrone). */
  const retouches = new Map<string, RetouchesLues>();
  /** Relectures en cours, par appli : seule la dernière compte. */
  const relectures = new Map<string, number>();
  /** Lecture de la page de référence en cours, par appli : annulée à la fermeture de la fenêtre et à la sortie. */
  const recherches = new Map<string, AbortController>();
  /** Le dernier résultat du suivi montré dans la barre, par appli (redonné quand une demande arrive trop tôt). */
  const derniersAvis = new Map<string, AvisBarre>();
  /** Nombre de changements d'adresse par appli : une relecture de site.json commencée avant l'un d'eux est refaite. */
  const changements = new Map<string, number>();
  /** Suppressions en cours : une seconde demande pour la même appli ne fait rien. */
  const suppressions = new Set<string>();
  /** Suppressions commencées par appli : une ouverture commencée avant l'une d'elles ne va pas au bout. */
  const suppressionsCommencees = new Map<string, number>();
  /** Ids montrés par la dernière `liste()` : une ligne périmée (dossier renommé depuis) agit encore sur ce qu'elle montrait. */
  let affiches = new Set<string>();
  /** Dernière action ratée par appli (« Supprimer » sans corbeille…), montrée en texte sur sa ligne. */
  const erreursActions = new Map<string, string>();
  /** L'empreinte des domaines donnée aux extensions pour chaque appli ouverte (`ouverture`). */
  const empreintesExtensions = new Map<string, string>();
  /** M4 : la synchronisation des extensions lancée par une relecture, en cours : toute relecture l'attend avant de recharger. */
  const synchrosExtensions = new Map<string, Promise<void>>();
  /** M3 : fermetures (pour les extensions) par appli : une ouverture qui en voit une pendant son attente redonne l'empreinte. */
  const fermeturesExtensions = new Map<string, number>();

  /** Les extensions de l'appli, pour cette empreinte (une erreur est journalisée : l'appli s'ouvre quand même). */
  async function ouvertureExtensions(id: string, empreinte: string): Promise<void> {
    if (!o.extensions) return;
    try {
      await o.extensions.ouverture(id, empreinte);
    } catch (e) {
      console.error(`[sites] ${id} : extensions non préparées :`, e);
    }
  }
  const fermetureExtensions = (id: string) => {
    empreintesExtensions.delete(id);
    fermeturesExtensions.set(id, (fermeturesExtensions.get(id) ?? 0) + 1);
    try {
      o.extensions?.fermeture(id);
    } catch (e) {
      console.error(`[sites] ${id} : extensions non fermées :`, e);
    }
  };

  const fenetres = new FenetresSites({
    // Rien n'est retenu pour une appli en cours de suppression (cadre, favicon) : souvenirs.oublier passe après.
    memoire: {
      lire: (id) => souvenirs.lire(id),
      noter: (id, x) => {
        if (!suppressions.has(id)) souvenirs.noter(id, x);
      },
    },
    adressesLocales: o.adressesLocales,
    ouvrirOnglet: o.ouvrirOnglet,
    surFermee: (id) => {
      abonnements.get(id)?.();
      abonnements.delete(id);
      derniereOuverture.delete(id);
      retouches.delete(id);
      relectures.delete(id);
      recherches.get(id)?.abort();
      recherches.delete(id);
      derniersAvis.delete(id);
      fermetureExtensions(id);
      void viderMemoire(id);
      o.diffuser();
      o.surFermee?.(id);
    },
    surFavicon: () => o.diffuser(),
    surSuivi: (id, url) => void chercherAdresse(id, url),
    ...(o.extensions?.surVue ? { surVue: o.extensions.surVue } : {}),
    ...(o.surInterruption ? { surInterruption: (id: string) => o.surInterruption?.(id) } : {}),
  });

  // La page de référence est lue par la session publique, sans profil : jamais un cookie de l'appli ni de l'utilisateur.
  const suivi = new SuiviAdresse({
    lireLiens: async (page, signal) =>
      (
        await lirePageInvisible(
          page,
          { profil: null, ...(o.adressesLocales ? { adressesLocales: true } : {}), ...(signal ? { signal } : {}) },
          {
            etat: () => {
              throw new Error("lecture publique : pas de profil");
            },
            sessionProfil: () => {
              throw new Error("lecture publique : pas de profil");
            },
          },
        )
      ).liens.map((l) => l.url),
    dossierSites,
    adressesLocales: o.adressesLocales,
    maintenant: () => Date.now(),
  });

  /**
   * Le site ne répond plus (ou renvoie hors de ses domaines, ou l'utilisateur le demande) : la page de référence dit où il est
   * maintenant. `url` : la page visée, reprise sur le nouveau domaine. Un avis dit le résultat ; trop tôt, rien.
   */
  async function chercherAdresse(id: string, url: string | null): Promise<void> {
    const s = fenetres.site(id);
    const d = s?.declaration;
    if (!s || !d?.suiviAdresse || suppressions.has(id)) return;
    // Une lecture est déjà en cours : le suivi répondra « trop-tot » sans la doubler.
    const enCours = recherches.has(id);
    const controle = new AbortController();
    if (!enCours) {
      recherches.set(id, controle);
      fenetres.cherche(id, true);
    }
    const r = await suivi.chercher(id, d, controle.signal).catch((): { t: "introuvable" } => ({ t: "introuvable" }));
    if (!enCours) {
      if (recherches.get(id) === controle) recherches.delete(id);
      if (!controle.signal.aborted) fenetres.cherche(id, false);
    }
    // Fenêtre fermée (ou sortie) pendant la lecture : ce qui arrive après est ignoré.
    const courante = fenetres.site(id);
    if (controle.signal.aborted || !courante) return;
    const notifier = (a: AvisBarre) => {
      derniersAvis.set(id, a);
      fenetres.avis(id, a);
    };
    switch (r.t) {
      case "trop-tot": {
        // Rien de nouveau : le dernier résultat revient dans la barre, s'il y en a un.
        const dernier = derniersAvis.get(id);
        if (dernier) fenetres.avis(id, dernier);
        return;
      }
      case "introuvable":
        return notifier({ genre: "introuvable", texte: adresseIntrouvable(hote(d.suiviAdresse.page) ?? d.suiviAdresse.page) });
      case "inchangee":
        return notifier({ genre: "inchangee", texte: adresseInchangee(d.nom) });
      case "change": {
        // La déclaration d'aujourd'hui (site.json a pu être relu pendant la lecture).
        const decl = courante.declaration;
        const domaines = domainesEffectifs(decl, r.etat);
        const depart = adresseDeDepart(decl, r.etat);
        // La même page sur le nouveau domaine, sinon l'adresse de départ.
        const relative = url ? adresseRelative(url, domaines) : null;
        const vers = (relative && adresseSurDomaine(relative, r.domaine, domaines, depart, lecture)) || depart;
        changements.set(id, (changements.get(id) ?? 0) + 1);
        fenetres.adresseChangee(id, domaines, depart, vers);
        notifier({ genre: "adresse-changee", texte: adresseChangee(d.nom, r.domaine) });
        // L'accueil montre le nouveau domaine.
        if (abonnements.has(id)) void memoire(id).then((m) => fenetres.envoyer(id, CANAUX.siteAccueilMemoireChange, messageMemoire(id, m)), () => {});
      }
    }
  }

  /**
   * L'appli telle qu'elle s'ouvre et ses fichiers de retouches, ou null (absente, site.json invalide, dossier dont le nom
   * n'est pas exactement `id`, ou `encore()` devenu faux après une des lectures).
   */
  async function preparer(id: string, encore: () => boolean = () => true): Promise<{ site: SiteOuvrable; retouches: RetouchesLues } | null> {
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
      const accords = await lireAccordsSites(o.dossierProfil);
      accord = Object.hasOwn(accords, id) ? (accords[id] ?? null) : null;
    } catch (e) {
      // Accords illisibles : l'accord est redemandé (rien n'est injecté sans lui).
      console.error("[sites] accords illisibles :", e);
    }
    if (!encore()) return null;
    const fichiers = await fichiersRetouches(lu);
    if (!encore()) return null;
    return {
      site: {
        id,
        declaration: d,
        aAccueil: lu.aAccueil,
        domaines: domainesEffectifs(d, etat),
        depart: adresseDeDepart(d, etat),
        accordRequis: accordNecessaire(d) && !accordCouvre(accord, d),
      },
      retouches: fichiers,
    };
  }

  /** Les fichiers des retouches ; aucun si l'un d'eux manque ou dépasse les bornes (l'erreur est écrite). */
  async function fichiersRetouches(lu: Extract<SiteLu, { declaration: unknown }>): Promise<RetouchesLues> {
    if (lu.declaration.retouches.length === 0) return { js: {}, css: {} };
    const r = await lireRetouches(lu).catch((e: unknown) => ({ erreur: String(e) }));
    if (!("erreur" in r)) return r;
    console.warn(`[sites] ${lu.id} : retouches non injectées : ${r.erreur}`);
    return { js: {}, css: {} };
  }

  /** site.json ou un fichier de retouche a changé : l'appli ouverte est relue, puis sa page rechargée. */
  async function relire(id: string): Promise<void> {
    if (!fenetres.site(id)) return;
    const n = (relectures.get(id) ?? 0) + 1;
    relectures.set(id, n);
    const changementsAvant = changements.get(id) ?? 0;
    const p = await preparer(id).catch((e: unknown) => {
      console.error(`[sites] ${id} illisible :`, e);
      return null;
    });
    const avant = fenetres.site(id);
    if (relectures.get(id) !== n || !avant) return;
    // Le site a changé d'adresse pendant la lecture : ses domaines seraient ceux d'avant, on relit.
    if ((changements.get(id) ?? 0) !== changementsAvant) return relire(id);
    // Les domaines de site.json ont changé : les extensions de l'appli suivent (une activation pour d'autres domaines ne
    // charge plus rien) avant que la page ne soit rechargée. Devenu invalide (C14) : l'empreinte d'avant reste.
    const empreinte = p ? empreinteExtensionsSite(p.site.declaration) : null;
    if (empreinte !== null && empreinte !== empreintesExtensions.get(id)) {
      empreintesExtensions.set(id, empreinte);
      const synchro: Promise<void> = ouvertureExtensions(id, empreinte).finally(() => {
        if (synchrosExtensions.get(id) === synchro) synchrosExtensions.delete(id);
      });
      synchrosExtensions.set(id, synchro);
    }
    // Celle-ci, ou celle d'une relecture précédente encore en cours (même empreinte) : la page n'est rechargée qu'après.
    const enCours = synchrosExtensions.get(id);
    if (enCours) {
      await enCours;
      if (relectures.get(id) !== n || !fenetres.site(id)) return;
      if ((changements.get(id) ?? 0) !== changementsAvant) return relire(id);
    }
    // Devenue invalide : plus rien n'est injecté (la fenêtre garde ce qu'elle avait, sans retouches).
    const nouvelles = p ? p.retouches : { js: {}, css: {} };
    // Rien de changé pour la page (dossier recopié, événement en double) : elle n'est pas rechargée.
    const pareil =
      JSON.stringify(nouvelles) === JSON.stringify(retouches.get(id) ?? null) &&
      (!p || JSON.stringify({ ...p.site, aAccueil: null }) === JSON.stringify({ ...avant, aAccueil: null }));
    retouches.set(id, nouvelles);
    // La carte qui revient recharge déjà la page (sans retouches) : pas une seconde fois.
    const rechargee = p ? fenetres.mettreAJour(p.site) : false;
    if (!pareil && !rechargee) fenetres.rechargerVue(id);
  }

  const arreterSurveillance = surveillerSites(o.chemins, (id, quoi) => {
    // La section « Sites » de la page Applications relit la liste (appli écrite, changée ou retirée par l'agent).
    if (quoi === "declaration") o.diffuser();
    if (quoi !== "accueil") void relire(id);
  });

  const notes = brancherInjection({
    siteDeSession,
    vue: (id) => fenetres.vueSite(id),
    injection(id, cadre) {
      const s = fenetres.site(id);
      const r = retouches.get(id);
      if (!s || !r) return null;
      return injectionPour({ site: s, retouches: r, accorde: !s.accordRequis, garde, adressesLocales: o.adressesLocales }, cadre);
    },
    accorde: (id) => fenetres.site(id)?.accordRequis === false,
    reprise(id, cadre) {
      const s = fenetres.site(id);
      return !!s && repriseDansCadre(s.declaration, cadre, o.adressesLocales === true);
    },
    memoire,
    adresseRelative(id, url) {
      const s = fenetres.site(id);
      return s ? adresseRelative(url, s.domaines) : null;
    },
  });

  /** Le domaine actuel de l'appli ouverte (celui de son adresse de départ). */
  const domaineActuel = (id: string) => {
    const s = fenetres.site(id);
    return (s && hote(s.depart)) ?? "";
  };

  const messageMemoire = (id: string, m: MemoireSite): MessageVersLAccueil & { type: "memoire" } => {
    const { valeurs, positions } = m.contenu();
    return { type: "memoire", valeurs, positions, domaine: domaineActuel(id) };
  };

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

  /** Une place parmi les chargements d'images de l'appli ; false si trop de demandes attendent déjà. */
  async function placeImage(id: string): Promise<boolean> {
    let f = images.get(id);
    if (!f) images.set(id, (f = { enCours: 0, attente: [] }));
    if (f.enCours < IMAGES_EN_MEME_TEMPS) {
      f.enCours++;
      return true;
    }
    if (f.attente.length >= IMAGES_EN_ATTENTE_MAX) return false;
    const file = f;
    // La place est transmise par celui qui la libère (enCours ne change pas).
    await new Promise<void>((ok) => file.attente.push(ok));
    return true;
  }
  function libererImage(id: string): void {
    const f = images.get(id);
    if (!f) return;
    const suivant = f.attente.shift();
    if (suivant) return suivant();
    f.enCours--;
    if (f.enCours === 0) images.delete(id);
  }

  /**
   * « Oublier ce que l'appli a retenu » : les notes de positions en attente sont abandonnées, puis la mémoire est effacée
   * (memoire.json supprimé ; l'accueil ouvert reçoit une mémoire vide). Sans fenêtre ouverte, la mémoire n'est pas gardée.
   */
  async function oublier(id: string): Promise<void> {
    if (!(await connue(id))) return;
    notes.annulerNotes(id);
    const m = await memoire(id);
    await m.effacer();
    if (!fenetres.site(id)) memoires.delete(id);
  }

  /** L'appli est-elle une de celles que la section montre : son dossier existe, ou la dernière liste la montrait ? */
  async function connue(id: string): Promise<boolean> {
    return (await dossierReel(id)) || affiches.has(id) || !!fenetres.site(id);
  }

  /** Le dossier de l'appli existe, et c'est un vrai dossier (jamais un lien). */
  async function dossierReel(id: string): Promise<boolean> {
    try {
      return (await lstat(join(o.chemins.sites, id))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * « Supprimer » : lecture d'adresse annulée, notes abandonnées, fenêtre fermée (vue détruite) avant que sa session soit
   * effacée, puis mémoire, adresse et accord oubliés, enfin le dossier à la corbeille. Une appli recréée au même id repart
   * vide. WebAiOs n'écrit rien d'autre dans ~/WebAiOs/sites/<id>/. Un dossier disparu depuis l'affichage de la ligne :
   * les données sont effacées quand même. Un échec de la corbeille est montré sur la ligne.
   */
  async function supprimer(id: string): Promise<void> {
    if (suppressions.has(id)) return;
    suppressions.add(id);
    suppressionsCommencees.set(id, (suppressionsCommencees.get(id) ?? 0) + 1);
    try {
      if (!(await connue(id))) return;
      o.surSupprimee?.(id);
      recherches.get(id)?.abort();
      notes.annulerNotes(id);
      // La vue est détruite, ou le délai est passé (`restante`, détruite après l'effacement de la session).
      const restante = await fenetres.fermer(id);
      // Les extensions : l'appli n'y est plus ouverte (avant tout retrait, sans attendre la fermeture), puis elle les
      // quitte et leur stockage est effacé dans sa session, avant que la session elle-même ne le soit.
      fermetureExtensions(id);
      if (o.extensions) {
        try {
          await o.extensions.suppression(id);
        } catch (e) {
          console.error(`[sites] ${id} : extensions non retirées :`, e);
        }
      }
      const m = memoires.get(id);
      if (m) await m.then((x) => x.effacer(), () => {});
      memoires.delete(id);
      suivi.oublier(id);
      try {
        await effacerSessionSite(id);
      } finally {
        if (restante) detruireVue(restante);
      }
      await supprimerDonneesSite(o.dossierProfil, id);
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
    // Une suppression commencée pendant une des lectures (même finie depuis) : rien ne s'ouvre, l'accord lu était le sien.
    const commencees = suppressionsCommencees.get(id) ?? 0;
    const encore = () => !suppressions.has(id) && (suppressionsCommencees.get(id) ?? 0) === commencees;
    if (!encore()) return false;
    const p = await preparer(id, encore);
    if (!p || !encore()) return false;
    // Les extensions de l'appli, avant sa première page (l'attente n'a pas de limite, comme au démarrage de WebAiOs).
    if (o.extensions) {
      const empreinte = empreinteExtensionsSite(p.site.declaration);
      // M3 : une fenêtre de l'appli fermée pendant l'attente (la sienne, ou celle d'une ouverture concurrente) a oublié
      // l'empreinte : elle est redonnée pour la fenêtre qui va s'ouvrir.
      let fermees = fermeturesExtensions.get(id) ?? 0;
      await ouvertureExtensions(id, empreinte);
      while (encore() && (fermeturesExtensions.get(id) ?? 0) !== fermees) {
        fermees = fermeturesExtensions.get(id) ?? 0;
        await ouvertureExtensions(id, empreinte);
      }
      if (!encore()) {
        // C3 : l'ouverture est abandonnée ; une appli qui n'est pas ouverte n'a plus rien à recevoir.
        if (!fenetres.site(id)) fermetureExtensions(id);
        return false;
      }
      empreintesExtensions.set(id, empreinte);
    }
    // Avant la fenêtre : le premier chargement de la page demande déjà ses retouches.
    retouches.set(id, p.retouches);
    relectures.set(id, (relectures.get(id) ?? 0) + 1);
    fenetres.ouvrir(p.site);
    o.diffuser();
    return true;
  }

  /** Les lignes de la section « Sites », et l'empreinte de chaque déclaration valide (pour l'agent seulement). */
  async function lignes(): Promise<(SiteAffiche & { empreinte?: string })[]> {
    const sites = await lireSites(o.chemins, lecture);
    affiches = new Set(sites.map((s) => s.id));
    const ouvertes = new Set(fenetres.ouvertes().map((f) => f.id));
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

  return {
    fenetres,
    async liste() {
      return (await lignes()).map(({ empreinte: _, ...l }) => l);
    },
    async noms() {
      const r: Record<string, string> = {};
      for (const s of await lireSites(o.chemins, lecture)) if (!("erreur" in s)) r[s.id] = s.declaration.nom;
      return r;
    },
    listeAgent: lignes,
    async agir(id, a, fenetreId) {
      if (!ID_SITE.test(id)) return;
      erreursActions.delete(id);
      switch (a) {
        case "ouvrir":
          if (!(await ouvrirParId(id))) console.warn(`[sites] ${id} ne peut pas s'ouvrir`);
          return;
        case "modifier":
          o.deboguer(fenetreId, modifierAvecAgent(id));
          return;
        case "oublier":
          return oublier(id);
        case "dossier":
          shell.showItemInFolder(join(o.chemins.sites, id));
          return;
        case "supprimer":
          return supprimer(id);
      }
    },
    ouvrirParId,
    memoire,
    erreurs: (id) => fenetres.erreursRetouches(id),
    adressePermise: (id, url) => fenetres.adressePermise(id, url),
    async memoireAccueil(id) {
      const m = await memoire(id);
      // Abonné une fois par fenêtre ouverte (désabonné à sa fermeture) ; une fenêtre déjà fermée ne l'est pas.
      if (!abonnements.has(id) && fenetres.site(id)) {
        abonnements.set(
          id,
          m.surChange(() => fenetres.envoyer(id, CANAUX.siteAccueilMemoireChange, messageMemoire(id, m))),
        );
      }
      return messageMemoire(id, m);
    },
    ouvrirDepuisAccueil(id, adresse) {
      const s = fenetres.site(id);
      if (!s) return false;
      const maintenant = Date.now();
      if (maintenant - (derniereOuverture.get(id) ?? -Infinity) < ECART_OUVERTURE_ACCUEIL_MS) return false;
      const url = adresseSurDomaine(adresse, hote(s.depart) ?? "", s.domaines, s.depart, lecture);
      // Sans geste récent de l'utilisateur dans l'accueil, rien ne s'ouvre : sinon un accueil qui ouvre une adresse dès son
      // chargement renverrait sur le site à chaque ⌂.
      if (!url || !gestes.accepter(id, id) || !fenetres.depuisAccueil(id, url)) return false;
      derniereOuverture.set(id, maintenant);
      return true;
    },
    async accorder(id, oui, empreinte) {
      const montree = fenetres.site(id);
      // Pendant une suppression, rien n'est accordé (l'accord serait celui d'une appli qui s'en va).
      if (!montree || suppressions.has(id) || fenetres.etat(id)?.vue !== "accord") return;
      if (!oui) return fenetres.apresAccord(id, null);
      // La déclaration connue du main, prise avant toute attente, n'est accordée que si ses droits sont ceux de la carte
      // cliquée : site.json a pu grandir entre l'affichage et le clic (l'agent choisit son moment).
      const d = montree.declaration;
      if (empreinteDroits(d) !== empreinte) return fenetres.rediffuser(id);
      // Une relecture déjà en cours a lu l'accord d'avant : elle est jetée (et refaite une fois l'accord écrit).
      relectures.set(id, (relectures.get(id) ?? 0) + 1);
      await accorderSite(o.dossierProfil, id, d);
      const s = fenetres.site(id);
      if (!s || suppressions.has(id)) return;
      const accorde = droitsDe(d);
      fenetres.apresAccord(id, { ...s, accordRequis: accordNecessaire(s.declaration) && !accordCouvre(accorde, s.declaration) });
      void relire(id);
    },
    gesteAccueil(id) {
      if (fenetres.site(id)) gestes.geste(id, id);
    },
    async imageAccueil(id, url) {
      const s = fenetres.site(id);
      if (!s || !(await placeImage(id))) return null;
      try {
        // Domaines relus à chaque image : l'appli a pu être rouverte avec d'autres entre-temps.
        const domaines = fenetres.site(id)?.domaines;
        return domaines ? await imageSite(requetesDe(sessionSite(id)), url, domaines) : null;
      } finally {
        libererImage(id);
      }
    },
    async arreter() {
      try {
        for (const c of recherches.values()) c.abort();
        await arreterSurveillance().catch(() => {});
        await Promise.allSettled(fenetres.ouvertes().map((f) => fenetres.fermer(f.id)));
        await Promise.allSettled([...memoires.keys()].map(viderMemoire));
      } finally {
        await souvenirs.vider();
      }
    },
  };
}
