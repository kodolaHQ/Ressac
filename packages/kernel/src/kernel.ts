import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { CONTAINER_PATH, sessionConfigPath, pathInContainer, sessionsFolder, spacePaths, type SpacePaths } from "./paths.js";
import { initSpace } from "./workspace/initialize.js";
import { readHome } from "./home/read.js";
import type { HomeState, WidgetState, WidgetLu } from "./home/schemas.js";
import { writeWidgetState, readData, readWidgetState, deleteData } from "./home/data.js";
import { watchHome } from "./home/watch.js";
import { loadProfiles, buildCommand } from "./profiles/profile.js";
import { writeMcpConfig, writeSessionConfig } from "./profiles/config-mcp.js";
import { Workshop, DEFAULT_DOCKER_FOLDER, type WorkshopState } from "./container/workshop.js";
import { defaultRunner, type Runner } from "./container/runner.js";
import { SessionAgent } from "./pty/session.js";
import { AccessPolicy } from "./access/policy.js";
import type { TabInfo, BrowserBridge } from "./mcp/bridge.js";
import type { ExtensionsTools } from "./mcp/extensions.js";
import { startMcpServer, generateToken, type ActionsTools, type AppsTools, type SitesTools, type WidgetsTools, type OpenWorkflow } from "./mcp/server.js";
import type { ProfileFiles } from "./mcp/devtools.js";
import { DevToolsTracking } from "./devtools/tracking.js";
import type { LocalAi } from "./ai/local-ai.js";
import { createAiDispatcher } from "./ai/dispatcher.js";
import { ID_EXECUTION, listRuns, readRun, type Execution } from "./workflows/executions.js";
import { DEFAULT_PACING } from "./workflows/run.js";
import { WidgetsScheduler, type DirectState, type AttemptResult } from "./widgets/scheduler.js";
import type { NotificationWidget } from "./widgets/nouveautes.js";
import { grantRequired } from "./widgets/harvest.js";
import { giveGrant, readGrants, removeGrant } from "./widgets/grants.js";
import { readAction, readActions, type ReadAction } from "./actions/read.js";
import { lastResult, readResult, forgetGoneActions, deleteDataAction } from "./actions/data.js";
import { FileActions, type ActionsState, type ActionLaunch } from "./actions/file.js";
import { ID_ACTION } from "./actions/schemas.js";
import { BUILTIN_COMPONENTS } from "./pages/catalog.js";
import { readAgentComponents } from "./pages/agent-components.js";
import { resolvePage, type RenderedPage } from "./pages/resolve.js";
import type { ResumeExecution } from "./workflows/executions.js";

export class WorkshopError extends Error {
  constructor(readonly state: WorkshopState, detail?: string) {
    super(detail ?? (state === "docker-absent" ? "Docker n'est pas lancé" : `Conteneur indisponible (${state})`));
    this.name = "WorkshopError";
  }
}

/** A single path segment, no climbing up: a file or project folder name. */
const safeSegment = (s: string): boolean => s !== "" && s !== "." && s !== ".." && basename(s) === s && !s.includes("\\");

/** Same items, same numbers of times, in any order. */
const sameLists = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Folder of the dev tools' raw profiles (distinct from `.webaios/profils`, that of the agent profiles). */
export const PROFILING_FOLDER = "profilage";

/** `.webaios/profilage` or `projets/<dossier>/.webaios/profilage`, in segments relative to the root. */
const profilingFolder = (parts: string[]): boolean =>
  parts.every(safeSegment) &&
  ((parts.length === 2 && parts[0] === ".webaios" && parts[1] === PROFILING_FOLDER) ||
    (parts.length === 4 && parts[0] === "projets" && parts[2] === ".webaios" && parts[3] === PROFILING_FOLDER));

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Reference of a profile kept outside the workspace: `profile:<file name>`. */
export const PRIVATE_PROFILE_PREFIX = "profile:";

/**
 * Raw profiles of the dev tools, written by the browser (spec §6). What the agent built goes into
 * the workspace: in the project for an application (`projets/<dossier>/.webaios/profilage`), in `.webaios/profilage`
 * otherwise. The profile of another site (its heap contains tokens and personal data) stays outside the mount, in
 * `dossierPrive` (the browser's profile), and the agent only gets a `profile:<name>` reference. Only these folders
 * are read or erased. The workspace is mounted writable in the container: the agent can put symbolic links in it,
 * so no link is followed, neither in the folders nor for the file.
 */
