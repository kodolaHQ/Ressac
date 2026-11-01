import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  accordCouvre,
  accordNecessaire,
  adresseDeDepart,
  adresseSurDomaine,
  domainesEffectifs,
  ID_SITE,
  lireAccordsSites,
  lireEtatAdresse,
  lireSite,
  lireSites,
  MemoireSite,
  type CheminsEspace,
  type DroitsSite,
} from "@webaios/noyau";
import { CANAUX } from "../../commun/canaux";
import { ECART_OUVERTURE_ACCUEIL_MS, type ActionSite, type MessageVersLAccueil, type SiteAffiche } from "../../commun/sites";
import { imageSite } from "./accueil";
import type { IdFenetre } from "../../commun/modele";
import { MemoireApplications } from "../applications/service";
import { FenetresSites, type SiteOuvrable } from "./fenetres";
import { fixerPreloadSite, sessionSite } from "./session";

/** Une erreur de console d'une retouche (tâche des retouches). */
export type ErreurRetouche = { quand: string; texte: string; source: string };

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
  /** Les erreurs de console des retouches de l'appli ouverte (vide tant que les retouches ne sont pas injectées). */
  erreurs(id: string): ErreurRetouche[];
  /** L'adresse est-elle sur les domaines de l'appli ouverte ? (navigation demandée par l'agent) */
  adressePermise(id: string, url: string): boolean;
  /**
   * Pour l'écran d'accueil de l'appli ouverte : sa mémoire (valeurs et positions, en lecture) et son domaine actuel. Ses
   * changements sont ensuite envoyés à l'interface de la fenêtre tant qu'elle reste ouverte.
   */
  memoireAccueil(id: string): Promise<MessageVersLAccueil & { type: "memoire" }>;
  /** L'accueil demande une adresse : sur le domaine actuel, une par `ECART_OUVERTURE_ACCUEIL_MS` ; faux si refusée. */
  ouvrirDepuisAccueil(id: string, adresse: string): boolean;
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
  /** Dernière adresse ouverte par l'accueil, par appli. */
  const derniereOuverture = new Map<string, number>();
  /** Images de l'accueil : chargements en cours et en attente, par appli. */
  const images = new Map<string, { enCours: number; attente: (() => void)[] }>();

  const fenetres = new FenetresSites({
    memoire: souvenirs,
    adressesLocales: o.adressesLocales,
    ouvrirOnglet: o.ouvrirOnglet,
    surFermee: (id) => {
      abonnements.get(id)?.();
      abonnements.delete(id);
      derniereOuverture.delete(id);
      void viderMemoire(id);
      o.diffuser();
    },
    surFavicon: () => o.diffuser(),
  });

  /** L'appli telle qu'elle s'ouvre, ou null (absente, site.json invalide, dossier dont le nom n'est pas exactement `id`). */
  async function ouvrable(id: string): Promise<SiteOuvrable | null> {
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
      id,
      declaration: d,
      aAccueil: lu.aAccueil,
      domaines: domainesEffectifs(d, etat),
      depart: adresseDeDepart(d, etat),
      accordRequis: accordNecessaire(d) && !accordCouvre(accord, d),
    };
  }

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
    const s = await ouvrable(id);
    if (!s) return false;
    fenetres.ouvrir(s);
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
    erreurs: () => [],
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
      if (!url || !fenetres.depuisAccueil(id, url)) return false;
      derniereOuverture.set(id, maintenant);
      return true;
    },
    async imageAccueil(id, url) {
      const s = fenetres.site(id);
      if (!s || !(await placeImage(id))) return null;
      try {
        // Domaines relus à chaque image : l'appli a pu être rouverte avec d'autres entre-temps.
        const domaines = fenetres.site(id)?.domaines;
        return domaines ? await imageSite(sessionSite(id), url, domaines) : null;
      } finally {
        libererImage(id);
      }
    },
    async arreter() {
      try {
        await Promise.allSettled(fenetres.ouvertes().map((f) => fenetres.fermer(f.id)));
        await Promise.allSettled([...memoires.keys()].map(viderMemoire));
      } finally {
        await souvenirs.vider();
      }
    },
  };
}
