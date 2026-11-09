import type { Kernel, TabInfo } from "../../../packages/kernel/src/index.ts";
import type { FrameBounds } from "../shared/model.ts";
import type { BuilderSelection, TerminalSize } from "../shared/api.ts";

// The agent host: Firefox spawns it and talks JSON-RPC over stdin/stdout, one JSON message per line.
// stdout carries only the RPC: anything else written there would corrupt it, so it goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.info = console.debug = console.error;
// Firefox gone: its pipe breaks, and the end of stdin stops everything below.
process.stdout.on("error", () => {});
process.on("unhandledRejection", (e) => console.error("[webaios] rejet non géré :", e));

process.env.WEBAIOS_CONTAINER ||= "webaios-workshop-firefox";
// The existing container's name and host ports: renaming them would orphan it.
process.env.WEBAIOS_CONTAINER_PORTS ||= "5300-5319";

const { join } = await import("node:path");
const { createInterface } = await import("node:readline");
const { appendFileSync } = await import("node:fs");
const { stat } = await import("node:fs/promises");
// Imported after the env is set and stdout redirected: nothing in the kernel can write to stdout at load time.
const { ACTION_UNKNOWN, Workshop, blockCatalog, loadProfiles, spacePaths, createKernel, defaultRunner, LocalAi, readHome, readFreeLayout, readTheme, Pacing, contextPrefix, removeGrant, deleteData, watchActions } = await import("../../../packages/kernel/src/index.ts");
const { SessionsAgent } = await import("../core/agent/sessions.ts");
const { History } = await import("../core/history.ts");
const { createRpc } = await import("../shared/rpc.ts");
const { RemoteBridge } = await import("./remote-bridge.ts");
const { createSites } = await import("./sites.ts");
const { createDesignHost, DESIGN_METHODS, externalMcpPort } = await import("./design.ts");
const { createApplicationsHost } = await import("./applications.ts");
const { createActionsHost } = await import("./actions.ts");
const { ExtensionsAgent } = await import("./extensions/agent.ts");
const { STORE_ABSENT } = await import("./extensions/amo.ts");
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

const dataDir = process.env.WEBAIOS_DATA_DIR;
if (!dataDir) {
  console.error("[webaios] WEBAIOS_DATA_DIR manquant");
  process.exit(2);
}
const root = join(dataDir, "workspace");
const paths = spacePaths(root);
// Widgets' data, states and grants: outside the space.
const widgetsFolder = join(dataDir, "widgets");
// Outside the agent's kernel: the history works even when the kernel does not start.
const MEMORY_LOOP = process.env.WEBAIOS_MEMORY_LOOP === "1";
// The pages whose text the history keeps for the agent's memory: http(s), never the machine (unless WEBAIOS_MEMORY_LOOP).
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
    console.error("[webaios] l'historique n'a pas pu s'ouvrir :", e);
    return undefined;
  }
})();
const purge = setInterval(() => hist?.purge(), 6 * 60 * 60 * 1000);
purge.unref();
const duckduckgo = process.env.WEBAIOS_TEST_DUCKDUCKGO_URL;
// Shown when the widgets service has no kernel.
const AGENT_STOPPED_MESSAGE = "Le service des widgets ne répond pas (agent arrêté ?)";
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
// One container for the agent (whatever its profile) and the apps it launches: the kernel's own default (kernel.ts:389).
const workshop = new Workshop({ paths: paths });

let kernel: Kernel | null = null;
let error: string | null = null;
let ready: Promise<Kernel | null> = Promise.resolve(null);
let unsubscribe: (() => void) | undefined;
let homeStop: (() => Promise<void>) | undefined;
let accessTimer: NodeJS.Timeout | undefined;

const accessState = () => ({ agent: kernel?.agent ?? "L'agent", tabs: kernel?.policy.state() ?? {} });
// A burst of policy changes gives one notification per 50 ms.
const broadcastAccess = () => {
  accessTimer ??= setTimeout(() => {
    accessTimer = undefined;
    rpc.notify("acces", accessState());
  }, 50);
};

