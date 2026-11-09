// The agent's applications on the host side. The gestionnaire, the Docker probe, the memory (applications.json),
// Supprimer, Passer en application and
// Déboguer live here; the window, its container and its guard are the chrome's, asked through `chrome`.
import fs from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { dossierValide, ecrireType, GestionnaireApplications, prefixeApplication, type Application, type Atelier, type CheminsEspace, type OngletInfo } from "../../../packages/noyau/src/index.ts";
import { SondeDocker } from "../core/applications/sonde.ts";
import { TAILLE_FAVICON } from "../core/applications/favicon.ts";
import { SchemaActionApplication, type ListeApplications } from "../shared/api.ts";
import type { Cadre, IdFenetre } from "../shared/modele.ts";
import { SiteSouvenirs } from "./sites.ts";

/** Plage de ports `min-max` de WEBAIOS_PORTS_APPS (tests), sinon celle du noyau. */
export function plageDePorts(valeur: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(valeur ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** The app window seen as an `app:<dossier>` tab by the agent. */
export const appTab = (a: { dossier: string; titre: string; url: string }): OngletInfo => ({ id: "app:" + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier });

const SchemaCadre = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });

export interface ApplicationsHost {
  gestionnaire: GestionnaireApplications;
  handlers: Record<string, (p: any) => unknown>;
  /** Running apps with a port: projetPourAdresse's appsLancees (plan 35b) and the review's applis. */
  liste(): Promise<Application[]>;
  /** toutArreter, arreterSurveillance, then the memory written. */
  arreter(): Promise<void>;
}

