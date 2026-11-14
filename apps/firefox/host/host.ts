import type { Kernel, TabInfo } from "../../../packages/kernel/src/index.ts";
import type { FrameBounds } from "../shared/model.ts";
import type { ClaudeEngine, CodexEngine, DockerStatus, OllamaStatus } from "../shared/settings.ts";
import type { BuilderSelection, TerminalSize } from "../shared/api.ts";
import { hostLocale, hostSay, setHostLocale } from "./locale.ts";

// The agent host: Firefox spawns it and talks JSON-RPC over stdin/stdout, one JSON message per line.
// stdout carries only the RPC: anything else written there would corrupt it, so it goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.info = console.debug = console.error;
// Firefox gone: its pipe breaks, and the end of stdin stops everything below.
process.stdout.on("error", () => {});
process.on("unhandledRejection", (e) => console.error("[ressac] unhandled rejection:", e));

process.env.RESSAC_CONTAINER ||= "ressac-workshop-firefox";
// The existing container's name and host ports: renaming them would orphan it.
process.env.RESSAC_CONTAINER_PORTS ||= "5300-5319";

const { join } = await import("node:path");
const { createInterface } = await import("node:readline");
const { appendFileSync } = await import("node:fs");
const { stat } = await import("node:fs/promises");
// Imported after the env is set and stdout redirected: nothing in the kernel can write to stdout at load time.
const { ACTION_UNKNOWN, Workshop, blockCatalog, loadProfiles, spacePaths, createKernel, defaultRunner, LocalAi, readHome, readFreeLayout, readTheme, Pacing, contextPrefix, removeGrant, deleteData, watchActions, createRecaps, ID_RECAP } = await import("../../../packages/kernel/src/index.ts");
const { SessionsAgent } = await import("../core/agent/sessions.ts");
const { History } = await import("../core/history.ts");
const { createRpc } = await import("../shared/rpc.ts");
const { RemoteBridge } = await import("./remote-bridge.ts");
const { createSites } = await import("./sites.ts");
const { createDesignHost, DESIGN_METHODS, externalMcpPort } = await import("./design.ts");
const { createSettingsHandlers, SETTINGS_METHODS } = await import("./settings.ts");
const { createOllamaRuntime, OLLAMA_LOCAL_URL, OLLAMA_MIN } = await import("./ollama-runtime.ts");
const { createDockerRuntime } = await import("./docker-runtime.ts");
const { createApplicationsHost } = await import("./applications.ts");
const { createActionsHost } = await import("./actions.ts");
const { ExtensionsAgent } = await import("./extensions/agent.ts");
const { CLAUDE_KEY, amoKeychain, keychain } = await import("./keychain.ts");
const { startRelay } = await import("./relay.ts");
const { codexEngineArgs } = await import("./codex-engine.ts");
const { claudeEngineEnv, withoutV1 } = await import("./claude-engine.ts");
const { ClaudeEngineSchema, CodexEngineSchema, DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE } = await import("../shared/settings.ts");
const { executionWidget, executionsWidget, placeWidgets, removeWidget, validatePlacements, toShownWidgets } = await import("./widgets.ts");
const { ACTION_ALREADY_RUNNING } = await import("../shared/actions.ts");
const {
  readActionCode,
  readActionEdit,
  readCode,
  readEdit,
  saveActionCode,
  saveActionEdit,
  saveCode,
  saveEdit,
  workflowOpen,
  WriteQueue,
} = await import("./workflow.ts");
const {
  GrantSchema,
  SchemaActionSite,
  WorkflowBlockSchema,
  DraftSchema,
  TargetSchema,
  SchemaCodeWorkflow,
  SchemaIdAction,
  SchemaIdExecution,
  NameCodeSchema,
  ActionInputSchema,
  builderSelection,
} = await import("../shared/api.ts");

const dataDir = process.env.RESSAC_DATA_DIR;
if (!dataDir) {
  console.error("[ressac] RESSAC_DATA_DIR manquant");
  process.exit(2);
}
const root = join(dataDir, "workspace");
const paths = spacePaths(root);
// Widgets' data, states and grants: outside the space.
const widgetsFolder = join(dataDir, "widgets");
// Outside the agent's kernel: the history works even when the kernel does not start.
const MEMORY_LOOP = process.env.RESSAC_MEMORY_LOOP === "1";
// The pages whose text the history keeps for the agent's memory: http(s), never the machine (unless RESSAC_MEMORY_LOOP).
const keepable = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && (MEMORY_LOOP || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};
// A broken database must not take the agent down: no history then (empty answers, no agent tools).
const hist = (() => {
  try {
    const h = new History(join(dataDir, "history.sqlite"));
    h.purge();
    return h;
  } catch (e) {
    console.error("[ressac] the history could not open:", e);
    return undefined;
  }
})();
const purge = setInterval(() => hist?.purge(), 6 * 60 * 60 * 1000);
purge.unref();
const duckduckgo = process.env.RESSAC_TEST_DUCKDUCKGO_URL;
// Shown when the widgets service has no kernel.
const AGENT_STOPPED_MESSAGE = () => hostSay("host-widgets-no-kernel");
// The answer to a bad builder argument.
const INVALID_ARGUMENT = { ok: false as const, error: "Argument invalide" };
// The workflow builder: the block selected in each window, the workflow page each window shows (chrome's mirror).
const selections = new Map<string, BuilderSelection>();
let actives = new Map<string, string>();
const writes = new WriteQueue();
const idAction = (v: unknown): v is string => SchemaIdAction.safeParse(v).success;
const executionAction = (v: unknown): v is string => SchemaIdExecution.safeParse(v).success;
// A link's bound.
const urlAction = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;
const widgetsContext = { paths: paths, widgetsFolder: widgetsFolder };
// Actions' runs, results, grants and refusals: outside the space.
const actionsFolder = join(dataDir, "actions");
const actionsContext = { paths: paths, actionsFolder: actionsFolder };
// The agent's recaps: the kernel publishes, this instance (same folder) serves the pages and erases, kernel or not.
const recapsFolder = join(dataDir, "recaps");
const recaps = createRecaps({ folder: recapsFolder });
const idRecap = (v: unknown): v is string => typeof v === "string" && ID_RECAP.test(v);
// One container for the agent (whatever its profile) and the apps it launches: the kernel's own default (kernel.ts:389).
const workshop = new Workshop({ paths: paths });

