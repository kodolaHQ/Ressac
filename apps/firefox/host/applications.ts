// The agent's applications on the host side. The gestionnaire, the Docker probe, the memory (applications.json),
// Supprimer, Passer en application and
// Déboguer live here; the window, its container and its guard are the chrome's, asked through `chrome`.
import fs from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { validFolder, writeType, ApplicationManager, appPrefix, type Application, type Workshop, type SpacePaths, type TabInfo } from "../../../packages/kernel/src/index.ts";
import { DockerProbe } from "../core/applications/probe.ts";
import { FAVICON_SIZE } from "../core/applications/favicon.ts";
import { SchemaActionApplication, type ApplicationList } from "../shared/api.ts";
import type { FrameBounds, WindowId } from "../shared/model.ts";
import { SiteRecords } from "./sites.ts";

/** `min-max` port range from WEBAIOS_PORTS_APPS (tests), otherwise the kernel's. */
export function portRange(value: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** The app window seen as an `app:<dossier>` tab by the agent. */
export const appTab = (a: { dossier: string; titre: string; url: string }): TabInfo => ({ id: "app:" + a.dossier, titre: a.titre, url: a.url, espace: "", application: a.dossier });

const FrameSchema = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });

export interface ApplicationsHost {
  gestionnaire: ApplicationManager;
  handlers: Record<string, (p: any) => unknown>;
  /** Running apps with a port: projectForUrl's appsLancees (plan 35b) and the review's applis. */
  liste(): Promise<Application[]>;
  /** toutArreter, arreterSurveillance, then the memory written. */
  arreter(): Promise<void>;
}

