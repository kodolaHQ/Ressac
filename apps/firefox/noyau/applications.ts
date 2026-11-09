// The agent's applications on the host side. The gestionnaire, the Docker probe, the memory (applications.json),
// Supprimer, Passer en application and
// Déboguer live here; the window, its container and its guard are the chrome's, asked through `chrome`.
import fs from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { validFolder, writeType, ApplicationManager, appPrefix, type Application, type Atelier, type SpacePaths, type TabInfo } from "../../../packages/noyau/src/index.ts";
import { DockerProbe } from "../core/applications/sonde.ts";
import { TAILLE_FAVICON } from "../core/applications/favicon.ts";
import { SchemaActionApplication, type ApplicationList } from "../shared/api.ts";
import type { Cadre, WindowId } from "../shared/modele.ts";
import { SiteSouvenirs } from "./sites.ts";

/** `min-max` port range from WEBAIOS_PORTS_APPS (tests), otherwise the kernel's. */
export function plageDePorts(valeur: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(valeur ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** The app window seen as an `app:<dossier>` tab by the agent. */
export const appTab = (a: { dossier: string; titre: string; url: string }): TabInfo => ({ id: "app:" + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier });

const SchemaCadre = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });

export interface ApplicationsHost {
  gestionnaire: ApplicationManager;
  handlers: Record<string, (p: any) => unknown>;
  /** Running apps with a port: projetPourAdresse's appsLancees (plan 35b) and the review's applis. */
  liste(): Promise<Application[]>;
  /** toutArreter, arreterSurveillance, then the memory written. */
  arreter(): Promise<void>;
}

