import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { CHEMIN_CONTENEUR, cheminConfigSession, cheminDansConteneur, dossierSessions, cheminsEspace, type CheminsEspace } from "./chemins.js";
import { initialiserEspace } from "./espace/initialiser.js";
import { lireAccueil } from "./accueil/lire.js";
import type { EtatAccueil, EtatWidget, WidgetLu } from "./accueil/schemas.js";
import { ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "./accueil/donnees.js";
import { surveillerAccueil } from "./accueil/surveiller.js";
import { chargerProfils, construireCommande } from "./profils/profil.js";
import { ecrireConfigMcp, ecrireConfigSession } from "./profils/config-mcp.js";
import { Atelier, DOSSIER_DOCKER_PAR_DEFAUT, type EtatAtelier } from "./conteneur/atelier.js";
import { executeurParDefaut, type Executeur } from "./conteneur/executeur.js";
import { SessionAgent } from "./pty/session.js";
import { PolitiqueAcces } from "./acces/politique.js";
import type { OngletInfo, PontNavigateur } from "./mcp/pont.js";
import type { OutilsExtensions } from "./mcp/extensions.js";
import { demarrerServeurMcp, genererJeton, type OutilsActions, type OutilsApplications, type OutilsSites, type OutilsWidgets, type WorkflowOuvert } from "./mcp/serveur.js";
import type { FichiersProfils } from "./mcp/outils-dev.js";
import { SuiviOutilsDev } from "./outils-dev/suivi.js";
import type { IaLocale } from "./ia/ia-locale.js";
import { creerRepartiteurIa } from "./ia/repartiteur.js";
import { ID_EXECUTION, listerExecutions, lireExecution, type Execution } from "./workflows/executions.js";
import { MENAGEMENT_PAR_DEFAUT } from "./workflows/executer.js";
import { PlanificateurWidgets, type EtatDirect, type ResultatEssai } from "./widgets/planificateur.js";
import type { NotificationWidget } from "./widgets/nouveautes.js";
import { accordRequis } from "./widgets/recolte.js";
import { accorder, lireAccords, retirerAccord } from "./widgets/accords.js";
import { lireAction, lireActions, type ActionLue } from "./actions/lire.js";
import { dernierResultat, lireResultat, oublierActionsDisparues, supprimerDonneesAction } from "./actions/donnees.js";
import { FileActions, type EtatActions, type LancementAction } from "./actions/file.js";
import { ID_ACTION } from "./actions/schemas.js";
import { COMPOSANTS_INTEGRES } from "./pages/catalogue.js";
import { lireComposantsAgent } from "./pages/composants-agent.js";
import { resoudrePage, type PageRendue } from "./pages/resoudre.js";
import type { ResumeExecution } from "./workflows/executions.js";

export class ErreurAtelier extends Error {
  constructor(readonly etat: EtatAtelier, detail?: string) {
    super(detail ?? (etat === "docker-absent" ? "Docker n'est pas lancé" : `Conteneur indisponible (${etat})`));
    this.name = "ErreurAtelier";
  }
}

/** A single path segment, no climbing up: a file or project folder name. */
const segmentSur = (s: string): boolean => s !== "" && s !== "." && s !== ".." && basename(s) === s && !s.includes("\\");

/** Same items, same numbers of times, in any order. */
const memesListes = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Folder of the dev tools' raw profiles (distinct from `.webaios/profils`, that of the agent profiles). */
export const DOSSIER_PROFILAGE = "profilage";

/** `.webaios/profilage` or `projets/<dossier>/.webaios/profilage`, in segments relative to the root. */
const dossierProfilage = (parties: string[]): boolean =>
  parties.every(segmentSur) &&
  ((parties.length === 2 && parties[0] === ".webaios" && parties[1] === DOSSIER_PROFILAGE) ||
    (parties.length === 4 && parties[0] === "projets" && parties[2] === ".webaios" && parties[3] === DOSSIER_PROFILAGE));

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Reference of a profile kept outside the workspace: `profil:<file name>`. */
export const PREFIXE_PROFIL_PRIVE = "profil:";

/**
 * Raw profiles of the dev tools, written by the browser (spec §6). What the agent built goes into
 * the workspace: in the project for an application (`projets/<dossier>/.webaios/profilage`), in `.webaios/profilage`
 * otherwise. The profile of another site (its heap contains tokens and personal data) stays outside the mount, in
 * `dossierPrive` (the browser's profile), and the agent only gets a `profil:<nom>` reference. Only these folders
 * are read or erased. The workspace is mounted writable in the container: the agent can put symbolic links in it,
 * so no link is followed, neither in the folders nor for the file.
 */
export function fichiersProfils(chemins: CheminsEspace, dossierPrive?: string): FichiersProfils {
  const refus = (cheminConteneur: string) => new Error(`Chemin hors des profils : ${cheminConteneur}`);

  /** Descends into the segments under the real root without following a link; creates the missing folders if `creer`. */
  async function descendre(parties: string[], creer: boolean, affiche: string): Promise<string> {
    let courant = await realpath(chemins.racine);
    for (const partie of parties) {
      courant = join(courant, partie);
      let info = await lstat(courant).catch((e) => {
        if (code(e) === "ENOENT" && creer) return null;
        throw code(e) === "ENOENT" ? new Error(`Profil introuvable : ${affiche}`) : refus(affiche);
      });
      if (!info) {
        await mkdir(courant).catch((e) => {
          if (code(e) !== "EEXIST") throw e;
        });
        info = await lstat(courant);
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw refus(affiche);
    }
    // A link placed between two checks would be seen here.
    if ((await realpath(courant)) !== courant) throw refus(affiche);
    return courant;
  }

  /** Container path → segments under the root, only for a file of a profiling folder. */
  const segments = (cheminConteneur: string): string[] => {
    const prefixe = `${CHEMIN_CONTENEUR}/`;
    const normal = posix.normalize(cheminConteneur);
    if (!posix.isAbsolute(cheminConteneur) || !normal.startsWith(prefixe)) throw refus(cheminConteneur);
    const parties = normal.slice(prefixe.length).split("/");
    if (parties.length < 3 || !segmentSur(parties.at(-1)!) || !dossierProfilage(parties.slice(0, -1))) throw refus(cheminConteneur);
    return parties;
  };

  /** The private folder (created if needed), without a symbolic link. */
  async function dossierPriveReel(creer: boolean): Promise<string> {
    if (!dossierPrive) throw new Error("Enregistrement des profils indisponible.");
    if (creer) await mkdir(dossierPrive, { recursive: true, mode: 0o700 });
    return realpath(dossierPrive);
  }

  /** The file, if it is a real file (not a link) in a real profiling folder, or the private folder. */
  async function fichierExistant(cheminConteneur: string): Promise<string> {
    let fichier: string;
    if (cheminConteneur.startsWith(PREFIXE_PROFIL_PRIVE)) {
      const nom = cheminConteneur.slice(PREFIXE_PROFIL_PRIVE.length);
      if (!segmentSur(nom)) throw refus(cheminConteneur);
      const dossier = await dossierPriveReel(false).catch((e: unknown) => {
        throw code(e) === "ENOENT" ? new Error(`Profil introuvable : ${cheminConteneur}`) : e;
      });
      fichier = join(dossier, nom);
    } else {
      const parties = segments(cheminConteneur);
      const dossier = await descendre(parties.slice(0, -1), false, cheminConteneur);
      fichier = join(dossier, parties.at(-1)!);
    }
    const info = await lstat(fichier).catch(() => {
      throw new Error(`Profil introuvable : ${cheminConteneur}`);
    });
    if (!info.isFile()) throw refus(cheminConteneur);
    return fichier;
  }

  return {
    async ecrireProfil(o, nom, contenu, construite) {
      if (!segmentSur(nom)) throw new Error(`Nom de profil invalide : ${nom}`);
      if (!construite) {
        // « wx »: never over an existing file or link.
        await writeFile(join(await dossierPriveReel(true), nom), contenu, { flag: "wx", mode: 0o600 });
        return PREFIXE_PROFIL_PRIVE + nom;
      }
      if (o.application !== undefined && !segmentSur(o.application)) throw new Error(`Dossier d'application invalide : ${o.application}`);
      const parties = o.application === undefined ? [".webaios", DOSSIER_PROFILAGE] : ["projets", o.application, ".webaios", DOSSIER_PROFILAGE];
      const cheminConteneur = `${CHEMIN_CONTENEUR}/${[...parties, nom].join("/")}`;
      const dossier = await descendre(parties, true, cheminConteneur);
      // « wx »: never over an existing file or link.
      await writeFile(join(dossier, nom), contenu, { flag: "wx" });
      return cheminConteneur;
    },
    async lireProfil(cheminConteneur) {
      const fichier = await fichierExistant(cheminConteneur);
      const f = await open(fichier, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
        throw refus(cheminConteneur);
      });
      try {
        if (!(await f.stat()).isFile()) throw refus(cheminConteneur);
        return await f.readFile("utf8");
      } finally {
        await f.close();
      }
    },
    async supprimerProfil(cheminConteneur) {
      const fichier = await fichierExistant(cheminConteneur).catch((e: Error) => {
        if (e.message.startsWith("Profil introuvable")) return null;
        throw e;
      });
      if (fichier) await unlink(fichier).catch(() => {});
    },
  };
}

/** An action run's result as its page shows it: the page resolved at read time. */
export type PageAction = {
  execution: string;
  debut: string;
  fin: string | null;
  saisie: string | null;
  statut: Execution["statut"];
  erreur?: string;
  page: PageRendue | null;
  /** The action reads with the user's account (current declaration): the results' images stay neutral. */
  compte: boolean;
};

/** The actions: launched on demand, in their own queue, results and grants outside the workspace. */
export interface ActionsNoyau {
  lister(): Promise<ActionLue[]>;
  /** Launches the action (trigger « manuelle » by default); if it is running or waiting already, returns that one (`deja`). */
  lancer(id: string, o: { saisie?: string; declencheur?: Execution["declencheur"] }): LancementAction;
  arreter(id: string): void;
  direct(): EtatActions;
  surDirect(rappel: (e: EtatActions) => void): () => void;
  executions(id: string): Promise<ResumeExecution[]>;
  execution(id: string, execution: string): Promise<Execution | null>;
  /** The result of this run (null: the last result), without relaunching anything; null if there is none. */
  page(id: string, execution: string | null): Promise<PageAction | null>;
  /** As for a widget, but nothing is launched: the user relaunches from the page. */
  accorder(o: { id: string; profil: string; compte: string[]; publiques: string[] }): Promise<void>;
  /** Withdraws the grant and erases runs, results and memory. */
  refuserAccord(id: string): Promise<void>;
  /** Builder try: a « -essai » run that does not become the last result. */
  rejouer(id: string, origine: string, depart: string): LancementAction;
  supprimerDonnees(id: string): Promise<void>;
}

export interface Noyau {
  chemins: CheminsEspace;
  actions: ActionsNoyau;
  politique: PolitiqueAcces;
  /** Name of the agent of this kernel's profile (the one that holds the accesses). */
  agent: string;
  etatAtelier(): Promise<EtatAtelier>;
  /** New conversation: erases the authorizations. Signal the current tab (interactionUtilisateur) afterwards. */
  ouvrirSessionAgent(o: { cols: number; rows: number; fenetre?: string }): Promise<SessionAgent>;
  /** Widgets of the home page, with their data and state (stored outside the workspace). */
  lireAccueil(): Promise<EtatAccueil>;
  surveillerAccueil(rappel: () => void): () => Promise<void>;
  /** Harvests this widget right away, after the harvest in progress (trigger: « manuelle » by default). */
  recolterMaintenant(id: string, declencheur?: Execution["declencheur"]): Promise<EtatWidget & { execution?: string }>;
  /**
   * Builder try: replays the widget's workflow from block `depart`, with the upstream outputs of run
   * `origine`, in the same queue as the harvests. Writes neither data, nor memory, nor state: only the try run.
   * Exception: a grant lost during the try follows the normal withdrawal path (data erased, `accord-requis`).
   */
  rejouer(id: string, origine: string, depart: string): Promise<ResultatEssai>;
  /** The run (or try) that is running, its blocks along the traces, and the waiting requests. */
  direct(): EtatDirect;
  /** Called at each change of `direct()`; returns a way to unsubscribe. */
  surDirect(rappel: (e: EtatDirect) => void): () => void;
  /** Local AI (Kev, Gemma) given by the browser; null without it. */
  ia: IaLocale | null;
  /**
   * The user authorizes the widget to read with their account, in this login profile. The browser checked beforehand that this
   * profile is not that of a private space. `compte` and `publiques` are the domains shown to the user: refused if they are no
   * longer exactly those of the declaration (the agent rewrote it meanwhile). A harvest follows.
   */
  accorder(o: { id: string; profil: string; compte: string[]; publiques: string[] }): Promise<void>;
  /** Withdraws the grant and erases the data read with it: the widget waits for a new grant (`accord-requis`). */
  refuserAccord(id: string): Promise<void>;
  arreter(): Promise<void>;
}

/** The single entry point for a browser: it gives its bridge, the noyau does the rest. */
export async function creerNoyau(o: {
  pont: PontNavigateur;
  racine?: string;
  executer?: Executeur;
  horloge?: () => Date;
  profilId?: string;
  /** Folder containing `modeles/` and `docker/` (by default, those of the package). */
  ressources?: string;
  /** Workshop shared with the browser (which also launches the applications); otherwise, the kernel creates its own. */
  atelier?: Atelier;
  /** MCP tools of the applications (launch, stop, log). */
  applications?: OutilsApplications;
  /** Ports on which a local demo opened by the agent is « built » (by default those of the container, plagePortsConteneur). */
  portConstruit?: (port: number) => boolean;
  /**
   * Host folder, outside the mounted workspace, for the raw profiles of the sites the agent did not build (the
   * browser gives `<profil>/profilage`). Absent, these profiles are not saved.
   */
  dossierProfilage?: string;
  /** Folder of the widgets' data, states and grants, outside the workspace (the browser gives `<profil>/widgets`). */
  dossierWidgets: string;
  /**
   * Folder of the actions' runs, results, memory and grants, outside the workspace (the browser gives
   * `<profil>/actions`).
   */
  dossierActions: string;
  /** Local AI for the harvests; stopped with the kernel. */
  ia?: IaLocale;
  /** Workflow engine, mounted in the harvest container (by default `<ressources>/docker/moteur`). */
  moteur?: string;
  /** The workflow open in a window's builder (MCP tool `workflow_ouvert`). */
  workflowOuvert?: (fenetre: string) => WorkflowOuvert | null;
  /** Called after each write of a widget's state or data, and after a grant or its withdrawal. */
  surChange?: () => void;
  /** Tests only: the harvests may read local addresses (the test server). */
  adressesLocales?: boolean;
  /** Tests only: the base of the DuckDuckGo searches (a recorded page served locally). */
  urlRecherche?: string;
  /** End notification of a watch that has new items (the browser shows it, see OptionsPlanificateur). */
  notifier?: (n: NotificationWidget) => void;
  /** MCP tools of the extensions (provided by the browser). */
  extensions?: OutilsExtensions;
  /** MCP tools of the site apps (provided by the browser). */
  sites?: OutilsSites;
}): Promise<Noyau> {
  const chemins = cheminsEspace(o.racine);
  const executer = o.executer ?? executeurParDefaut;
  await initialiserEspace(chemins, o.ressources ? join(o.ressources, "modeles") : undefined);

  const profilId = o.profilId ?? "claude";
  const profil = (await chargerProfils(chemins)).profils.find((p) => p.id === profilId);
  if (!profil) throw new Error(`Profil d'agent inconnu : ${profilId}`);

  const politique = new PolitiqueAcces(o.portConstruit ? { portConstruit: o.portConstruit } : {});
  const { dossierWidgets } = o;
  const { dossierActions } = o;
  // An action deleted (or put in the trash) since the last launch: its data and grant go.
  await oublierActionsDisparues(chemins, dossierActions).catch((e) => console.error("[webaios] oubli des actions disparues :", e));
  const ia = o.ia ?? null;
  // Access specific to this kernel, closed with it: a harvest still in flight at shutdown does not relaunch Kev.
  const accesIa = ia?.acces() ?? null;
  // A single dispatcher for the widgets and the actions: an action's calls go before those of the widgets.
  const repartiteurIa = accesIa ? creerRepartiteurIa(accesIa) : null;
  const signaler = () => {
    try {
      o.surChange?.();
    } catch (e) {
      console.error("[webaios] rappel des widgets :", e);
    }
  };
  const widget = async (id: string): Promise<WidgetLu | undefined> =>
    (await lireAccueil(chemins, dossierWidgets)).widgets.find((w) => w.id === id);
  // Read by the agent through its MCP tools. A widget whose declaration is unreadable, or that has a recorded grant, counts
  // as reading with the user's account: its data may have been harvested with it.
  const outilsWidgets: OutilsWidgets = {
    async lire(id) {
      const w = await widget(id);
      if (!w) return null;
      const accord = (await lireAccords(dossierWidgets))[id] !== undefined;
      if ("erreur" in w) return { nom: id, compte: true, donnees: await lireDonnees(dossierWidgets, id) };
      return { nom: w.declaration.nom, compte: accord || w.declaration.sources.compte.length > 0, donnees: w.donnees };
    },
    recolter: (id) => planificateur.recolterMaintenant(id, "agent"),
    executions: (id) => listerExecutions(join(dossierWidgets, id)),
    execution: (id, execution) => lireExecution(join(dossierWidgets, id), execution),
  };
  // The browser keeps its dev tools from one kernel to the next: this one takes its own, which revokes those
  // of a previous kernel (its late calls are refused, its attachments drop).
  const proprietaire = o.pont.outilsDev?.proprietaire?.();
  const outilsDev = proprietaire ?? o.pont.outilsDev;
  const jeton = genererJeton();
  // Read by the agent through its MCP tools. An unreadable action, or one that has a recorded grant, counts as reading with the
  // user's account. `actions` is defined further down: these functions are only used once the server is launched.
  const outilsActions: OutilsActions = {
    async lire(id) {
      const a = await lireAction(chemins, id);
      if (!a) return null;
      const accord = (await lireAccords(dossierActions))[id] !== undefined;
      if ("erreur" in a) return { nom: id, compte: true, saisie: null };
      return { nom: a.declaration.nom, compte: accord || a.declaration.sources.compte.length > 0, saisie: a.declaration.saisie?.libelle ?? null };
    },
    lancer: (id, saisie) => actions.lancer(id, { ...(saisie !== undefined ? { saisie } : {}), declencheur: "agent" }).fin,
    executions: (id) => actions.executions(id),
    async execution(id, execution) {
      const e = await actions.execution(id, execution);
      if (!e) return null;
      const r = await lireResultat(dossierActions, id, execution);
      return { ...e, plan: r?.plan ?? null };
    },
  };
  const serveur = await demarrerServeurMcp({
    pont: o.pont,
    politique,
    jeton,
    agent: profil.nom,
    profils: fichiersProfils(chemins, o.dossierProfilage),
    ...(outilsDev ? { outilsDev } : {}),
    ...(o.applications ? { applications: o.applications } : {}),
    widgets: outilsWidgets,
    actions: outilsActions,
    ...(o.workflowOuvert ? { workflowOuvert: o.workflowOuvert } : {}),
    ...(o.extensions ? { extensions: o.extensions } : {}),
    ...(o.sites ? { sites: o.sites } : {}),
  });
  try {
    // Session configs left by a crash: their tokens are worth nothing any more.
    // A failure does not prevent starting: dead tokens are harmless.
    await rm(dossierSessions(chemins), { recursive: true, force: true }).catch((e) => console.error("[webaios] purge des configs de session :", e));
    await ecrireConfigMcp(chemins, profil.configMcp, { url: serveur.urlConteneur, jeton });
  } catch (e) {
    await serveur.arreter();
    proprietaire?.liberer();
    throw e;
  }

  // Navigation must never wait for Docker (spec §9): the first image build takes
  // minutes, and a failure (port in use…) only concerns the agent.
  const atelier = o.atelier ?? new Atelier({ chemins, executer, ...(o.ressources ? { dossierDocker: join(o.ressources, "docker") } : {}) });
  // The container is prepared from launch. If it fails, the first session returns this failure rather than rebuilding
  // everything right away; the following ones (Réessayer) try again. Once successful, it is re-checked (quick probe).
  // Before any session, the agents left by a previous app are stopped.
  const atelierPret = atelier.assurerDemarre().then(async (etat) => {
    if (etat === "demarre") await atelier.arreterSessionsOrphelines();
    return etat;
  });
  atelierPret.catch(() => {});
  let demarrage: Promise<EtatAtelier> | null = atelierPret;
  const moteur = o.moteur ?? (o.ressources ? join(o.ressources, "docker", "moteur") : join(DOSSIER_DOCKER_PAR_DEFAUT, "moteur"));
  const abonnesDirect = new Set<(e: EtatDirect) => void>();
  const planificateur = new PlanificateurWidgets({
    chemins,
    dossierWidgets,
    moteur,
    atelier,
    pont: o.pont,
    ia: accesIa,
    ...(repartiteurIa ? { repartiteur: repartiteurIa } : {}),
    surChange: signaler,
    surDirect(e) {
      for (const rappel of abonnesDirect) {
        try {
          rappel(e);
        } catch (err) {
          console.error("[webaios] suivi en direct :", err);
        }
      }
    },
    // Kept apart from `demarrage` (which ouvrirSessionAgent resets to null): the harvests wait for the first startup.
    pret: atelierPret,
    ...(o.horloge ? { horloge: o.horloge } : {}),
    ...(o.adressesLocales ? { adressesLocales: true } : {}),
    // A single pacing for the whole application (all kernels, tries included): one search at a time, one
    // read at a time per host, even during the 15 s when the old kernel stops at the profile change.
    menagement: MENAGEMENT_PAR_DEFAUT,
    ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
    ...(o.notifier ? { notifier: o.notifier } : {}),
  });
  await planificateur.demarrer();
  const abonnesActions = new Set<(e: EtatActions) => void>();
  const fileActions = new FileActions({
    chemins,
    dossierActions,
    moteur,
    atelier,
    pont: o.pont,
    repartiteur: repartiteurIa,
    pret: atelierPret,
    ...(o.horloge ? { horloge: o.horloge } : {}),
    ...(o.adressesLocales ? { adressesLocales: true } : {}),
    menagement: MENAGEMENT_PAR_DEFAUT,
    ...(o.urlRecherche !== undefined ? { urlRecherche: o.urlRecherche } : {}),
    surDirect(e) {
      for (const rappel of abonnesActions) {
        try {
          rappel(e);
        } catch (err) {
          console.error("[webaios] suivi des actions :", err);
        }
      }
    },
  });
  const actions: ActionsNoyau = {
    lister: () => lireActions(chemins),
    lancer: (id, l) => fileActions.lancer(id, { saisie: l.saisie ?? null, declencheur: l.declencheur ?? "manuelle" }),
    arreter: (id) => void fileActions.arreter(id),
    direct: () => fileActions.direct(),
    surDirect(rappel) {
      abonnesActions.add(rappel);
      return () => void abonnesActions.delete(rappel);
    },
    executions: async (id) => (ID_ACTION.test(id) ? listerExecutions(join(dossierActions, id)) : []),
    execution: async (id, execution) => (ID_ACTION.test(id) && ID_EXECUTION.test(execution) ? lireExecution(join(dossierActions, id), execution) : null),
    async page(id, execution) {
      if (execution !== null && !ID_EXECUTION.test(execution)) return null;
      const action = await lireAction(chemins, id);
      if (!action) return null;
      const r = execution === null ? await dernierResultat(dossierActions, id) : await lireResultat(dossierActions, id, execution);
      const e = await lireExecution(join(dossierActions, id), r?.execution ?? execution ?? "");
      if (!e) return null;
      // Unreadable, or a grant still recorded (rewritten without account, its results may have been read with it): counts as
      // reading with the account (the most cautious, like the MCP tools and the images). Unreadable grants: same.
      const accords = await lireAccords(dossierActions).catch(() => null);
      const compte = "erreur" in action || action.declaration.sources.compte.length > 0 || !accords || Object.hasOwn(accords, id);
      const catalogue = [...COMPOSANTS_INTEGRES, ...(await lireComposantsAgent(chemins.composants)).valides];
      return {
        execution: e.id,
        debut: e.debut,
        fin: e.fin,
        saisie: r?.saisie ?? e.saisie ?? null,
        statut: e.statut,
        ...(e.erreur !== undefined ? { erreur: e.erreur } : {}),
        page: r ? resoudrePage(r.plan ?? { blocs: [] }, r.resultats, { compte, catalogue, secours: r.secours }) : null,
        compte,
      };
    },
    async accorder({ id, profil: nomProfil, compte: montres, publiques: publiquesMontrees }) {
      const a = await lireAction(chemins, id);
      if (!a) throw new Error(`Action inconnue : ${id}`);
      if ("erreur" in a) throw new Error(`Action illisible : ${a.erreur}`);
      const { compte, publiques } = a.declaration.sources;
      if (!compte.length) throw new Error(`L'action ${id} ne lit pas avec un compte`);
      if (!memesListes(compte, montres) || !memesListes(publiques, publiquesMontrees)) {
        throw new Error(`La déclaration de l'action ${id} a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.`);
      }
      await accorder(dossierActions, id, { domaines: [...compte].sort(), publiques: [...publiques].sort(), profil: nomProfil });
    },
    async refuserAccord(id) {
      await retirerAccord(dossierActions, id);
      await supprimerDonneesAction(dossierActions, id);
    },
    rejouer: (id, origine, depart) => fileActions.essayer(id, origine, depart),
    supprimerDonnees: (id) => supprimerDonneesAction(dossierActions, id),
  };
  const pont = o.pont;
  const suivi = outilsDev ? new SuiviOutilsDev(politique, outilsDev, () => pont.listerOnglets()) : null;

  // Cleanups of the sessions with a window still open, also done at the kernel's shutdown.
  const sessionsOuvertes = new Set<() => Promise<void>>();

  return {
    chemins,
    actions,
    politique,
    agent: profil.nom,
    etatAtelier: () => atelier.etat(),
    async ouvrirSessionAgent({ cols, rows, fenetre }) {
      const premier = demarrage;
      demarrage = null;
      const tentative = premier ? premier.then(() => atelier.assurerDemarre()) : atelier.assurerDemarre();
      let etat: EtatAtelier;
      try {
        etat = await tentative;
      } catch (e) {
        throw new ErreurAtelier("absent", (e as Error).message);
      }
      if (etat !== "demarre") throw new ErreurAtelier(etat);
      // New conversation: no authorization any more. The sessions share the MCP server and therefore the policy:
      // a session of another window also loses its accesses (it will ask again), rather than inheriting them.
      politique.reinitialiser();
      const id = randomBytes(8).toString("hex");
      // With a window: its own token and config, so that `workflow_ouvert` knows which one speaks (without a window,
      // dev CLI: the main config).
      let jetonSession: string | undefined;
      const configSession = cheminConfigSession(chemins, id);
      const nettoyer = (): Promise<void> => {
        if (jetonSession === undefined) return Promise.resolve();
        serveur.fermerSession(jetonSession);
        jetonSession = undefined;
        return rm(configSession, { force: true }).catch((e) => console.error("[webaios] suppression de la config de session :", e));
      };
      try {
        if (fenetre !== undefined) {
          jetonSession = serveur.ouvrirSession(fenetre);
          await ecrireConfigSession(chemins, profil.configMcp, { url: serveur.urlConteneur, jeton: jetonSession }, id);
        }
        const commande = construireCommande(profil, "interactif", {
          mcpConfig: cheminDansConteneur(fenetre !== undefined ? configSession : chemins.configMcp, chemins),
        });
        const session = SessionAgent.demarrer(atelier.commandeSession(id, commande), { cols, rows, arreterDistant: () => atelier.arreterSession(id) });
        sessionsOuvertes.add(nettoyer);
        session.surFin(() => {
          sessionsOuvertes.delete(nettoyer);
          void nettoyer();
        });
        return session;
      } catch (e) {
        await nettoyer();
        throw e;
      }
    },
    lireAccueil: () => lireAccueil(chemins, dossierWidgets),
    surveillerAccueil: (rappel) => surveillerAccueil(chemins, rappel),
    recolterMaintenant: (id, declencheur) => planificateur.recolterMaintenant(id, declencheur),
    rejouer: (id, origine, depart) => planificateur.rejouer(id, origine, depart),
    direct: () => planificateur.direct(),
    surDirect(rappel) {
      abonnesDirect.add(rappel);
      return () => void abonnesDirect.delete(rappel);
    },
    ia,
    async accorder({ id, profil: nomProfil, compte: montres, publiques: publiquesMontrees }) {
      const w = await widget(id);
      if (!w) throw new Error(`Widget inconnu : ${id}`);
      if ("erreur" in w) throw new Error(`Widget illisible : ${w.erreur}`);
      const { compte, publiques } = w.declaration.sources;
      if (!compte.length) throw new Error(`Le widget ${id} ne lit pas avec un compte`);
      if (!memesListes(compte, montres) || !memesListes(publiques, publiquesMontrees)) {
        throw new Error(`La déclaration du widget ${id} a changé depuis l'affichage de la demande : rien n'est accordé, relis la nouvelle demande.`);
      }
      await accorder(dossierWidgets, id, { domaines: [...compte].sort(), publiques: [...publiques].sort(), profil: nomProfil });
      signaler();
      // The harvest takes time: it follows in the background and reports its own changes.
      planificateur.recolterMaintenant(id).catch((e) => console.error("[webaios] récolte après accord :", e));
    },
    async refuserAccord(id) {
      await retirerAccord(dossierWidgets, id);
      // The data read with this account goes with the grant: without it, nothing protects it any more (account removed…).
      await supprimerDonnees(dossierWidgets, id);
      const w = await widget(id);
      if (w && !("erreur" in w) && w.declaration.sources.compte.length) {
        const avant = await lireEtatWidget(dossierWidgets, id);
        await ecrireEtatWidget(dossierWidgets, id, {
          statut: "accord-requis",
          derniereMaj: avant.derniereMaj,
          derniereTentative: avant.derniereTentative,
          erreur: accordRequis(w.declaration),
          erreurNoyau: true,
        });
      }
      signaler();
    },
    async arreter() {
      suivi?.arreter();
      await Promise.all([...sessionsOuvertes].map((nettoyer) => nettoyer()));
      sessionsOuvertes.clear();
      // No access at all: the cards still displayed are removed, and a late answer grants nothing.
      politique.reinitialiser();
      await Promise.all([planificateur.arreter(), fileActions.arreterTout()]);
      await accesIa?.fermer().catch((e) => console.error("[webaios] arrêt de l'IA locale :", e));
      await serveur.arreter();
      proprietaire?.liberer();
    },
  };
}
