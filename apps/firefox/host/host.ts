import type { BuildProgress, InstructionChange, Kernel, LaunchSpec, TabInfo } from "../../../packages/kernel/src/index.ts";
import type { OpenOptions } from "../core/agent/chats.ts";
import type { AskReply, ChatView } from "../shared/chat.ts";
import type { FrameBounds } from "../shared/model.ts";
import type { ClaudeEngine, CodexEngine, DockerStatus } from "../shared/settings.ts";
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
// Firefox's kill after its 5 s stop delay: a clean exit runs the "exit" handler that kills the llama-servers' groups (runner.ts).
process.on("SIGTERM", () => process.exit(0));

process.env.RESSAC_CONTAINER ||= "ressac-workshop-firefox";
// The existing container's name and host ports: renaming them would orphan it.
process.env.RESSAC_CONTAINER_PORTS ||= "5300-5319";
// A packaged host never honours the e2e hooks nor the dev overrides that pick a binary, a model or a download to run:
// dropped before any module reads them, so neither the kernel nor the processes it starts see one. The dev host runs
// from source under tsx, where the build flag is absent. (RESSAC_LLAMA_SERVER and RESSAC_KERNEL_RESOURCES are set by
// the browser itself, over the inherited ones.)
declare const __RESSAC_PACKAGED__: boolean | undefined;
const DEV_OVERRIDES = ["RESSAC_GIT", "RESSAC_EMBED_URL", "RESSAC_EMBED_SHA256", "RESSAC_EMBED_SERVER_URL", "RESSAC_ROOT", "RESSAC_HOST_TEST", "RESSAC_MEMORY_LOOP"];
if (typeof __RESSAC_PACKAGED__ !== "undefined" && __RESSAC_PACKAGED__)
  for (const k of Object.keys(process.env)) if (k.startsWith("RESSAC_TEST_") || DEV_OVERRIDES.includes(k)) delete process.env[k];

const { join } = await import("node:path");
const { createInterface } = await import("node:readline");
const { appendFileSync, readFileSync } = await import("node:fs");
const { rm, stat } = await import("node:fs/promises");
// Imported after the env is set and stdout redirected: nothing in the kernel can write to stdout at load time.
const { passportReady, ACTION_UNKNOWN, Workshop, DEFAULT_DOCKER_FOLDER, containerName, createRunner, dockerEngine, blockCatalog, loadProfiles, spacePaths, createKernel, LocalAi, readHome, readFreeLayout, readTheme, Pacing, contextPrefix, handOffText, removeGrant, createAgentWriter, deleteData, watchActions, createRecaps, ID_RECAP, removeReads, EMBED_FILE, WorkspaceLock, tweaksPaused, isTier3Widget } = await import("../../../packages/kernel/src/index.ts");
const { SessionsAgent } = await import("../core/agent/sessions.ts");
const { Chats, ResumeError, SignedOutError } = await import("../core/agent/chats.ts");
const { ChatStore } = await import("../core/agent/chat-store.ts");
const { claudeEngine: claudeChat } = await import("../core/agent/chat/claude.ts");
const { codexEngine: codexChat } = await import("../core/agent/chat/codex.ts");
const { cleanDraft, createChatSend, DRAFT_MAX } = await import("./chat-send.ts");
const { createLoginTerminals } = await import("./chat-login.ts");
const { chatToTerminal } = await import("./chat-terminal.ts");
const { LABEL_SOURCE } = await import("../../../packages/kernel/src/mask/table.ts");
const { labInUse } = await import("./tiers.ts");
const { History } = await import("../core/history.ts");
const { createRpc } = await import("../shared/rpc.ts");
const { RemoteBridge } = await import("./remote-bridge.ts");
const { hostPassport, maskGuess, maskingStatus, maskPaste, maskRuns, revealLocal } = await import("./masking.ts");
const { createSites } = await import("./sites.ts");
const { copyComponentRequest, copyHomeRequest } = await import("./home-copy.ts");
const { createAsk } = await import("./ask.ts");
const { createPageIndexer, llamaEmbed } = await import("./page-indexer.ts");
const { createDesignHost, DESIGN_METHODS, externalMcpPort } = await import("./design.ts");
const { AGENT_ACCOUNTS, createSettingsHandlers, SETTINGS_METHODS } = await import("./settings.ts");
const { createHostWriter, createWriterChoice } = await import("./writer.ts");
const { createAgentCli, NAMES: AGENT_NAMES, profileCli } = await import("./agent-cli.ts");
const { createDockerRuntime } = await import("./docker-runtime.ts");
const { MACHINE_HOME, createMachine, engineCopy, fakeMachine, createWakeGrace, memoryAllows, memoryLevel, vmImage } = await import("./machine.ts");
const { copyLogins, createEngines } = await import("./engines.ts");
const { createApplicationsHost } = await import("./applications.ts");
const { createActionsHost } = await import("./actions.ts");
const { removeAgentExtensions } = await import("./extensions-removal.ts");
const { CLAUDE_KEY, keychain } = await import("./keychain.ts");
const { startRelay } = await import("./relay.ts");
const { codexEngineArgs } = await import("./codex-engine.ts");
const { ollamaRelayTarget } = await import("./ollama-models.ts");
const { claudeEngineEnv, withoutV1 } = await import("./claude-engine.ts");
const { ClaudeEngineSchema, CodexEngineSchema, DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE, MachineIdleSchema, SEARCH_MODEL, cleanAgentDomains } = await import("../shared/settings.ts");
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
  ReadsApprovalSchema,
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
    const h = new History(join(dataDir, "history.sqlite"), { vectorModel: EMBED_FILE });
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
const INVALID_ARGUMENT = () => ({ ok: false as const, error: hostSay("host-invalid-argument") });
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
// The workspace lock after a reveal: the kernel writes it, this instance (same file, read at each call) cuts the container's
// network, refuses the site apps' memory writes and the external MCP, kernel or not.
const maskingFolder = join(dataDir, "masking");
const workspaceLock = new WorkspaceLock(join(maskingFolder, "lock.json"));
/** The kernel's notice for each conversation (session id), shown in its window's panel: a new conversation has none. */
// shortcut: entries of ended conversations stay (a few short texts per conversation); drop them on session close if it grows.
const maskNotices = new Map<string, string>();
/** The user's passports, pushed by the chrome at each host start; every kernel of this process gets this one (ruling F1). */
const passport = hostPassport(process.env);
/** Any failure of a passport.* call: a fixed text, never the value (invariant 7). */
const PASSPORT_INVALID = "invalid passport";
/** The panels read their masking status again (a reveal, a lift, a session opened or closed, a notice). */
const maskingChanged = () => rpc.notify("agent.masking");
/** The workspace lock to the chrome's agent page guard (chrome/agent/page-guard.ts), locked there until told. */
const pushPagesLock = () => rpc.request("agent.pagesLocked", [workspaceLock.locked()]);
const recaps = createRecaps({ folder: recapsFolder });
const idRecap = (v: unknown): v is string => typeof v === "string" && ID_RECAP.test(v);
// One container for the agent (whatever its profile) and the apps it launches: the kernel's own default (kernel.ts:389).
// The user's extra domains (Settings), sent by the chrome at start and on change.
let agentDomains: string[] = [];
// How long the idle machine keeps running (Settings), sent by the chrome at start and on change.
let machineIdleMinutes = 5;
// « Économiser la mémoire » (told by the chrome): scheduled harvests and page indexing wait for calm memory.
let saveMemory = false;
// After the Mac wakes, Firefox reloads and reconnects its pages: harvests (which may boot the machine) and page indexing
// (the embedding server) wait 2 min, whatever the memory looks like in those first seconds.
const wakeGrace = createWakeGrace(2 * 60_000);
setInterval(wakeGrace.tick, 5_000).unref();
const calm = async () => wakeGrace.ok() && memoryAllows(saveMemory);
// Critical pressure while saving memory: the chrome unloads tabs now, and again every 10 s while it lasts (warn is left
// to Firefox's own unloading). On entering it the models unload and an unused machine stops too, at once; later in the
// episode only the tab unloads relieve again (chrome/window/tabs.ts, at most every 60 s). The sysctl, not Firefox's
// topic: Firefox does not tell warn from critical.
let critical = false;
setInterval(() => {
  if (!saveMemory) return void (critical = false);
  void memoryLevel().then((l) => {
    if (!saveMemory) return; // turned off while the level was read
    if (l >= 4 && !critical) relieveMemory();
    critical = l >= 4;
    if (critical) rpc.notify("memory.critical");
  });
}, 10_000).unref();
// An apply while the kernel is down leaves the MCP port closed on purpose: openAgentSession applies again before any session.
// Without `network` the kernel applies no firewall: it must stay passed. The MCP port is known once the kernel is up, read at each apply.
// The workshop's engines: Ressac's machine, Docker while the machine is not ready (or for good where it cannot run).
const runTool = createRunner(() => hostLocale());
const dockerContainers = dockerEngine({ run: runTool });
// The host is Node and cannot call Cc: in tests it writes the file, otherwise the chrome store shows the alert.
// RESSAC_TEST_DOCKER_KIND (e2e): a fixed status and a start that touches nothing.
const fakeDocker = process.env.RESSAC_TEST_DOCKER_KIND;
const docker = fakeDocker
  ? { status: async () => ({ kind: fakeDocker, app: "OrbStack" }) as DockerStatus, start: async () => {} }
  : createDockerRuntime({ running: () => dockerContainers.up(), managed: process.platform === "darwin" && !process.env.RESSAC_TEST_NO_SYSTEM });
