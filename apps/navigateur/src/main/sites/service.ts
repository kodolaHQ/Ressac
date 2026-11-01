import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  accordCouvre,
  accordNecessaire,
  accorderSite,
  droitsDe,
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
  surveillerSites,
  type CheminsEspace,
  type DroitsSite,
  type RetouchesLues,
  type SiteLu,
} from "@webaios/noyau";
import { CANAUX } from "../../commun/canaux";
import { type AvisBarre, adresseChangee, adresseInchangee, adresseIntrouvable, ECART_OUVERTURE_ACCUEIL_MS, type ActionSite, type MessageVersLAccueil, type SiteAffiche } from "../../commun/sites";
import { lirePageInvisible } from "../agent/lecture-invisible";
import { imageSite } from "./accueil";
import { requetesDe } from "../image-distante";
import { gardienGestes } from "../agent/geste-widget";
import type { IdFenetre } from "../../commun/modele";
import { MemoireApplications } from "../applications/service";
import { empreinteDroits, FenetresSites, type ErreurRetouche, type SiteOuvrable } from "./fenetres";
import { brancherInjection, injectionPour, repriseDansCadre } from "./injection";
import { fixerPreloadSite, sessionSite, siteDeSession } from "./session";
import { SuiviAdresse } from "./suivi";

export type { ErreurRetouche };

export interface ServiceSites {
  fenetres: FenetresSites;
  /** Ce que montre la section « Sites » de la page Applications. */
  liste(): Promise<SiteAffiche[]>;
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

  const fenetres = new FenetresSites({
    memoire: souvenirs,
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
      void viderMemoire(id);
      o.diffuser();
    },
    surFavicon: () => o.diffuser(),
    surSuivi: (id, url) => void chercherAdresse(id, url),
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
    if (!s || !d?.suiviAdresse) return;
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
   * n'est pas exactement `id`).
   */
  async function preparer(id: string): Promise<{ site: SiteOuvrable; retouches: RetouchesLues } | null> {
    if (!ID_SITE.test(id)) return null;
    // Un disque insensible à la casse trouverait « MonSite » pour « monsite » : seul le nom exact compte.
    const noms = await readdir(o.chemins.sites).catch(() => [] as string[]);
    if (!noms.includes(id)) return null;
    const lu = await lireSite(o.chemins, id, lecture);
    if (!lu || "erreur" in lu) return null;
    const d = lu.declaration;
    const etat = await lireEtatAdresse(dossierSites, id);
    let accord: DroitsSite | null = null;
    try {
      const accords = await lireAccordsSites(o.dossierProfil);
      accord = Object.hasOwn(accords, id) ? (accords[id] ?? null) : null;
    } catch (e) {
      // Accords illisibles : l'accord est redemandé (rien n'est injecté sans lui).
      console.error("[sites] accords illisibles :", e);
    }
    return {
      site: {
        id,
        declaration: d,
        aAccueil: lu.aAccueil,
        domaines: domainesEffectifs(d, etat),
        depart: adresseDeDepart(d, etat),
        accordRequis: accordNecessaire(d) && !accordCouvre(accord, d),
      },
      retouches: await fichiersRetouches(lu),
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
    if (quoi !== "accueil") void relire(id);
  });

  brancherInjection({
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

  async function ouvrirParId(id: string): Promise<boolean> {
    const p = await preparer(id);
    if (!p) return false;
    // Avant la fenêtre : le premier chargement de la page demande déjà ses retouches.
    retouches.set(id, p.retouches);
    relectures.set(id, (relectures.get(id) ?? 0) + 1);
    fenetres.ouvrir(p.site);
    o.diffuser();
    return true;
  }

  return {
    fenetres,
    async liste() {
      const sites = await lireSites(o.chemins, lecture);
      const ouvertes = new Set(fenetres.ouvertes().map((f) => f.id));
      return Promise.all(
        sites.map(async (s): Promise<SiteAffiche> => {
          const icone = souvenirs.lire(s.id).favicon ?? null;
          if ("erreur" in s) return { id: s.id, nom: s.id, description: "", domaine: null, icone, ouverte: ouvertes.has(s.id), erreur: s.erreur };
          const etat = ID_SITE.test(s.id) ? await lireEtatAdresse(dossierSites, s.id) : null;
          return {
            id: s.id,
            nom: s.declaration.nom,
            description: s.declaration.description,
            domaine: hote(adresseDeDepart(s.declaration, etat)),
            icone,
            ouverte: ouvertes.has(s.id),
          };
        }),
      );
    },
    async agir(id, a) {
      switch (a) {
        case "ouvrir":
          if (!(await ouvrirParId(id))) console.warn(`[sites] ${id} ne peut pas s'ouvrir`);
          return;
        default:
          // Modifier, oublier, dossier, supprimer : la section « Sites » de la page Applications (tâche suivante).
          console.warn(`[sites] action ${a} pas encore prise en charge`);
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
      if (!montree || fenetres.etat(id)?.vue !== "accord") return;
      if (!oui) return fenetres.apresAccord(id, null);
      // La déclaration connue du main, prise avant toute attente, n'est accordée que si ses droits sont ceux de la carte
      // cliquée : site.json a pu grandir entre l'affichage et le clic (l'agent choisit son moment).
      const d = montree.declaration;
      if (empreinteDroits(d) !== empreinte) return fenetres.rediffuser(id);
      await accorderSite(o.dossierProfil, id, d);
      const s = fenetres.site(id);
      if (!s) return;
      const accorde = droitsDe(d);
      fenetres.apresAccord(id, { ...s, accordRequis: accordNecessaire(s.declaration) && !accordCouvre(accorde, s.declaration) });
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
