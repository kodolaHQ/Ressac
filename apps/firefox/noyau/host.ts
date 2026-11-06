import type { Noyau, OngletInfo } from "../../../packages/noyau/src/index.ts";
import type { Cadre } from "../../navigateur/src/commun/modele.ts";
import type { SelectionConstructeur, TailleTerminal } from "../../navigateur/src/commun/api.ts";

// The agent host: Firefox spawns it and talks JSON-RPC over stdin/stdout, one JSON message per line.
// stdout carries only the RPC: anything else written there would corrupt it, so it goes to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
console.log = console.info = console.debug = console.error;
// Firefox gone: its pipe breaks, and the end of stdin stops everything below.
process.stdout.on("error", () => {});
process.on("unhandledRejection", (e) => console.error("[webaios] rejet non géré :", e));

process.env.WEBAIOS_CONTENEUR ||= "webaios-atelier-firefox";
// Two containers cannot publish the same host ports: the Electron app keeps 5280-5299.
process.env.WEBAIOS_PORTS_CONTENEUR ||= "5300-5319";

const { join } = await import("node:path");
const { createInterface } = await import("node:readline");
const { appendFileSync } = await import("node:fs");
const { stat } = await import("node:fs/promises");
// Imported after the env is set and stdout redirected: nothing in the noyau can write to stdout at load time.
const { ACTION_INCONNUE, catalogueBlocs, chargerProfils, cheminsEspace, creerNoyau, executeurParDefaut, IaLocale, lireAccueil, lireDispositionLibre, lireTheme, Menagement, prefixeContexte, retirerAccord, supprimerDonnees, surveillerActions } = await import("../../../packages/noyau/src/index.ts");
const { SessionsAgent } = await import("../../navigateur/src/main/agent/sessions.ts");
const { Historique } = await import("../../navigateur/src/main/historique.ts");
const { createRpc } = await import("../shared/rpc.ts");
const { RemoteBridge } = await import("./remote-bridge.ts");
const { createSites, SchemaActionSite } = await import("./sites.ts");
const { createActionsHost, SchemaAccord, SchemaIdAction, SchemaSaisieAction } = await import("./actions.ts");
const { ExtensionsAgent } = await import("./extensions/agent.ts");
const { STORE_ABSENT } = await import("./extensions/amo.ts");
const { executionWidget, executionsWidget, placerWidgets, retirerWidget, validerPlacements, versWidgetsAffiches } = await import("./widgets.ts");
const { ACTION_TOURNE_DEJA } = await import("../../navigateur/src/commun/actions.ts");
const {
  readActionCode,
  readActionEdition,
  readCode,
  readEdition,
  saveActionCode,
  saveActionEdition,
  saveCode,
  saveEdition,
  SchemaBlocWorkflow,
  SchemaBrouillon,
  SchemaCible,
  SchemaCodeWorkflow,
  SchemaIdExecution,
  SchemaNomCode,
  selectionConstructeur,
  workflowOpen,
  WriteQueue,
} = await import("./workflow.ts");