let kernel: Kernel | null = null;
let error: string | null = null;
let ready: Promise<Kernel | null> = Promise.resolve(null);
let unsubscribe: (() => void) | undefined;
let homeStop: (() => Promise<void>) | undefined;
let accessTimer: NodeJS.Timeout | undefined;

const accessState = () => ({ agent: kernel?.agent ?? "L'agent", tabs: kernel?.policy.state() ?? {} });
// Tabs a tool ran on in the last notification.
let notifiedRunning = new Set<string>();
const notifyAccess = (state = accessState()) => {
  clearTimeout(accessTimer);
  accessTimer = undefined;
  notifiedRunning = new Set(Object.keys(state.tabs).filter((id) => state.tabs[id]!.running));
  rpc.notify("access", state);
};
// A burst of policy changes gives one notification per 50 ms, except a tool starting on a tab: sent at once, or a
// read shorter than the 50 ms would never show (the window's halo).
const broadcastAccess = () => {
  const state = accessState();
  if (Object.keys(state.tabs).some((id) => state.tabs[id]!.running && !notifiedRunning.has(id))) return notifyAccess(state);
  accessTimer ??= setTimeout(() => notifyAccess(), 50);
};

// The local AI for harvests: Gemma and the decision model both run in Ollama (same
// /v1/systemone answers). Nothing is installed here: a missing model fails with Ollama's answer.
const ai = new LocalAi({ folder: join(dataDir, "local-ai"), run: defaultRunner, decisionModel: "pplx-decider-flash" });

// The host is Node and cannot call Cc: in tests it writes the file, otherwise the chrome store shows the alert.
// Another address imposed (a remote Ollama, a test): Ressac then starts and installs nothing.
// RESSAC_TEST_OLLAMA_KIND (e2e): a fixed status and actions that touch nothing, to show each state of the pages.
const fakeOllama = process.env.RESSAC_TEST_OLLAMA_KIND;
const ollama = fakeOllama
  ? { status: async () => ({ kind: fakeOllama, version: "0.30.0", min: OLLAMA_MIN }) as OllamaStatus, start: async () => {}, install: async (progress: (p: number | null) => void) => progress(50), close: () => {} }
  : createOllamaRuntime({ url: ai.ollamaUrl, dataDir, managed: process.platform === "darwin" && ai.ollamaUrl === OLLAMA_LOCAL_URL && !process.env.RESSAC_TEST_NO_SYSTEM });
// An installed Ollama that is not running is started with Ressac; nothing is ever downloaded without a click.
void ollama.status().then((s) => (s.kind === "stopped" ? ollama.start() : undefined)).catch((e) => console.error("[ressac] Ollama did not start:", e));
// RESSAC_TEST_DOCKER_KIND (e2e): a fixed status and a start that touches nothing.
const fakeDocker = process.env.RESSAC_TEST_DOCKER_KIND;
const docker = fakeDocker
  ? { status: async () => ({ kind: fakeDocker, app: "OrbStack" }) as DockerStatus, start: async () => {} }
  : createDockerRuntime({ running: async () => (await workshop.state()) !== "docker-absent", managed: process.platform === "darwin" && !process.env.RESSAC_TEST_NO_SYSTEM });
// An installed container app that is not running is started with Ressac, and left running at quit.
void docker.status().then((s) => (s.kind === "stopped" ? docker.start() : undefined)).catch((e) => console.error("[ressac] Docker did not start:", e));
const notify = (n: { title: string; text: string }) => {
  const file = process.env.RESSAC_TEST_NOTIFICATIONS;
  if (file) return void appendFileSync(file, JSON.stringify({ title: n.title, text: n.text }) + "\n");
  rpc.notify("home.notification", { title: n.title, text: n.text });
};

const launchKernel = (profileId: string): Promise<Kernel | null> => {
  error = null;
  return createKernel({
    bridge: bridge,
    profileId: profileId,
    locale: () => hostLocale(),
    root: root,
    widgetsFolder: widgetsFolder,
    actionsFolder: actionsFolder,
    recapsFolder: recapsFolder,
    ...(process.env.RESSAC_TEST_RECAP_DAY_MS ? { recapsDayMs: Number(process.env.RESSAC_TEST_RECAP_DAY_MS) } : {}),
    onRecapChange: (id) => rpc.notify("recaps.changed", { id }),
    onActivity: (a) => rpc.notify("agent.activity", a),
    ai: ai,
    profilingFolder: join(dataDir, "profiling"),
    extensions: extensions.tools(),
    sites: sites.tools,
    workshop: workshop,
    apps: apps.manager,
    openWorkflow: (f) => workflowOpen(actives.get(f), selections.get(f)),
    // Widgets and actions wrote something, or a grant changed: the page reads again.
    onChange: () => rpc.notify("home.change"),
    notify: notify,
    ...(process.env.RESSAC_TEST_LOCAL_ADDRESSES === "1" ? { localAddresses: true } : {}),
    ...(duckduckgo ? { searchUrl: duckduckgo } : {}),
  }).then(
    (n) => {
      kernel = n;
      const offPolicy = n.policy.onChange(broadcastAccess);
      const offDirect = n.onLive((e) => rpc.notify("workflow.live", e));
      const offActions = n.actions.onLive((e) => {
        rpc.notify("actions.live", e);
        actions.directSeen(e);
      });
      unsubscribe = () => (offPolicy(), offDirect(), offActions());
      // A widget added or rewritten, a placement made in another window, a theme: the page reads again.
      // Unguarded, a watch failure would reject `ready` and every host method with it.
      try {
        homeStop = n.watchHome(() => rpc.notify("home.change"));
      } catch (e) {
        console.error("[ressac] the home watch did not start:", e);
      }
      broadcastAccess();
      // Each kernel start (a restart included): what the pages read while it was down is read again.
      rpc.notify("home.change");
      return n;
    },
    (e: Error) => {
      error = e.message;
      console.error("[ressac] the kernel failed to start:", e);
      return null;
    },
  );
};