// The local AI for harvests: Gemma and the decision model both run in Ollama (same
// /v1/systemone answers). Nothing is installed here: a missing model fails with Ollama's answer.
const ai = new LocalAi({ folder: join(dataDir, "local-ai"), run: defaultRunner, decisionModel: "pplx-decider-flash" });

// The host is Node and cannot call Cc: in tests it writes the file, otherwise the chrome store shows the alert.
const notify = (n: { title: string; text: string }) => {
  const file = process.env.WEBAIOS_TEST_NOTIFICATIONS;
  if (file) return void appendFileSync(file, JSON.stringify({ title: n.title, text: n.text }) + "\n");
  rpc.notify("accueil.notification", { title: n.title, text: n.text });
};

const launchKernel = (profileId: string): Promise<Kernel | null> => {
  error = null;
  return createKernel({
    bridge: bridge,
    profileId: profileId,
    root: root,
    widgetsFolder: widgetsFolder,
    actionsFolder: actionsFolder,
    ai: ai,
    profilingFolder: join(dataDir, "profiling"),
    extensions: extensions.tools(),
    sites: sites.tools,
    workshop: workshop,
    apps: apps.manager,
    openWorkflow: (f) => workflowOpen(actives.get(f), selections.get(f)),
    // Widgets and actions wrote something, or a grant changed: the page reads again.
    onChange: () => rpc.notify("accueil.change"),
    notify: notify,
    ...(process.env.WEBAIOS_TEST_LOCAL_ADDRESSES === "1" ? { localAddresses: true } : {}),
    ...(duckduckgo ? { searchUrl: duckduckgo } : {}),
  }).then(
    (n) => {
      kernel = n;
      const offPolicy = n.policy.onChange(broadcastAccess);
      const offDirect = n.onLive((e) => rpc.notify("workflow.direct", e));
      const offActions = n.actions.onLive((e) => {
        rpc.notify("actions.direct", e);
        actions.directSeen(e);
      });
      unsubscribe = () => (offPolicy(), offDirect(), offActions());
      // A widget added or rewritten, a placement made in another window, a theme: the page reads again.
      // Unguarded, a watch failure would reject `pret` and every host method with it.
      try {
        homeStop = n.watchHome(() => rpc.notify("accueil.change"));
      } catch (e) {
        console.error("[webaios] la surveillance de l'accueil n'a pas démarré :", e);
      }
      broadcastAccess();
      // Each kernel start (a restart included): what the pages read while it was down is read again.
      rpc.notify("accueil.change");
      return n;
    },
    (e: Error) => {
      error = e.message;
      console.error("[webaios] the kernel failed to start:", e);
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
  if (!n) throw new Error(error ?? "le noyau de l'agent n'a pas démarré");
  return { agent: n.agent };
};

let profile: string | null = null;
// Another profile: a new kernel (command, MCP config) and a new agent in every panel. Never two kernels at once:
// two MCP servers would write the same mcp.json.
const changeProfile = (agentProfile: string) => {
  const relaunch = profile !== null;
  profile = agentProfile;
  ready = ready.then(stopKernel).then(() => launchKernel(agentProfile));
  if (relaunch) void sessions.relaunchAll();
  return start();
};

let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    // Started first (spike S8) but not awaited before the others: a slow docker must not eat the 5 s quit delay
    // before the history is closed. Settled alone:
    // its failure never skips the stops below. WEBAIOS_TEST_APPS_STOP_FAILS: tests only.
    const appsStopped = (process.env.WEBAIOS_TEST_APPS_STOP_FAILS === "1" ? Promise.reject(new Error("arrêt des applis simulé")) : apps.stop()).catch((e) =>
      console.error("[webaios] les applis ne se sont pas arrêtées :", e),
    );
    extensions.stop();
    await sessions.stopAll();
    await sites.stop();
    await design.stop();
    await actionsStop?.();
    await stopKernel(await ready);
    await ai.close().catch(() => {});
    clearInterval(purge);
    hist?.close();
    await appsStopped;
  })());