export function createApplicationsHost(o: {
  chemins: SpacePaths;
  dataDir: string;
  atelier: Atelier;
  chrome: {
    ouvrir(a: { dossier: string; nom: string; port: number }, cadre: Cadre | null): Promise<void>;
    fermer(dossier: string): Promise<void>;
    montrer(dossier: string): Promise<boolean>;
    effacer(dossier: string): Promise<void>;
  };
  deboguer(win: WindowId, text: string, access?: () => TabInfo | undefined): void;
  politique(): { ongletFerme(id: string): void; ongletNavigue(id: string, url: string): void; construite(o: TabInfo): void } | null;
  diffuser(): void;
}): ApplicationsHost {
  // Under <dataDir>, never in <dataDir>/espace that the container mounts.
  const memory = new SiteSouvenirs(o.dataDir, 500, "applications.json");
  /** Open windows, by dossier: their last known title and address (the chrome tells, `applications.navigation`). */
  const windows = new Map<string, { titre: string; url: string }>();
  /** Launches in progress per folder: a relaunched app goes through « arretee » without its window having to close. */
  const enCours = new Map<string, number>();
  /** Last launch requested per folder: it resolves only after the earlier ones (the manager chains them). */
  const derniers = new Map<string, Promise<unknown>>();
  const delay = Number(process.env.WEBAIOS_DELAI_APP_MS);
  const ports = plageDePorts(process.env.WEBAIOS_PORTS_APPS);
  const signaler = (dossier: string, what: string) => (e: unknown) => console.error(`[applications] ${dossier} non ${what} :`, e);

  const close = (dossier: string) => {
    windows.delete(dossier);
    void o.chrome.fermer(dossier).catch(signaler(dossier, "fermée"));
  };
  /** Closes the window of an app that is no longer running, except during a launch (which will decide at its end). */
  const followState = (dossier: string) => {
    const state = manager.etatDe(dossier);
    if ((state === "arretee" || state === "erreur") && !enCours.get(dossier) && windows.has(dossier)) close(dossier);
  };

  // Launches come from the agent (MCP tool) as from the apps page: all go through here.
  class Manager extends ApplicationManager {
    override lancer(dossier: string): Promise<Application> {
      enCours.set(dossier, (enCours.get(dossier) ?? 0) + 1);
      const fin = super.lancer(dossier);
      derniers.set(dossier, fin);
      void fin
        .then(
          (a) => {
            // Launched, or relaunched: the window opens or reloads on the new port.
            if (a.etat === "en-marche" && a.port !== undefined) {
              windows.set(dossier, { titre: windows.get(dossier)?.titre ?? a.nom, url: `http://localhost:${a.port}/` });
              void o.chrome.ouvrir({ dossier, nom: a.nom, port: a.port }, memory.lire(dossier).cadre ?? null).catch(signaler(dossier, "ouverte"));
              memory.noter(dossier, { dernierLancement: new Date().toISOString() });
            }
          },
          () => {},
        )
        .finally(() => {
          if (derniers.get(dossier) === fin) derniers.delete(dossier);
          const n = (enCours.get(dossier) ?? 1) - 1;
          if (n > 0) enCours.set(dossier, n);
          else enCours.delete(dossier);
          followState(dossier);
        });
      return fin;
    }
  }

  const manager: ApplicationManager = new Manager({
    chemins: o.chemins,
    atelier: o.atelier,
    ...(ports ? { ports } : {}),
    ...(delay > 0 ? { delaiPretMs: delay } : {}),
    surChange: () => {
      for (const dossier of [...windows.keys()]) followState(dossier);
      o.diffuser();
    },
  });
  // Once per host life, in the background: windows never wait for Docker.
  manager.demarrer().catch((e) => console.error("[applications] démarrage impossible :", e));
  // The list never waits for it: the page is re-read when Docker's state changes.
  const docker = new DockerProbe({ sonder: () => o.atelier.etat(), surChange: o.diffuser });

  /** Erases the folder, the container and its memory; refused while the app runs or starts. */
  async function remove(dossier: string): Promise<void> {
    const state = manager.etatDe(dossier);
    if (state !== "arretee" && state !== "erreur") throw new Error(`appli ${state}`);
    // The name comes from any « Sans fiche » project: only a direct folder of projets/ is erased.
    const projects = resolve(o.chemins.projets);
    const target = resolve(projects, dossier);
    if (!target.startsWith(projects + sep) || target.slice(projects.length + 1).includes(sep)) throw new Error(`${target} hors de ${projects}`);
    // Stopping cancels the launches that have not started, and we wait for the last one to hand back control.
    await manager.arreter(dossier);
    await derniers.get(dossier)?.catch(() => {});
    await fs.rm(target, { recursive: true, force: true });
    await o.chrome.effacer(dossier);
    memory.oublier(dossier);
    manager.oublier(dossier);
    o.diffuser();
  }

  async function debug(dossier: string, win: WindowId): Promise<void> {
    const a = (await manager.liste()).find((x) => x.dossier === dossier);
    if (!a) return;
    // Open window = running app: the agent can read it without asking, if it still is when the text is written.
    const access = () => {
      const f = windows.get(dossier);
      return f && appTab({ dossier, ...f });
    };
    const text = appPrefix({ nom: a.nom, dossier, sansFiche: a.type === "sans-fiche", enMarche: access() !== undefined });
    o.deboguer(win, text, access() ? access : undefined);
  }

  const act = (dossier: string, action: z.infer<typeof SchemaActionApplication>["action"], win: WindowId): void => {
    switch (action) {
      // Relaunch = launch a running or errored app: the manager first stops the running instance.
      case "lancer":
      case "relancer":
        void manager.lancer(dossier).catch(signaler(dossier, "lancée"));
        return;
      case "arreter":
        void manager.arreter(dossier).catch(signaler(dossier, "arrêtée"));
        return;
      case "ouvrir":
        void o.chrome.montrer(dossier).catch(signaler(dossier, "montrée"));
        return;
      case "supprimer":
        void remove(dossier).catch(signaler(dossier, "supprimée"));
        return;
      case "promouvoir":
        void writeType(o.chemins, dossier, "application").then(o.diffuser).catch(signaler(dossier, "promue"));
        return;
      case "deboguer":
        void debug(dossier, win).catch(signaler(dossier, "déboguée"));
        return;
      // « dossier » and « relire » are the chrome's and the page's (plan 35a tasks 4 and 5).
    }
  };

  type Params = { [k: string]: unknown } | null | undefined;
  const dossierDe = (p: Params) => (typeof p?.dossier === "string" && validFolder(p.dossier) ? p.dossier : undefined);

  const handlers: Record<string, (p: Params) => unknown> = {
    "applications.liste": async (): Promise<ApplicationList> => {
      const applications = await manager.liste();
      return {
        atelier: docker.valeur(),
        applications: applications.map((a) => {
          const { favicon, dernierLancement: lastLaunch } = memory.lire(a.dossier);
          return { ...a, ...(favicon ? { favicon } : {}), ...(lastLaunch ? { dernierLancement: lastLaunch } : {}) };
        }),
      };
    },
    // A bad input does nothing.
    "applications.agir": (p) => {
      const a = SchemaActionApplication.safeParse(p);
      if (a.success && typeof p?.fenetre === "string") act(a.data.dossier, a.data.action, p.fenetre);
    },
    // The agent's access to « app:<dossier> » goes with the window; closed by the user, the app stops.
    "applications.fenetreFermee": (p) => {
      const dossier = dossierDe(p);
      if (!dossier) return;
      windows.delete(dossier);
      o.politique()?.ongletFerme("app:" + dossier);
      if (p?.byUser === true) void manager.arreter(dossier).catch(signaler(dossier, "arrêtée"));
    },
    // An app window always shows what the agent built: « construite » again on its new origin.
    "applications.navigation": (p) => {
      const dossier = dossierDe(p);
      if (!dossier || typeof p?.url !== "string" || !windows.has(dossier)) return;
      const f = { titre: typeof p.titre === "string" ? p.titre : "", url: p.url };
      windows.set(dossier, f);
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
      if (cadre.success) memory.noter(dossier, { cadre: cadre.data });
      const favicon = p?.favicon;
      if (typeof favicon !== "string" || !favicon.startsWith("data:image/") || favicon.length > TAILLE_FAVICON || memory.lire(dossier).favicon === favicon) return;
      memory.noter(dossier, { favicon });
      o.diffuser();
    },
  };

  return {
    gestionnaire: manager,
    handlers,
    liste: async () => (await manager.liste()).filter((a) => a.etat === "en-marche" && a.port !== undefined),
    async arreter() {
      try {
        await manager.toutArreter();
        await manager.arreterSurveillance();
      } finally {
        await memory.vider();
      }
    },
  };
}