const stopKernel = async (n: Kernel | null) => {
  kernel = null;
  unsubscribe?.();
  unsubscribe = undefined;
  await homeStop?.();
  homeStop = undefined;
  broadcastAccess();
  await n?.stop();
};

const start = async () => {
  const n = await ready;
  if (!n) throw new Error(error ?? hostSay("host-kernel-not-started"));
  return { agent: n.agent };
};

// Through the kernel, which also writes the grants; without it, the files directly.
const denyWidget = async (w: string) => {
  const n = await ready;
  if (n) return n.denyGrant(w);
  await removeGrant(widgetsFolder, w);
  await deleteData(widgetsFolder, w);
};

// The profile of windows that have not chosen their agent. One kernel serves every profile: it starts once.
let defaultProfile = "claude";
let kernelLaunched = false;

// Codex's and Claude's engines (Settings › Agents) and the relay that adds each one's compatible API key, which stays on the Mac.
let engine = DEFAULT_CODEX_ENGINE;
let claudeEngine = DEFAULT_CLAUDE_ENGINE;
let relocalized = 0;
const keys = { codex: keychain(), claude: keychain(CLAUDE_KEY) };
const cachedKeys: { codex?: string; claude?: string } = {};
// Called after a key is written or removed (Settings › Agents).
const forgetKey = (kind: "codex" | "claude") => void delete cachedKeys[kind];
const relay = await startRelay({
  // Only a string is kept: a failed read (Keychain locked) is tried again.
  readKey: async (kind) => {
    cachedKeys[kind] ??= (await keys[kind].read()) ?? undefined;
    return cachedKeys[kind] ?? null;
  },
});

let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    // Started first (spike S8) but not awaited before the others: a slow docker must not eat the 5 s quit delay
    // before the history is closed. Settled alone:
    // its failure never skips the stops below. RESSAC_TEST_APPS_STOP_FAILS: tests only.
    const appsStopped = (process.env.RESSAC_TEST_APPS_STOP_FAILS === "1" ? Promise.reject(new Error("simulated apps stop")) : apps.stop()).catch((e) =>
      console.error("[ressac] the apps did not stop:", e),
    );
    extensions.stop();
    settings.stopLogins();
    await sessions.stopAll();
    await relay.stop();
    await sites.stop();
    await design.stop();
    await actionsStop?.();
    await stopKernel(await ready);
    await ai.close().catch(() => {});
    ollama.close();
    clearInterval(purge);
    hist?.close();
    await appsStopped;
  })());