export function createApplicationsHost(o: {
  chemins: CheminsEspace;
  dataDir: string;
  atelier: Atelier;
  chrome: {
    ouvrir(a: { dossier: string; nom: string; port: number }, cadre: Cadre | null): Promise<void>;
    fermer(dossier: string): Promise<void>;
    montrer(dossier: string): Promise<boolean>;
    effacer(dossier: string): Promise<void>;
  };
  deboguer(fenetre: IdFenetre, texte: string, acces?: () => OngletInfo | undefined): void;
  politique(): { ongletFerme(id: string): void; ongletNavigue(id: string, url: string): void; construite(o: OngletInfo): void } | null;
  diffuser(): void;
}): ApplicationsHost {
  // Under <dataDir>, never in <dataDir>/espace that the container mounts.
  const memoire = new SiteSouvenirs(o.dataDir, 500, "applications.json");
  /** Open windows, by dossier: their last known title and address (the chrome tells, `applications.navigation`). */
  const fenetres = new Map<string, { titre: string; url: string }>();
  /** Lancements en cours par dossier : une appli relancée passe par « arretee » sans que sa fenêtre doive se fermer. */
  const enCours = new Map<string, number>();
  /** Dernier lancement demandé par dossier : il ne se résout qu'après ceux d'avant (le gestionnaire les enchaîne). */
  const derniers = new Map<string, Promise<unknown>>();
  const delai = Number(process.env.WEBAIOS_DELAI_APP_MS);
  const ports = plageDePorts(process.env.WEBAIOS_PORTS_APPS);
  const signaler = (dossier: string, quoi: string) => (e: unknown) => console.error(`[applications] ${dossier} non ${quoi} :`, e);

  const fermer = (dossier: string) => {
    fenetres.delete(dossier);
    void o.chrome.fermer(dossier).catch(signaler(dossier, "fermée"));
  };
  /** Ferme la fenêtre d'une appli qui n'est plus en marche, sauf pendant un lancement (qui décidera à sa fin). */
  const suivreEtat = (dossier: string) => {
    const etat = gestionnaire.etatDe(dossier);
    if ((etat === "arretee" || etat === "erreur") && !enCours.get(dossier) && fenetres.has(dossier)) fermer(dossier);
  };

  // Les lancements viennent de l'agent (outil MCP) comme de la page des applis : tous passent par ici.
  class Gestionnaire extends GestionnaireApplications {
    override lancer(dossier: string): Promise<Application> {
      enCours.set(dossier, (enCours.get(dossier) ?? 0) + 1);
      const fin = super.lancer(dossier);
      derniers.set(dossier, fin);
      void fin
        .then(
          (a) => {
            // Lancée, ou relancée : la fenêtre s'ouvre ou se recharge sur le nouveau port.
            if (a.etat === "en-marche" && a.port !== undefined) {
              fenetres.set(dossier, { titre: fenetres.get(dossier)?.titre ?? a.nom, url: `http://localhost:${a.port}/` });
              void o.chrome.ouvrir({ dossier, nom: a.nom, port: a.port }, memoire.lire(dossier).cadre ?? null).catch(signaler(dossier, "ouverte"));
              memoire.noter(dossier, { dernierLancement: new Date().toISOString() });
            }
          },
          () => {},
        )
        .finally(() => {
          if (derniers.get(dossier) === fin) derniers.delete(dossier);
          const n = (enCours.get(dossier) ?? 1) - 1;
          if (n > 0) enCours.set(dossier, n);
          else enCours.delete(dossier);
          suivreEtat(dossier);
        });
      return fin;
    }
  }

  const gestionnaire: GestionnaireApplications = new Gestionnaire({
    chemins: o.chemins,
    atelier: o.atelier,
    ...(ports ? { ports } : {}),
    ...(delai > 0 ? { delaiPretMs: delai } : {}),
    surChange: () => {
      for (const dossier of [...fenetres.keys()]) suivreEtat(dossier);
      o.diffuser();
    },
  });
  // Une fois par vie de l'hôte, en tâche de fond : les fenêtres n'attendent jamais Docker.
  gestionnaire.demarrer().catch((e) => console.error("[applications] démarrage impossible :", e));
  // La liste ne l'attend jamais : la page est relue quand l'état de Docker change.
  const docker = new SondeDocker({ sonder: () => o.atelier.etat(), surChange: o.diffuser });

  /** Efface le dossier, le conteneur et son souvenir ; refusé tant que l'appli tourne ou démarre. */
  async function supprimer(dossier: string): Promise<void> {
    const etat = gestionnaire.etatDe(dossier);
    if (etat !== "arretee" && etat !== "erreur") throw new Error(`appli ${etat}`);
    // Le nom vient d'un projet « Sans fiche » quelconque : seul un dossier direct de projets/ est effacé.
    const projets = resolve(o.chemins.projets);
    const cible = resolve(projets, dossier);
    if (!cible.startsWith(projets + sep) || cible.slice(projets.length + 1).includes(sep)) throw new Error(`${cible} hors de ${projets}`);
    // L'arrêt annule les lancements qui n'ont pas commencé, et on attend que le dernier ait rendu la main.
    await gestionnaire.arreter(dossier);
    await derniers.get(dossier)?.catch(() => {});
    await fs.rm(cible, { recursive: true, force: true });
    await o.chrome.effacer(dossier);
    memoire.oublier(dossier);
    gestionnaire.oublier(dossier);
    o.diffuser();
  }

  async function deboguer(dossier: string, fenetre: IdFenetre): Promise<void> {
    const a = (await gestionnaire.liste()).find((x) => x.dossier === dossier);
    if (!a) return;
    // Fenêtre ouverte = appli en marche : l'agent peut la lire sans demander, si elle l'est toujours quand le texte s'écrit.
    const acces = () => {
      const f = fenetres.get(dossier);
      return f && appTab({ dossier, ...f });
    };
    const texte = prefixeApplication({ nom: a.nom, dossier, sansFiche: a.type === "sans-fiche", enMarche: acces() !== undefined });
    o.deboguer(fenetre, texte, acces() ? acces : undefined);
  }

  const agir = (dossier: string, action: z.infer<typeof SchemaActionApplication>["action"], fenetre: IdFenetre): void => {
    switch (action) {
      // Relancer = lancer une appli en marche ou en erreur : le gestionnaire arrête d'abord l'instance en cours.
      case "lancer":
      case "relancer":
        void gestionnaire.lancer(dossier).catch(signaler(dossier, "lancée"));
        return;
      case "arreter":
        void gestionnaire.arreter(dossier).catch(signaler(dossier, "arrêtée"));
        return;
      case "ouvrir":
        void o.chrome.montrer(dossier).catch(signaler(dossier, "montrée"));
        return;
      case "supprimer":
        void supprimer(dossier).catch(signaler(dossier, "supprimée"));
        return;
      case "promouvoir":
        void ecrireType(o.chemins, dossier, "application").then(o.diffuser).catch(signaler(dossier, "promue"));
        return;
      case "deboguer":
        void deboguer(dossier, fenetre).catch(signaler(dossier, "déboguée"));
        return;
      // « dossier » and « relire » are the chrome's and the page's (plan 35a tasks 4 and 5).
    }
  };

  type Params = { [k: string]: unknown } | null | undefined;
  const dossierDe = (p: Params) => (typeof p?.dossier === "string" && dossierValide(p.dossier) ? p.dossier : undefined);

  const handlers: Record<string, (p: Params) => unknown> = {
    "applications.liste": async (): Promise<ListeApplications> => {
      const applications = await gestionnaire.liste();
      return {
        atelier: docker.valeur(),
        applications: applications.map((a) => {
          const { favicon, dernierLancement } = memoire.lire(a.dossier);
          return { ...a, ...(favicon ? { favicon } : {}), ...(dernierLancement ? { dernierLancement } : {}) };
        }),
      };
    },
    // A bad input does nothing.
    "applications.agir": (p) => {
      const a = SchemaActionApplication.safeParse(p);
      if (a.success && typeof p?.fenetre === "string") agir(a.data.dossier, a.data.action, p.fenetre);
    },
    // The agent's access to « app:<dossier> » goes with the window; closed by the user, the app stops.
    "applications.fenetreFermee": (p) => {
      const dossier = dossierDe(p);
      if (!dossier) return;
      fenetres.delete(dossier);
      o.politique()?.ongletFerme("app:" + dossier);
      if (p?.byUser === true) void gestionnaire.arreter(dossier).catch(signaler(dossier, "arrêtée"));
    },
    // An app window always shows what the agent built: « construite » again on its new origin.
    "applications.navigation": (p) => {
      const dossier = dossierDe(p);
      if (!dossier || typeof p?.url !== "string" || !fenetres.has(dossier)) return;
      const f = { titre: typeof p.titre === "string" ? p.titre : "", url: p.url };
      fenetres.set(dossier, f);
      const politique = o.politique();
      if (!politique) return;
      politique.ongletNavigue("app:" + dossier, f.url);
      politique.construite(appTab({ dossier, ...f }));
    },
    // The chrome checked the favicon already: checked again here (data:image/, 64 KB at most).
    "applications.noter": (p) => {
      const dossier = dossierDe(p);
      if (!dossier) return;
      const cadre = SchemaCadre.safeParse(p?.cadre);
      if (cadre.success) memoire.noter(dossier, { cadre: cadre.data });
      const favicon = p?.favicon;
      if (typeof favicon !== "string" || !favicon.startsWith("data:image/") || favicon.length > TAILLE_FAVICON || memoire.lire(dossier).favicon === favicon) return;
      memoire.noter(dossier, { favicon });
      o.diffuser();
    },
  };

  return {
    gestionnaire,
    handlers,
    liste: async () => (await gestionnaire.liste()).filter((a) => a.etat === "en-marche" && a.port !== undefined),
    async arreter() {
      try {
        await gestionnaire.toutArreter();
        await gestionnaire.arreterSurveillance();
      } finally {
        await memoire.vider();
      }
    },
  };
}