export function profileFiles(paths: SpacePaths, privateFolder?: string): ProfileFiles {
  const denial = (containerPath: string) => new Error(`Chemin hors des profils : ${containerPath}`);

  /** Descends into the segments under the real root without following a link; creates the missing folders if `creer`. */
  async function descend(parts: string[], create: boolean, shown: string): Promise<string> {
    let current = await realpath(paths.root);
    for (const part of parts) {
      current = join(current, part);
      let info = await lstat(current).catch((e) => {
        if (code(e) === "ENOENT" && create) return null;
        throw code(e) === "ENOENT" ? new Error(`Profil introuvable : ${shown}`) : denial(shown);
      });
      if (!info) {
        await mkdir(current).catch((e) => {
          if (code(e) !== "EEXIST") throw e;
        });
        info = await lstat(current);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw denial(shown);
    }
    // A link placed between two checks would be seen here.
    if ((await realpath(current)) !== current) throw denial(shown);
    return current;
  }

  /** Container path → segments under the root, only for a file of a profiling folder. */
  const segments = (containerPath: string): string[] => {
    const prefix = `${CONTAINER_PATH}/`;
    const normal = posix.normalize(containerPath);
    if (!posix.isAbsolute(containerPath) || !normal.startsWith(prefix)) throw denial(containerPath);
    const parts = normal.slice(prefix.length).split("/");
    if (parts.length < 3 || !safeSegment(parts.at(-1)!) || !profilingFolder(parts.slice(0, -1))) throw denial(containerPath);
    return parts;
  };

  /** The private folder (created if needed), without a symbolic link. */
  async function realPrivateFolder(create: boolean): Promise<string> {
    if (!privateFolder) throw new Error("Enregistrement des profils indisponible.");
    if (create) await mkdir(privateFolder, { recursive: true, mode: 0o700 });
    return realpath(privateFolder);
  }

  /** The file, if it is a real file (not a link) in a real profiling folder, or the private folder. */
  async function existingFile(containerPath: string): Promise<string> {
    let file: string;
    if (containerPath.startsWith(PRIVATE_PROFILE_PREFIX)) {
      const name = containerPath.slice(PRIVATE_PROFILE_PREFIX.length);
      if (!safeSegment(name)) throw denial(containerPath);
      const folder = await realPrivateFolder(false).catch((e: unknown) => {
        throw code(e) === "ENOENT" ? new Error(`Profil introuvable : ${containerPath}`) : e;
      });
      file = join(folder, name);
    } else {
      const parts = segments(containerPath);
      const folder = await descend(parts.slice(0, -1), false, containerPath);
      file = join(folder, parts.at(-1)!);
    }
    const info = await lstat(file).catch(() => {
      throw new Error(`Profil introuvable : ${containerPath}`);
    });
    if (!info.isFile()) throw denial(containerPath);
    return file;
  }

  return {
    async writeProfile(o, name, content, built) {
      if (!safeSegment(name)) throw new Error(`Nom de profil invalide : ${name}`);
      if (!built) {
        // « wx »: never over an existing file or link.
        await writeFile(join(await realPrivateFolder(true), name), content, { flag: "wx", mode: 0o600 });
        return PRIVATE_PROFILE_PREFIX + name;
      }
      if (o.app !== undefined && !safeSegment(o.app)) throw new Error(`Dossier d'application invalide : ${o.app}`);
      const parts = o.app === undefined ? [".webaios", PROFILING_FOLDER] : ["projets", o.app, ".webaios", PROFILING_FOLDER];
      const containerPath = `${CONTAINER_PATH}/${[...parts, name].join("/")}`;
      const folder = await descend(parts, true, containerPath);
      // « wx »: never over an existing file or link.
      await writeFile(join(folder, name), content, { flag: "wx" });
      return containerPath;
    },
    async readProfile(containerPath) {
      const file = await existingFile(containerPath);
      const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
        throw denial(containerPath);
      });
      try {
        if (!(await f.stat()).isFile()) throw denial(containerPath);
        return await f.readFile("utf8");
      } finally {
        await f.close();
      }
    },
    async deleteProfile(containerPath) {
      const file = await existingFile(containerPath).catch((e: Error) => {
        if (e.message.startsWith("Profil introuvable")) return null;
        throw e;
      });
      if (file) await unlink(file).catch(() => {});
    },
  };
}