const dataDir = process.env.WEBAIOS_DATA_DIR;
if (!dataDir) {
  console.error("[webaios] WEBAIOS_DATA_DIR manquant");
  process.exit(2);
}
const racine = join(dataDir, "espace");
const chemins = cheminsEspace(racine);
// Widgets' data, states and accords: outside the space, like Electron.
const dossierWidgets = join(dataDir, "widgets");
// Outside the agent's noyau: the history works even when the noyau does not start.
// Electron's retenable (capture-texte.ts) can't be imported here: it needs the extensionless "../historique" import, which Node refuses.
const MEMOIRE_BOUCLE = process.env.WEBAIOS_MEMOIRE_BOUCLE === "1";
// Keep in sync with apps/navigateur/src/main/onglets/capture-texte.ts.
const retenable = (url: string) => {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && (MEMOIRE_BOUCLE || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};
// A broken database must not take the agent down: no history then (empty answers, no agent tools).
const historique = (() => {
  try {
    const h = new Historique(join(dataDir, "historique.sqlite"));
    h.purger();
    return h;
  } catch (e) {
    console.error("[webaios] l'historique n'a pas pu s'ouvrir :", e);
    return undefined;
  }
})();
const purge = setInterval(() => historique?.purger(), 6 * 60 * 60 * 1000);
purge.unref();
const duckduckgo = process.env.WEBAIOS_TEST_DUCKDUCKGO_URL;
// Electron's MESSAGE_AGENT_ARRETE (main/index.ts, which imports electron, so it cannot be imported here).
const MESSAGE_AGENT_ARRETE = "Le service des widgets ne répond pas (agent arrêté ?)";
// Electron's ipc.ts answer to a bad builder argument.
const ARGUMENT_INVALIDE = { ok: false as const, erreur: "Argument invalide" };
// The workflow builder: the block selected in each window, the workflow page each window shows (chrome's mirror).
const selections = new Map<string, SelectionConstructeur>();
let actives = new Map<string, string>();
const writes = new WriteQueue();
const idAction = (v: unknown): v is string => SchemaIdAction.safeParse(v).success;
const executionAction = (v: unknown): v is string => SchemaIdExecution.safeParse(v).success;
// Electron's ipc.ts bound on a link.
const urlAction = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;
const contexteWidgets = { chemins, dossierWidgets };
// Actions' runs, results, accords and refusals: outside the space, like Electron.
const dossierActions = join(dataDir, "actions");
const contexteActions = { chemins, dossierActions };

let noyau: Noyau | null = null;
let erreur: string | null = null;
let pret: Promise<Noyau | null> = Promise.resolve(null);
let unsubscribe: (() => void) | undefined;
let arretAccueil: (() => Promise<void>) | undefined;
let accesTimer: NodeJS.Timeout | undefined;

const etatAcces = () => ({ agent: noyau?.agent ?? "L'agent", onglets: noyau?.politique.etat() ?? {} });
// A burst of policy changes gives one notification per 50 ms.
const diffuserAcces = () => {
  accesTimer ??= setTimeout(() => {
    accesTimer = undefined;
    rpc.notify("acces", etatAcces());
  }, 50);
};

// The local AI for harvests: Gemma and the decision model both run in Ollama (Electron launches Kev instead; same
// /v1/systemone answers). Nothing is installed here: a missing model fails with Ollama's answer.
const ia = new IaLocale({ dossier: join(dataDir, "ia-locale"), executer: executeurParDefaut, modeleDecision: "pplx-decider-flash" });

const lancerNoyau = (profilId: string): Promise<Noyau | null> => {
  erreur = null;
  return creerNoyau({
    pont: bridge,
    profilId,
    racine,
    dossierWidgets,
    dossierActions,
    ia,
    dossierProfilage: join(dataDir, "profilage"),
    extensions: extensions.outils(),
    sites: sites.outils,
    workflowOuvert: (f) => workflowOpen(actives.get(f), selections.get(f)),
    // Widgets and actions wrote something, or an accord changed: the page reads again.
    surChange: () => rpc.notify("accueil.change"),
    // The host is Node and cannot call Cc: in tests it writes the file, otherwise the chrome store shows the alert.
    notifier: (n) => {
      const fichier = process.env.WEBAIOS_TEST_NOTIFICATIONS;
      if (fichier) return void appendFileSync(fichier, JSON.stringify({ titre: n.titre, texte: n.texte }) + "\n");
      rpc.notify("accueil.notification", { titre: n.titre, texte: n.texte });
    },
    ...(process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1" ? { adressesLocales: true } : {}),
    ...(duckduckgo ? { urlRecherche: duckduckgo } : {}),
  }).then(
    (n) => {
      noyau = n;
      const offPolitique = n.politique.surChange(diffuserAcces);
      const offDirect = n.surDirect((e) => rpc.notify("workflow.direct", e));
      const offActions = n.actions.surDirect((e) => {
        rpc.notify("actions.direct", e);
        actions.directVu(e);
      });
      unsubscribe = () => (offPolitique(), offDirect(), offActions());
      // A widget added or rewritten, a placement made in another window, a theme: the page reads again.
      // Unguarded, a watch failure would reject `pret` and every host method with it.
      try {
        arretAccueil = n.surveillerAccueil(() => rpc.notify("accueil.change"));
      } catch (e) {
        console.error("[webaios] la surveillance de l'accueil n'a pas démarré :", e);
      }
      diffuserAcces();
      return n;
    },
    (e: Error) => {
      erreur = e.message;
      console.error("[webaios] le noyau n'a pas pu démarrer :", e);
      return null;
    },
  );
};

const arreterNoyau = async (n: Noyau | null) => {
  noyau = null;
  unsubscribe?.();
  unsubscribe = undefined;
  await arretAccueil?.();
  arretAccueil = undefined;
  diffuserAcces();
  await n?.arreter();
};

const demarrer = async () => {
  const n = await pret;
  if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
  return { agent: n.agent };
};

let profil: string | null = null;
// Another profile: a new noyau (command, MCP config) and a new agent in every panel. Never two noyaux at once:
// two MCP servers would write the same mcp.json.
const changerProfil = (profilAgent: string) => {
  const relancer = profil !== null;
  profil = profilAgent;
  pret = pret.then(arreterNoyau).then(() => lancerNoyau(profilAgent));
  if (relancer) void sessions.relancerTout();
  return demarrer();
};

let stopping: Promise<void> | undefined;
const arreter = () =>
  (stopping ??= (async () => {
    extensions.arreter();
    await sessions.toutArreter();
    await sites.arreter();
    await arretActions?.();
    await arreterNoyau(await pret);
    await ia.fermer().catch(() => {});
    clearInterval(purge);
    historique?.fermer();
  })());

const sessions = new SessionsAgent({
  async ouvrir(f, t) {
    const n = await pret;
    if (!n) throw new Error(erreur ?? "le noyau de l'agent n'a pas démarré");
    return n.ouvrirSessionAgent({ ...t, fenetre: f });
  },
  // The user talks to the agent from the tab on screen: it is given to the agent.
  surEnvoi: (f) => {
    rpc.request<OngletInfo | null>("ongletActif", [f]).then(
      (o) => o && noyau?.politique.interactionUtilisateur(o),
      () => {},
    );
  },
  envoyer: (fenetre, canal, v) => rpc.notify(canal === "donnees" ? "agent.donnees" : "agent.etat", canal === "donnees" ? { fenetre, d: v } : { fenetre, e: v }),
});

const rpc = createRpc({
  send: (line) => void writeStdout(line + "\n"),
  handlers: {
    // Repeated with the same profile: the running noyau stays (its sessions with it); a failed start is retried.
    demarrer: async (p: { profilAgent: string }) => {
      if (profil === p.profilAgent && (await pret)) return demarrer();
      return changerProfil(p.profilAgent);
    },
    changerProfil: (p: { profilAgent: string }) => changerProfil(p.profilAgent),
    "agent.demarrer": (p: { fenetre: string; taille: TailleTerminal }) => sessions.demarrer(p.fenetre, p.taille),
    "agent.profils": async () => {
      // The noyau writes the default profile while it starts: the panel may ask before that.
      await pret;
      try {
        return (await chargerProfils(chemins)).profils.map((x) => ({ id: x.id, nom: x.nom }));
      } catch {
        return [];
      }
    },
    "acces.etat": etatAcces,
    // Home page: the widgets of espace/accueil/widgets, their data and state, the validated theme. Electron's rules,
    // with the free placement (version 3).
    "accueil.lire": async () => {
      const n = await pret;
      if (!n) return { widgets: [], theme: null };
      try {
        const etat = await n.lireAccueil();
        const mtimes: Record<string, number> = {};
        await Promise.all(
          etat.widgets.map(async (w) => {
            if ("erreur" in w || !w.aAffichage) return;
            try {
              mtimes[w.id] = Math.round((await stat(join(w.dossier, "affichage.html"))).mtimeMs);
            } catch {
              // affichage.html supprimé entre-temps : la prochaine lecture le dira
            }
          }),
        );
        const [placements, theme] = await Promise.all([lireDispositionLibre(n.chemins), lireTheme(n.chemins)]);
        // Un thème invalide garde le défaut : il est signalé, jamais réécrit.
        if (theme.erreur) console.warn(`[webaios] ${theme.erreur}`);
        return versWidgetsAffiches({ etat, placements, theme: theme.theme, mtimes });
      } catch (e) {
        console.error("[webaios] page d'accueil illisible :", e);
        return { widgets: [], theme: null };
      }
    },
    "accueil.placer": async (p: { placements?: unknown }) => {
      try {
        // Un placement n'a pas besoin du noyau : les dossiers de l'espace suffisent (comme Electron).
        const ids = (await lireAccueil(chemins, dossierWidgets)).widgets.map((w) => w.id);
        await placerWidgets(chemins, validerPlacements(p?.placements, ids));
      } catch (e) {
        console.error("[webaios] disposition non écrite :", e);
        // L'interface a déjà montré l'aperçu du geste : elle relit l'ancienne disposition au lieu de le laisser à l'écran.
        rpc.notify("accueil.change");
      }
    },
    "accueil.retirer": (p: { id?: unknown }) => {
      const id = typeof p?.id === "string" ? p.id : "";
      // L'accord et les données lues avec le compte partent avec le widget (par le noyau, qui écrit aussi les accords).
      void retirerWidget(chemins, id, async (w) => {
        const n = await pret;
        if (n) return n.refuserAccord(w);
        await retirerAccord(dossierWidgets, w);
        await supprimerDonnees(dossierWidgets, w);
      }).then(
        () => rpc.notify("accueil.change"),
        (e) => console.error(`[webaios] widget ${id} non retiré :`, e),
      );
    },
    "accueil.accorder": async (p: { id: string; profil: string; compte: string[]; publiques: string[] }) => {
      const n = await pret;
      if (!n) return { ok: false as const, erreur: MESSAGE_AGENT_ARRETE };
      try {
        // Le noyau refuse si la déclaration n'est plus celle que la carte a montrée.
        await n.accorder(p);
        return { ok: true as const };
      } catch (e) {
        console.error(`[webaios] accord du widget ${p?.id} :`, e);
        // L'interface relit la page : la nouvelle demande s'affiche.
        rpc.notify("accueil.change");
        return { ok: false as const, erreur: (e as Error).message };
      }
    },
    "accueil.refuserAccord": async (p: { id?: unknown }) => {
      const n = await pret;
      if (!n || typeof p?.id !== "string") return;
      await n.refuserAccord(p.id).catch((e) => console.error(`[webaios] retrait de l'accord du widget ${p.id} :`, e));
    },
    "accueil.recolter": async (p: { id?: unknown }) => {
      const n = await pret;
      if (!n || typeof p?.id !== "string") return;
      await n.recolterMaintenant(p.id).catch((e) => console.error(`[webaios] récolte du widget ${p.id} :`, e));
    },
    // Lues sans le noyau, comme la page d'accueil : les exécutions, hors de l'espace.
    "accueil.executions": (p: { id?: unknown }) => executionsWidget(dossierWidgets, typeof p?.id === "string" ? p.id : ""),
    "accueil.execution": (p: { id?: unknown; execution?: unknown }) =>
      executionWidget(dossierWidgets, typeof p?.id === "string" ? p.id : "", typeof p?.execution === "string" ? p.execution : ""),
    // The workflow builder, as Electron's main/index.ts, ipc.ts and constructeur.ts: inputs checked with the same
    // schemas, a bad one answered with ipc.ts's shapes. The private-space refusal of an action is the chrome's (api.ts).
    "workflow.catalogue": () => catalogueBlocs(),
    "workflow.lire": (p: { cible?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      if (!cible.success) return null;
      return cible.data.type === "widget" ? readEdition(contexteWidgets, cible.data.id) : readActionEdition(contexteActions, cible.data.id);
    },
    "workflow.enregistrer": (p: { cible?: unknown; brouillon?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      const brouillon = SchemaBrouillon.safeParse(p?.brouillon);
      if (!cible.success || !brouillon.success) return { ...ARGUMENT_INVALIDE, avertissements: [] };
      const id = cible.data.id;
      if (cible.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionEdition(contexteActions, id, brouillon.data));
      return writes.inSeries(id, () => saveEdition(contexteWidgets, id, brouillon.data));
    },
    "workflow.lireCode": (p: { cible?: unknown; nom?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      const nom = SchemaNomCode.safeParse(p?.nom);
      if (!cible.success || !nom.success) return { erreur: ARGUMENT_INVALIDE.erreur };
      return cible.data.type === "widget" ? readCode(chemins, cible.data.id, nom.data) : readActionCode(chemins, cible.data.id, nom.data);
    },
    "workflow.enregistrerCode": (p: { cible?: unknown; nom?: unknown; texte?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      const nom = SchemaNomCode.safeParse(p?.nom);
      const texte = SchemaCodeWorkflow.safeParse(p?.texte);
      if (!cible.success || !nom.success || !texte.success) return ARGUMENT_INVALIDE;
      const id = cible.data.id;
      if (cible.data.type === "action") return writes.inSeries(`action:${id}`, () => saveActionCode(chemins, id, nom.data, texte.data));
      return writes.inSeries(id, () => saveCode(chemins, id, nom.data, texte.data));
    },
    "workflow.rejouer": async (p: { cible?: unknown; execution?: unknown; bloc?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      const execution = SchemaIdExecution.safeParse(p?.execution);
      const bloc = SchemaBlocWorkflow.safeParse(p?.bloc);
      if (!cible.success || !execution.success || !bloc.success) return ARGUMENT_INVALIDE;
      const n = await pret;
      if (!n) return { ok: false as const, erreur: MESSAGE_AGENT_ARRETE };
      if (cible.data.type === "widget") return n.rejouer(cible.data.id, execution.data, bloc.data);
      // A trial: its result shows in the builder's preview, never as the last result.
      const l = n.actions.rejouer(cible.data.id, execution.data, bloc.data);
      if (l.deja) return { ok: false as const, erreur: ACTION_TOURNE_DEJA };
      const r = await l.fin;
      return r.statut !== "invalide" && r.execution !== undefined
        ? { ok: true as const, execution: r.execution, statut: r.statut }
        : { ok: false as const, erreur: r.erreur ?? "Rejeu impossible" };
    },
    // Bad input or no noyau: {} (the page then selects no run); a failed run throws nothing.
    "workflow.lancer": async (p: { cible?: unknown; saisie?: unknown }) => {
      const cible = SchemaCible.safeParse(p?.cible);
      const saisie = SchemaSaisieAction.safeParse(p?.saisie ?? null);
      if (!cible.success || !saisie.success) return {};
      const n = await pret;
      if (!n) return {};
      const id = cible.data.id;
      if (cible.data.type === "action") {
        // A different input while the action runs is not lost silently.
        const l = n.actions.lancer(id, { ...(saisie.data?.trim() ? { saisie: saisie.data } : {}), declencheur: "manuelle" });
        if (l.deja) return { erreur: ACTION_TOURNE_DEJA };
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
    "workflow.direct": async () => (await pret)?.direct() ?? { courants: [], enAttente: [] },
    // A bad selection is ignored, as Electron's IPC does.
    "workflow.selection": (p: { fenetre?: unknown; cible?: unknown; bloc?: unknown }) => {
      const s = selectionConstructeur(p);
      if (s && typeof p?.fenetre === "string") selections.set(p.fenetre, s);
    },
    // Replaces the whole mirror: a window absent or without a workflow page is forgotten.
    "fenetres.actives": (p: Record<string, unknown> | null) => {
      actives = new Map(Object.entries(p ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    },
    // Actions: what touches the noyau and the disk (the chrome keeps the window state). Inputs checked with Electron's
    // schemas; a bad one gets Electron's empty answer.
    "actions.liste": () => actions.liste(),
    "actions.preparer": (p: { id?: unknown; saisie?: unknown }) =>
      idAction(p?.id) && SchemaSaisieAction.safeParse(p.saisie ?? null).success ? actions.preparer(p.id, (p.saisie ?? null) as string | null) : { ok: false, erreur: ACTION_INCONNUE },
    "actions.nom": (p: { id?: unknown }) => (idAction(p?.id) ? actions.nom(p.id) : null),
    "actions.lancer": (p: { id?: unknown; saisie?: unknown }) =>
      idAction(p?.id) && SchemaSaisieAction.safeParse(p.saisie ?? null).success
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
      const r = SchemaAccord.safeParse(p);
      return r.success && idAction(r.data.id) ? actions.accorder(r.data) : { ok: false, erreur: "Demande d'accord invalide" };
    },
    "actions.refuserAccord": (p: { id?: unknown }) => (idAction(p?.id) ? actions.refuserAccord(p.id) : undefined),
    "actions.supprimer": (p: { id?: unknown }) => (idAction(p?.id) ? actions.supprimer(p.id) : { ok: false, erreur: "Demande invalide" }),
    // Site apps (the window is the chrome's). A bad action is ignored, as Electron's IPC does.
    "sites.pret": () => sites.resynchroniser(),
    "sites.liste": () => sites.liste(),
    "sites.agir": (p: { id?: unknown; action?: unknown; fenetre?: unknown }) => {
      const a = SchemaActionSite.safeParse(p);
      if (a.success && typeof p?.fenetre === "string") return sites.agir(a.data.id, a.data.action, p.fenetre);
    },
    "sites.memoireAccueil": (p: { id?: unknown }) => (typeof p?.id === "string" ? sites.memoireAccueil(p.id) : null),
    "sites.noter": (p: { id?: unknown; cadre?: Cadre; favicon?: unknown }) => {
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
    "historique.noter": (p: Parameters<InstanceType<typeof Historique>["noter"]>[0]) => historique?.noter(p),
    "historique.titre": (p: { url: string; espaceId: string; titre: string }) => historique?.majTitre(p.url, p.espaceId, p.titre),
    "historique.retenir": (p: { url: string; espaceId: string; titre: string; texte: string }) => {
      if (retenable(p.url)) historique?.retenir({ ...p, texte: String(p.texte) });
    },
    "historique.rendrePrive": (p: { espaceId: string }) => historique?.rendrePrive(p.espaceId),
    "historique.rechercher": (p: { texte: string; limite?: number; distinctes?: boolean }) => historique?.rechercher(p.texte, p.limite, p.distinctes) ?? [],
    "historique.recents": () => historique?.recents() ?? [],
    "historique.effacer": (p: { depuis?: string }) => historique?.effacer(p.depuis ? new Date(p.depuis) : undefined),
    "historique.oublierTexte": (p: { url: string; espaceId: string }) => historique?.oublierTexte(p.url, p.espaceId),
    arreter: async () => {
      try {
        await arreter();
      } finally {
        // Exit once the answer (or the error) is flushed: stdout is an asynchronous pipe on macOS.
        setImmediate(() => writeStdout("", () => process.exit(0)));
      }
    },
    "agent.ecrire": (p: { fenetre: string; d: string }) => sessions.ecrire(p.fenetre, p.d),
    "agent.redimensionner": (p: { fenetre: string; taille: TailleTerminal }) => sessions.redimensionner(p.fenetre, p.taille),
    "agent.fermerFenetre": (p: { fenetre: string }) => {
      selections.delete(p.fenetre);
      actives.delete(p.fenetre);
      void sessions.fermerFenetre(p.fenetre);
    },
    prives: (p: { prives: string[]; actifPrive: boolean }) => bridge.setPrivate(p),
    "politique.navigue": (p: { id: string; url: string }) => noyau?.politique.ongletNavigue(p.id, p.url),
    "politique.ferme": (p: { id: string }) => noyau?.politique.ongletFerme(p.id),
    "politique.couper": (p: { id: string; droit?: Parameters<Noyau["politique"]["couper"]>[1] }) => noyau?.politique.couper(p.id, p.droit),
    "agent.envoi": (p: { onglet: OngletInfo | null }) => void (p.onglet && noyau?.politique.interactionUtilisateur(p.onglet)),
    // Opening the panel on a tab gives it to the agent and pre-fills the context, without sending it.
    "agent.panneauOuvert": (p: { fenetre: string; onglet: OngletInfo }) => {
      noyau?.politique.interactionUtilisateur(p.onglet);
      if (sessions.active(p.fenetre)) sessions.ecrire(p.fenetre, prefixeContexte(p.onglet.titre, p.onglet.url));
    },
    // Sent by the chrome on each host start, with the about:addons changes seen while no host ran (applied first:
    // never reinstalled); answered when every granted extension is handled. A failed start is retried by the next one.
    "extensions.pret": async (p: { horsWebaios?: { addonId: string; quoi: "desinstallee" | "desactivee" }[]; plantages?: { addonId?: unknown; le?: unknown }[] }) => {
      for (const c of Array.isArray(p?.plantages) ? p.plantages : []) extensions.plantage(c?.addonId, c?.le);
      for (const h of p?.horsWebaios ?? []) await extensions.horsWebaios(h.addonId, h.quoi);
      return (demarrageExtensions ??= extensions.demarrer().catch((e) => {
        demarrageExtensions = undefined;
        throw e;
      }));
    },
    "extensions.horsWebaios": (p: { addonId: string; quoi: "desinstallee" | "desactivee" }) =>
      extensions.horsWebaios(p.addonId, p.quoi),
    "extensions.aTourne": (p: { addonId: string; profil: string; lisible: boolean }) => extensions.aTourne(p.addonId, p.profil, p.lisible),
    // A content script's message is readable only from a tab the agent can read as it is noted (Electron's
    // ongletLisibleParAgent): asked of the policy here, which knows an agent-opened tab before Firefox hears of it.
    "extensions.console": (p: { addonId?: unknown; m?: unknown; onglet?: { ongletId?: unknown; url?: unknown } | null }) => {
      const o = p?.onglet;
      const lisible = !!o && typeof o.ongletId === "string" && typeof o.url === "string" && noyau?.politique.peutLire({ id: o.ongletId, url: o.url, titre: "", espace: "" }) === true;
      extensions.noterConsole(p?.addonId, p?.m, o ? { lisible } : null);
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
    "extensions.supprimer": (p: { cle?: unknown }) => parCle(p, (cle) => extensions.supprimerPage(cle)),
    "extensions.desactiverPartout": (p: { cle?: unknown }) => parCle(p, (cle) => extensions.desactiverPartout(cle)),
    "extensions.reactiver": (p: { cle?: unknown }) => parCle(p, (cle) => extensions.reactiver(cle)),
    "extensions.couperDeblocage": (p: { cle?: unknown }) => parCle(p, (cle) => extensions.couperDeblocage(cle)),
    "extensions.revoir": (p: { cle?: unknown; fenetre?: unknown }) =>
      parCle(p, (cle) => extensions.revoir(cle, typeof p.fenetre === "string" ? p.fenetre : null)),
    "extensions.toutCouper": (p: { oui?: unknown }) => extensions.toutCouper(p?.oui === true),
    "extensions.installerStore": () => ({ ok: false, erreur: STORE_ABSENT }),
    // The RPC signal is ignored on purpose: the noyau's Menagement hands the lane back (partie=false) when the read has already ended, and rpc.ts drops a late answer.
    "lecture.changerHote": (p: { lecture: string; hote: string }) => bridge.changerHote(p.lecture, p.hote),
    // Tests only: a paced read through a Menagement shared by the calls, as a workflow's web widget does.
    ...(process.env.WEBAIOS_TEST_LECTURE_MENAGEE === "1"
      ? {
          "test.lectureMenagee": ({ url }: { url: string }) =>
            menagementTest.lire(new URL(url).hostname, (ch) => bridge.lirePageInvisible(url, { profil: null, changerHote: ch })),
        }
      : {}),
    ...(process.env.WEBAIOS_HOST_TEST === "1" ? { "debug.log": (p: { texte: string }) => console.log(p.texte) } : {}),
  },
});
const bridge = new RemoteBridge(rpc, historique, (site, url) => sites.adressePermise(site, url));
const menagementTest = new Menagement();
/** A page request on one extension key: a malformed one is refused as text. */
const parCle = <T,>(p: { cle?: unknown } | undefined, f: (cle: string) => T) => (typeof p?.cle === "string" ? f(p.cle) : { ok: false as const, erreur: "Paramètres invalides" });
// Outside the agent's noyau, like the history: granted extensions run even when the noyau does not start.
const extensions = new ExtensionsAgent({ dossier: join(dataDir, "extensions"), dossierAgent: chemins.extensions, rpc });
// Site apps: the Node side (list, memory, deletion); the windows are the chrome's, asked through the RPC.
const sites = createSites({
  chemins,
  dataDir,
  adressesLocales: process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1",
  chrome: {
    ouvrir: (s, cadre, retouches) => rpc.request("sites.ouvrir", [s, cadre, retouches]),
    fermer: (id) => rpc.request("sites.fermer", [id]),
    effacer: (id) => rpc.request("sites.effacer", [id]),
    mettreAJour: (s, retouches) => rpc.request("sites.mettreAJour", [s, retouches]),
    rechargerVue: (id) => rpc.request("sites.rechargerVue", [id]),
    erreurs: (id) => rpc.request("sites.erreurs", [id]),
    vue: (id) => rpc.request("sites.vue", [id]),
    apresAccord: (id, s) => rpc.request("sites.apresAccord", [id, s]),
    rediffuser: (id) => rpc.request("sites.rediffuser", [id]),
    ouvertes: () => rpc.request("sites.ouvertes"),
    accueilChange: (id) => rpc.notify("sites.accueilChange", [id]),
    cherche: (id, oui) => rpc.notify("sites.cherche", [id, oui]),
    avis: (id, a) => rpc.notify("sites.avis", [id, a]),
    adresseChangee: (id, domaines, depart, vers) => rpc.notify("sites.adresseChangee", [id, domaines, depart, vers]),
  },
  // The public read (a throwaway container, no profile): never the app's cookies nor the user's.
  lireLiens: async (page, signal) =>
    (await bridge.lirePageInvisible(page, { profil: null, ...(process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1" ? { adressesLocales: true } : {}), ...(signal ? { signal } : {}) })).liens.map((l) => l.url),
  diffuser: () => rpc.notify("sites.change"),
  preRemplir: (f, t) => sessions.preRemplir(f, t),
  notifierMemoire: (id, message) => rpc.notify("sites.memoire", { id, message }),
  // The agent loses its dev tools on the closed window; the app's accord holds for the conversation, until « Supprimer »
  // (an app made again under the same id asks for its card again).
  surFermee: (id) => noyau?.politique.ongletFerme(`site:${id}`),
  surSupprimee: (id) => noyau?.politique.retirerLectureSite(id),
});
// Actions: the noyau and disk half; the chrome keeps the window state (private spaces, tabs, pace of links).
const actions = createActionsHost({ chemins, dossierActions, noyau: () => noyau, surChange: () => rpc.notify("actions.change") });
// The actions and components folders, watched outside the noyau like Electron's agent.ts: the page lists even without it.
let arretActions: (() => Promise<void>) | undefined;
try {
  arretActions = surveillerActions(chemins, () => rpc.notify("actions.change"));
} catch (e) {
  console.error("[webaios] la surveillance des actions n'a pas démarré :", e);
}
// The chrome may not answer yet (its handlers come up later): it calls "sites.pret" once it does.
void sites.resynchroniser().catch(() => {});
let demarrageExtensions: Promise<void> | undefined;

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (l) => rpc.receive(l))
  .on("close", () => {
    rpc.close("Firefox s'est arrêté");
    // A stop that hangs (docker, a session) must not keep an orphan host alive.
    setTimeout(() => process.exit(0), 5_000).unref();
    void arreter().finally(() => process.exit(0));
  });