// Packaged: ressac-host/vm (Lima's bin/ and share/, podman, lima.yaml); dev: what scripts/vm-tools.sh caches.
const vmTools = (() => {
  const shipped = process.env.RESSAC_KERNEL_RESOURCES;
  if (shipped) {
    const vm = join(shipped, "..", "vm");
    return { limactl: join(vm, "bin", "limactl"), podman: join(vm, "podman"), template: join(vm, "lima.yaml") };
  }
  const app = join(import.meta.dirname, "..");
  const pins = readFileSync(join(app, "scripts", "vm-tools.sh"), "utf8");
  const version = (tool: string) => new RegExp(`^${tool}_version=(\\S+)`, "m").exec(pins)?.[1];
  const cache = join(app, "dist", "cache", "vm-tools");
  return { limactl: join(cache, `lima-${version("lima")}`, "bin", "limactl"), podman: join(cache, `podman-${version("podman")}`, "podman"), template: join(app, "scripts", "vm", "lima.yaml") };
})();
// Tests never touch a real machine. RESSAC_TEST_MACHINE (e2e): a fake one with a fixed status (or removed), that never
// takes over from the fake Docker (no hand-over nor Docker start, its own marker).
const testMachine = process.env.RESSAC_TEST_MACHINE;
// The machine mounts the engine folder by its path, and the harvests name that path: a translocated app (opened from
// the DMG or Downloads) moves at each launch, so the packaged one runs a copy at a path that stays (outside the workspace).
const engineFolder = process.env.RESSAC_KERNEL_RESOURCES ? engineCopy(join(DEFAULT_DOCKER_FOLDER, "engine"), dataDir) : join(DEFAULT_DOCKER_FOLDER, "engine");
const machine: ReturnType<typeof createMachine> = testMachine
  ? fakeMachine(testMachine, join(root, "fake-machine-calls.log"), Number(process.env.RESSAC_TEST_MACHINE_DELAY_MS) || 0)
  : createMachine({
      ...vmTools,
      engine: engineFolder,
      ressacRoot: root,
      run: runTool,
      busy: () => workshop.busy(machine),
      idleMs: () => machineIdleMinutes * 60_000,
      image: vmImage(),
      ...(process.env.RESSAC_TEST_NO_SYSTEM ? { supported: async () => false } : {}),
    });
const engines = createEngines({
  machine,
  // Docker starts its app for the user, never for a background harvest.
  docker: { ...dockerContainers, start: () => docker.start(), wake: (reason) => (reason === "user" ? docker.start() : Promise.resolve()) },
  // Sessions nobody typed in (a panel opened, left empty) do not hold the hand-over: they restart in the machine.
  workshopIdle: async () => !(await workshop.busy(dockerContainers)) || (!(await workshop.busy(dockerContainers, { agentSessions: false })) && !sessions.touched() && "untouched"),
  relaunchSessions: () => sessions.relaunchAll(),
  stopDocker: async () => {
    const r = await runTool(dockerContainers.binary()!, ["stop", "-t", "10", containerName()], { delayMs: 60_000 });
    if (r.code !== 0 && !/no such container/i.test(r.stderr)) throw new Error(`docker stop: ${r.stderr.trim()}`);
  },
  copyLogins: () => copyLogins({ docker: dockerContainers.binary()!, podman: machine.binary(), podmanArgs: machine.args(), run: runTool }),
  marker: join(testMachine ? dataDir : MACHINE_HOME, "logins-copied"),
});
const workshop = new Workshop({ paths: paths, locale: () => hostLocale(), engine: () => engines.current(), browserMode: () => agentMode === "browser", network: () => ({ ports: [kernel?.mcpPort, relay.port].filter((p): p is number => typeof p === "number"), domains: agentDomains, locked: workspaceLock.locked() }) });

// The agents' CLIs, downloaded on first use into .ressac/cli (first on the container's PATH).
const cli = createAgentCli({ internal: paths.internal });

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

// The local AI: the search model (⌘T) runs in the llama-server shipped with Ressac (RESSAC_LLAMA_SERVER, set by
// chrome/agent/command.ts). RESSAC_EMBED_URL / RESSAC_EMBED_SHA256, RESSAC_EMBED_SERVER_URL (a search server already
// running): dev and tests only.
// The agent that writes (host/writer.ts): the default profile's, else the other, by its API key, its Ollama or its signed-in CLI.
const profileAgents = new Map<string, "claude" | "codex">();
// Best effort (the space may not exist yet): a profile read late leaves the default "claude" until agent.profiles runs.
const refreshProfileAgents = () => void loadProfiles(paths).then(({ profiles }) => { for (const x of profiles) profileAgents.set(x.id, profileCli(x)); }, () => {});
/** The CLI a profile needs downloaded: a shipped one's, a custom one's by its command; null for a profile that is gone. */
const cliOfProfile = async (id: string): Promise<"claude" | "codex" | null> => {
  if (id === "claude" || id === "codex") return id;
  const p = (await loadProfiles(paths)).profiles.find((x) => x.id === id);
  return p ? profileCli(p) : null;
};
// Codex's and Claude's engines (Settings › Agent) and their API keys: declared before the writer that reads them.
let engine = DEFAULT_CODEX_ENGINE;
let claudeEngine = DEFAULT_CLAUDE_ENGINE;
const keys = { codex: keychain(), claude: keychain(CLAUDE_KEY) };
const cachedKeys: { codex?: string; claude?: string } = {};
// Only a string is kept: a failed read (Keychain locked) is tried again.
async function readKey(kind: "codex" | "claude"): Promise<string | null> {
  cachedKeys[kind] ??= (await keys[kind].read()) ?? undefined;
  return cachedKeys[kind] ?? null;
}
// The profile of windows that have not chosen their agent. One kernel serves every profile: it starts once.
let defaultProfile = "claude";
const preferredWriter = (): "claude" | "codex" => profileAgents.get(defaultProfile) ?? (defaultProfile === "codex" ? "codex" : "claude");
const writerChoice = createWriterChoice({ workshop, preferred: preferredWriter, installed: cli.installed });
// Each agent's engine (Réglages › Agent): its API key or its Ollama first, its CLI only on its subscription.
const engineOf = (a: "claude" | "codex"): ClaudeEngine | CodexEngine => (a === "claude" ? claudeEngine : engine);
const hostWriter = createHostWriter({
  preferred: preferredWriter,
  engine: engineOf,
  readKey,
  // The other agent is excluded: the CLI writes as the agent picked, never as one the user put on a key or Ollama.
  cli: (only) =>
    createAgentWriter({
      exec: async (argv, x) => {
        const started = Date.now();
        await cli.ensure(argv[0] as "claude" | "codex", undefined, x);
        return workshop.execWrite(argv, { ...x, delayMs: Math.max(1, x.delayMs - (Date.now() - started)) });
      },
      agent: (exclude) => writerChoice.wakeAgent(new Set([...(exclude ?? []), only === "claude" ? "codex" : "claude"])),
      signedOut: writerChoice.signedOut,
      log: (l) => console.log("[writer]", l),
      locale: () => hostLocale(),
    }),
  cliUsable: writerChoice.usable,
  locale: () => hostLocale(),
});
const ai = new LocalAi({
  writer: hostWriter,
  folder: join(dataDir, "local-ai"),
  llamaServer: process.env.RESSAC_LLAMA_SERVER,
  embedUrl: process.env.RESSAC_EMBED_URL,
  embedSha256: process.env.RESSAC_EMBED_SHA256,
  locale: () => hostLocale(),
});
// The decision model (d1) is gone: its folder, left by an older Ressac, is removed once. A plain rm of the path: a link in
// its place is unlinked, never followed outside the data folder. Idempotent, so retried at each launch if it failed.
void rm(join(dataDir, "local-ai", "d1"), { recursive: true, force: true }).catch((e) => console.error("[ressac] the old d1 folder was not removed:", e));

// The ⌘T bar's Demander mode: rules and the search model, outside the workflows' dispatcher queue.
const ask = createAsk({ embed: ai.embed, history: () => hist ?? null });
// The pages' vectors for ⌘T Demander, computed in the background while AI is on and the search model is installed.
// RESSAC_TEST_INDEX_IDLE_MS (e2e): pages seeded after launch get their vectors without waiting for a pass.
const testIndexIdle = Number(process.env.RESSAC_TEST_INDEX_IDLE_MS);
const indexer = hist && createPageIndexer({ history: hist, embed: llamaEmbed(() => ai.embed.ready()), calm, ...(testIndexIdle ? { idleMs: testIndexIdle, passEveryMs: 0 } : {}) });
const startIndexer = () => {
  if (aiOn && ai.embed.installed()) indexer?.start();
};

// AI on (settings.aiEnabled, told by the chrome's `start` and `ai.enabled`): off, nothing below touches Docker or the local models.
let aiOn = false;
// The lab as the chrome stores it (`start`, `lab.enabled`), and the effective lab: stored on and AI on (shared/tiers.ts),
// held here too, whatever the chrome sends.
let labWanted = false;
let labOn = false;
let aiWoken = false;
// Once per off → on: the machine is installed (downloaded once) and the logins move over from Docker; where it cannot
// run, an installed container app that is not running is started, and left running at quit (nothing of it is downloaded
// without a click); Ollama, the agents' optional engine, is the user's to start. The search model (⌘T), small, is downloaded at once when missing; a failure shows in Réglages and is retried at the next launch.
const wakeAi = () => {
  if (aiWoken) return;
  aiWoken = true;
  void ai.check().then((v) => aiOn && !v.embed && settings.downloadModels([SEARCH_MODEL]), () => {});
  // A machine the user removed stays so: only their « Installer la machine » brings it back.
  void machine.install({ auto: true }).then(
    // AI turned off meanwhile (machine.cancel): no hand-over, nor Docker start, until it is on again.
    () => (aiOn && !testMachine ? engines.settle() : Promise.resolve()).catch((e) => console.error("[ressac] the logins did not move to the machine:", e)),
    (e) => {
      console.error("[ressac] the machine is not ready:", e);
      if (aiOn && !testMachine && engines.current().kind === "docker")
        void docker.status().then((s) => (s.kind === "stopped" ? docker.start() : undefined)).catch((e) => console.error("[ressac] Docker did not start:", e));
    },
  );
};
/** Wraps a handler that reaches Docker or Ollama: refused while AI is off, whatever the UI shows. */
const aiOnly =
  <P, R>(f: (p: P) => R) =>
  (p: P): R => {
    if (!aiOn) throw new Error("ai-off");
    return f(p);
  };