/** An action run's result as its page shows it: the page resolved at read time. */
export type PageAction = {
  run: string;
  start: string;
  end: string | null;
  input: string | null;
  status: Execution["status"];
  error?: string;
  page: RenderedPage | null;
  /** The action reads with the user's account (current declaration): the results' images stay neutral. */
  account: boolean;
};

/** The actions: launched on demand, in their own queue, results and grants outside the workspace. */
export interface KernelActions {
  list(): Promise<ReadAction[]>;
  /** Launches the action (trigger « manuelle » by default); if it is running or waiting already, returns that one (`deja`). */
  launch(id: string, o: { input?: string; trigger?: Execution["trigger"] }): ActionLaunch;
  stop(id: string): void;
  direct(): ActionsState;
  onLive(callback: (e: ActionsState) => void): () => void;
  runs(id: string): Promise<ResumeExecution[]>;
  run(id: string, execution: string): Promise<Execution | null>;
  /** The result of this run (null: the last result), without relaunching anything; null if there is none. */
  page(id: string, execution: string | null): Promise<PageAction | null>;
  /** As for a widget, but nothing is launched: the user relaunches from the page. */
  grant(o: { id: string; profile: string; account: string[]; public: string[] }): Promise<void>;
  /** Withdraws the grant and erases runs, results and memory. */
  denyGrant(id: string): Promise<void>;
  /** Builder try: a « -essai » run that does not become the last result. */
  replay(id: string, origin: string, start: string): ActionLaunch;
  deleteData(id: string): Promise<void>;
}

export interface Kernel {
  paths: SpacePaths;
  actions: KernelActions;
  policy: AccessPolicy;
  /** Name of the agent of this kernel's profile (the one that holds the accesses). */
  agent: string;
  workshopState(): Promise<WorkshopState>;
  /** New conversation: erases the authorizations. Signal the current tab (interactionUtilisateur) afterwards. */
  openAgentSession(o: { cols: number; rows: number; window?: string }): Promise<SessionAgent>;
  /** Widgets of the home page, with their data and state (stored outside the workspace). */
  readHome(): Promise<HomeState>;
  watchHome(callback: () => void): () => Promise<void>;
  /** Harvests this widget right away, after the harvest in progress (trigger: « manuelle » by default). */
  harvestNow(id: string, trigger?: Execution["trigger"]): Promise<WidgetState & { run?: string }>;
  /**
   * Builder try: replays the widget's workflow from block `depart`, with the upstream outputs of run
   * `origine`, in the same queue as the harvests. Writes neither data, nor memory, nor state: only the try run.
   * Exception: a grant lost during the try follows the normal withdrawal path (data erased, `accord-requis`).
   */
  replay(id: string, origin: string, start: string): Promise<AttemptResult>;
  /** The run (or try) that is running, its blocks along the traces, and the waiting requests. */
  direct(): DirectState;
  /** Called at each change of `direct()`; returns a way to unsubscribe. */
  onLive(callback: (e: DirectState) => void): () => void;
  /** Local AI (Kev, Gemma) given by the browser; null without it. */
  ai: LocalAi | null;
  /**
   * The user authorizes the widget to read with their account, in this login profile. The browser checked beforehand that this
   * profile is not that of a private space. `compte` and `publiques` are the domains shown to the user: refused if they are no
   * longer exactly those of the declaration (the agent rewrote it meanwhile). A harvest follows.
   */
  grant(o: { id: string; profile: string; account: string[]; public: string[] }): Promise<void>;
  /** Withdraws the grant and erases the data read with it: the widget waits for a new grant (`accord-requis`). */
  denyGrant(id: string): Promise<void>;
  stop(): Promise<void>;
}

