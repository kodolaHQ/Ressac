import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  accordCouvre,
  accordNecessaire,
  adresseDeDepart,
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
import type { ActionSite, SiteAffiche } from "../../commun/sites";
import type { IdFenetre } from "../../commun/modele";
import { MemoireApplications } from "../applications/service";
import { FenetresSites, type SiteOuvrable } from "./fenetres";
import { fixerPreloadSite } from "./session";

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
  /** À la sortie : fenêtres fermées (cadres notés), mémoires écrites. */
  arreter(): Promise<void>;
}

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

  const fenetres = new FenetresSites({
    memoire: souvenirs,
    adressesLocales: o.adressesLocales,
    ouvrirOnglet: o.ouvrirOnglet,
    surFermee: (id) => {
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
    memoire(id) {
      let m = memoires.get(id);
      if (!m) {
        m = MemoireSite.ouvrir(dossierSites, id);
        memoires.set(id, m);
        // Un id refusé ne reste pas en cache.
        m.catch(() => memoires.delete(id));
      }
      return m;
    },
    erreurs: () => [],
    adressePermise: (id, url) => fenetres.adressePermise(id, url),
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