/** Wraps a tier-3 handler: refused while the effective lab is off, whatever the UI shows. */
const labOnly =
  <P, R>(f: (p: P) => R) =>
  (p: P): R => {
    if (!labOn) throw new Error("lab-off");
    return f(p);
  };
// Every workflow.*, actions.*, design mode and sites.* handler but the chrome's shutdown paths (a window closing notes its frame).
const LAB_FREE = new Set(["sites.ready", "sites.closed", "sites.tabDetached", "sites.note"]);
const labRpc = (k: string) => !LAB_FREE.has(k) && (/^(workflow|actions|sites)\./.test(k) || (DESIGN_METHODS as readonly string[]).includes(k));
const gateLab = <H extends Record<string, (p: never) => unknown>>(h: H): H =>
  Object.fromEntries(Object.entries(h).map(([k, f]) => [k, labRpc(k) ? labOnly(f) : f])) as H;
// `start` and `ai.enabled` run one after the other (the RPC runs each message in its own microtask): a quick off → on
// must not see on's wake undone by off's stops still in flight. An off waits for a kernel launch in flight, then stops it.
let aiSwitch: Promise<unknown> = Promise.resolve();
const serialAi = <R,>(f: () => Promise<R>): Promise<R> => {
  const run = aiSwitch.then(f);
  aiSwitch = run.catch(() => {});
  return run;
};
const notify = (n: { title: string; text: string }) => {
  const file = process.env.RESSAC_TEST_NOTIFICATIONS;
  if (file) return void appendFileSync(file, JSON.stringify({ title: n.title, text: n.text }) + "\n");
  rpc.notify("home.notification", { title: n.title, text: n.text });
};

const launchKernel = (profileId: string): Promise<Kernel | null> => {
  error = null;
  return createKernel({
    bridge: bridge,
    lab: () => labOn,
    profileId: profileId,
    locale: () => hostLocale(),
    engine: engineFolder,
    root: root,
    widgetsFolder: widgetsFolder,
    actionsFolder: actionsFolder,
    recapsFolder: recapsFolder,
    maskingFolder: maskingFolder,
    passport,
    ...(process.env.RESSAC_TEST_RECAP_DAY_MS ? { recapsDayMs: Number(process.env.RESSAC_TEST_RECAP_DAY_MS) } : {}),
    onRecapChange: (id) => rpc.notify("recaps.changed", { id }),
    onActivity: (a) => rpc.notify("agent.activity", a),
    ai: ai,
    profilingFolder: join(dataDir, "profiling"),
    sites: sites.tools,
    workshop: workshop,
    apps: apps.manager,
    // Before the revealed value leaves: no agent app keeps running, no CDN or WebRTC for agent pages.
    onLock: async () => {
      await Promise.all([apps.manager.stopAll(), pushPagesLock()]);
    },
    // The sweep before a first session kills every process of the agent's user: a sign-in by code in progress ends first
    // (the session waits for it, 2 min at most), then the apps stop cleanly (« arrêtée »).
    // shortcut: a sign-in started in the few ms between its end and the sweep is still killed; serialize them if it shows.
    // The chat's login terminals too: they run as the agent's user (chat-login.ts).
    aroundSweep: (sweep) => Promise.all([settings.loginEnded(), logins.settled()]).then(() => apps.whileStopped(sweep)),
    openWorkflow: (f) => workflowOpen(actives.get(f), selections.get(f)),
    // Widgets and actions wrote something, or a grant changed: the page reads again.
    onChange: () => rpc.notify("home.change"),
    notify: notify,
    // Scheduled harvests may boot the workshop machine: not under memory pressure.
    calm,
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
      const offMasker = n.masker.onChange(maskingChanged);
      // A lift: the panels read the status again, the site apps whose tweaks the lock held back get them.
      const offLock = n.workspaceLock.onChange(() => {
        maskingChanged();
        void pushPagesLock().catch((e) => console.error("[ressac] agent pages' lock not sent:", e));
        if (!workspaceLock.locked()) sites.lockLifted();
      });
      unsubscribe = () => (offPolicy(), offDirect(), offActions(), offMasker(), offLock());
      maskingChanged();
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
  maskingChanged();
  await n?.stop();
};

/** The kernel, or the reason it is not there. */
const liveKernel = async () => {
  const n = await ready;
  if (!n) throw new Error(error ?? hostSay("host-kernel-not-started"));
  return n;
};
const start = async () => ({ agent: (await liveKernel()).agent });

// Through the kernel, which also writes the grants; without it, the files directly.
const denyWidget = async (w: string) => {
  const n = await ready;
  if (n) return n.denyGrant(w);
  await removeGrant(widgetsFolder, w);
  await removeReads(widgetsFolder, w);
  await deleteData(widgetsFolder, w);
};

// Settings: « browser » takes the agent's shell away at its next session (the panel relaunches it on a change).
// `wantedMode` is the chrome's; the Atelier is tier 3, so `agentMode` is browser while the lab is off.
let wantedMode: "browser" | "workshop" = "browser";
let agentMode: "browser" | "workshop" = "browser";
let kernelLaunched = false;

// The relay adds each engine's compatible API key, which stays on the Mac.
let relocalized = 0;
// Called after a key is written or removed (Settings › Agent).
const forgetKey = (kind: "codex" | "claude") => {
  delete cachedKeys[kind];
  writerChoice.reset();
};
const relay = await startRelay({ readKey });

let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    // First: nothing else needs them, and a slow stop below must not leave them running when Firefox kills the host.
    void ai.stopServers().catch(() => {});
    // Detached, after a short grace for the sessions and apps in it: the machine's stop outlives Firefox's kill.
    void machine.close().catch((e) => console.error("[ressac] the machine did not stop:", e));
    // Started first (spike S8) but not awaited before the others: a slow docker must not eat the 5 s quit delay
    // before the history is closed. Settled alone:
    // its failure never skips the stops below. RESSAC_TEST_APPS_STOP_FAILS: tests only.
    const appsStopped = (process.env.RESSAC_TEST_APPS_STOP_FAILS === "1" ? Promise.reject(new Error("simulated apps stop")) : apps.stop()).catch((e) =>
      console.error("[ressac] the apps did not stop:", e),
    );
    indexer?.stop();
    settings.stopLogins();
    await Promise.all([sessions.stopAll(), chats.stopAll(), logins.stopAll()]);
    await relay.stop();
    await sites.stop();
    await design.stop();
    await actionsStop?.();
    await stopKernel(await ready);
    await ai.close().catch(() => {});
    clearInterval(purge);
    hist?.close();
    await appsStopped;
  })());

// The settings handlers that reach Docker (the workshop, the agents' accounts) or Ollama.
const AI_SETTINGS = new Set<string>([
  "settings.agents",
  "settings.login",
  "settings.logout",
  "settings.ollamaModels",
  "settings.workshop",
  "settings.docker",
  "settings.startDocker",
  "settings.restartWorkshop",
  "settings.machineInstall",
  "settings.machineRemove",
  "settings.machineSwitchNow",
  "ai.state",
  "ai.writer",
  "settings.pullModel",
  "settings.pullInBackground",
]);
type StartParams = { agentProfile: string; locale?: string; aiEnabled?: boolean; lab?: boolean };
// Brings the host to `aiOn`, the latest wanted state (set at once by `start` and `ai.enabled`, before their turn in
// serialAi): a step queued behind a newer switch converges to it. On: Docker, the apps and the kernel (once; a
// failed start is retried). Off: the sessions, the apps and the kernel stop (after a launch in flight, chained on `ready`).
const applyAi = async () => {
  if (aiOn) {
    wakeAi();
    startIndexer();
    apps.wake();
    if (!kernelLaunched || !(await ready)) {
      kernelLaunched = true;
      ready = ready.then(stopKernel).then(() => launchKernel(defaultProfile));
    }
    await ready;
    return;
  }
  indexer?.stop();
  await ai.stopServers();
  if (!aiWoken && !kernelLaunched) return;
  aiWoken = false;
  kernelLaunched = false;
  settings.cancelDownloads();
  cli.cancel();
  void machine.cancel().catch((e) => console.error("[ressac] the machine did not stop:", e));
  // The kernel first: its widget scheduler must not start a harvest while the sessions and apps stop. Its stop only
  // drops the sessions' MCP tokens (idempotent with their own end); the sessions themselves stop below.
  ready = ready.then(async (n) => (await stopKernel(n), null));
  await Promise.all([sessions.stopAll(), chats.stopAll(), logins.stopAll()]);
  await apps.stop().catch((e) => console.error("[ressac] the apps did not stop:", e));
  await ready;
};

