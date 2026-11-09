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

process.env.WEBAIOS_CONTENEUR ||= "webaios-atelier-firefox";
// The existing container's name and host ports: renaming them would orphan it.
process.env.WEBAIOS_PORTS_CONTENEUR ||= "5300-5319";

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
const root = join(dataDir, "espace");
const paths = spacePaths(root);
// Widgets' data, states and grants: outside the space.
const widgetsFolder = join(dataDir, "widgets");
// Outside the agent's kernel: the history works even when the kernel does not start.
const MEMORY_LOOP = process.env.WEBAIOS_MEMOIRE_BOUCLE === "1";
// The pages whose text the history keeps for the agent's memory: http(s), never the machine (unless WEBAIOS_MEMOIRE_BOUCLE).
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
    const h = new History(join(dataDir, "historique.sqlite"));
    h.purger();
    return h;
  } catch (e) {
    console.error("[webaios] l'historique n'a pas pu s'ouvrir :", e);
    return undefined;
  }
})();
const purge = setInterval(() => hist?.purger(), 6 * 60 * 60 * 1000);
purge.unref();
const duckduckgo = process.env.WEBAIOS_TEST_DUCKDUCKGO_URL;
// Shown when the widgets service has no kernel.
const AGENT_STOPPED_MESSAGE = "Le service des widgets ne répond pas (agent arrêté ?)";
// The answer to a bad builder argument.
const INVALID_ARGUMENT = { ok: false as const, erreur: "Argument invalide" };
// The workflow builder: the block selected in each window, the workflow page each window shows (chrome's mirror).
const selections = new Map<string, BuilderSelection>();
let actives = new Map<string, string>();
const writes = new WriteQueue();
const idAction = (v: unknown): v is string => SchemaIdAction.safeParse(v).success;
const executionAction = (v: unknown): v is string => SchemaIdExecution.safeParse(v).success;
// A link's bound.
const urlAction = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;
const widgetsContext = { chemins: paths, dossierWidgets: widgetsFolder };
// Actions' runs, results, grants and refusals: outside the space.
const actionsFolder = join(dataDir, "actions");
const actionsContext = { chemins: paths, dossierActions: actionsFolder };
// One container for the agent (whatever its profile) and the apps it launches: the kernel's own default (kernel.ts:389).
const workshop = new Workshop({ chemins: paths });

let kernel: Kernel | null = null;
let error: string | null = null;
let ready: Promise<Kernel | null> = Promise.resolve(null);
let unsubscribe: (() => void) | undefined;
let homeStop: (() => Promise<void>) | undefined;
let accessTimer: NodeJS.Timeout | undefined;

const accessState = () => ({ agent: kernel?.agent ?? "L'agent", onglets: kernel?.politique.etat() ?? {} });
// A burst of policy changes gives one notification per 50 ms.
const broadcastAccess = () => {
  accessTimer ??= setTimeout(() => {
    accessTimer = undefined;
    rpc.notify("acces", accessState());
  }, 50);
};

// The local AI for harvests: Gemma and the decision model both run in Ollama (same
// /v1/systemone answers). Nothing is installed here: a missing model fails with Ollama's answer.
const ai = new LocalAi({ dossier: join(dataDir, "ia-locale"), executer: defaultRunner, modeleDecision: "pplx-decider-flash" });

// The host is Node and cannot call Cc: in tests it writes the file, otherwise the chrome store shows the alert.
const notify = (n: { titre: string; texte: string }) => {
  const file = process.env.WEBAIOS_TEST_NOTIFICATIONS;
  if (file) return void appendFileSync(file, JSON.stringify({ titre: n.titre, texte: n.texte }) + "\n");
  rpc.notify("accueil.notification", { titre: n.titre, texte: n.texte });
};