const sessions = new SessionsAgent({
  defaultProfile: () => defaultProfile,
  async open(f, t, { profile, resume, onBuildProgress }) {
    const n = await ready;
    if (!n) throw new Error(error ?? hostSay("host-kernel-not-started"));
    // A container app Ressac is starting (or can start): the panel stays on « Préparation » until Docker answers.
    await docker.start().catch(() => {});
    if (profile !== "codex" && profile !== "claude") return n.openAgentSession({ ...t, window: f, profile, resume, onBuildProgress });
    const e = profile === "claude" ? claudeEngine : engine; // one snapshot: the env must match the relay token
    const token = e.kind === "api" && (await keys[profile].has()) ? relay.openSession(profile === "claude" ? withoutV1(e.apiUrl) : e.apiUrl, profile) : null;
    try {
      const relayed = token ? { url: relay.containerUrl, token } : null;
      const extra = profile === "claude" ? claudeEngineEnv(e as ClaudeEngine, relayed) : codexEngineArgs(e as CodexEngine, relayed);
      const session = await n.openAgentSession({ ...t, window: f, profile, resume, extra, onBuildProgress });
      if (token) session.onEnd(() => relay.closeSession(token));
      return session;
    } catch (err) {
      if (token) relay.closeSession(token);
      throw err;
    }
  },
  // The user talks to the agent from the tab on screen: it is given to the agent.
  onSend: (f) => {
    rpc.request<TabInfo | null>("activeTab", [f]).then(
      (o) => o && kernel?.policy.userInteraction(o),
      () => {},
    );
  },
  send: (win, channel, v) => rpc.notify(channel === "data" ? "agent.data" : "agent.state", channel === "data" ? { window: win, data: v } : { window: win, state: v }),
});

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  handlers: {
    // Sets the default profile; the kernel starts once (its sessions stay), a failed start is retried.
    start: async (p: { agentProfile: string; locale?: string }) => {
      defaultProfile = p.agentProfile;
      if (typeof p.locale === "string") setHostLocale(p.locale);
      if (!kernelLaunched || !(await ready)) {
        kernelLaunched = true;
        ready = ready.then(stopKernel).then(() => launchKernel(p.agentProfile));
      }
      return start();
    },
    // Only new windows take the new default: open agents stay.
    changeProfile: (p: { agentProfile: string }) => void (defaultProfile = p.agentProfile),
    "agent.start": (p: { window: string; size: TerminalSize }) => sessions.start(p.window, p.size),
    "agent.switch": async (p: { window: string; profile: unknown }) => {
      if (typeof p.profile === "string" && /^[\w-]{1,64}$/.test(p.profile)) await sessions.switchProfile(p.window, p.profile);
    },
    "agent.current": (p: { window: string }) => sessions.profileOf(p.window),
    "agent.codexEngine": (p: { engine: unknown }) => {
      const r = CodexEngineSchema.safeParse(p?.engine);
      if (r.success) engine = r.data;
    },
    "settings.locale": (p: { locale: unknown }) => {
      if (typeof p?.locale !== "string" || p.locale === hostLocale()) return;
      setHostLocale(p.locale);
      relocalized++;
      void kernel?.relocalize().catch((e) => console.error("[ressac] relocalize failed:", e));
    },
    "agent.claudeEngine": (p: { engine: unknown }) => {
      const r = ClaudeEngineSchema.safeParse(p?.engine);
      if (r.success) claudeEngine = r.data;
    },
    "agent.profiles": async () => {
      // The kernel writes the default profile while it starts: the panel may ask before that.
      await ready;
      try {
        return (await loadProfiles(paths)).profiles.map((x) => ({ id: x.id, name: x.name }));
      } catch {
        return [];
      }
    },
    "access.state": accessState,
    // Home page: the widgets of workspace/home/widgets, their data and state, the validated theme,
    // with the free placement (version 3).
    "home.read": async () => {
      const n = await ready;
      if (!n) return { widgets: [], theme: null };
      try {
        const state = await n.readHome();
        const mtimes: Record<string, number> = {};
        await Promise.all(
          state.widgets.map(async (w) => {
            if ("error" in w || !w.hasDisplay) return;
            try {
              mtimes[w.id] = Math.round((await stat(join(w.folder, "display.html"))).mtimeMs);
            } catch {
              // display.html deleted in the meantime: the next read will tell
            }
          }),
        );
        const [placements, theme] = await Promise.all([readFreeLayout(n.paths), readTheme(n.paths)]);
        // An invalid theme keeps the default: it is reported, never rewritten.
        if (theme.error) console.warn(`[ressac] ${theme.error}`);
        return toShownWidgets({ state: state, placements, theme: theme.theme, mtimes });
      } catch (e) {
        console.error("[ressac] home page unreadable:", e);
        return { widgets: [], theme: null };
      }
    },
    "home.place": async (p: { placements?: unknown }) => {
      try {
        // A placement needs no kernel: the space's folders are enough.
        const ids = (await readHome(paths, widgetsFolder)).widgets.map((w) => w.id);
        await placeWidgets(paths, validatePlacements(p?.placements, ids));
      } catch (e) {
        console.error("[ressac] layout not written:", e);
        // The UI already showed the gesture's preview: it re-reads the old layout instead of leaving it on screen.
        rpc.notify("home.change");
      }
    },
    "home.remove": (p: { id?: unknown }) => {
      const id = typeof p?.id === "string" ? p.id : "";
      // The grant and the data read with the account leave with the widget (through the kernel, which also writes the grants).
      void removeWidget(paths, id, denyWidget).then(
        () => rpc.notify("home.change"),
        (e) => console.error(`[ressac] widget ${id} not removed:`, e),
      );
    },
    "home.grant": async (p: { id: string; profile: string; account: string[]; public: string[] }) => {
      const n = await ready;
      if (!n) return { ok: false as const, error: AGENT_STOPPED_MESSAGE() };
      try {
        // The kernel refuses if the declaration is no longer the one the card showed.
        await n.grant(p);
        return { ok: true as const };
      } catch (e) {
        console.error(`[ressac] grant of widget ${p?.id}:`, e);
        // The UI re-reads the page: the new request is displayed.
        rpc.notify("home.change");
        return { ok: false as const, error: (e as Error).message };
      }
    },
    "home.denyGrant": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.denyGrant(p.id).catch((e) => console.error(`[ressac] grant removal of widget ${p.id}:`, e));
    },
    "home.harvest": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.harvestNow(p.id).catch((e) => console.error(`[ressac] harvest of widget ${p.id}:`, e));
    },
    // Read without the kernel, like the home page: the executions, outside the space.
    "home.runs": (p: { id?: unknown }) => executionsWidget(widgetsFolder, typeof p?.id === "string" ? p.id : ""),
    "home.run": (p: { id?: unknown; run?: unknown }) =>
      executionWidget(widgetsFolder, typeof p?.id === "string" ? p.id : "", typeof p?.run === "string" ? p.run : ""),
    // The workflow builder: inputs checked with the shared
    // schemas, a bad one answered with INVALID_ARGUMENT's shape. The private-space refusal of an action is the chrome's (api.ts).
    "workflow.catalog": () => blockCatalog(),
    "workflow.read": (p: { target?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      if (!target.success) return null;
      return target.data.type === "widget" ? readEdit(widgetsContext, target.data.id) : readActionEdit(actionsContext, target.data.id);
    },
    "workflow.save": (p: { target?: unknown; draft?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const draft = DraftSchema.safeParse(p?.draft);
      if (!target.success || !draft.success) return { ...INVALID_ARGUMENT, warnings: [] };
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionEdit(actionsContext, id, draft.data));
      return writes.inSeries(id, () => saveEdit(widgetsContext, id, draft.data));
    },
    "workflow.readCode": (p: { target?: unknown; name?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      if (!target.success || !name.success) return { error: INVALID_ARGUMENT.error };
      return target.data.type === "widget" ? readCode(paths, target.data.id, name.data) : readActionCode(paths, target.data.id, name.data);
    },
    "workflow.saveCode": (p: { target?: unknown; name?: unknown; text?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      const text = SchemaCodeWorkflow.safeParse(p?.text);
      if (!target.success || !name.success || !text.success) return INVALID_ARGUMENT;
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionCode(paths, id, name.data, text.data));
      return writes.inSeries(id, () => saveCode(paths, id, name.data, text.data));
    },
    "workflow.replay": async (p: { target?: unknown; run?: unknown; block?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const execution = SchemaIdExecution.safeParse(p?.run);
      const block = WorkflowBlockSchema.safeParse(p?.block);
      if (!target.success || !execution.success || !block.success) return INVALID_ARGUMENT;
      const n = await ready;
      if (!n) return { ok: false as const, error: AGENT_STOPPED_MESSAGE() };
      if (target.data.type === "widget") return n.replay(target.data.id, execution.data, block.data);
      // A trial: its result shows in the builder's preview, never as the last result.
      const l = n.actions.replay(target.data.id, execution.data, block.data);
      if (l.already) return { ok: false as const, error: ACTION_ALREADY_RUNNING };
      const r = await l.end;
      return r.status !== "invalid" && r.run !== undefined
        ? { ok: true as const, run: r.run, status: r.status }
        : { ok: false as const, error: r.error ?? "Rejeu impossible" };
    },
    // Bad input or no kernel: {} (the page then selects no run); a failed run throws nothing.
    "workflow.run": async (p: { target?: unknown; input?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const input = ActionInputSchema.safeParse(p?.input ?? null);
      if (!target.success || !input.success) return {};
      const n = await ready;
      if (!n) return {};
      const id = target.data.id;
      if (target.data.type === "action") {
        // A different input while the action runs is not lost silently.
        const l = n.actions.launch(id, { ...(input.data?.trim() ? { input: input.data } : {}), trigger: "manual" });
        if (l.already) return { error: ACTION_ALREADY_RUNNING };
        const r = await l.end;
        if (r.run !== undefined) return { run: r.run };
        return r.error !== undefined ? { error: r.error } : {};
      }
      try {
        const r = await n.harvestNow(id, "manual");
        return r.run === undefined ? {} : { run: r.run };
      } catch (e) {
        console.error(`[ressac] run of widget ${id}:`, e);
        return {};
      }
    },
    "workflow.live": async () => (await ready)?.direct() ?? { running: [], waiting: [] },
    // A bad selection is ignored.
    "workflow.selection": (p: { window?: unknown; target?: unknown; block?: unknown }) => {
      const s = builderSelection(p);
      if (s && typeof p?.window === "string") selections.set(p.window, s);
    },
    // Replaces the whole mirror: a window absent or without a workflow page is forgotten.
    "windows.active": (p: Record<string, unknown> | null) => {
      actives = new Map(Object.entries(p ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    },
    // Actions: what touches the kernel and the disk (the chrome keeps the window state). Inputs checked with the shared
    // schemas; a bad one gets an empty answer.
    "actions.list": () => actions.list(),
    "actions.prepare": (p: { id?: unknown; input?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success ? actions.prepare(p.id, (p.input ?? null) as string | null) : { ok: false, error: ACTION_UNKNOWN },
    "actions.name": (p: { id?: unknown }) => (idAction(p?.id) ? actions.name(p.id) : null),
    "actions.launch": (p: { id?: unknown; input?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success
        ? actions.launch(p.id, (p.input ?? null) as string | null)
        : { status: "invalid", error: "Demande invalide" },
    "actions.stop": (p: { id?: unknown }) => void (idAction(p?.id) && actions.stop(p.id)),
    "actions.page": (p: { id?: unknown; run?: unknown }) =>
      idAction(p?.id) && (p.run === null || executionAction(p.run)) ? actions.page(p.id, p.run) : null,
    "actions.runs": (p: { id?: unknown }) => (idAction(p?.id) ? actions.runs(p.id) : []),
    "actions.run": (p: { id?: unknown; run?: unknown }) => (idAction(p?.id) && executionAction(p.run) ? actions.run(p.id, p.run) : null),
    "actions.live": () => actions.direct(),
    "actions.linkAllowed": (p: { id?: unknown; run?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.run) && urlAction(p.url) ? actions.linkAllowed(p.id, p.run, p.url) : false,
    "actions.imageAllowed": (p: { id?: unknown; run?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.run) && urlAction(p.url) ? actions.imageAllowed(p.id, p.run, p.url) : false,
    // Recaps: `{ gone: true }` goes to the page as is (closed or swept, not « not ready »).
    "recaps.page": (p: { id?: unknown }) => (idRecap(p?.id) ? recaps.page(p.id) : null),
    "recaps.linkAllowed": (p: { id?: unknown; url?: unknown }) => (idRecap(p?.id) && urlAction(p.url) ? recaps.linkAllowed(p.id, p.url) : false),
    "recaps.imageAllowed": (p: { id?: unknown; url?: unknown }) => (idRecap(p?.id) && urlAction(p.url) ? recaps.imageAllowed(p.id, p.url) : false),
    "recaps.closed": (p: { id?: unknown }) => (idRecap(p?.id) ? recaps.remove(p.id) : undefined),
    "actions.grant": (p: unknown) => {
      const r = GrantSchema.safeParse(p);
      return r.success && idAction(r.data.id) ? actions.grant(r.data) : { ok: false, error: "Demande d'accord invalide" };
    },
    "actions.denyGrant": (p: { id?: unknown }) => (idAction(p?.id) ? actions.denyGrant(p.id) : undefined),
    "actions.delete": (p: { id?: unknown }) => (idAction(p?.id) ? actions.delete(p.id) : { ok: false, error: "Demande invalide" }),
    // Site apps (the window is the chrome's). A bad action is ignored.
    // The open apps are known again: the Applications page reads them (it read « fermée » while the host was down).
    "sites.ready": () => sites.resync().then(() => rpc.notify("sites.change")),
    "sites.list": () => sites.list(),
    "sites.act": (p: { id?: unknown; action?: unknown; window?: unknown }) => {
      const a = SchemaActionSite.safeParse(p);
      if (a.success && typeof p?.window === "string") return sites.dispatch(a.data.id, a.data.action, p.window);
    },
    "sites.homeMemory": (p: { id?: unknown }) => (typeof p?.id === "string" ? sites.homeMemory(p.id) : null),
    "sites.note": (p: { id?: unknown; frame?: FrameBounds; favicon?: unknown }) => {
      if (typeof p?.id === "string") sites.note(p.id, { ...(p.frame ? { frame: p.frame } : {}), ...(typeof p.favicon === "string" ? { favicon: p.favicon } : {}) });
    },
    "sites.memoryOp": (p: unknown) => sites.memoryOp(p),
    "sites.position": (p: unknown) => sites.position(p),
    "sites.resume": (p: unknown) => sites.resume(p),
    "sites.lookup": (p: { id?: unknown; url?: unknown }) => {
      if (typeof p?.id === "string" && (p.url === null || typeof p.url === "string")) return sites.lookupAddress(p.id, p.url);
    },
    "sites.grant": (p: { id?: unknown; yes?: unknown; hash?: unknown }) => {
      if (typeof p?.id === "string" && typeof p.yes === "boolean" && typeof p.hash === "string") return sites.grant(p.id, p.yes, p.hash);
    },
    "sites.closed": (p: { id?: unknown }) => {
      if (typeof p?.id === "string") sites.closed(p.id);
    },
    "history.record": (p: Parameters<InstanceType<typeof History>["note"]>[0]) => hist?.note(p),
    "history.import": (p: { visits?: unknown }) => {
      const str = (x: unknown) => typeof x === "string" && x.length <= 2048;
      if (!Array.isArray(p?.visits) || p.visits.length > 50_000) throw new Error("history.import: invalid visits");
      const visits: { url: string; title: string; date: Date }[] = [];
      for (const v of p.visits) {
        const date = new Date(v?.date);
        if (str(v?.url) && str(v?.title) && !isNaN(date.getTime())) visits.push({ url: v.url, title: v.title, date });
      }
      return { count: hist?.importVisits(visits) ?? 0 };
    },
    "history.title": (p: { url: string; spaceId: string; title: string }) => hist?.updateTitle(p.url, p.spaceId, p.title),
    "history.keep": (p: { url: string; spaceId: string; title: string; text: string }) => {
      if (keepable(p.url)) hist?.keep({ ...p, text: String(p.text) });
    },
    "history.makePrivate": (p: { spaceId: string }) => hist?.makePrivate(p.spaceId),
    "history.search": (p: { text: string; limit?: number; distinct?: boolean }) => hist?.search(p.text, p.limit, p.distinct) ?? [],
    "history.recent": () => hist?.recents() ?? [],
    "history.clear": (p: { since?: string }) => hist?.erase(p.since ? new Date(p.since) : undefined),
    "history.forgetText": (p: { url: string; spaceId: string }) => hist?.forgetText(p.url, p.spaceId),
    stop: async () => {
      try {
        await stop();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    "agent.write": (p: { window: string; data: string }) => sessions.write(p.window, p.data),
    "agent.resize": (p: { window: string; size: TerminalSize }) => sessions.resize(p.window, p.size),
    "agent.closeWindow": (p: { window: string }) => {
      selections.delete(p.window);
      actives.delete(p.window);
      void sessions.closeWindow(p.window);
    },
    privateTabs: (p: { privateTabs: string[]; activePrivate: boolean }) => bridge.setPrivate(p),
    "policy.navigated": (p: { id: string; url: string }) => { kernel?.policy.tabNavigated(p.id, p.url); kernel?.search.tabNavigated(p.id, p.url); },
    "policy.closed": (p: { id: string }) => { kernel?.policy.tabClosed(p.id); kernel?.search.tabClosed(p.id); },
    "search.continue": (p: { id: string }) => kernel?.search.continue(p.id),
    "search.stop": (p: { id: string }) => kernel?.search.stop(p.id),
    "search.dismiss": (p: { id: string }) => kernel?.search.dismiss(p.id),
    "policy.cut": (p: { id: string; right?: Parameters<Kernel["policy"]["cut"]>[1] }) => kernel?.policy.cut(p.id, p.right),
    "agent.send": (p: { tab: TabInfo | null }) => void (p.tab && kernel?.policy.userInteraction(p.tab)),
    // Opening the panel on a tab gives it to the agent and pre-fills the context, without sending it.
    "agent.panelOpened": (p: { window: string; tab: TabInfo }) => {
      kernel?.policy.userInteraction(p.tab);
      if (sessions.active(p.window)) sessions.write(p.window, contextPrefix(p.tab.title, p.tab.url));
    },
    // Sent by the chrome on each host start, with the about:addons changes seen while no host ran (applied first:
    // never reinstalled); answered when every granted extension is handled. A failed start is retried by the next one.
    "extensions.ready": async (p: { outsideRessac?: { addonId: string; what: "uninstalled" | "disabled" }[]; crashes?: { addonId?: unknown; at?: unknown }[] }) => {
      for (const c of Array.isArray(p?.crashes) ? p.crashes : []) extensions.crash(c?.addonId, c?.at);
      for (const h of p?.outsideRessac ?? []) await extensions.outsideRessac(h.addonId, h.what);
      return (extensionsStartup ??= extensions.start().catch((e) => {
        extensionsStartup = undefined;
        throw e;
      }));
    },
    "extensions.outsideRessac": (p: { addonId: string; what: "uninstalled" | "disabled" }) =>
      extensions.outsideRessac(p.addonId, p.what),
    "extensions.ran": (p: { addonId: string; profile: string; readable: boolean }) => extensions.ran(p.addonId, p.profile, p.readable),
    // A content script's message is readable only from a tab the agent can read as it is noted:
    // tabReadableByAgent): asked of the policy here, which knows an agent-opened tab before Firefox hears of it.
    "extensions.console": (p: { addonId?: unknown; message?: unknown; tab?: { tabId?: unknown; url?: unknown } | null }) => {
      const o = p?.tab;
      const readable = !!o && typeof o.tabId === "string" && typeof o.url === "string" && kernel?.policy.canRead({ id: o.tabId, url: o.url, title: "", space: "" }) === true;
      extensions.noteConsole(p?.addonId, p?.message, o ? { readable: readable } : null);
    },
    "extensions.crash": (p: { addonId?: unknown; at?: unknown }) => extensions.crash(p?.addonId, p?.at),
    "extensions.privateProfiles": (p: { profiles?: unknown }) =>
      extensions.privateProfiles(Array.isArray(p?.profiles) ? p.profiles.filter((x): x is string => typeof x === "string") : []),
    "extensions.forSpace": (p: { spaceId?: unknown }) => (typeof p?.spaceId === "string" ? extensions.forSpace(p.spaceId) : []),
    "extensions.toggle": (p: { key?: unknown; spaceId?: unknown; active?: unknown; window?: unknown }) =>
      typeof p?.key === "string" && typeof p.spaceId === "string"
        ? extensions.toggle(p.key, p.spaceId, p.active === true, typeof p.window === "string" ? p.window : null)
        : { ok: false, error: hostSay("host-invalid-params") },
    // The Extensions page (the agent's extensions only, decision 8).
    "extensions.list": () => extensions.entries(),
    "extensions.allCut": () => extensions.cut(),
    "extensions.remove": (p: { key?: unknown }) => byKey(p, (key) => extensions.deletePage(key)),
    "extensions.disableEverywhere": (p: { key?: unknown }) => byKey(p, (key) => extensions.disableEverywhere(key)),
    "extensions.reenable": (p: { key?: unknown }) => byKey(p, (key) => extensions.reactivate(key)),
    "extensions.cutUnlock": (p: { key?: unknown }) => byKey(p, (key) => extensions.cutUnlock(key)),
    "extensions.review": (p: { key?: unknown; window?: unknown }) =>
      byKey(p, (key) => extensions.review(key, typeof p.window === "string" ? p.window : null)),
    "extensions.cutAll": (p: { yes?: unknown }) => extensions.cutAll(p?.yes === true),
    // The RPC signal is ignored on purpose: the kernel's Pacing hands the lane back (partie=false) when the read has already ended, and rpc.ts drops a late answer.
    "read.changeHost": (p: { read: string; host: string }) => bridge.changeHost(p.read, p.host),
    // Tests only: a paced read through a Pacing shared by the calls, as a workflow's web widget does.
    ...(process.env.RESSAC_TEST_PACED_READ === "1"
      ? {
          "test.pacedRead": ({ url }: { url: string }) =>
            testPacing.read(new URL(url).hostname, (ch) => bridge.readPageInvisible(url, { profile: null, changeHost: ch })),
        }
      : {}),
    // The agent's applications (host/applications.ts): `apps` is made after the RPC, below.
    ...Object.fromEntries(["apps.list", "apps.act", "apps.windowClosed", "apps.navigation", "apps.note"].map((k) => [k, (p: unknown) => apps.handlers[k]!(p)])),
    // Design mode's host side (host/design.ts): `design` is made after `sites`, below.
    // The settings page (host/settings.ts): `settings` is made after `sites` and `actions`, below.
    ...Object.fromEntries(SETTINGS_METHODS.map((k) => [k, (p: unknown) => settings[k]!(p)])),
    ...Object.fromEntries(DESIGN_METHODS.map((k) => [k, (p: unknown) => design.handlers[k]!(p)])),
    ...(process.env.RESSAC_HOST_TEST === "1" ? { "debug.locale": () => ({ locale: hostLocale(), relocalized }), "debug.log": (p: { text: string }) => console.log(p.text) } : {}),
  },
});
// Errors go to Firefox, which reports them (chrome/store/telemetry.ts), on top of the stderr log.
const reportError = (e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e));
  rpc.notify("telemetryError", { source: "host", type: err.name, message: err.message, stack: err.stack });
};
process.on("unhandledRejection", reportError);
process.on("uncaughtException", (e) => {
  console.error("[ressac] uncaught exception:", e);
  reportError(e);
  // Exit once the notification is flushed: stdout is an asynchronous pipe on macOS.
  writeStdout("", () => process.exit(1));
});
const bridge = new RemoteBridge(rpc, hist, (site, url) => sites.urlAllowed(site, url));
const testPacing = new Pacing();
/** A page request on one extension key: a malformed one is refused as text. */
const byKey = <T,>(p: { key?: unknown } | undefined, f: (key: string) => T) => (typeof p?.key === "string" ? f(p.key) : { ok: false as const, error: hostSay("host-invalid-params") });
// Outside the agent's kernel, like the history: granted extensions run even when the kernel does not start.
const extensions = new ExtensionsAgent({ folder: join(dataDir, "extensions"), agentFolder: paths.extensions, rpc });
// Site apps: the Node side (list, memory, deletion); the windows are the chrome's, asked through the RPC.
const sites = createSites({
  paths: paths,
  dataDir,
  localAddresses: process.env.RESSAC_TEST_LOCAL_ADDRESSES === "1",
  chrome: {
    open: (s, frame, tweaks) => rpc.request("sites.open", [s, frame, tweaks]),
    close: (id) => rpc.request("sites.close", [id]),
    erase: (id) => rpc.request("sites.erase", [id]),
    update: (s, tweaks) => rpc.request("sites.update", [s, tweaks]),
    reloadView: (id) => rpc.request("sites.reloadView", [id]),
    errors: (id) => rpc.request("sites.errors", [id]),
    view: (id) => rpc.request("sites.view", [id]),
    afterGrant: (id, s) => rpc.request("sites.afterGrant", [id, s]),
    rebroadcast: (id) => rpc.request("sites.rebroadcast", [id]),
    openSites: () => rpc.request("sites.openIds"),
    homeChange: (id) => rpc.notify("sites.homeChange", [id]),
    search: (id, yes) => rpc.notify("sites.lookingUp", [id, yes]),
    notice: (id, a) => rpc.notify("sites.notice", [id, a]),
    urlChanged: (id, domains, start, to) => rpc.notify("sites.urlChanged", [id, domains, start, to]),
  },
  // The public read (a throwaway container, no profile): never the app's cookies nor the user's.
  readLinks: async (page, signal) =>
    (await bridge.readPageInvisible(page, { profile: null, ...(process.env.RESSAC_TEST_LOCAL_ADDRESSES === "1" ? { localAddresses: true } : {}), ...(signal ? { signal } : {}) })).links.map((l) => l.url),
  // The review takes a new app's first snapshot.
  broadcast: () => {
    rpc.notify("sites.change");
    design.sitesChanged();
  },
  prefill: (f, t) => sessions.prefill(f, t),
  notifyMemory: (id, message) => rpc.notify("sites.memory", { id, message }),
  // The agent loses its dev tools on the closed window; the app's grant holds for the conversation, until « Supprimer »
  // (an app made again under the same id asks for its card again).
  onClosed: (id) => kernel?.policy.tabClosed(`site:${id}`),
  // Its remarks, review repository and comments go with it.
  onDeleted: (id) => {
    kernel?.policy.removeSiteRead(id);
    design.siteDeleted(id);
  },
  // A snapshot taken between the start and the end of the deletion is erased again (an app made again starts afresh).
  afterDelete: (id) => design.siteDeleted(id),
});
// The agent's applications: the gestionnaire, the Docker probe, the memory; the windows are the chrome's.
const apps = createApplicationsHost({
  paths: paths,
  dataDir,
  workshop: workshop,
  chrome: {
    open: (a, frame) => rpc.request("apps.open", [a, frame]),
    close: (folder) => rpc.request("apps.close", [folder]),
    show: (folder) => rpc.request("apps.show", [folder]),
    erase: (folder) => rpc.request("apps.erase", [folder]),
  },
  // The tab is given to the agent when the text is written, then the panel opens.
  debug: (f, text, access) => {
    sessions.prefill(
      f,
      text,
      access &&
        (() => {
          const tab = access();
          if (tab) kernel?.policy.userInteraction(tab);
        }),
    );
    rpc.notify("design.giveAgent", [f]);
  },
  policy: () => kernel?.policy ?? null,
  // The Applications page reads the list again; design mode too (the running apps' ports may have changed); the review
  // takes a new app's first snapshot.
  broadcast: () => {
    rpc.notify("apps.change");
    rpc.notify("design.change");
    design.appsChanged();
  },
});
// Design mode: remarks, the external MCP server and the review, without waiting for the kernel.
const design = createDesignHost({
  dataDir,
  paths: paths,
  port: externalMcpPort(process.env.RESSAC_PORT_MCP_EXTERNAL),
  sites: () => sites.list().then((l) => l.map(({ id, name: name }) => ({ id, name: name }))),
  // Every app (apps.liste() keeps the running ones only).
  siteApps: () => apps.manager.list(),
  // Remarks from the cart and comments from the review: already reviewed by the user, so sent right away.
  prefill: (f, t) => sessions.prefill(f, t, undefined, true),
  chrome: { agentWindow: () => rpc.request("design.agentWindow"), giveAgent: (f) => rpc.notify("design.giveAgent", [f]) },
  notify: notify,
  broadcast: () => (rpc.notify("external.change"), rpc.notify("design.change")),
});
// Actions: the kernel and disk half; the chrome keeps the window state (private spaces, tabs, pace of links).
const actions = createActionsHost({ paths: paths, actionsFolder: actionsFolder, kernel: () => kernel, onChange: () => rpc.notify("actions.change") });
// The actions and components folders, watched outside the kernel: the page lists even without it.
let actionsStop: (() => Promise<void>) | undefined;
try {
  actionsStop = watchActions(paths, () => rpc.notify("actions.change"));
} catch (e) {
  console.error("[ressac] the actions watch did not start:", e);
}
const settings = createSettingsHandlers({
  workshop,
  ai,
  ollama,
  docker,
  stopApps: () => apps.manager.stopAll(),
  relaunchSessions: () => sessions.relaunchAll(),
  dataDir,
  widgetsFolder,
  actionsFolder,
  names: async (kind) => {
    if (kind === "widget") return Object.fromEntries((await readHome(paths, widgetsFolder)).widgets.flatMap((w) => ("declaration" in w ? [[w.id, w.declaration.name]] : [])));
    const l = kind === "action" ? await actions.list() : await sites.list();
    return Object.fromEntries(l.map((x) => [x.id, x.name]));
  },
  denyWidget,
  denyAction: async (id) => void (await actions.denyGrant(id)),
  revokeSite: (id) => sites.revokeGrant(id),
  deviceCommand: (argv) => workshop.execCommand(argv, { interactive: false }),
  keychain: keys.codex,
  claudeKeychain: keys.claude,
  amoKeychain: amoKeychain(),
  forgetKey,
  notify,
});
// The chrome may not answer yet (its handlers come up later): it calls "sites.ready" once it does.
void sites.resync().catch(() => {});
let extensionsStartup: Promise<void> | undefined;

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (l) => rpc.receive(l))
  .on("close", () => {
    rpc.close("Firefox s'est arrêté");
    // A stop that hangs (docker, a session) must not keep an orphan host alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void stop().finally(() => process.exit(0));
  });