/** The single entry point for a browser: it gives its bridge, the kernel does the rest. */
export async function createKernel(o: {
  bridge: BrowserBridge;
  root?: string;
  run?: Runner;
  clock?: () => Date;
  profileId?: string;
  /** Folder containing `modeles/` and `docker/` (by default, those of the package). */
  resources?: string;
  /** Workshop shared with the browser (which also launches the applications); otherwise, the kernel creates its own. */
  workshop?: Workshop;
  /** MCP tools of the applications (launch, stop, log). */
  apps?: AppsTools;
  /** Ports on which a local demo opened by the agent is « built » (by default those of the container, containerPortRange). */
  portBuilt?: (port: number) => boolean;
  /**
   * Host folder, outside the mounted workspace, for the raw profiles of the sites the agent did not build (the
   * browser gives `<profil>/profilage`). Absent, these profiles are not saved.
   */
  profilingFolder?: string;
  /** Folder of the widgets' data, states and grants, outside the workspace (the browser gives `<profil>/widgets`). */
  widgetsFolder: string;
  /**
   * Folder of the actions' runs, results, memory and grants, outside the workspace (the browser gives
   * `<profil>/actions`).
   */
  actionsFolder: string;
  /** Local AI for the harvests; stopped with the kernel. */
  ai?: LocalAi;
  /** Workflow engine, mounted in the harvest container (by default `<ressources>/docker/moteur`). */
  engine?: string;
  /** The workflow open in a window's builder (MCP tool `open_workflow`). */
  openWorkflow?: (win: string) => OpenWorkflow | null;
  /** Called after each write of a widget's state or data, and after a grant or its withdrawal. */
  onChange?: () => void;
  /** Tests only: the harvests may read local addresses (the test server). */
  localAddresses?: boolean;
  /** Tests only: the base of the DuckDuckGo searches (a recorded page served locally). */
  searchUrl?: string;
  /** End notification of a watch that has new items (the browser shows it, see SchedulerOptions). */
  notify?: (n: NotificationWidget) => void;
  /** MCP tools of the extensions (provided by the browser). */
  extensions?: ExtensionsTools;
  /** MCP tools of the site apps (provided by the browser). */
  sites?: SitesTools;
}): Promise<Kernel> {
  const paths = spacePaths(o.root);
  const run = o.run ?? defaultRunner;
  await initSpace(paths, o.resources ? join(o.resources, "modeles") : undefined);

  const profileId = o.profileId ?? "claude";
  const profile = (await loadProfiles(paths)).profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Profil d'agent inconnu : ${profileId}`);

  const policy = new AccessPolicy(o.portBuilt ? { portBuilt: o.portBuilt } : {});
  const { widgetsFolder: widgetsFolder } = o;
  const { actionsFolder: actionsFolder } = o;
  // An action deleted (or put in the trash) since the last launch: its data and grant go.
  await forgetGoneActions(paths, actionsFolder).catch((e) => console.error("[webaios] oubli des actions disparues :", e));
  const ai = o.ai ?? null;
  // Access specific to this kernel, closed with it: a harvest still in flight at shutdown does not relaunch Kev.
  const aiAccess = ai?.access() ?? null;
  // A single dispatcher for the widgets and the actions: an action's calls go before those of the widgets.
  const aiDispatcher = aiAccess ? createAiDispatcher(aiAccess) : null;
  const report = () => {
    try {
      o.onChange?.();
    } catch (e) {
      console.error("[webaios] rappel des widgets :", e);
    }
  };
  const widget = async (id: string): Promise<WidgetLu | undefined> =>
    (await readHome(paths, widgetsFolder)).widgets.find((w) => w.id === id);
  // Read by the agent through its MCP tools. A widget whose declaration is unreadable, or that has a recorded grant, counts
  // as reading with the user's account: its data may have been harvested with it.
  const widgetsTools: WidgetsTools = {
    async read(id) {
      const w = await widget(id);
      if (!w) return null;
      const grant = (await readGrants(widgetsFolder))[id] !== undefined;
      if ("error" in w) return { name: id, account: true, data: await readData(widgetsFolder, id) };
      return { name: w.declaration.name, account: grant || w.declaration.sources.account.length > 0, data: w.data };
    },
    harvest: (id) => scheduler.harvestNow(id, "agent"),
    runs: (id) => listRuns(join(widgetsFolder, id)),
    run: (id, execution) => readRun(join(widgetsFolder, id), execution),
  };
  // The browser keeps its dev tools from one kernel to the next: this one takes its own, which revokes those
  // of a previous kernel (its late calls are refused, its attachments drop).
  const owner = o.bridge.devTools?.owner?.();
  const devTools = owner ?? o.bridge.devTools;
  const token = generateToken();
  // Read by the agent through its MCP tools. An unreadable action, or one that has a recorded grant, counts as reading with the
  // user's account. `actions` is defined further down: these functions are only used once the server is launched.
  const actionsTools: ActionsTools = {
    async read(id) {
      const a = await readAction(paths, id);
      if (!a) return null;
      const grant = (await readGrants(actionsFolder))[id] !== undefined;
      if ("error" in a) return { name: id, account: true, input: null };
      return { name: a.declaration.name, account: grant || a.declaration.sources.account.length > 0, input: a.declaration.input?.label ?? null };
    },
    launch: (id, input) => actions.launch(id, { ...(input !== undefined ? { input: input } : {}), trigger: "agent" }).end,
    runs: (id) => actions.runs(id),
    async run(id, execution) {
      const e = await actions.run(id, execution);
      if (!e) return null;
      const r = await readResult(actionsFolder, id, execution);
      return { ...e, plan: r?.plan ?? null };
    },
  };
  const server = await startMcpServer({
    bridge: o.bridge,
    policy: policy,
    token: token,
    agent: profile.name,
    profiles: profileFiles(paths, o.profilingFolder),
    ...(devTools ? { devTools: devTools } : {}),
    ...(o.apps ? { apps: o.apps } : {}),
    widgets: widgetsTools,
    actions: actionsTools,
    ...(o.openWorkflow ? { openWorkflow: o.openWorkflow } : {}),
    ...(o.extensions ? { extensions: o.extensions } : {}),
    ...(o.sites ? { sites: o.sites } : {}),
  });
  try {
    // Session configs left by a crash: their tokens are worth nothing any more.
    // A failure does not prevent starting: dead tokens are harmless.
    await rm(sessionsFolder(paths), { recursive: true, force: true }).catch((e) => console.error("[webaios] purge des configs de session :", e));
    await writeMcpConfig(paths, profile.mcpConfig, { url: server.containerUrl, token: token });
  } catch (e) {
    await server.stop();
    owner?.release();
    throw e;
  }

  // Navigation must never wait for Docker (spec §9): the first image build takes
  // minutes, and a failure (port in use…) only concerns the agent.
  const workshop = o.workshop ?? new Workshop({ paths: paths, run: run, ...(o.resources ? { dockerFolder: join(o.resources, "docker") } : {}) });
  // The container is prepared from launch. If it fails, the first session returns this failure rather than rebuilding
  // everything right away; the following ones (Réessayer) try again. Once successful, it is re-checked (quick probe).
  // Before any session, the agents left by a previous app are stopped.
  const workshopReady = workshop.ensureStarted().then(async (state) => {
    if (state === "demarre") await workshop.stopOrphanSessions();
    return state;
  });
  workshopReady.catch(() => {});
  let startup: Promise<WorkshopState> | null = workshopReady;
  const engine = o.engine ?? (o.resources ? join(o.resources, "docker", "moteur") : join(DEFAULT_DOCKER_FOLDER, "moteur"));
  const directSubscribers = new Set<(e: DirectState) => void>();
  const scheduler = new WidgetsScheduler({
    paths: paths,
    widgetsFolder: widgetsFolder,
    engine: engine,
    workshop: workshop,
    bridge: o.bridge,
    ai: aiAccess,
    ...(aiDispatcher ? { dispatcher: aiDispatcher } : {}),
    onChange: report,
    onLive(e) {
      for (const callback of directSubscribers) {
        try {
          callback(e);
        } catch (err) {
          console.error("[webaios] suivi en direct :", err);
        }
      }
    },
    // Kept apart from `demarrage` (which ouvrirSessionAgent resets to null): the harvests wait for the first startup.
    ready: workshopReady,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.localAddresses ? { localAddresses: true } : {}),
    // A single pacing for the whole application (all kernels, tries included): one search at a time, one
    // read at a time per host, even during the 15 s when the old kernel stops at the profile change.
    pacing: DEFAULT_PACING,
    ...(o.searchUrl !== undefined ? { searchUrl: o.searchUrl } : {}),
    ...(o.notify ? { notify: o.notify } : {}),
  });
  await scheduler.start();
  const actionSubscribers = new Set<(e: ActionsState) => void>();
  const fileActions = new FileActions({
    paths: paths,
    actionsFolder: actionsFolder,
    engine: engine,
    workshop: workshop,
    bridge: o.bridge,
    dispatcher: aiDispatcher,
    ready: workshopReady,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.localAddresses ? { localAddresses: true } : {}),
    pacing: DEFAULT_PACING,
    ...(o.searchUrl !== undefined ? { searchUrl: o.searchUrl } : {}),
    onLive(e) {
      for (const callback of actionSubscribers) {
        try {
          callback(e);
        } catch (err) {
          console.error("[webaios] suivi des actions :", err);
        }
      }
    },
  });
  const actions: KernelActions = {
    list: () => readActions(paths),
    launch: (id, l) => fileActions.launch(id, { input: l.input ?? null, trigger: l.trigger ?? "manuelle" }),
    stop: (id) => void fileActions.stop(id),
    direct: () => fileActions.direct(),
    onLive(callback) {
      actionSubscribers.add(callback);
      return () => void actionSubscribers.delete(callback);
    },
    runs: async (id) => (ID_ACTION.test(id) ? listRuns(join(actionsFolder, id)) : []),
    run: async (id, execution) => (ID_ACTION.test(id) && ID_EXECUTION.test(execution) ? readRun(join(actionsFolder, id), execution) : null),
    async page(id, execution) {
      if (execution !== null && !ID_EXECUTION.test(execution)) return null;
      const action = await readAction(paths, id);
      if (!action) return null;
      const r = execution === null ? await lastResult(actionsFolder, id) : await readResult(actionsFolder, id, execution);
      const e = await readRun(join(actionsFolder, id), r?.run ?? execution ?? "");
      if (!e) return null;
      // Unreadable, or a grant still recorded (rewritten without account, its results may have been read with it): counts as
      // reading with the account (the most cautious, like the MCP tools and the images). Unreadable grants: same.
      const grants = await readGrants(actionsFolder).catch(() => null);
      const account = "error" in action || action.declaration.sources.account.length > 0 || !grants || Object.hasOwn(grants, id);
      const catalog = [...BUILTIN_COMPONENTS, ...(await readAgentComponents(paths.components)).valid];
      return {
        run: e.id,
        start: e.start,
        end: e.end,
        input: r?.input ?? e.input ?? null,
        status: e.status,
        ...(e.error !== undefined ? { error: e.error } : {}),
        page: r ? resolvePage(r.plan ?? { blocks: [] }, r.results, { account: account, catalog: catalog, fallback: r.fallback }) : null,
        account: account,
      };
    },
    async grant({ id, profile: profileName, account: shown, public: shownPublic }) {
      const a = await readAction(paths, id);
      if (!a) throw new Error(`Action inconnue : ${id}`);
      if ("error" in a) throw new Error(`Action illisible : ${a.error}`);
      const { account: account, public: publics } = a.declaration.sources;
      if (!account.length) throw new Error(`L'action ${id} ne lit pas avec un compte`);
      if (!sameLists(account, shown) || !sameLists(publics, shownPublic)) {
        throw new Error(`La déclaration de l'action ${id} a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.`);
      }
      await giveGrant(actionsFolder, id, { domains: [...account].sort(), public: [...publics].sort(), profile: profileName });
    },
    async denyGrant(id) {
      await removeGrant(actionsFolder, id);
      await deleteDataAction(actionsFolder, id);
    },
    replay: (id, origin, start) => fileActions.try(id, origin, start),
    deleteData: (id) => deleteDataAction(actionsFolder, id),
  };
  const bridge = o.bridge;
  const tracking = devTools ? new DevToolsTracking(policy, devTools, () => bridge.listTabs()) : null;

  // Cleanups of the sessions with a window still open, also done at the kernel's shutdown.
  const openSessions = new Set<() => Promise<void>>();

  return {
    paths: paths,
    actions,
    policy: policy,
    agent: profile.name,
    workshopState: () => workshop.state(),
    async openAgentSession({ cols, rows, window: win }) {
      const first = startup;
      startup = null;
      const attempt = first ? first.then(() => workshop.ensureStarted()) : workshop.ensureStarted();
      let state: WorkshopState;
      try {
        state = await attempt;
      } catch (e) {
        throw new WorkshopError("absent", (e as Error).message);
      }
      if (state !== "demarre") throw new WorkshopError(state);
      // New conversation: no authorization any more. The sessions share the MCP server and therefore the policy:
      // a session of another window also loses its accesses (it will ask again), rather than inheriting them.
      policy.reset();
      const id = randomBytes(8).toString("hex");
      // With a window: its own token and config, so that `open_workflow` knows which one speaks (without a window,
      // dev CLI: the main config).
      let sessionToken: string | undefined;
      const configSession = sessionConfigPath(paths, id);
      const clean = (): Promise<void> => {
        if (sessionToken === undefined) return Promise.resolve();
        server.closeSession(sessionToken);
        sessionToken = undefined;
        return rm(configSession, { force: true }).catch((e) => console.error("[webaios] suppression de la config de session :", e));
      };
      try {
        if (win !== undefined) {
          sessionToken = server.openSession(win);
          await writeSessionConfig(paths, profile.mcpConfig, { url: server.containerUrl, token: sessionToken }, id);
        }
        const command = buildCommand(profile, "interactive", {
          mcpConfig: pathInContainer(win !== undefined ? configSession : paths.mcpConfig, paths),
        });
        const session = SessionAgent.start(workshop.sessionCommand(id, command), { cols, rows, stopRemote: () => workshop.stopSession(id) });
        openSessions.add(clean);
        session.onEnd(() => {
          openSessions.delete(clean);
          void clean();
        });
        return session;
      } catch (e) {
        await clean();
        throw e;
      }
    },
    readHome: () => readHome(paths, widgetsFolder),
    watchHome: (callback) => watchHome(paths, callback),
    harvestNow: (id, trigger) => scheduler.harvestNow(id, trigger),
    replay: (id, origin, start) => scheduler.replay(id, origin, start),
    direct: () => scheduler.direct(),
    onLive(callback) {
      directSubscribers.add(callback);
      return () => void directSubscribers.delete(callback);
    },
    ai: ai,
    async grant({ id, profile: profileName, account: shown, public: shownPublic }) {
      const w = await widget(id);
      if (!w) throw new Error(`Widget inconnu : ${id}`);
      if ("error" in w) throw new Error(`Widget illisible : ${w.error}`);
      const { account: account, public: publics } = w.declaration.sources;
      if (!account.length) throw new Error(`Le widget ${id} ne lit pas avec un compte`);
      if (!sameLists(account, shown) || !sameLists(publics, shownPublic)) {
        throw new Error(`La déclaration du widget ${id} a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.`);
      }
      await giveGrant(widgetsFolder, id, { domains: [...account].sort(), public: [...publics].sort(), profile: profileName });
      report();
      // The harvest takes time: it follows in the background and reports its own changes.
      scheduler.harvestNow(id).catch((e) => console.error("[webaios] récolte après accord :", e));
    },
    async denyGrant(id) {
      await removeGrant(widgetsFolder, id);
      // The data read with this account goes with the grant: without it, nothing protects it any more (account removed…).
      await deleteData(widgetsFolder, id);
      const w = await widget(id);
      if (w && !("error" in w) && w.declaration.sources.account.length) {
        const before = await readWidgetState(widgetsFolder, id);
        await writeWidgetState(widgetsFolder, id, {
          status: "accord-requis",
          lastUpdate: before.lastUpdate,
          lastAttempt: before.lastAttempt,
          error: grantRequired(w.declaration),
          kernelError: true,
        });
      }
      report();
    },
    async stop() {
      tracking?.stop();
      await Promise.all([...openSessions].map((clean) => clean()));
      openSessions.clear();
      // No access at all: the cards still displayed are removed, and a late answer grants nothing.
      policy.reset();
      await Promise.all([scheduler.stop(), fileActions.stopAll()]);
      await aiAccess?.close().catch((e) => console.error("[webaios] arrêt de l'IA locale :", e));
      await server.stop();
      owner?.release();
    },
  };
}
