// The agent's applications on the host side. The gestionnaire, the Docker probe, the memory (apps.json),
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

/** `min-max` port range from RESSAC_APP_PORTS (tests), otherwise the kernel's. */
export function portRange(value: string | undefined): [number, number] | undefined {
  const m = /^(\d+)-(\d+)$/.exec(value ?? "");
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** The app window seen as an `app:<dossier>` tab by the agent. */
export const appTab = (a: { folder: string; title: string; url: string }): TabInfo => ({ id: "app:" + a.folder, title: a.title, url: a.url, space: "", app: a.folder });

const FrameSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export interface ApplicationsHost {
  manager: ApplicationManager;
  handlers: Record<string, (p: any) => unknown>;
  /** Running apps with a port: projectForUrl's appsLancees (plan 35b) and the review's applis. */
  list(): Promise<Application[]>;
  /** AI on: the orphan apps' cleanup, the projects watch and the Docker probe start; idempotent until stop(). */
  wake(): void;
  /** toutArreter, arreterSurveillance, then the memory written. */
  stop(): Promise<void>;
}

export function createApplicationsHost(o: {
  paths: SpacePaths;
  locale?: () => string;
  dataDir: string;
  workshop: Workshop;
  chrome: {
    open(a: { folder: string; name: string; port: number }, frame: FrameBounds | null): Promise<void>;
    close(folder: string): Promise<void>;
    show(folder: string): Promise<boolean>;
    erase(folder: string): Promise<void>;
  };
  debug(win: WindowId, text: string, access?: () => TabInfo | undefined): void;
  policy(): { tabClosed(id: string): void; tabNavigated(id: string, url: string): void; built(o: TabInfo): void } | null;
  broadcast(): void;
}): ApplicationsHost {
  // Under <dataDir>, never in <dataDir>/espace that the container mounts.
  const memory = new SiteRecords(o.dataDir, 500, "apps.json");
  /** Open windows, by dossier: their last known title and address (the chrome tells, `apps.navigation`). */
  const windows = new Map<string, { title: string; url: string }>();
  /** Launches in progress per folder: a relaunched app goes through « arretee » without its window having to close. */
  const running = new Map<string, number>();
  /** Last launch requested per folder: it resolves only after the earlier ones (the manager chains them). */
  const last = new Map<string, Promise<unknown>>();
  const delay = Number(process.env.RESSAC_APP_DELAY_MS);
  const ports = portRange(process.env.RESSAC_APP_PORTS);
  const report = (folder: string, what: string) => (e: unknown) => console.error(`[applications] ${folder} not ${what}:`, e);

  const close = (folder: string) => {
    windows.delete(folder);
    void o.chrome.close(folder).catch(report(folder, "closed"));
  };
  /** Closes the window of an app that is no longer running, except during a launch (which will decide at its end). */
  const followState = (folder: string) => {
    const state = manager.stateOf(folder);
    if ((state === "stopped" || state === "error") && !running.get(folder) && windows.has(folder)) close(folder);
  };

  // Launches come from the agent (MCP tool) as from the apps page: all go through here.
  class Manager extends ApplicationManager {
    override launch(folder: string): Promise<Application> {
      running.set(folder, (running.get(folder) ?? 0) + 1);
      const end = super.launch(folder);
      last.set(folder, end);
      void end
        .then(
          (a) => {
            // Launched, or relaunched: the window opens or reloads on the new port.
            if (a.state === "running" && a.port !== undefined) {
              windows.set(folder, { title: windows.get(folder)?.title ?? a.name, url: `http://localhost:${a.port}/` });
              void o.chrome.open({ folder: folder, name: a.name, port: a.port }, memory.read(folder).frame ?? null).catch(report(folder, "opened"));
              memory.note(folder, { lastLaunch: new Date().toISOString() });
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
    paths: o.paths,
    ...(o.locale ? { locale: o.locale } : {}),
    workshop: o.workshop,
    ...(ports ? { ports } : {}),
    ...(delay > 0 ? { readyDelayMs: delay } : {}),
    onChange: () => {
      for (const folder of [...windows.keys()]) followState(folder);
      o.broadcast();
    },
  });
  // Made by wake(): before it (AI off), nothing here runs docker. The list never waits for it: the page is re-read when Docker's state changes.
  let docker: DockerProbe | undefined;

  /** Erases the folder, the container and its memory; refused while the app runs or starts. */
  async function remove(folder: string): Promise<void> {
    const state = manager.stateOf(folder);
    if (state !== "stopped" && state !== "error") throw new Error(`appli ${state}`);
    // The name comes from any « Sans fiche » project: only a direct folder of projets/ is erased.
    const projects = resolve(o.paths.projects);
    const target = resolve(projects, folder);
    if (!target.startsWith(projects + sep) || target.slice(projects.length + 1).includes(sep)) throw new Error(`${target} hors de ${projects}`);
    // Stopping cancels the launches that have not started, and we wait for the last one to hand back control.
    await manager.stop(folder);
    await last.get(folder)?.catch(() => {});
    await fs.rm(target, { recursive: true, force: true });
    await o.chrome.erase(folder);
    memory.forget(folder);
    manager.forget(folder);
    o.broadcast();
  }

  async function debug(folder: string, win: WindowId): Promise<void> {
    const a = (await manager.list()).find((x) => x.folder === folder);
    if (!a) return;
    // Open window = running app: the agent can read it without asking, if it still is when the text is written.
    const access = () => {
      const f = windows.get(folder);
      return f && appTab({ folder: folder, ...f });
    };
    const text = appPrefix({ name: a.name, folder: folder, noManifest: a.type === "no-manifest", running: access() !== undefined });
    o.debug(win, text, access() ? access : undefined);
  }

  const act = (folder: string, action: z.infer<typeof SchemaActionApplication>["action"], win: WindowId): void => {
    switch (action) {
      // Relaunch = launch a running or errored app: the manager first stops the running instance.
      case "launch":
      case "relaunch":
        void manager.launch(folder).catch(report(folder, "launched"));
        return;
      case "stop":
        void manager.stop(folder).catch(report(folder, "stopped"));
        return;
      case "open":
        void o.chrome.show(folder).catch(report(folder, "shown"));
        return;
      case "delete":
        void remove(folder).catch(report(folder, "deleted"));
        return;
      case "promote":
        void writeType(o.paths, folder, "app").then(o.broadcast).catch(report(folder, "promoted"));
        return;
      case "debug":
        void debug(folder, win).catch(report(folder, "debugged"));
        return;
      // « dossier » and « relire » are the chrome's and the page's (plan 35a tasks 4 and 5).
    }
  };

  type Params = { [k: string]: unknown } | null | undefined;
  const folderOf = (p: Params) => (typeof p?.folder === "string" && validFolder(p.folder) ? p.folder : undefined);

  const handlers: Record<string, (p: Params) => unknown> = {
    "apps.list": async (): Promise<ApplicationList> => {
      const applications = await manager.list();
      return {
        workshop: docker?.value() ?? "ok",
        apps: applications.map((a) => {
          const { favicon, lastLaunch: lastLaunch } = memory.read(a.folder);
          return { ...a, ...(favicon ? { favicon } : {}), ...(lastLaunch ? { lastLaunch: lastLaunch } : {}) };
        }),
      };
    },
    // A bad input does nothing.
    "apps.act": (p) => {
      const a = SchemaActionApplication.safeParse(p);
      if (a.success && typeof p?.window === "string") act(a.data.folder, a.data.action, p.window);
    },
    // The agent's access to « app:<dossier> » goes with the window; closed by the user, the app stops.
    "apps.windowClosed": (p) => {
      const folder = folderOf(p);
      if (!folder) return;
      windows.delete(folder);
      o.policy()?.tabClosed("app:" + folder);
      if (p?.byUser === true) void manager.stop(folder).catch(report(folder, "stopped"));
    },
    // An app window always shows what the agent built: « construite » again on its new origin.
    "apps.navigation": (p) => {
      const folder = folderOf(p);
      if (!folder || typeof p?.url !== "string" || !windows.has(folder)) return;
      const f = { title: typeof p.title === "string" ? p.title : "", url: p.url };
      windows.set(folder, f);
      const policy = o.policy();
      if (!policy) return;
      policy.tabNavigated("app:" + folder, f.url);
      policy.built(appTab({ folder: folder, ...f }));
    },
    // The chrome checked the favicon already: checked again here (data:image/, 64 KB at most).
    "apps.note": (p) => {
      const folder = folderOf(p);
      if (!folder) return;
      const frame = FrameSchema.safeParse(p?.frame);
      if (frame.success) memory.note(folder, { frame: frame.data });
      const favicon = p?.favicon;
      if (typeof favicon !== "string" || !favicon.startsWith("data:image/") || favicon.length > FAVICON_SIZE || memory.read(folder).favicon === favicon) return;
      memory.note(folder, { favicon });
      o.broadcast();
    },
  };

  return {
    manager: manager,
    handlers,
    list: async () => (await manager.list()).filter((a) => a.state === "running" && a.port !== undefined),
    wake() {
      if (docker) return;
      docker = new DockerProbe({ probe: () => o.workshop.state(), onChange: o.broadcast });
      // In the background: windows never wait for Docker.
      manager.start().catch((e) => console.error("[applications] start failed:", e));
    },
    async stop() {
      docker = undefined;
      try {
        await manager.stopAll();
        await manager.stopWatching();
      } finally {
        await memory.clear();
      }
    },
  };
}