/** The mode the sessions open in: the chrome's, browser while the lab is off. */
const applyMode = () => {
  const was = agentMode;
  agentMode = labOn && wantedMode === "workshop" ? "workshop" : "browser";
  // A change recreates the container with the mode's mounts (Workshop's shape): no session or app stays in the one removed.
  // To Navigateur, too, no session (custom profiles too) keeps its shell, nor app agent-written code (with the lab going off,
  // relab stops them: one call). AI off: applyAi stops the sessions instead.
  if (was !== agentMode) {
    if (labOn) void apps.manager.stopAll().catch((e) => console.error("[ressac] the apps did not stop:", e));
    // After the relaunch (its start already recreated the container): with no session, the old shape (Atelier's writable
    // folders) must not keep running. removeOutdated keeps it under the lock.
    const outdated = () => workshop.removeOutdated().catch((e) => console.error("[ressac] the outdated workshop was not removed:", e));
    // The discussions resting in the old container pause (a running turn ends with it and shows « Réessayer »).
    return aiOn ? Promise.all([sessions.relaunchActive(), chats.pauseIdle()]).finally(outdated) : outdated();
  }
  sessions.engineChanged("claude");
  sessions.engineChanged("codex");
};
/** `labWanted` or `aiOn` changed: the effective lab follows; off, no agent app keeps running agent-written code (site app windows: the chrome closes them). */
const relab = (force = false) => {
  const was = labOn;
  labOn = labWanted && aiOn;
  if (was === labOn && !force) return;
  if (was && !labOn) void apps.manager.stopAll().catch((e) => console.error("[ressac] the apps did not stop:", e));
  return applyLab();
};
/** Brings the lab's parts to `labOn`: the kernel's gate, the external MCP, the actions watch and the agent's mode. */
const applyLab = async () => {
  const on = labOn;
  if (on) watchActionsNow();
  else {
    const s = actionsStop;
    actionsStop = undefined;
    void s?.().catch(() => {});
  }
  await Promise.all([
    design.setLab(on),
    applyMode(),
    kernel?.setLab(on).catch((e) => console.error(`[ressac] lab ${on ? "on" : "off"} failed:`, e)),
  ]);
};

/**
 * What every agent start needs first, terminal or chat: AI on, the passports, the kernel, the machine awake, the profile's
 * CLI downloaded (its progress through `onBuildProgress`).
 */
async function readyToStart(profile: string, onBuildProgress?: (p: BuildProgress) => void): Promise<Kernel> {
  if (!aiOn) throw new Error("ai-off");
  await aiSwitch;
  // Ressac's own texts to the session (prefills, the ⌘T question) are masked as they are written, once it runs: with
  // the passports, never before them (design § 5.2). At the cap: as without a kernel.
  if (!(await passportReady(passport))) throw new Error(hostSay("host-kernel-not-started"));
  const n = await ready;
  if (!n) throw new Error(error ?? hostSay("host-kernel-not-started"));
  // AI turned off while waiting: no further docker command.
  if (!aiOn) throw new Error("ai-off");
  // The machine or a container app Ressac is starting (or can start): the panel stays on « Préparation » until it answers.
  await engines.current().wake("user").catch(() => {});
  if (!aiOn) throw new Error("ai-off");
  // A custom profile runs a pinned CLI too (by its command): the image carries none. A profile gone: the kernel says so.
  const needs = await cliOfProfile(profile);
  if (needs) {
    // The kernel refuses this anyway: before a download nobody can use yet.
    if (workspaceLock.locked() && (await workshop.shapeChanged())) throw new Error(hostSay("kernel-err-shape-locked"));
    const since = Date.now();
    const agent = AGENT_NAMES[needs];
    const label = (p: number | null) => (p === null ? hostSay("host-cli-downloading-size", { agent }) : hostSay("host-cli-downloading", { agent, percent: p }));
    await cli.ensure(needs, (p) => onBuildProgress?.({ step: 1, of: 1, label: label(p), since }));
    if (!aiOn) throw new Error("ai-off");
  }
  return n;
}

/** The engine relay's env and args for a shipped profile (Réglages › Agent), and its token: the caller closes it when the session ends. */
async function engineRelay(profile: "claude" | "codex"): Promise<{ extra: { args: string[]; env: Record<string, string> }; token: string | null }> {
  const e = profile === "claude" ? claudeEngine : engine; // one snapshot: the env must match the relay token
  const claude = profile === "claude";
  // Ollama is relayed without a key: the agent reaches inference paths only, never /api/pull. Codex's target ends in /v1.
  const token =
    e.kind === "api" && (await keys[profile].has())
      ? relay.openSession(claude ? withoutV1(e.apiUrl) : e.apiUrl, profile)
      : e.kind === "ollama" && e.ollamaUrl
        ? relay.openSession(ollamaRelayTarget(e.ollamaUrl, profile), `${profile}-ollama`)
        : null;
  try {
    const relayed = token ? { url: relay.containerUrl, token } : null;
    return { extra: claude ? claudeEngineEnv(e as ClaudeEngine, relayed) : codexEngineArgs(e as CodexEngine, relayed), token };
  } catch (err) {
    if (token) relay.closeSession(token);
    throw err;
  }
}