const sessions = new SessionsAgent({
  async open(f, t) {
    const n = await ready;
    if (!n) throw new Error(error ?? "le noyau de l'agent n'a pas démarré");
    return n.openAgentSession({ ...t, window: f });
  },
  // The user talks to the agent from the tab on screen: it is given to the agent.
  onSend: (f) => {
    rpc.request<TabInfo | null>("ongletActif", [f]).then(
      (o) => o && kernel?.policy.userInteraction(o),
      () => {},
    );
  },
  send: (win, channel, v) => rpc.notify(channel === "donnees" ? "agent.donnees" : "agent.etat", channel === "donnees" ? { window: win, d: v } : { window: win, e: v }),
});

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  handlers: {
    // Repeated with the same profile: the running kernel stays (its sessions with it); a failed start is retried.
    start: async (p: { agentProfile: string }) => {
      if (profile === p.agentProfile && (await ready)) return start();
      return changeProfile(p.agentProfile);
    },
    changeProfile: (p: { agentProfile: string }) => changeProfile(p.agentProfile),
    "agent.demarrer": (p: { window: string; size: TerminalSize }) => sessions.start(p.window, p.size),
    "agent.profils": async () => {
      // The kernel writes the default profile while it starts: the panel may ask before that.
      await ready;
      try {
        return (await loadProfiles(paths)).profiles.map((x) => ({ id: x.id, name: x.name }));
      } catch {
        return [];
      }
    },
    "acces.etat": accessState,
    // Home page: the widgets of espace/home/widgets, their data and state, the validated theme,
    // with the free placement (version 3).
    "accueil.lire": async () => {
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
        if (theme.error) console.warn(`[webaios] ${theme.error}`);
        return toShownWidgets({ state: state, placements, theme: theme.theme, mtimes });
      } catch (e) {
        console.error("[webaios] page d'accueil illisible :", e);
        return { widgets: [], theme: null };
      }
    },
    "accueil.placer": async (p: { placements?: unknown }) => {
      try {
        // A placement needs no kernel: the space's folders are enough.
        const ids = (await readHome(paths, widgetsFolder)).widgets.map((w) => w.id);
        await placeWidgets(paths, validatePlacements(p?.placements, ids));
      } catch (e) {
        console.error("[webaios] disposition non écrite :", e);
        // The UI already showed the gesture's preview: it re-reads the old layout instead of leaving it on screen.
        rpc.notify("accueil.change");
      }
    },
    "accueil.retirer": (p: { id?: unknown }) => {
      const id = typeof p?.id === "string" ? p.id : "";
      // The grant and the data read with the account leave with the widget (through the kernel, which also writes the grants).
      void removeWidget(paths, id, async (w) => {
        const n = await ready;
        if (n) return n.denyGrant(w);
        await removeGrant(widgetsFolder, w);
        await deleteData(widgetsFolder, w);
      }).then(
        () => rpc.notify("accueil.change"),
        (e) => console.error(`[webaios] widget ${id} non retiré :`, e),
      );
    },
    "accueil.accorder": async (p: { id: string; profile: string; account: string[]; public: string[] }) => {
      const n = await ready;
      if (!n) return { ok: false as const, error: AGENT_STOPPED_MESSAGE };
      try {
        // The kernel refuses if the declaration is no longer the one the card showed.
        await n.grant(p);
        return { ok: true as const };
      } catch (e) {
        console.error(`[webaios] accord du widget ${p?.id} :`, e);
        // The UI re-reads the page: the new request is displayed.
        rpc.notify("accueil.change");
        return { ok: false as const, error: (e as Error).message };
      }
    },
    "accueil.refuserAccord": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.denyGrant(p.id).catch((e) => console.error(`[webaios] retrait de l'accord du widget ${p.id} :`, e));
    },
    "accueil.recolter": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.harvestNow(p.id).catch((e) => console.error(`[webaios] récolte du widget ${p.id} :`, e));
    },
    // Read without the kernel, like the home page: the executions, outside the space.
    "accueil.executions": (p: { id?: unknown }) => executionsWidget(widgetsFolder, typeof p?.id === "string" ? p.id : ""),
    "accueil.execution": (p: { id?: unknown; run?: unknown }) =>
      executionWidget(widgetsFolder, typeof p?.id === "string" ? p.id : "", typeof p?.run === "string" ? p.run : ""),
    // The workflow builder: inputs checked with the shared
    // schemas, a bad one answered with INVALID_ARGUMENT's shape. The private-space refusal of an action is the chrome's (api.ts).
    "workflow.catalogue": () => blockCatalog(),
    "workflow.lire": (p: { target?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      if (!target.success) return null;
      return target.data.type === "widget" ? readEdit(widgetsContext, target.data.id) : readActionEdit(actionsContext, target.data.id);
    },
    "workflow.enregistrer": (p: { target?: unknown; draft?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const draft = DraftSchema.safeParse(p?.draft);
      if (!target.success || !draft.success) return { ...INVALID_ARGUMENT, warnings: [] };
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionEdit(actionsContext, id, draft.data));
      return writes.inSeries(id, () => saveEdit(widgetsContext, id, draft.data));
    },
    "workflow.lireCode": (p: { target?: unknown; name?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      if (!target.success || !name.success) return { error: INVALID_ARGUMENT.error };
      return target.data.type === "widget" ? readCode(paths, target.data.id, name.data) : readActionCode(paths, target.data.id, name.data);
    },
    "workflow.enregistrerCode": (p: { target?: unknown; name?: unknown; text?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const name = NameCodeSchema.safeParse(p?.name);
      const text = SchemaCodeWorkflow.safeParse(p?.text);
      if (!target.success || !name.success || !text.success) return INVALID_ARGUMENT;
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionCode(paths, id, name.data, text.data));
      return writes.inSeries(id, () => saveCode(paths, id, name.data, text.data));
    },
    "workflow.rejouer": async (p: { target?: unknown; run?: unknown; block?: unknown }) => {
      const target = TargetSchema.safeParse(p?.target);
      const execution = SchemaIdExecution.safeParse(p?.run);
      const block = WorkflowBlockSchema.safeParse(p?.block);
      if (!target.success || !execution.success || !block.success) return INVALID_ARGUMENT;
      const n = await ready;
      if (!n) return { ok: false as const, error: AGENT_STOPPED_MESSAGE };
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
    "workflow.lancer": async (p: { target?: unknown; input?: unknown }) => {
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
        console.error(`[webaios] exécution du widget ${id} :`, e);
        return {};
      }
    },
    "workflow.direct": async () => (await ready)?.direct() ?? { running: [], waiting: [] },
    // A bad selection is ignored.
    "workflow.selection": (p: { window?: unknown; target?: unknown; block?: unknown }) => {
      const s = builderSelection(p);
      if (s && typeof p?.window === "string") selections.set(p.window, s);
    },
    // Replaces the whole mirror: a window absent or without a workflow page is forgotten.
    "fenetres.actives": (p: Record<string, unknown> | null) => {
      actives = new Map(Object.entries(p ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    },
    // Actions: what touches the kernel and the disk (the chrome keeps the window state). Inputs checked with the shared
    // schemas; a bad one gets an empty answer.
    "actions.liste": () => actions.list(),
    "actions.preparer": (p: { id?: unknown; input?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success ? actions.prepare(p.id, (p.input ?? null) as string | null) : { ok: false, error: ACTION_UNKNOWN },
    "actions.nom": (p: { id?: unknown }) => (idAction(p?.id) ? actions.name(p.id) : null),
    "actions.lancer": (p: { id?: unknown; input?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.input ?? null).success
        ? actions.launch(p.id, (p.input ?? null) as string | null)
        : { status: "invalid", error: "Demande invalide" },
    "actions.arreter": (p: { id?: unknown }) => void (idAction(p?.id) && actions.stop(p.id)),
    "actions.page": (p: { id?: unknown; run?: unknown }) =>
      idAction(p?.id) && (p.run === null || executionAction(p.run)) ? actions.page(p.id, p.run) : null,
    "actions.executions": (p: { id?: unknown }) => (idAction(p?.id) ? actions.runs(p.id) : []),
    "actions.execution": (p: { id?: unknown; run?: unknown }) => (idAction(p?.id) && executionAction(p.run) ? actions.run(p.id, p.run) : null),
    "actions.direct": () => actions.direct(),
    "actions.lienPermis": (p: { id?: unknown; run?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.run) && urlAction(p.url) ? actions.linkAllowed(p.id, p.run, p.url) : false,
    "actions.imagePermise": (p: { id?: unknown; run?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.run) && urlAction(p.url) ? actions.imageAllowed(p.id, p.run, p.url) : false,
    "actions.accorder": (p: unknown) => {
      const r = GrantSchema.safeParse(p);
      return r.success && idAction(r.data.id) ? actions.grant(r.data) : { ok: false, error: "Demande d'accord invalide" };
    },
    "actions.refuserAccord": (p: { id?: unknown }) => (idAction(p?.id) ? actions.denyGrant(p.id) : undefined),
    "actions.supprimer": (p: { id?: unknown }) => (idAction(p?.id) ? actions.supprimer(p.id) : { ok: false, error: "Demande invalide" }),
    // Site apps (the window is the chrome's). A bad action is ignored.
    // The open apps are known again: the Applications page reads them (it read « fermée » while the host was down).
    "sites.pret": () => sites.resync().then(() => rpc.notify("sites.change")),
    "sites.liste": () => sites.list(),
    "sites.agir": (p: { id?: unknown; action?: unknown; window?: unknown }) => {
      const a = SchemaActionSite.safeParse(p);
      if (a.success && typeof p?.window === "string") return sites.dispatch(a.data.id, a.data.action, p.window);
    },
    "sites.memoireAccueil": (p: { id?: unknown }) => (typeof p?.id === "string" ? sites.homeMemory(p.id) : null),
    "sites.noter": (p: { id?: unknown; frame?: FrameBounds; favicon?: unknown }) => {
      if (typeof p?.id === "string") sites.note(p.id, { ...(p.frame ? { frame: p.frame } : {}), ...(typeof p.favicon === "string" ? { favicon: p.favicon } : {}) });
    },
    "sites.memoireOp": (p: unknown) => sites.memoryOp(p),
    "sites.position": (p: unknown) => sites.position(p),
    "sites.reprise": (p: unknown) => sites.resume(p),
    "sites.chercher": (p: { id?: unknown; url?: unknown }) => {
      if (typeof p?.id === "string" && (p.url === null || typeof p.url === "string")) return sites.lookupAddress(p.id, p.url);
    },
    "sites.accorder": (p: { id?: unknown; yes?: unknown; hash?: unknown }) => {
      if (typeof p?.id === "string" && typeof p.yes === "boolean" && typeof p.hash === "string") return sites.grant(p.id, p.yes, p.hash);
    },
    "sites.ferme": (p: { id?: unknown }) => {
      if (typeof p?.id === "string") sites.closed(p.id);
    },
    "historique.noter": (p: Parameters<InstanceType<typeof History>["note"]>[0]) => hist?.note(p),
    "historique.titre": (p: { url: string; spaceId: string; title: string }) => hist?.updateTitle(p.url, p.spaceId, p.title),
    "historique.retenir": (p: { url: string; spaceId: string; title: string; text: string }) => {
      if (keepable(p.url)) hist?.keep({ ...p, text: String(p.text) });
    },
    "historique.rendrePrive": (p: { spaceId: string }) => hist?.makePrivate(p.spaceId),
    "historique.rechercher": (p: { text: string; limit?: number; distinct?: boolean }) => hist?.search(p.text, p.limit, p.distinct) ?? [],
    "historique.recents": () => hist?.recents() ?? [],
    "historique.effacer": (p: { since?: string }) => hist?.erase(p.since ? new Date(p.since) : undefined),
    "historique.oublierTexte": (p: { url: string; spaceId: string }) => hist?.forgetText(p.url, p.spaceId),
    stop: async () => {
      try {
        await stop();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    "agent.ecrire": (p: { window: string; d: string }) => sessions.write(p.window, p.d),
    "agent.redimensionner": (p: { window: string; size: TerminalSize }) => sessions.resize(p.window, p.size),
    "agent.fermerFenetre": (p: { window: string }) => {
      selections.delete(p.window);
      actives.delete(p.window);
      void sessions.closeWindow(p.window);
    },
    privateTabs: (p: { privateTabs: string[]; activePrivate: boolean }) => bridge.setPrivate(p),
    "politique.navigue": (p: { id: string; url: string }) => kernel?.policy.tabNavigated(p.id, p.url),
    "politique.ferme": (p: { id: string }) => kernel?.policy.tabClosed(p.id),
    "politique.couper": (p: { id: string; right?: Parameters<Kernel["policy"]["cut"]>[1] }) => kernel?.policy.cut(p.id, p.right),
    "agent.envoi": (p: { tab: TabInfo | null }) => void (p.tab && kernel?.policy.userInteraction(p.tab)),
    // Opening the panel on a tab gives it to the agent and pre-fills the context, without sending it.
    "agent.panneauOuvert": (p: { window: string; tab: TabInfo }) => {
      kernel?.policy.userInteraction(p.tab);
      if (sessions.active(p.window)) sessions.write(p.window, contextPrefix(p.tab.title, p.tab.url));
    },
    // Sent by the chrome on each host start, with the about:addons changes seen while no host ran (applied first:
    // never reinstalled); answered when every granted extension is handled. A failed start is retried by the next one.
    "extensions.pret": async (p: { outsideWebaios?: { addonId: string; what: "desinstallee" | "desactivee" }[]; crashes?: { addonId?: unknown; at?: unknown }[] }) => {
      for (const c of Array.isArray(p?.crashes) ? p.crashes : []) extensions.crash(c?.addonId, c?.at);
      for (const h of p?.outsideWebaios ?? []) await extensions.outsideWebaios(h.addonId, h.what);
      return (extensionsStartup ??= extensions.start().catch((e) => {
        extensionsStartup = undefined;
        throw e;
      }));
    },
    "extensions.horsWebaios": (p: { addonId: string; what: "desinstallee" | "desactivee" }) =>
      extensions.outsideWebaios(p.addonId, p.what),
    "extensions.aTourne": (p: { addonId: string; profile: string; readable: boolean }) => extensions.ran(p.addonId, p.profile, p.readable),
    // A content script's message is readable only from a tab the agent can read as it is noted:
    // ongletLisibleParAgent): asked of the policy here, which knows an agent-opened tab before Firefox hears of it.
    "extensions.console": (p: { addonId?: unknown; m?: unknown; tab?: { tabId?: unknown; url?: unknown } | null }) => {
      const o = p?.tab;
      const readable = !!o && typeof o.tabId === "string" && typeof o.url === "string" && kernel?.policy.canRead({ id: o.tabId, url: o.url, title: "", space: "" }) === true;
      extensions.noteConsole(p?.addonId, p?.m, o ? { readable: readable } : null);
    },
    "extensions.plantage": (p: { addonId?: unknown; at?: unknown }) => extensions.crash(p?.addonId, p?.at),
    "extensions.profilsPrives": (p: { privateTabs?: unknown }) =>
      extensions.privateProfiles(Array.isArray(p?.privateTabs) ? p.privateTabs.filter((x): x is string => typeof x === "string") : []),
    "extensions.pourEspace": (p: { spaceId?: unknown }) => (typeof p?.spaceId === "string" ? extensions.forSpace(p.spaceId) : []),
    "extensions.basculer": (p: { key?: unknown; spaceId?: unknown; active?: unknown; window?: unknown }) =>
      typeof p?.key === "string" && typeof p.spaceId === "string"
        ? extensions.toggle(p.key, p.spaceId, p.active === true, typeof p.window === "string" ? p.window : null)
        : { ok: false, error: "Paramètres invalides" },
    // The Extensions page (the agent's extensions only, decision 8).
    "extensions.liste": () => extensions.entries(),
    "extensions.coupees": () => extensions.cut(),
    "extensions.supprimer": (p: { key?: unknown }) => byKey(p, (key) => extensions.deletePage(key)),
    "extensions.desactiverPartout": (p: { key?: unknown }) => byKey(p, (key) => extensions.disableEverywhere(key)),
    "extensions.reactiver": (p: { key?: unknown }) => byKey(p, (key) => extensions.reactivate(key)),
    "extensions.couperDeblocage": (p: { key?: unknown }) => byKey(p, (key) => extensions.cutUnlock(key)),
    "extensions.revoir": (p: { key?: unknown; window?: unknown }) =>
      byKey(p, (key) => extensions.review(key, typeof p.window === "string" ? p.window : null)),
    "extensions.toutCouper": (p: { yes?: unknown }) => extensions.cutAll(p?.yes === true),
    "extensions.installerStore": () => ({ ok: false, error: STORE_ABSENT }),
    // The RPC signal is ignored on purpose: the kernel's Pacing hands the lane back (partie=false) when the read has already ended, and rpc.ts drops a late answer.
    "lecture.changerHote": (p: { read: string; host: string }) => bridge.changeHost(p.read, p.host),
    // Tests only: a paced read through a Pacing shared by the calls, as a workflow's web widget does.
    ...(process.env.WEBAIOS_TEST_PACED_READ === "1"
      ? {
          "test.lectureMenagee": ({ url }: { url: string }) =>
            testPacing.read(new URL(url).hostname, (ch) => bridge.readPageInvisible(url, { profile: null, changeHost: ch })),
        }
      : {}),
    // The agent's applications (host/applications.ts): `apps` is made after the RPC, below.
    ...Object.fromEntries(["applications.liste", "applications.agir", "applications.fenetreFermee", "applications.navigation", "applications.noter"].map((k) => [k, (p: unknown) => apps.handlers[k]!(p)])),
    // Design mode's host side (host/design.ts): `design` is made after `sites`, below.
    ...Object.fromEntries(DESIGN_METHODS.map((k) => [k, (p: unknown) => design.handlers[k]!(p)])),
    ...(process.env.WEBAIOS_HOST_TEST === "1" ? { "debug.log": (p: { text: string }) => console.log(p.text) } : {}),
  },
});
const bridge = new RemoteBridge(rpc, hist, (site, url) => sites.urlAllowed(site, url));
const testPacing = new Pacing();
/** A page request on one extension key: a malformed one is refused as text. */
const byKey = <T,>(p: { key?: unknown } | undefined, f: (key: string) => T) => (typeof p?.key === "string" ? f(p.key) : { ok: false as const, error: "Paramètres invalides" });
// Outside the agent's kernel, like the history: granted extensions run even when the kernel does not start.
const extensions = new ExtensionsAgent({ folder: join(dataDir, "extensions"), agentFolder: paths.extensions, rpc });
// Site apps: the Node side (list, memory, deletion); the windows are the chrome's, asked through the RPC.
const sites = createSites({
  paths: paths,
  dataDir,
  localAddresses: process.env.WEBAIOS_TEST_LOCAL_ADDRESSES === "1",
  chrome: {
    open: (s, frame, tweaks) => rpc.request("sites.ouvrir", [s, frame, tweaks]),
    close: (id) => rpc.request("sites.fermer", [id]),
    erase: (id) => rpc.request("sites.effacer", [id]),
    update: (s, tweaks) => rpc.request("sites.mettreAJour", [s, tweaks]),
    reloadView: (id) => rpc.request("sites.rechargerVue", [id]),
    errors: (id) => rpc.request("sites.erreurs", [id]),
    view: (id) => rpc.request("sites.vue", [id]),
    afterGrant: (id, s) => rpc.request("sites.apresAccord", [id, s]),
    rebroadcast: (id) => rpc.request("sites.rediffuser", [id]),
    openSites: () => rpc.request("sites.ouvertes"),
    homeChange: (id) => rpc.notify("sites.accueilChange", [id]),
    search: (id, yes) => rpc.notify("sites.cherche", [id, yes]),
    notice: (id, a) => rpc.notify("sites.avis", [id, a]),
    urlChanged: (id, domains, start, to) => rpc.notify("sites.adresseChangee", [id, domains, start, to]),
  },
  // The public read (a throwaway container, no profile): never the app's cookies nor the user's.
  readLinks: async (page, signal) =>
    (await bridge.readPageInvisible(page, { profile: null, ...(process.env.WEBAIOS_TEST_LOCAL_ADDRESSES === "1" ? { localAddresses: true } : {}), ...(signal ? { signal } : {}) })).links.map((l) => l.url),
  // The review takes a new app's first snapshot.
  broadcast: () => {
    rpc.notify("sites.change");
    design.sitesChanged();
  },
  prefill: (f, t) => sessions.prefill(f, t),
  notifyMemory: (id, message) => rpc.notify("sites.memoire", { id, message }),
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
    open: (a, frame) => rpc.request("apps.ouvrir", [a, frame]),
    close: (folder) => rpc.request("apps.fermer", [folder]),
    show: (folder) => rpc.request("apps.montrer", [folder]),
    erase: (folder) => rpc.request("apps.effacer", [folder]),
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
    rpc.notify("design.donnerAgent", [f]);
  },
  policy: () => kernel?.policy ?? null,
  // The Applications page reads the list again; design mode too (the running apps' ports may have changed); the review
  // takes a new app's first snapshot.
  broadcast: () => {
    rpc.notify("applications.change");
    rpc.notify("design.change");
    design.appsChanged();
  },
});
// Design mode: remarks, the external MCP server and the review, without waiting for the kernel.
const design = createDesignHost({
  dataDir,
  paths: paths,
  port: externalMcpPort(process.env.WEBAIOS_PORT_MCP_EXTERNAL),
  sites: () => sites.list().then((l) => l.map(({ id, name: name }) => ({ id, name: name }))),
  // Every app (apps.liste() keeps the running ones only).
  siteApps: () => apps.manager.list(),
  prefill: (f, t) => sessions.prefill(f, t),
  chrome: { agentWindow: () => rpc.request("design.fenetreAgent"), giveAgent: (f) => rpc.notify("design.donnerAgent", [f]) },
  notify: notify,
  broadcast: () => (rpc.notify("externes.change"), rpc.notify("design.change")),
});
// Actions: the kernel and disk half; the chrome keeps the window state (private spaces, tabs, pace of links).
const actions = createActionsHost({ paths: paths, actionsFolder: actionsFolder, kernel: () => kernel, onChange: () => rpc.notify("actions.change") });
// The actions and components folders, watched outside the kernel: the page lists even without it.
let actionsStop: (() => Promise<void>) | undefined;
try {
  actionsStop = watchActions(paths, () => rpc.notify("actions.change"));
} catch (e) {
  console.error("[webaios] la surveillance des actions n'a pas démarré :", e);
}
// The chrome may not answer yet (its handlers come up later): it calls "sites.pret" once it does.
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