const launchKernel = (profileId: string): Promise<Kernel | null> => {
  error = null;
  return createKernel({
    pont: bridge,
    profilId: profileId,
    racine: root,
    dossierWidgets: widgetsFolder,
    dossierActions: actionsFolder,
    ia: ai,
    dossierProfilage: join(dataDir, "profilage"),
    extensions: extensions.outils(),
    sites: sites.outils,
    atelier: workshop,
    applications: apps.gestionnaire,
    workflowOuvert: (f) => workflowOpen(actives.get(f), selections.get(f)),
    // Widgets and actions wrote something, or a grant changed: the page reads again.
    surChange: () => rpc.notify("accueil.change"),
    notifier: notify,
    ...(process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1" ? { adressesLocales: true } : {}),
    ...(duckduckgo ? { urlRecherche: duckduckgo } : {}),
  }).then(
    (n) => {
      kernel = n;
      const offPolicy = n.politique.surChange(broadcastAccess);
      const offDirect = n.surDirect((e) => rpc.notify("workflow.direct", e));
      const offActions = n.actions.surDirect((e) => {
        rpc.notify("actions.direct", e);
        actions.directVu(e);
      });
      unsubscribe = () => (offPolicy(), offDirect(), offActions());
      // A widget added or rewritten, a placement made in another window, a theme: the page reads again.
      // Unguarded, a watch failure would reject `pret` and every host method with it.
      try {
        homeStop = n.surveillerAccueil(() => rpc.notify("accueil.change"));
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
  await n?.arreter();
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
  if (relaunch) void sessions.relancerTout();
  return start();
};

let stopping: Promise<void> | undefined;
const stop = () =>
  (stopping ??= (async () => {
    // Started first (spike S8) but not awaited before the others: a slow docker must not eat the 5 s quit delay
    // before the history is closed. Settled alone:
    // its failure never skips the stops below. WEBAIOS_TEST_ARRET_APPS_ECHOUE: tests only.
    const appsStopped = (process.env.WEBAIOS_TEST_ARRET_APPS_ECHOUE === "1" ? Promise.reject(new Error("arrêt des applis simulé")) : apps.arreter()).catch((e) =>
      console.error("[webaios] les applis ne se sont pas arrêtées :", e),
    );
    extensions.arreter();
    await sessions.toutArreter();
    await sites.arreter();
    await design.arreter();
    await actionsStop?.();
    await stopKernel(await ready);
    await ai.fermer().catch(() => {});
    clearInterval(purge);
    hist?.fermer();
    await appsStopped;
  })());

const sessions = new SessionsAgent({
  async ouvrir(f, t) {
    const n = await ready;
    if (!n) throw new Error(error ?? "le noyau de l'agent n'a pas démarré");
    return n.ouvrirSessionAgent({ ...t, fenetre: f });
  },
  // The user talks to the agent from the tab on screen: it is given to the agent.
  surEnvoi: (f) => {
    rpc.request<TabInfo | null>("ongletActif", [f]).then(
      (o) => o && kernel?.politique.interactionUtilisateur(o),
      () => {},
    );
  },
  envoyer: (win, channel, v) => rpc.notify(channel === "donnees" ? "agent.donnees" : "agent.etat", channel === "donnees" ? { fenetre: win, d: v } : { fenetre: win, e: v }),
});

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  handlers: {
    // Repeated with the same profile: the running kernel stays (its sessions with it); a failed start is retried.
    demarrer: async (p: { profilAgent: string }) => {
      if (profile === p.profilAgent && (await ready)) return start();
      return changeProfile(p.profilAgent);
    },
    changerProfil: (p: { profilAgent: string }) => changeProfile(p.profilAgent),
    "agent.demarrer": (p: { fenetre: string; taille: TerminalSize }) => sessions.demarrer(p.fenetre, p.taille),
    "agent.profils": async () => {
      // The kernel writes the default profile while it starts: the panel may ask before that.
      await ready;
      try {
        return (await loadProfiles(paths)).profils.map((x) => ({ id: x.id, nom: x.nom }));
      } catch {
        return [];
      }
    },
    "acces.etat": accessState,
    // Home page: the widgets of espace/accueil/widgets, their data and state, the validated theme,
    // with the free placement (version 3).
    "accueil.lire": async () => {
      const n = await ready;
      if (!n) return { widgets: [], theme: null };
      try {
        const state = await n.lireAccueil();
        const mtimes: Record<string, number> = {};
        await Promise.all(
          state.widgets.map(async (w) => {
            if ("erreur" in w || !w.aAffichage) return;
            try {
              mtimes[w.id] = Math.round((await stat(join(w.dossier, "affichage.html"))).mtimeMs);
            } catch {
              // affichage.html deleted in the meantime: the next read will tell
            }
          }),
        );
        const [placements, theme] = await Promise.all([readFreeLayout(n.chemins), readTheme(n.chemins)]);
        // An invalid theme keeps the default: it is reported, never rewritten.
        if (theme.erreur) console.warn(`[webaios] ${theme.erreur}`);
        return toShownWidgets({ etat: state, placements, theme: theme.theme, mtimes });
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
        if (n) return n.refuserAccord(w);
        await removeGrant(widgetsFolder, w);
        await deleteData(widgetsFolder, w);
      }).then(
        () => rpc.notify("accueil.change"),
        (e) => console.error(`[webaios] widget ${id} non retiré :`, e),
      );
    },
    "accueil.accorder": async (p: { id: string; profil: string; compte: string[]; publiques: string[] }) => {
      const n = await ready;
      if (!n) return { ok: false as const, erreur: AGENT_STOPPED_MESSAGE };
      try {
        // The kernel refuses if the declaration is no longer the one the card showed.
        await n.accorder(p);
        return { ok: true as const };
      } catch (e) {
        console.error(`[webaios] accord du widget ${p?.id} :`, e);
        // The UI re-reads the page: the new request is displayed.
        rpc.notify("accueil.change");
        return { ok: false as const, erreur: (e as Error).message };
      }
    },
    "accueil.refuserAccord": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.refuserAccord(p.id).catch((e) => console.error(`[webaios] retrait de l'accord du widget ${p.id} :`, e));
    },
    "accueil.recolter": async (p: { id?: unknown }) => {
      const n = await ready;
      if (!n || typeof p?.id !== "string") return;
      await n.recolterMaintenant(p.id).catch((e) => console.error(`[webaios] récolte du widget ${p.id} :`, e));
    },
    // Read without the kernel, like the home page: the executions, outside the space.
    "accueil.executions": (p: { id?: unknown }) => executionsWidget(widgetsFolder, typeof p?.id === "string" ? p.id : ""),
    "accueil.execution": (p: { id?: unknown; execution?: unknown }) =>
      executionWidget(widgetsFolder, typeof p?.id === "string" ? p.id : "", typeof p?.execution === "string" ? p.execution : ""),
    // The workflow builder: inputs checked with the shared
    // schemas, a bad one answered with INVALID_ARGUMENT's shape. The private-space refusal of an action is the chrome's (api.ts).
    "workflow.catalogue": () => blockCatalog(),
    "workflow.lire": (p: { cible?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      if (!target.success) return null;
      return target.data.type === "widget" ? readEdit(widgetsContext, target.data.id) : readActionEdit(actionsContext, target.data.id);
    },
    "workflow.enregistrer": (p: { cible?: unknown; brouillon?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      const draft = DraftSchema.safeParse(p?.brouillon);
      if (!target.success || !draft.success) return { ...INVALID_ARGUMENT, avertissements: [] };
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionEdit(actionsContext, id, draft.data));
      return writes.inSeries(id, () => saveEdit(widgetsContext, id, draft.data));
    },
    "workflow.lireCode": (p: { cible?: unknown; nom?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      const name = NameCodeSchema.safeParse(p?.nom);
      if (!target.success || !name.success) return { erreur: INVALID_ARGUMENT.erreur };
      return target.data.type === "widget" ? readCode(paths, target.data.id, name.data) : readActionCode(paths, target.data.id, name.data);
    },
    "workflow.enregistrerCode": (p: { cible?: unknown; nom?: unknown; texte?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      const name = NameCodeSchema.safeParse(p?.nom);
      const text = SchemaCodeWorkflow.safeParse(p?.texte);
      if (!target.success || !name.success || !text.success) return INVALID_ARGUMENT;
      const id = target.data.id;
      if (target.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionCode(paths, id, name.data, text.data));
      return writes.inSeries(id, () => saveCode(paths, id, name.data, text.data));
    },
    "workflow.rejouer": async (p: { cible?: unknown; execution?: unknown; bloc?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      const execution = SchemaIdExecution.safeParse(p?.execution);
      const block = WorkflowBlockSchema.safeParse(p?.bloc);
      if (!target.success || !execution.success || !block.success) return INVALID_ARGUMENT;
      const n = await ready;
      if (!n) return { ok: false as const, erreur: AGENT_STOPPED_MESSAGE };
      if (target.data.type === "widget") return n.rejouer(target.data.id, execution.data, block.data);
      // A trial: its result shows in the builder's preview, never as the last result.
      const l = n.actions.rejouer(target.data.id, execution.data, block.data);
      if (l.deja) return { ok: false as const, erreur: ACTION_ALREADY_RUNNING };
      const r = await l.fin;
      return r.statut !== "invalide" && r.execution !== undefined
        ? { ok: true as const, execution: r.execution, statut: r.statut }
        : { ok: false as const, erreur: r.erreur ?? "Rejeu impossible" };
    },
    // Bad input or no kernel: {} (the page then selects no run); a failed run throws nothing.
    "workflow.lancer": async (p: { cible?: unknown; saisie?: unknown }) => {
      const target = TargetSchema.safeParse(p?.cible);
      const input = ActionInputSchema.safeParse(p?.saisie ?? null);
      if (!target.success || !input.success) return {};
      const n = await ready;
      if (!n) return {};
      const id = target.data.id;
      if (target.data.type === "action") {
        // A different input while the action runs is not lost silently.
        const l = n.actions.lancer(id, { ...(input.data?.trim() ? { saisie: input.data } : {}), declencheur: "manuelle" });
        if (l.deja) return { erreur: ACTION_ALREADY_RUNNING };
        const r = await l.fin;
        if (r.execution !== undefined) return { execution: r.execution };
        return r.erreur !== undefined ? { erreur: r.erreur } : {};
      }
      try {
        const r = await n.recolterMaintenant(id, "manuelle");
        return r.execution === undefined ? {} : { execution: r.execution };
      } catch (e) {
        console.error(`[webaios] exécution du widget ${id} :`, e);
        return {};
      }
    },
    "workflow.direct": async () => (await ready)?.direct() ?? { courants: [], enAttente: [] },
    // A bad selection is ignored.
    "workflow.selection": (p: { fenetre?: unknown; cible?: unknown; bloc?: unknown }) => {
      const s = builderSelection(p);
      if (s && typeof p?.fenetre === "string") selections.set(p.fenetre, s);
    },
    // Replaces the whole mirror: a window absent or without a workflow page is forgotten.
    "fenetres.actives": (p: Record<string, unknown> | null) => {
      actives = new Map(Object.entries(p ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    },
    // Actions: what touches the kernel and the disk (the chrome keeps the window state). Inputs checked with the shared
    // schemas; a bad one gets an empty answer.
    "actions.liste": () => actions.liste(),
    "actions.preparer": (p: { id?: unknown; saisie?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.saisie ?? null).success ? actions.preparer(p.id, (p.saisie ?? null) as string | null) : { ok: false, erreur: ACTION_UNKNOWN },
    "actions.nom": (p: { id?: unknown }) => (idAction(p?.id) ? actions.nom(p.id) : null),
    "actions.lancer": (p: { id?: unknown; saisie?: unknown }) =>
      idAction(p?.id) && ActionInputSchema.safeParse(p.saisie ?? null).success
        ? actions.lancer(p.id, (p.saisie ?? null) as string | null)
        : { statut: "invalide", erreur: "Demande invalide" },
    "actions.arreter": (p: { id?: unknown }) => void (idAction(p?.id) && actions.arreter(p.id)),
    "actions.page": (p: { id?: unknown; execution?: unknown }) =>
      idAction(p?.id) && (p.execution === null || executionAction(p.execution)) ? actions.page(p.id, p.execution) : null,
    "actions.executions": (p: { id?: unknown }) => (idAction(p?.id) ? actions.executions(p.id) : []),
    "actions.execution": (p: { id?: unknown; execution?: unknown }) => (idAction(p?.id) && executionAction(p.execution) ? actions.execution(p.id, p.execution) : null),
    "actions.direct": () => actions.direct(),
    "actions.lienPermis": (p: { id?: unknown; execution?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.execution) && urlAction(p.url) ? actions.lienPermis(p.id, p.execution, p.url) : false,
    "actions.imagePermise": (p: { id?: unknown; execution?: unknown; url?: unknown }) =>
      idAction(p?.id) && executionAction(p.execution) && urlAction(p.url) ? actions.imagePermise(p.id, p.execution, p.url) : false,
    "actions.accorder": (p: unknown) => {
      const r = GrantSchema.safeParse(p);
      return r.success && idAction(r.data.id) ? actions.accorder(r.data) : { ok: false, erreur: "Demande d'accord invalide" };
    },
    "actions.refuserAccord": (p: { id?: unknown }) => (idAction(p?.id) ? actions.refuserAccord(p.id) : undefined),
    "actions.supprimer": (p: { id?: unknown }) => (idAction(p?.id) ? actions.supprimer(p.id) : { ok: false, erreur: "Demande invalide" }),
    // Site apps (the window is the chrome's). A bad action is ignored.
    // The open apps are known again: the Applications page reads them (it read « fermée » while the host was down).
    "sites.pret": () => sites.resynchroniser().then(() => rpc.notify("sites.change")),
    "sites.liste": () => sites.liste(),
    "sites.agir": (p: { id?: unknown; action?: unknown; fenetre?: unknown }) => {
      const a = SchemaActionSite.safeParse(p);
      if (a.success && typeof p?.fenetre === "string") return sites.agir(a.data.id, a.data.action, p.fenetre);
    },
    "sites.memoireAccueil": (p: { id?: unknown }) => (typeof p?.id === "string" ? sites.memoireAccueil(p.id) : null),
    "sites.noter": (p: { id?: unknown; cadre?: FrameBounds; favicon?: unknown }) => {
      if (typeof p?.id === "string") sites.noter(p.id, { ...(p.cadre ? { cadre: p.cadre } : {}), ...(typeof p.favicon === "string" ? { favicon: p.favicon } : {}) });
    },
    "sites.memoireOp": (p: unknown) => sites.memoireOp(p),
    "sites.position": (p: unknown) => sites.position(p),
    "sites.reprise": (p: unknown) => sites.reprise(p),
    "sites.chercher": (p: { id?: unknown; url?: unknown }) => {
      if (typeof p?.id === "string" && (p.url === null || typeof p.url === "string")) return sites.chercherAdresse(p.id, p.url);
    },
    "sites.accorder": (p: { id?: unknown; oui?: unknown; empreinte?: unknown }) => {
      if (typeof p?.id === "string" && typeof p.oui === "boolean" && typeof p.empreinte === "string") return sites.accorder(p.id, p.oui, p.empreinte);
    },
    "sites.ferme": (p: { id?: unknown }) => {
      if (typeof p?.id === "string") sites.fermee(p.id);
    },
    "historique.noter": (p: Parameters<InstanceType<typeof History>["noter"]>[0]) => hist?.noter(p),
    "historique.titre": (p: { url: string; espaceId: string; titre: string }) => hist?.majTitre(p.url, p.espaceId, p.titre),
    "historique.retenir": (p: { url: string; espaceId: string; titre: string; texte: string }) => {
      if (keepable(p.url)) hist?.retenir({ ...p, texte: String(p.texte) });
    },
    "historique.rendrePrive": (p: { espaceId: string }) => hist?.rendrePrive(p.espaceId),
    "historique.rechercher": (p: { texte: string; limite?: number; distinctes?: boolean }) => hist?.rechercher(p.texte, p.limite, p.distinctes) ?? [],
    "historique.recents": () => hist?.recents() ?? [],
    "historique.effacer": (p: { depuis?: string }) => hist?.effacer(p.depuis ? new Date(p.depuis) : undefined),
    "historique.oublierTexte": (p: { url: string; espaceId: string }) => hist?.oublierTexte(p.url, p.espaceId),
    arreter: async () => {
      try {
        await stop();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    "agent.ecrire": (p: { fenetre: string; d: string }) => sessions.ecrire(p.fenetre, p.d),
    "agent.redimensionner": (p: { fenetre: string; taille: TerminalSize }) => sessions.redimensionner(p.fenetre, p.taille),
    "agent.fermerFenetre": (p: { fenetre: string }) => {
      selections.delete(p.fenetre);
      actives.delete(p.fenetre);
      void sessions.fermerFenetre(p.fenetre);
    },
    prives: (p: { prives: string[]; actifPrive: boolean }) => bridge.setPrivate(p),
    "politique.navigue": (p: { id: string; url: string }) => kernel?.politique.ongletNavigue(p.id, p.url),
    "politique.ferme": (p: { id: string }) => kernel?.politique.ongletFerme(p.id),
    "politique.couper": (p: { id: string; droit?: Parameters<Kernel["politique"]["couper"]>[1] }) => kernel?.politique.couper(p.id, p.droit),
    "agent.envoi": (p: { onglet: TabInfo | null }) => void (p.onglet && kernel?.politique.interactionUtilisateur(p.onglet)),
    // Opening the panel on a tab gives it to the agent and pre-fills the context, without sending it.
    "agent.panneauOuvert": (p: { fenetre: string; onglet: TabInfo }) => {
      kernel?.politique.interactionUtilisateur(p.onglet);
      if (sessions.active(p.fenetre)) sessions.ecrire(p.fenetre, contextPrefix(p.onglet.titre, p.onglet.url));
    },
    // Sent by the chrome on each host start, with the about:addons changes seen while no host ran (applied first:
    // never reinstalled); answered when every granted extension is handled. A failed start is retried by the next one.
    "extensions.pret": async (p: { horsWebaios?: { addonId: string; quoi: "desinstallee" | "desactivee" }[]; plantages?: { addonId?: unknown; le?: unknown }[] }) => {
      for (const c of Array.isArray(p?.plantages) ? p.plantages : []) extensions.plantage(c?.addonId, c?.le);
      for (const h of p?.horsWebaios ?? []) await extensions.horsWebaios(h.addonId, h.quoi);
      return (extensionsStartup ??= extensions.demarrer().catch((e) => {
        extensionsStartup = undefined;
        throw e;
      }));
    },
    "extensions.horsWebaios": (p: { addonId: string; quoi: "desinstallee" | "desactivee" }) =>
      extensions.horsWebaios(p.addonId, p.quoi),
    "extensions.aTourne": (p: { addonId: string; profil: string; lisible: boolean }) => extensions.aTourne(p.addonId, p.profil, p.lisible),
    // A content script's message is readable only from a tab the agent can read as it is noted:
    // ongletLisibleParAgent): asked of the policy here, which knows an agent-opened tab before Firefox hears of it.
    "extensions.console": (p: { addonId?: unknown; m?: unknown; onglet?: { ongletId?: unknown; url?: unknown } | null }) => {
      const o = p?.onglet;
      const readable = !!o && typeof o.ongletId === "string" && typeof o.url === "string" && kernel?.politique.peutLire({ id: o.ongletId, url: o.url, titre: "", espace: "" }) === true;
      extensions.noterConsole(p?.addonId, p?.m, o ? { lisible: readable } : null);
    },
    "extensions.plantage": (p: { addonId?: unknown; le?: unknown }) => extensions.plantage(p?.addonId, p?.le),
    "extensions.profilsPrives": (p: { prives?: unknown }) =>
      extensions.profilsPrives(Array.isArray(p?.prives) ? p.prives.filter((x): x is string => typeof x === "string") : []),
    "extensions.pourEspace": (p: { espaceId?: unknown }) => (typeof p?.espaceId === "string" ? extensions.pourEspace(p.espaceId) : []),
    "extensions.basculer": (p: { cle?: unknown; espaceId?: unknown; actif?: unknown; fenetre?: unknown }) =>
      typeof p?.cle === "string" && typeof p.espaceId === "string"
        ? extensions.basculer(p.cle, p.espaceId, p.actif === true, typeof p.fenetre === "string" ? p.fenetre : null)
        : { ok: false, erreur: "Paramètres invalides" },
    // The Extensions page (the agent's extensions only, decision 8).
    "extensions.liste": () => extensions.liste(),
    "extensions.coupees": () => extensions.coupees(),
    "extensions.supprimer": (p: { cle?: unknown }) => byKey(p, (key) => extensions.supprimerPage(key)),
    "extensions.desactiverPartout": (p: { cle?: unknown }) => byKey(p, (key) => extensions.desactiverPartout(key)),
    "extensions.reactiver": (p: { cle?: unknown }) => byKey(p, (key) => extensions.reactiver(key)),
    "extensions.couperDeblocage": (p: { cle?: unknown }) => byKey(p, (key) => extensions.couperDeblocage(key)),
    "extensions.revoir": (p: { cle?: unknown; fenetre?: unknown }) =>
      byKey(p, (key) => extensions.revoir(key, typeof p.fenetre === "string" ? p.fenetre : null)),
    "extensions.toutCouper": (p: { oui?: unknown }) => extensions.toutCouper(p?.oui === true),
    "extensions.installerStore": () => ({ ok: false, erreur: STORE_ABSENT }),
    // The RPC signal is ignored on purpose: the kernel's Pacing hands the lane back (partie=false) when the read has already ended, and rpc.ts drops a late answer.
    "lecture.changerHote": (p: { lecture: string; hote: string }) => bridge.changerHote(p.lecture, p.hote),
    // Tests only: a paced read through a Pacing shared by the calls, as a workflow's web widget does.
    ...(process.env.WEBAIOS_TEST_LECTURE_MENAGEE === "1"
      ? {
          "test.lectureMenagee": ({ url }: { url: string }) =>
            testPacing.lire(new URL(url).hostname, (ch) => bridge.lirePageInvisible(url, { profil: null, changerHote: ch })),
        }
      : {}),
    // The agent's applications (host/applications.ts): `apps` is made after the RPC, below.
    ...Object.fromEntries(["applications.liste", "applications.agir", "applications.fenetreFermee", "applications.navigation", "applications.noter"].map((k) => [k, (p: unknown) => apps.handlers[k]!(p)])),
    // Design mode's host side (host/design.ts): `design` is made after `sites`, below.
    ...Object.fromEntries(DESIGN_METHODS.map((k) => [k, (p: unknown) => design.handlers[k]!(p)])),
    ...(process.env.WEBAIOS_HOST_TEST === "1" ? { "debug.log": (p: { texte: string }) => console.log(p.texte) } : {}),
  },
});
const bridge = new RemoteBridge(rpc, hist, (site, url) => sites.adressePermise(site, url));
const testPacing = new Pacing();
/** A page request on one extension key: a malformed one is refused as text. */
const byKey = <T,>(p: { cle?: unknown } | undefined, f: (key: string) => T) => (typeof p?.cle === "string" ? f(p.cle) : { ok: false as const, erreur: "Paramètres invalides" });
// Outside the agent's kernel, like the history: granted extensions run even when the kernel does not start.
const extensions = new ExtensionsAgent({ dossier: join(dataDir, "extensions"), dossierAgent: paths.extensions, rpc });
// Site apps: the Node side (list, memory, deletion); the windows are the chrome's, asked through the RPC.
const sites = createSites({
  chemins: paths,
  dataDir,
  adressesLocales: process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1",
  chrome: {
    ouvrir: (s, frame, tweaks) => rpc.request("sites.ouvrir", [s, frame, tweaks]),
    fermer: (id) => rpc.request("sites.fermer", [id]),
    effacer: (id) => rpc.request("sites.effacer", [id]),
    mettreAJour: (s, tweaks) => rpc.request("sites.mettreAJour", [s, tweaks]),
    rechargerVue: (id) => rpc.request("sites.rechargerVue", [id]),
    erreurs: (id) => rpc.request("sites.erreurs", [id]),
    vue: (id) => rpc.request("sites.vue", [id]),
    apresAccord: (id, s) => rpc.request("sites.apresAccord", [id, s]),
    rediffuser: (id) => rpc.request("sites.rediffuser", [id]),
    ouvertes: () => rpc.request("sites.ouvertes"),
    accueilChange: (id) => rpc.notify("sites.accueilChange", [id]),
    cherche: (id, yes) => rpc.notify("sites.cherche", [id, yes]),
    avis: (id, a) => rpc.notify("sites.avis", [id, a]),
    adresseChangee: (id, domains, start, to) => rpc.notify("sites.adresseChangee", [id, domains, start, to]),
  },
  // The public read (a throwaway container, no profile): never the app's cookies nor the user's.
  lireLiens: async (page, signal) =>
    (await bridge.lirePageInvisible(page, { profil: null, ...(process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1" ? { adressesLocales: true } : {}), ...(signal ? { signal } : {}) })).liens.map((l) => l.url),
  // The review takes a new app's first snapshot.
  diffuser: () => {
    rpc.notify("sites.change");
    design.sitesChanged();
  },
  preRemplir: (f, t) => sessions.preRemplir(f, t),
  notifierMemoire: (id, message) => rpc.notify("sites.memoire", { id, message }),
  // The agent loses its dev tools on the closed window; the app's grant holds for the conversation, until « Supprimer »
  // (an app made again under the same id asks for its card again).
  surFermee: (id) => kernel?.politique.ongletFerme(`site:${id}`),
  // Its remarks, review repository and comments go with it.
  surSupprimee: (id) => {
    kernel?.politique.retirerLectureSite(id);
    design.siteDeleted(id);
  },
  // A snapshot taken between the start and the end of the deletion is erased again (an app made again starts afresh).
  apresSuppression: (id) => design.siteDeleted(id),
});
// The agent's applications: the gestionnaire, the Docker probe, the memory; the windows are the chrome's.
const apps = createApplicationsHost({
  chemins: paths,
  dataDir,
  atelier: workshop,
  chrome: {
    ouvrir: (a, frame) => rpc.request("apps.ouvrir", [a, frame]),
    fermer: (folder) => rpc.request("apps.fermer", [folder]),
    montrer: (folder) => rpc.request("apps.montrer", [folder]),
    effacer: (folder) => rpc.request("apps.effacer", [folder]),
  },
  // The tab is given to the agent when the text is written, then the panel opens.
  deboguer: (f, text, access) => {
    sessions.preRemplir(
      f,
      text,
      access &&
        (() => {
          const tab = access();
          if (tab) kernel?.politique.interactionUtilisateur(tab);
        }),
    );
    rpc.notify("design.donnerAgent", [f]);
  },
  politique: () => kernel?.politique ?? null,
  // The Applications page reads the list again; design mode too (the running apps' ports may have changed); the review
  // takes a new app's first snapshot.
  diffuser: () => {
    rpc.notify("applications.change");
    rpc.notify("design.change");
    design.appsChanged();
  },
});
// Design mode: remarks, the external MCP server and the review, without waiting for the kernel.
const design = createDesignHost({
  dataDir,
  chemins: paths,
  port: externalMcpPort(process.env.WEBAIOS_PORT_MCP_EXTERNE),
  sites: () => sites.liste().then((l) => l.map(({ id, nom: name }) => ({ id, nom: name }))),
  // Every app (apps.liste() keeps the running ones only).
  applis: () => apps.gestionnaire.liste(),
  preRemplir: (f, t) => sessions.preRemplir(f, t),
  chrome: { fenetreAgent: () => rpc.request("design.fenetreAgent"), donnerAgent: (f) => rpc.notify("design.donnerAgent", [f]) },
  notifier: notify,
  diffuser: () => (rpc.notify("externes.change"), rpc.notify("design.change")),
});
// Actions: the kernel and disk half; the chrome keeps the window state (private spaces, tabs, pace of links).
const actions = createActionsHost({ chemins: paths, dossierActions: actionsFolder, noyau: () => kernel, surChange: () => rpc.notify("actions.change") });
// The actions and components folders, watched outside the kernel: the page lists even without it.
let actionsStop: (() => Promise<void>) | undefined;
try {
  actionsStop = watchActions(paths, () => rpc.notify("actions.change"));
} catch (e) {
  console.error("[webaios] la surveillance des actions n'a pas démarré :", e);
}
// The chrome may not answer yet (its handlers come up later): it calls "sites.pret" once it does.
void sites.resynchroniser().catch(() => {});
let extensionsStartup: Promise<void> | undefined;

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (l) => rpc.receive(l))
  .on("close", () => {
    rpc.close("Firefox s'est arrêté");
    // A stop that hangs (docker, a session) must not keep an orphan host alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void stop().finally(() => process.exit(0));
  });