/** Ressac's own text for a window's agent, as it goes to it: masked with its session's table (nothing to mask without a kernel). */
const maskForAgent = (win: string, text: string) => kernel?.masker.maskTyped(win, text).text ?? text;
const sessions = new SessionsAgent({
  defaultProfile: () => defaultProfile,
  mask: maskForAgent,
  // The mode counts as part of the engine: a change offers « Relancer » in the other windows' panels.
  engineOf: (p) => (p === "claude" ? JSON.stringify([claudeEngine, agentMode]) : p === "codex" ? JSON.stringify([engine, agentMode]) : ""),
  async open(f, t, { profile, resume, conversation, thread, onBuildProgress, review }) {
    const n = await readyToStart(profile, onBuildProgress);
    if (profile !== "codex" && profile !== "claude") return n.openAgentSession({ ...t, window: f, profile, resume, mode: agentMode, onBuildProgress, review });
    const { extra, token } = await engineRelay(profile);
    try {
      const session = await n.openAgentSession({ ...t, window: f, profile, resume, ...(profile === "claude" ? { conversation } : thread ? { conversation: thread } : {}), extra, mode: agentMode, onBuildProgress, review });
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

// The chat (spec §4-§7): discussions over pipe sessions, the terminal above stays for « Mode avancé » and custom profiles.
const CHAT_CUSTOM_PROFILE = "Ce profil s'utilise dans le terminal (Mode avancé).";
const CHAT_WINDOW_CLOSED = "La fenêtre de cette discussion est fermée.";
const CHAT_LABEL = new RegExp(`^${LABEL_SOURCE}$`);
/** Réglages › Agent « Affichage de l'agent », told by the chrome. */
let agentView: "chat" | "terminal" = "chat";
/** Windows whose panel shows the terminal for now (« Mode avancé ») whatever the setting. */
const terminalWindows = new Set<string>();
/** A custom profile stays in the terminal: the chat speaks the shipped CLIs only. */
const viewOf = (win: string) => {
  const profile = sessions.profileOf(win);
  return agentView === "terminal" || terminalWindows.has(win) || (profile !== "claude" && profile !== "codex") ? "terminal" : "chat";
};
/** Each window's active space, as its UI last said: where a discussion made for it belongs. */
const windowSpaces = new Map<string, string>();
/** Page titles the agent saw (list_tabs), for its read_tab lines. */
const tabTitles = new Map<string, string>();
const rememberTabs = (l: readonly TabInfo[]) => {
  for (const t of l) tabTitles.set(t.id, t.title);
  if (tabTitles.size > 500) for (const k of [...tabTitles.keys()].slice(0, tabTitles.size - 500)) tabTitles.delete(k);
};
/** An engine start in flight: aborted, with its review card, when its discussion pauses or fails meanwhile. */
type ChatOpen = { abort: AbortController; review?: { id: number; resolve: (c: "keep" | "revert") => void; reject: (e: Error) => void } };
const chatOpens = new Map<string, ChatOpen>();
const chatPrep = new Map<string, NonNullable<ChatView["preparing"]>>();
/** The last view each discussion pushed, to push it again with its preparing state. */
const chatViews = new Map<string, { win: string; view: ChatView }>();
let chatReviews = 0;
/** Accounts seen signed in by their status command: the next opens skip the check (a later sign-out shows at its turn). */
const signedIn = new Set<"claude" | "codex">();
const chatStore = new ChatStore(join(dataDir, "chats"));
void chatStore.sweep(Date.now()).catch((e) => console.error("[ressac] old discussions not removed:", e));

/** The view with what the host adds: the start's progress, the drafts waiting, the window's prefix. */
const decorated = (win: string, view: ChatView): ChatView => {
  const id = view.summary.id;
  const preparing = chatPrep.get(id);
  const waiting = chatSend.waiting(id);
  const prefix = chats.active(win)?.summary.id === id ? chatSend.prefixOf(win) : null;
  return { ...view, ...(preparing ? { preparing } : {}), ...(waiting ? { waiting } : {}), ...(prefix ? { prefix } : {}), ...(terminalWindows.has(win) ? { advanced: true as const } : {}) };
};
const pushChat = (win: string, view: ChatView) => {
  chatViews.set(view.summary.id, { win, view });
  rpc.notify("chat.view", { window: win, view: decorated(win, view) });
};
const repushChat = (id: string) => {
  const v = chatViews.get(id);
  if (v) pushChat(v.win, v.view);
};
const abortChatOpen = (id: string) => {
  const o = chatOpens.get(id);
  o?.abort.abort();
  o?.review?.reject(new Error("closed"));
};

/** The account's status command in the workshop (Réglages' check); unreadable counts as signed in: the engine's own error shows then. */
async function accountSignedIn(agent: "claude" | "codex"): Promise<boolean> {
  const e = engineOf(agent);
  if (e.kind !== (agent === "claude" ? "subscription" : "chatgpt") || signedIn.has(agent)) return true;
  const a = AGENT_ACCOUNTS.find((x) => x.id === agent)!;
  try {
    const s = a.parse(await workshop.exec(a.status));
    if (s.loggedIn) signedIn.add(agent);
    return s.loggedIn;
  } catch {
    return true;
  }
}

/** Chats' open: the kernel's pipe session, then the engine on it. Any failure once the session exists stops it (its slot blocks a lift). */
async function openChat(o: OpenOptions) {
  if (o.profile !== "claude" && o.profile !== "codex") throw new Error(CHAT_CUSTOM_PROFILE);
  if (o.windowId === null) throw new Error(CHAT_WINDOW_CLOSED);
  const slot: ChatOpen = { abort: new AbortController() };
  const signal = slot.abort.signal;
  chatOpens.set(o.chatId, slot);
  const onBuildProgress = (p: BuildProgress) => {
    if (slot.review) return;
    chatPrep.set(o.chatId, { state: "preparing", ...p });
    repushChat(o.chatId);
  };
  const review = (files: InstructionChange[]) =>
    new Promise<"keep" | "revert">((resolve, reject) => {
      if (signal.aborted) return reject(new Error("closed"));
      const id = ++chatReviews;
      slot.review = { id, resolve, reject };
      chatPrep.set(o.chatId, { state: "review", id, files });
      repushChat(o.chatId);
    });
  try {
    const n = await readyToStart(o.profile, onBuildProgress);
    if (signal.aborted) throw new Error("closed");
    // Before the kernel session when the workshop runs: a signed-out retry resets no window's grants. A cold workshop
    // starts with the session (the kernel's own start order), and is checked right after it.
    const checked = (await workshop.state().catch(() => null)) === "started";
    if (checked && !(await accountSignedIn(o.engine))) throw new SignedOutError();
    const { extra, token } = await engineRelay(o.profile);
    let launch: LaunchSpec;
    try {
      launch = await n.openAgentSession({
        transport: "pipe",
        window: o.windowId,
        profile: o.profile,
        mode: o.mode,
        resume: o.resumeId !== undefined,
        // Claude by uuid: the covered set and the terminal's resume keep working by id. Codex resumes by thread id in the adapter.
        ...(o.profile === "claude" ? { conversation: o.resumeId ?? o.sessionId } : {}),
        extra,
        onBuildProgress,
        review,
      });
    } catch (err) {
      if (token) relay.closeSession(token);
      throw err;
    }
    try {
      if (signal.aborted) throw new Error("closed");
      if (!checked && !(await accountSignedIn(o.engine))) throw new SignedOutError();
      const conversation = await (o.engine === "claude" ? claudeChat : codexChat)
        .open({
          chatId: o.chatId,
          ...(o.resumeId ? { resumeId: o.resumeId } : {}),
          ...(o.sessionId ? { sessionId: o.sessionId } : {}),
          launch,
          signal,
          tabTitle: (id) => (typeof id === "string" ? tabTitles.get(id) : undefined),
        })
        // Only the engine's own resume failing lets Chats open fresh; an abort stays an abort.
        .catch((err) => {
          throw o.resumeId && !signal.aborted ? new ResumeError(err) : err;
        });
      if (token) conversation.onEnd(() => relay.closeSession(token));
      return { conversation, launch };
    } catch (err) {
      await launch.stop();
      if (token) relay.closeSession(token);
      throw err;
    }
  } finally {
    if (chatOpens.get(o.chatId) === slot) chatOpens.delete(o.chatId);
    chatPrep.delete(o.chatId);
    repushChat(o.chatId);
  }
}

const chats = new Chats({
  store: chatStore,
  open: openChat,
  mode: () => agentMode,
  notify: (win, view) => {
    // Pushed before the flush: a prompt it sends pushes a newer view, which must arrive last.
    pushChat(win, view);
    const s = view.summary.state;
    if (s === "paused" || s === "error" || s === "signed-out") abortChatOpen(view.summary.id);
    chatSend.flush(view.summary.id);
  },
});

/** Talking from a window gives its tab on screen to the agent, as the terminal's Enter does. */
const giveActiveTab = (win: string) => {
  rpc.request<TabInfo | null>("activeTab", [win]).then(
    (t) => t && kernel?.policy.userInteraction(t),
    () => {},
  );
};

const chatSend = createChatSend({
  chats,
  masker: () => kernel?.masker ?? null,
  outflow: () => kernel?.outflow ?? null,
  interacted: giveActiveTab,
  create: (win) => createChat(win, {}),
});

async function createChat(win: string, c: { profile?: unknown; mode?: unknown; space?: unknown }): Promise<ChatView> {
  const profile = typeof c.profile === "string" ? c.profile : sessions.profileOf(win);
  if (profile !== "claude" && profile !== "codex") throw new Error(CHAT_CUSTOM_PROFILE);
  const mode = c.mode === "workshop" || c.mode === "browser" ? c.mode : agentMode;
  if (typeof c.space === "string") windowSpaces.set(win, c.space);
  return chats.create(win, { profile, mode, engine: profile, spaceId: windowSpaces.get(win) ?? "" });
}

/**
 * Ressac's own text for the window's agent (a site app's or an app's prefix, design remarks): the terminal's prefill, or in
 * chat view a message to the active discussion (`submit`) or the prefix of the window's next one, shown in its composer.
 */
function prefillAgent(win: string, text: string, written?: () => void, submit = false): void {
  if (viewOf(win) === "terminal") return sessions.prefill(win, text, written, submit);
  void chatSend
    .prefill(win, text, { submit, ...(written ? { written } : {}) })
    .then(() => {
      const id = activeChat(win)?.id;
      if (id) repushChat(id);
    })
    .catch((e) => console.error("[ressac] text for the discussion not sent:", e));
}

/** The panel's context in chat view: before the discussion's first message, shown in its composer meanwhile. */
function prefillAgentContext(win: string, text: string): void {
  chatSend.panelOpened(win, text);
  const id = activeChat(win)?.id;
  if (id) repushChat(id);
}

const activeChat = (win: unknown) => (typeof win === "string" ? (chats.active(win)?.summary ?? null) : null);

// The CLI's own sign-in for the chat's login card; a first session's sweep waits for it (launchKernel's aroundSweep).
const logins = createLoginTerminals({
  open: async (program, size) => (await liveKernel()).openLoginSession({ ...size, program }),
  data: (win, d) => rpc.notify("agent.data", { window: win, data: d }),
  ended: (win, code) => {
    rpc.notify("agent.state", { window: win, state: { state: "done", code } });
    // Signed in (or not): the window's signed-out discussions check again.
    for (const { win: w, view } of chatViews.values()) if (w === win && view.summary.state === "signed-out") void chats.retry(view.summary.id);
  },
});

/** macOS runs short of memory: the local models unload, idle agent sessions sleep, the machine stops unless in use. */
function relieveMemory(): void {
  void ai.stopServers().catch(() => {});
  void Promise.all([sessions.sleepIdle(Number(process.env.RESSAC_TEST_AGENT_SLEEP_MS) || 2 * 60_000), chats.pauseIdle()])
    .catch((e) => console.error("[ressac] the agent sessions did not sleep:", e))
    .then(() => machine.relieve())
    .catch((e) => console.error("[ressac] the machine did not stop:", e));
}

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  // Tier-3 handlers refused while the lab is off (labRpc).
  handlers: gateLab({
    // Sets the default profile and AI's state; with AI on the kernel starts once (its sessions stay).
    start: (p: StartParams) => {
      defaultProfile = p.agentProfile;
      refreshProfileAgents();
      if (typeof p.locale === "string") setHostLocale(p.locale);
      aiOn = p.aiEnabled === true;
      labWanted = p.lab === true;
      // Forced: a first start brings every part to the lab; a later one that turns it off stops the apps too.
      void relab(true)?.catch((e) => console.error("[ressac] lab at start failed:", e));
      return serialAi(async () => {
        await applyAi();
        return aiOn ? start() : null;
      });
    },
    // Live switch (Réglages). Docker and OrbStack are left running when off: they may serve the user's own work.
    "ai.enabled": (p: { on?: unknown }) => {
      aiOn = p?.on === true;
      void relab()?.catch((e) => console.error("[ressac] lab with AI failed:", e));
      return serialAi(applyAi).catch((e) => console.error(`[ressac] AI ${aiOn ? "on" : "off"} failed:`, e));
    },
    "lab.enabled": (p: { on?: unknown }) => {
      labWanted = p?.on === true;
      return relab();
    },
    // Once, for a session saved before tiers: does the user already use the lab? The chrome sends its saved mode (no
    // `agent.mode` has come yet).
    "lab.decide": async (p: { agentMode?: unknown }) => ({ on: await labInUse(paths, p?.agentMode === "workshop" ? "workshop" : "browser", isTier3Widget) }),
    // macOS runs short of memory (Firefox's memory-pressure): the local models unload, idle agent sessions sleep, the
    // machine stops unless in use.
    "memory.pressure": () => relieveMemory(),
    // Only new windows take the new default: open agents stay.
    changeProfile: (p: { agentProfile: string }) => {
      defaultProfile = p.agentProfile;
      refreshProfileAgents();
    },
    "agent.start": (p: { window: string; size: TerminalSize }) => sessions.start(p.window, p.size),
    "agent.relaunch": (p: { window: string }) => sessions.relaunch(p.window),
    "agent.review": (p: { window: string; id: unknown; choice: unknown }) => {
      if (typeof p.id === "number" && (p.choice === "keep" || p.choice === "revert")) sessions.answerReview(p.window, p.id, p.choice);
    },
    "agent.switch": async (p: { window: string; profile: unknown }) => {
      if (typeof p.profile === "string" && /^[\w-]{1,64}$/.test(p.profile)) await sessions.switchProfile(p.window, p.profile);
    },
    "agent.current": (p: { window: string }) => sessions.profileOf(p.window),
    // The welcome's « Télécharger en arrière-plan »: the profile's CLI downloads while the user goes on (a custom one's by its command).
    "cli.prepare": aiOnly((p: { agent?: unknown }) => {
      if (typeof p?.agent !== "string") return;
      void cliOfProfile(p.agent)
        .then((a) => a && cli.ensure(a))
        .catch((e) => console.error("[ressac] the agent CLI did not download:", e));
    }),
    "agent.mode": (p: { mode: unknown }) => {
      wantedMode = p?.mode === "workshop" ? "workshop" : "browser";
      return applyMode();
    },
    "agent.codexEngine": (p: { engine: unknown }) => {
      const r = CodexEngineSchema.safeParse(p?.engine);
      if (r.success) engine = r.data;
      sessions.engineChanged("codex");
    },
    "settings.locale": (p: { locale: unknown }) => {
      if (typeof p?.locale !== "string" || p.locale === hostLocale()) return;
      setHostLocale(p.locale);
      relocalized++;
      // `ready` also covers a kernel being created or restarted: the change is applied once it is up.
      void ready.then((n) => n?.relocalize()).catch((e) => console.error("[ressac] relocalize failed:", e));
    },
    "settings.agentDomains": (p: { domains: unknown }) => {
      agentDomains = Array.isArray(p?.domains) ? cleanAgentDomains(p.domains) : [];
      // New connections follow the list; a running session is not killed. A stopped container has no rules to refresh.
      // AI off: Docker is never touched; turning AI on starts the workshop, which applies the list then.
      if (!aiOn) return;
      // Not applied: the running sessions start again, so each one applies the list or shows why it cannot.
      void workshop
        .state()
        .then((s) => (s === "started" ? workshop.secureNetwork() : undefined))
        .catch((e) => {
          console.error("[ressac] agent domains not applied:", e);
          return sessions.relaunchActive();
        });
    },
    "settings.saveMemory": (p: { on?: unknown }) => {
      saveMemory = p?.on === true;
    },
    "settings.machineIdle": (p: { minutes: unknown }) => {
      const r = MachineIdleSchema.safeParse(p?.minutes);
      if (r.success) machineIdleMinutes = r.data;
    },
    "agent.claudeEngine": (p: { engine: unknown }) => {
      const r = ClaudeEngineSchema.safeParse(p?.engine);
      if (r.success) claudeEngine = r.data;
      sessions.engineChanged("claude");
    },
    "agent.profiles": async () => {
      // After the kernel's start (removeOutdated, initSpace): .ressac/profiles is read once no older container can move .ressac.
      await aiSwitch;
      await ready;
      try {
        const { profiles } = await loadProfiles(paths);
        refreshProfileAgents();
        return profiles.map((x) => ({ id: x.id, name: x.name }));
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
    "home.approveReads": async (p: unknown) => {
      const r = ReadsApprovalSchema.safeParse(p);
      if (!r.success) return { ok: false as const, error: hostSay("host-invalid-grant-request") };
      const n = await ready;
      if (!n) return { ok: false as const, error: AGENT_STOPPED_MESSAGE() };
      try {
        // The kernel refuses if the declaration is no longer the one the banner showed.
        await n.approveReads(r.data);
        return { ok: true as const };
      } catch (e) {
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
    "workflow.catalog": () => blockCatalog(hostLocale()),
    "workflow.read": (p: { target?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      if (!target.success) return null;
      return target.data.type === "widget" ? readEdit(widgetsContext, target.data.id) : readActionEdit(actionsContext, target.data.id);
    },
    "workflow.save": (p: { target?: unknown; draft?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const draft = DraftSchema.safeParse(p?.draft);
      if (!target.success || !draft.success) return { ...INVALID_ARGUMENT(), warnings: [] };
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionEdit(actionsContext, id, draft.data));
      return writes.inSeries(id, () => saveEdit(widgetsContext, id, draft.data));
    },
    "workflow.readCode": (p: { target?: unknown; name?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      if (!target.success || !name.success) return { error: INVALID_ARGUMENT().error };
      return target.data.type === "widget" ? readCode(paths, target.data.id, name.data) : readActionCode(paths, target.data.id, name.data);
    },
    "workflow.saveCode": (p: { target?: unknown; name?: unknown; text?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      const text = SchemaCodeWorkflow.safeParse(p?.text);
      if (!target.success || !name.success || !text.success) return INVALID_ARGUMENT();
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionCode(paths, id, name.data, text.data));
      return writes.inSeries(id, () => saveCode(paths, id, name.data, text.data));
    },
    "workflow.replay": async (p: { target?: unknown; run?: unknown; block?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const execution = SchemaIdExecution.safeParse(p?.run);
      const block = WorkflowBlockSchema.safeParse(p?.block);
      if (!target.success || !execution.success || !block.success) return INVALID_ARGUMENT();
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
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success ? actions.prepare(p.id, (p.input ?? null) as string | null) : { ok: false, error: ACTION_UNKNOWN(hostLocale()) },
    "actions.name": (p: { id?: unknown }) => (idAction(p?.id) ? actions.name(p.id) : null),
    "actions.copyComponent": (p: { root?: unknown; name?: unknown; token?: unknown }) => copyComponentRequest(p?.root, paths.components, p),
    "actions.launch": (p: { id?: unknown; input?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success
        ? actions.launch(p.id, (p.input ?? null) as string | null)
        : { status: "invalid", error: hostSay("host-invalid-request") },
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
      return r.success && idAction(r.data.id) ? actions.grant(r.data) : { ok: false, error: hostSay("host-invalid-grant-request") };
    },
    "actions.approveReads": (p: unknown) => {
      const r = ReadsApprovalSchema.safeParse(p);
      return r.success && idAction(r.data.id) ? actions.approveReads(r.data) : { ok: false, error: hostSay("host-invalid-grant-request") };
    },
    "actions.denyGrant": (p: { id?: unknown }) => (idAction(p?.id) ? actions.denyGrant(p.id) : undefined),
    "actions.delete": (p: { id?: unknown }) => (idAction(p?.id) ? actions.delete(p.id) : { ok: false, error: hostSay("host-invalid-request") }),
    // Site apps (the window is the chrome's). A bad action is ignored.
    // The open apps are known again: the Applications page reads them (it read « fermée » while the host was down).
    // The chrome's handlers are up: its agent page guard learns the lock, its site windows are listed.
    "sites.ready": () => {
      void pushPagesLock().catch((e) => console.error("[ressac] agent pages' lock not sent:", e));
      return sites.resync().then(() => rpc.notify("sites.change"));
    },
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
    "sites.tabSite": (p: { id?: unknown }) => (typeof p?.id === "string" ? sites.tabSite(p.id) : null),
    "sites.tabDetached": (p: { id?: unknown }) => {
      if (typeof p?.id === "string") sites.tabDetached(p.id);
    },
    "sites.position": (p: unknown) => sites.position(p),
    "sites.resume": (p: unknown) => sites.resume(p),
    "sites.copyHome": (p: { root?: unknown; id?: unknown; token?: unknown }) => copyHomeRequest(p?.root, paths.sites, p),
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
      // No history (unreadable database): a failure, so the importer says the history did not come in.
      if (!hist) throw new Error("history.import: no history");
      if (!Array.isArray(p?.visits) || p.visits.length > 50_000) throw new Error("history.import: invalid visits");
      const visits: { url: string; title: string; date: Date }[] = [];
      for (const v of p.visits) {
        const date = new Date(v?.date);
        // A long title is cut by importVisits (TITLE_MAX), never a reason to drop the visit.
        if (typeof v?.url === "string" && v.url.length <= 2048 && typeof v.title === "string" && !isNaN(date.getTime()))
          visits.push({ url: v.url, title: v.title, date });
      }
      return { count: hist.importVisits(visits) };
    },
    "history.title": (p: { url: string; spaceId: string; title: string }) => hist?.updateTitle(p.url, p.spaceId, p.title),
    "history.icon": (p: { url: string; spaceId: string; icon: string }) => hist?.noteIcon(p.url, p.spaceId, p.icon),
    "history.keep": (p: { url: string; spaceId: string; title: string; text: string; byAgent: boolean }) => {
      if (keepable(p.url)) hist?.keep({ ...p, text: String(p.text) });
    },
    "history.makePrivate": (p: { spaceId: string }) => hist?.makePrivate(p.spaceId),
    "history.search": (p: { text: string; limit?: number; distinct?: boolean }) => hist?.search(p.text, p.limit, p.distinct) ?? [],
    "history.recent": () => hist?.recents() ?? [],
    "history.clear": (p: { since?: string }) => hist?.erase(p.since ? new Date(p.since) : undefined),
    "history.forgetText": (p: { url: string; spaceId: string }) => hist?.forgetText(p.url, p.spaceId),
    "ask.usable": () => aiOn && ask.usable(),
    "ask.warm": () => void (aiOn && ask.warm()),
    "ask.find": aiOnly((p: { question?: unknown }) => {
      if (typeof p?.question !== "string") throw new Error("ask.find: invalid question");
      return ask.find(p.question.slice(0, 2000));
    }),
    "ask.handOff": aiOnly((p: { window?: unknown; question?: unknown; shown?: unknown; space?: unknown }) => {
      if (typeof p?.window !== "string" || typeof p.question !== "string" || !Array.isArray(p.shown)) throw new Error("ask.handOff: invalid params");
      const str = (x: unknown) => typeof x === "string";
      const shown = (p.shown as Partial<Record<"url" | "title" | "lastVisit", unknown>>[])
        .filter((h): h is { url: string; title: string; lastVisit: string } => str(h?.url) && str(h?.title) && str(h?.lastVisit))
        .slice(0, 3);
      const question = p.question.slice(0, 2000);
      const win = p.window;
      if (viewOf(win) === "chat") {
        if (typeof p.space === "string") windowSpaces.set(win, p.space);
        // The question is the user's own text (typed); the pages shown with it go after it, masked, never typed.
        const q = handOffText(question, [], "");
        return chatSend.handOff(win, q, handOffText(question, shown, hostSay("host-ask-shown-pages")).slice(q.length));
      }
      // Outflow rules: only the question is the user's own text, not the page titles shown with it. Fed as it is written,
      // after a fresh session's reset (⌘T usually opens the window's agent), not when it is queued; masked as it is written
      // (the same value gets the same label in the session's table).
      sessions.prefill(win, handOffText(question, shown, hostSay("host-ask-shown-pages")), () => kernel?.outflow.typed(win, maskForAgent(win, question) + "\r"), true);
    }),
    stop: async () => {
      try {
        await stop();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    // The user's keystrokes and pastes: what they type is theirs to send, not what they paste (outflow rules). Prefills never come through here.
    "agent.write": (p: { window: string; data: string; paste?: unknown }) => {
      // The login terminal's keys (a sign-in code) reach no agent: not the outflow's.
      if (logins.write(p.window, p.data)) return;
      kernel?.outflow.typed(p.window, p.data, { pasted: p.paste === true });
      sessions.write(p.window, p.data);
    },
    "agent.resize": (p: { window: string; size: TerminalSize }) => void (logins.resize(p.window, p.size) || sessions.resize(p.window, p.size)),
    "agent.masking": async (p: { window?: unknown }) => {
      const win = String(p?.window);
      const chat = viewOf(win) === "chat" ? chats.sessionIdOf(activeChat(win)?.id ?? "") : undefined;
      return maskingStatus(kernel?.masker ?? null, workspaceLock, maskNotices, win, passport, chat);
    },
    // The chrome's passports (design § 5.2, § 5.3): kept by this process whether a kernel runs or not.
    "passport.replace": async (p: { profile?: unknown; entries?: unknown }) => {
      try {
        if (typeof p?.profile !== "string" || !Array.isArray(p.entries)) throw new Error();
        const { uncovered } = kernel ? await kernel.replacePassport(p.profile, p.entries) : (passport.replace(p.profile, p.entries), { uncovered: 0 });
        return { ok: true, uncovered };
      } catch {
        throw new Error(PASSPORT_INVALID);
      } finally {
        maskingChanged();
      }
    },
    "passport.drop": (p: { profile?: unknown }) => {
      try {
        if (typeof p?.profile !== "string") throw new Error();
        passport.drop(p.profile);
        return { ok: true };
      } catch {
        throw new Error(PASSPORT_INVALID);
      } finally {
        maskingChanged();
      }
    },
    "passport.ready": (p: { unreadable?: unknown }) => {
      if (!Array.isArray(p?.unreadable)) throw new Error(PASSPORT_INVALID);
      passport.markReady(p.unreadable.filter((x): x is string => typeof x === "string"));
      maskingChanged();
      return { ok: true };
    },
    // Lifting the workspace lock (spec § 3). Touch ID ran in the chrome before « masking.lift » (ui/api.ts): a refusal sends nothing.
    "masking.changed": async () => (await liveKernel()).masking.changedFiles(),
    "masking.file": async (p: { path?: unknown }) => {
      if (typeof p?.path !== "string") throw new Error(hostSay("host-invalid-params"));
      return (await liveKernel()).masking.file(p.path);
    },
    "masking.lift": async (p: { choice?: unknown; remove?: unknown }) => {
      const choice = p?.choice;
      if (choice !== "quarantine" && choice !== "keep" && choice !== "delete") throw new Error(hostSay("host-invalid-params"));
      const remove = Array.isArray(p.remove) ? p.remove.filter((x): x is string => typeof x === "string") : [];
      const n = await liveKernel();
      // Idle discussions pause first (R7); a running turn keeps its session open, so the kernel refuses the lift.
      await chats.pauseIdle();
      await n.masking.lift({ choice, remove });
    },
    "masking.quarantine.list": async () => (await liveKernel()).masking.quarantine.list(),
    "masking.quarantine.restore": async (p: { id?: unknown }) => {
      if (typeof p?.id !== "string") throw new Error(hostSay("host-invalid-params"));
      await (await liveKernel()).masking.quarantine.restore(p.id);
    },
    // The value goes back to the window's own UI only: never logged, never in a card's request.
    "agent.revealLocal": (p: { window?: unknown; label?: unknown }) => revealLocal(kernel?.masker ?? null, p?.window, p?.label),
    // A paste held by the terminal: the masked text and what it hid, never the original (the UI keeps it for « Coller en clair »).
    "agent.maskPaste": (p: { window?: unknown; text?: unknown }) => maskPaste(() => kernel?.masker ?? null, passport, p?.window, p?.text),
    // Chrome's « Cacher pour l'agent » marks: where the window's agent sees labels, never a label or a value.
    "mask.runs": (p: unknown) => maskRuns(kernel ?? null, p),
    "mask.guess": (p: unknown) => maskGuess(p),
    "agent.revealLogins": (p: { window?: unknown; ref?: unknown }) => bridge.loginsFor(p?.ref, p?.window),
    // A fill card's passport value (ruling F10): to that card's own window only, never logged.
    "agent.revealPassport": (p: { window?: unknown; ref?: unknown }) => bridge.passportFor(p?.ref, p?.window),
    // Chrome's « Le site n'a pas pu être retenu. » after a fill card's « Retenir ce site » (task 13b).
    "mask.notice": (p: { window?: unknown; text?: unknown }) => maskNotice({ text: p?.text ?? "" }, typeof p?.window === "string" ? p.window : undefined, true),
    "agent.closeWindow": (p: { window: string }) => {
      selections.delete(p.window);
      actives.delete(p.window);
      terminalWindows.delete(p.window);
      windowSpaces.delete(p.window);
      chatSend.dropWindow(p.window);
      void logins.stop(p.window).catch((e) => console.error("[ressac] login terminal stop:", e));
      void chats.closeWindow(p.window).catch((e) => console.error("[ressac] chat window close:", e));
      kernel?.outflow.forget(p.window);
      // Again once the agent is stopped: a tool call answered while it stopped would have made the window's memory anew.
      // Not if the window reopened on the same id meanwhile (chrome/store/windows.ts reuses it): that memory is the new session's.
      void sessions
        .closeWindow(p.window)
        .catch((e) => console.error("[ressac] agent window close:", e))
        .finally(() => {
          if (!sessions.has(p.window)) kernel?.outflow.forget(p.window);
        });
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
      const share = () => kernel?.policy.userInteraction(p.tab);
      share();
      // Chat: the context goes before the discussion's first message (its send gives the tab again, after the session's reset).
      if (viewOf(p.window) === "chat") return prefillAgentContext(p.window, contextPrefix(p.tab.title, p.tab.url));
      // A session still starting (the panel's first opening) gets the context once active, and the tab again: its start takes the accesses back.
      sessions.prefill(p.window, contextPrefix(p.tab.title, p.tab.url), share);
    },
    "settings.agentView": (p: { view?: unknown }) => {
      agentView = p?.view === "terminal" ? "terminal" : "chat";
    },
    // The chat (shared/api.ts `chat`): always the window's own discussions; the UI names no other window.
    "chat.list": aiOnly(async (p: { window?: unknown; space?: unknown }) => {
      if (typeof p?.window !== "string" || typeof p.space !== "string") return [];
      windowSpaces.set(p.window, p.space);
      return chats.list(p.window, p.space);
    }),
    "chat.open": aiOnly(async (p: { window?: unknown; space?: unknown; chatId?: unknown }) => {
      if (typeof p?.window !== "string") throw new Error(hostSay("host-invalid-params"));
      if (typeof p.space === "string") windowSpaces.set(p.window, p.space);
      if (typeof p.chatId === "string") {
        const v = await chats.select(p.window, p.chatId);
        if (!v) throw new Error("Cette discussion n'existe plus.");
        return decorated(p.window, v);
      }
      return decorated(p.window, chats.active(p.window) ?? (await createChat(p.window, p)));
    }),
    "chat.create": aiOnly((p: { window?: unknown; space?: unknown; profile?: unknown; mode?: unknown }) => {
      if (typeof p?.window !== "string") throw new Error(hostSay("host-invalid-params"));
      return createChat(p.window, p).then((v) => decorated(p.window as string, v));
    }),
    "chat.send": aiOnly(async (p: { window?: unknown; draft?: unknown }) => {
      const draft = cleanDraft(p?.draft);
      const chat = activeChat(p?.window);
      if (!draft) return { ok: false, error: "Ce message est vide ou trop long." };
      if (!chat) return { ok: false, error: "Aucune discussion n'est ouverte." };
      return chatSend.send(p.window as string, chat.id, draft);
    }),
    // Chips while typing: masked with the discussion's table (the labels it issues are the ones the send gives); never typed, never sent.
    "chat.preview": (p: { window?: unknown; text?: unknown }) => {
      const chat = activeChat(p?.window);
      const session = chat && chats.sessionIdOf(chat.id);
      if (!session || !kernel || typeof p?.text !== "string" || p.text.length > DRAFT_MAX) return null;
      try {
        return kernel.masker.maskTypedFor(session, p.text);
      } catch {
        return null;
      }
    },
    "chat.cancel": (p: { window?: unknown }) => {
      const chat = activeChat(p?.window);
      if (!chat) return;
      chatSend.drop(chat.id);
      chats.cancel(chat.id);
    },
    "chat.answer": (p: { window?: unknown; requestId?: unknown; reply?: unknown }) => {
      const chat = activeChat(p?.window);
      const r = (p?.reply ?? {}) as Record<string, unknown>;
      const answers = r.answers && typeof r.answers === "object" ? Object.entries(r.answers as object) : null;
      const reply: AskReply | null =
        r.cancelled === true ? { cancelled: true } : answers?.every(([, v]) => typeof v === "string") ? { answers: Object.fromEntries(answers) as Record<string, string> } : null;
      if (chat && typeof p.requestId === "string" && reply) chats.answer(chat.id, p.requestId, reply);
    },
    "chat.dropPrefix": (p: { window?: unknown }) => {
      if (typeof p?.window !== "string") return;
      chatSend.dropPrefix(p.window);
      const chat = activeChat(p.window);
      if (chat) repushChat(chat.id);
    },
    "chat.retry": (p: { window?: unknown }) => {
      const chat = activeChat(p?.window);
      if (chat) void chats.retry(chat.id);
    },
    "chat.review": (p: { window?: unknown; id?: unknown; choice?: unknown }) => {
      const chat = activeChat(p?.window);
      const r = chat && chatOpens.get(chat.id)?.review;
      if (!chat || !r || r.id !== p.id || (p.choice !== "keep" && p.choice !== "revert")) return;
      chatOpens.get(chat.id)!.review = undefined;
      chatPrep.set(chat.id, { state: "preparing" });
      repushChat(chat.id);
      r.resolve(p.choice);
    },
    // The value goes back to the window's own UI only: never logged, never sent. A paused discussion's labels resolve nothing (R2).
    "chat.reveal": (p: { window?: unknown; label?: unknown }) => {
      const chat = activeChat(p?.window);
      const session = chat && chats.sessionIdOf(chat.id);
      if (!session || typeof p?.label !== "string" || !CHAT_LABEL.test(p.label)) return null;
      return kernel?.masker.lookupForSession(session, p.label)?.value ?? null;
    },
    // « Mode avancé »: the discussion pauses, the window's terminal resumes its conversation (Claude by id, Codex its latest).
    "chat.toTerminal": aiOnly(async (p: { window?: unknown }) => {
      if (typeof p?.window !== "string") throw new Error(hostSay("host-invalid-params"));
      await chatToTerminal(p.window, {
        stopLogin: (w) => logins.stop(w),
        active: activeChat,
        pause: (id) => chats.pause(id),
        resumeIdOf: (id) => chats.resumeIdOf(id),
        resumeNext: (w, profile, id) => sessions.resumeNext(w, profile, id),
        switchProfile: (w, profile) => sessions.switchProfile(w, profile),
        terminal: terminalWindows,
        repush: repushChat,
      });
    }),
    "chat.toChat": aiOnly(async (p: { window?: unknown }) => {
      if (typeof p?.window !== "string") throw new Error(hostSay("host-invalid-params"));
      terminalWindows.delete(p.window);
      await sessions.closeWindow(p.window);
      const chat = activeChat(p.window);
      if (!chat) return;
      // The engine has what was said in the terminal; this transcript does not.
      await chats.notice(chat.id, "Échanges faits dans le terminal");
      await chats.select(p.window, chat.id);
    }),
    // The login card: the CLI's own sign-in in a small terminal; the window's signed-out discussions retry when it ends.
    "chat.login": aiOnly(async (p: { window?: unknown }) => {
      if (typeof p?.window !== "string") throw new Error(hostSay("host-invalid-params"));
      const program = activeChat(p.window)?.engine ?? (sessions.profileOf(p.window) === "codex" ? "codex" : "claude");
      signedIn.delete(program);
      await readyToStart(program);
      await logins.start(p.window, program, { cols: 80, rows: 24 });
      rpc.notify("agent.state", { window: p.window, state: { state: "active" } });
    }),
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
    ...Object.fromEntries(["apps.list", "apps.windowClosed", "apps.navigation", "apps.note"].map((k) => [k, (p: unknown) => apps.handlers[k]!(p)])),
    "apps.act": aiOnly(labOnly((p: unknown) => apps.handlers["apps.act"]!(p))),
    // Design mode's host side (host/design.ts): `design` is made after `sites`, below.
    // The settings page (host/settings.ts): `settings` is made after `sites` and `actions`, below.
    ...Object.fromEntries(SETTINGS_METHODS.map((k) => [k, AI_SETTINGS.has(k) ? aiOnly((p: unknown) => settings[k]!(p)) : (p: unknown) => settings[k]!(p)])),
    ...Object.fromEntries(DESIGN_METHODS.map((k) => [k, (p: unknown) => design.handlers[k]!(p)])),
    ...(process.env.RESSAC_HOST_TEST === "1"
      ? {
          "debug.locale": () => ({ locale: hostLocale(), relocalized }),
          "debug.log": (p: { text: string }) => console.log(p.text),
          "debug.outflowCheck": (p: { window: string; text: string }) => kernel?.outflow.check(p.window, p.text) ?? null,
        }
      : {}),
  }),
});
// Errors go to Firefox, which reports them (chrome/store/telemetry.ts), on top of the stderr log.
const reportError = (e: unknown) => {
  console.error("[ressac] uncaught:", e);
  const err = e instanceof Error ? e : new Error(String(e));
  rpc.notify("telemetryError", { source: "host", type: err.name, message: err.message, stack: err.stack });
};
process.on("unhandledRejection", reportError);
process.on("uncaughtException", (e) => {
  reportError(e);
  // Exit once the notification is flushed: stdout is an asynchronous pipe on macOS.
  writeStdout("", () => process.exit(1));
});
/**
 * A notice on the window's conversation banner, never the agent's: the kernel's lock notice, or chrome's « site non
 * retenu » (`unless`: never over a notice already there, so a lock notice stays).
 */
function maskNotice(o: { text: unknown }, win: string | undefined, unless = false) {
  const session = win === undefined ? null : (kernel?.masker.sessionOf(win) ?? null);
  if (session === null || (unless && maskNotices.has(session))) return;
  maskNotices.set(session, String(o.text).slice(0, 300));
  maskingChanged();
}
const bridge = new RemoteBridge(rpc, hist, (site, url) => sites.urlAllowed(site, url), maskNotice);
// The titles the agent's list_tabs gives, for the chat's « Lit la page « … » » lines (read_tab's input has the id only).
const listTabs = bridge.listTabs;
bridge.listTabs = () => listTabs().then((l) => (rememberTabs(l), l));
const testPacing = new Pacing();
// Agent-written extensions are gone (0.1.27): their leftovers go once, without holding the start.
void removeAgentExtensions({ dataDir, workspace: root }).catch((e: unknown) => console.error("[ressac] agent extensions' leftovers not removed:", e));
// Site apps: the Node side (list, memory, deletion); the windows are the chrome's, asked through the RPC.
const sites = createSites({
  paths: paths,
  dataDir,
  locked: () => workspaceLock.locked(),
  tweaksPaused: (id, t) => tweaksPaused(workspaceLock, id, t),
  pausedText: () => hostSay("kernel-mask-run-paused"),
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
    tabsChange: (id) => rpc.notify("sites.tabsChange", [id]),
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
  prefill: (f, t) => prefillAgent(f, t),
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
  locale: () => hostLocale(),
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
    prefillAgent(
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
  lab: () => labOn,
  // Its remarks, review repository and comments go with it.
  erased: (folder) => design.appDeleted(folder),
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
  sites: () => sites.list().then((l) => l.map(({ id, name }) => ({ id, name: name }))),
  // Every app (apps.liste() keeps the running ones only).
  siteApps: () => apps.manager.list(),
  // Remarks from the cart and comments from the review: already reviewed by the user, so sent right away.
  // AI off: no agent will read it, nothing is kept for a later session.
  prefill: (f, t) => {
    if (aiOn) prefillAgent(f, t, undefined, true);
  },
  chrome: { agentWindow: () => rpc.request("design.agentWindow"), giveAgent: (f) => rpc.notify("design.giveAgent", [f]) },
  notify: notify,
  broadcast: () => (rpc.notify("external.change"), rpc.notify("design.change")),
  refuse: () => (workspaceLock.locked() ? hostSay("kernel-mask-design-locked") : null),
});
// Actions: the kernel and disk half; the chrome keeps the window state (private spaces, tabs, pace of links).
const actions = createActionsHost({ paths: paths, actionsFolder: actionsFolder, kernel: () => kernel, onChange: () => rpc.notify("actions.change") });
// The actions and components folders, watched outside the kernel: the page lists even without it.
// While the lab is on (applyLab).
let actionsStop: (() => Promise<void>) | undefined;
function watchActionsNow() {
  if (actionsStop) return;
  try {
    actionsStop = watchActions(paths, () => rpc.notify("actions.change"));
  } catch (e) {
    console.error("[ressac] the actions watch did not start:", e);
  }
}
let fakeSwitched = false;
const settings = createSettingsHandlers({
  workshop,
  cli,
  writer: { via: hostWriter.via, reset: writerChoice.reset },
  ai,
  docker,
  machine: {
    status: machine.status,
    usage: machine.usage,
    remove: machine.remove,
    // A retry from Réglages: once installed, the workshop moves over as at AI start (in the background, it waits for Docker's to idle).
    install: async () => {
      await machine.install();
      if (!testMachine) void engines.settle().catch((e) => console.error("[ressac] the logins did not move to the machine:", e));
    },
    // e2e: « running:waiting » plays a hand-over waiting for Docker's sessions, which « Passer maintenant » ends.
    waiting: () => (testMachine ? testMachine === "running:waiting" && !fakeSwitched : engines.waiting()),
    switchNow: async () => {
      if (testMachine) fakeSwitched = true;
      else await engines.switchNow();
    },
  },
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
  forgetKey,
  notify,
  modelInstalled: (name) => name === SEARCH_MODEL && startIndexer(),
});
// The chrome may not answer yet (its handlers come up later): it calls "sites.ready" once it does.
void sites.resync().catch(() => {});

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (l) => rpc.receive(l))
  .on("close", () => {
    rpc.close("Firefox s'est arrêté");
    // A stop that hangs (docker, a session) must not keep an orphan host alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void stop().finally(() => process.exit(0));
  });