export function createApplicationsHost(o: {
  chemins: SpacePaths;
  dataDir: string;
  atelier: Workshop;
  chrome: {
    ouvrir(a: { dossier: string; nom: string; port: number }, frame: FrameBounds | null): Promise<void>;
    fermer(folder: string): Promise<void>;
    montrer(folder: string): Promise<boolean>;
    effacer(folder: string): Promise<void>;
  };
  deboguer(win: WindowId, text: string, access?: () => TabInfo | undefined): void;
  politique(): { ongletFerme(id: string): void; ongletNavigue(id: string, url: string): void; construite(o: TabInfo): void } | null;
  diffuser(): void;
}): ApplicationsHost {
  // Under <dataDir>, never in <dataDir>/espace that the container mounts.
  const memory = new SiteRecords(o.dataDir, 500, "applications.json");
  /** Open windows, by dossier: their last known title and address (the chrome tells, `applications.navigation`). */
  const windows = new Map<string, { titre: string; url: string }>();
  /** Launches in progress per folder: a relaunched app goes through « arretee » without its window having to close. */
  const running = new Map<string, number>();
  /** Last launch requested per folder: it resolves only after the earlier ones (the manager chains them). */
  const last = new Map<string, Promise<unknown>>();
  const delay = Number(process.env.WEBAIOS_DELAI_APP_MS);
  const ports = portRange(process.env.WEBAIOS_PORTS_APPS);
  const report = (folder: string, what: string) => (e: unknown) => console.error(`[applications] ${folder} non ${what} :`, e);

  const close = (folder: string) => {
    windows.delete(folder);
    void o.chrome.fermer(folder).catch(report(folder, "fermée"));
  };
  /** Closes the window of an app that is no longer running, except during a launch (which will decide at its end). */
  const followState = (folder: string) => {
    const state = manager.etatDe(folder);
    if ((state === "arretee" || state === "erreur") && !running.get(folder) && windows.has(folder)) close(folder);
  };

  // Launches come from the agent (MCP tool) as from the apps page: all go through here.
  class Manager extends ApplicationManager {
    override lancer(folder: string): Promise<Application> {
      running.set(folder, (running.get(folder) ?? 0) + 1);
      const end = super.lancer(folder);
      last.set(folder, end);
      void end
        .then(
          (a) => {
            // Launched, or relaunched: the window opens or reloads on the new port.
            if (a.etat === "en-marche" && a.port !== undefined) {
              windows.set(folder, { titre: windows.get(folder)?.titre ?? a.nom, url: `http://localhost:${a.port}/` });
              void o.chrome.ouvrir({ dossier: folder, nom: a.nom, port: a.port }, memory.lire(folder).cadre ?? null).catch(report(folder, "ouverte"));
              memory.noter(folder, { dernierLancement: new Date().toISOString() });
            }
          },
          () => {},
        )
        .finally(() => {
          if (last.get(folder) === end) last.delete(folder);
          const n = (running.get(folder) ?? 1) - 1;
          if (n > 0) running.set(folder, n);
          else running.delete(folder);
          followState(folder);
        });
      return end;
    }
  }

  const manager: ApplicationManager = new Manager({
    chemins: o.chemins,
    atelier: o.atelier,
    ...(ports ? { ports } : {}),
    ...(delay > 0 ? { delaiPretMs: delay } : {}),
    surChange: () => {
      for (const folder of [...windows.keys()]) followState(folder);
      o.diffuser();
    },
  });
  // Once per host life, in the background: windows never wait for Docker.
  manager.demarrer().catch((e) => console.error("[applications] démarrage impossible :", e));
  // The list never waits for it: the page is re-read when Docker's state changes.
  const docker = new DockerProbe({ sonder: () => o.atelier.etat(), surChange: o.diffuser });

  /** Erases the folder, the container and its memory; refused while the app runs or starts. */
  async function remove(folder: string): Promise<void> {
    const state = manager.etatDe(folder);
    if (state !== "arretee" && state !== "erreur") throw new Error(`appli ${state}`);
    // The name comes from any « Sans fiche » project: only a direct folder of projets/ is erased.
    const projects = resolve(o.chemins.projets);
    const target = resolve(projects, folder);
    if (!target.startsWith(projects + sep) || target.slice(projects.length + 1).includes(sep)) throw new Error(`${target} hors de ${projects}`);
    // Stopping cancels the launches that have not started, and we wait for the last one to hand back control.
    await manager.arreter(folder);
    await last.get(folder)?.catch(() => {});
    await fs.rm(target, { recursive: true, force: true });
    await o.chrome.effacer(folder);
    memory.oublier(folder);
    manager.oublier(folder);
    o.diffuser();
  }

  async function debug(folder: string, win: WindowId): Promise<void> {
    const a = (await manager.liste()).find((x) => x.dossier === folder);
    if (!a) return;
    // Open window = running app: the agent can read it without asking, if it still is when the text is written.
    const access = () => {
      const f = windows.get(folder);
      return f && appTab({ dossier: folder, ...f });
    };
    const text = appPrefix({ nom: a.nom, dossier: folder, sansFiche: a.type === "sans-fiche", enMarche: access() !== undefined });
    o.deboguer(win, text, access() ? access : undefined);
  }

  const act = (folder: string, action: z.infer<typeof SchemaActionApplication>["action"], win: WindowId): void => {
    switch (action) {
      // Relaunch = launch a running or errored app: the manager first stops the running instance.
      case "lancer":
      case "relancer":
        void manager.lancer(folder).catch(report(folder, "lancée"));
        return;
      case "arreter":
        void manager.arreter(folder).catch(report(folder, "arrêtée"));
        return;
      case "ouvrir":
        void o.chrome.montrer(folder).catch(report(folder, "montrée"));
        return;
      case "supprimer":
        void remove(folder).catch(report(folder, "supprimée"));
        return;
      case "promouvoir":
        void writeType(o.chemins, folder, "application").then(o.diffuser).catch(report(folder, "promue"));
        return;
      case "deboguer":
        void debug(folder, win).catch(report(folder, "déboguée"));
        return;
      // « dossier » and « relire » are the chrome's and the page's (plan 35a tasks 4 and 5).
    }
  };

  type Params = { [k: string]: unknown } | null | undefined;
  const folderOf = (p: Params) => (typeof p?.dossier === "string" && validFolder(p.dossier) ? p.dossier : undefined);

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
      const folder = folderOf(p);
      if (!folder) return;
      windows.delete(folder);
      o.politique()?.ongletFerme("app:" + folder);
      if (p?.byUser === true) void manager.arreter(folder).catch(report(folder, "arrêtée"));
    },
    // An app window always shows what the agent built: « construite » again on its new origin.
    "applications.navigation": (p) => {
      const folder = folderOf(p);
      if (!folder || typeof p?.url !== "string" || !windows.has(folder)) return;
      const f = { titre: typeof p.titre === "string" ? p.titre : "", url: p.url };
      windows.set(folder, f);
      const policy = o.politique();
      if (!policy) return;
      policy.ongletNavigue("app:" + folder, f.url);
      policy.construite(appTab({ dossier: folder, ...f }));
    },
    // The chrome checked the favicon already: checked again here (data:image/, 64 KB at most).
    "applications.noter": (p) => {
      const folder = folderOf(p);
      if (!folder) return;
      const frame = FrameSchema.safeParse(p?.cadre);
      if (frame.success) memory.noter(folder, { cadre: frame.data });
      const favicon = p?.favicon;
      if (typeof favicon !== "string" || !favicon.startsWith("data:image/") || favicon.length > FAVICON_SIZE || memory.lire(folder).favicon === favicon) return;
      memory.noter(folder, { favicon });
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
