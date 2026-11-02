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

/** Un seul segment de chemin, sans remontée : un nom de fichier ou de dossier de projet. */
const segmentSur = (s: string): boolean => s !== "" && s !== "." && s !== ".." && basename(s) === s && !s.includes("\\");

/** Mêmes éléments, mêmes nombres de fois, dans n'importe quel ordre. */
const memesListes = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Dossier des profils bruts des outils de développement (distinct de `.webaios/profils`, celui des profils d'agent). */
export const DOSSIER_PROFILAGE = "profilage";

/** `.webaios/profilage` ou `projets/<dossier>/.webaios/profilage`, en segments relatifs à la racine. */
const dossierProfilage = (parties: string[]): boolean =>
  parties.every(segmentSur) &&
  ((parties.length === 2 && parties[0] === ".webaios" && parties[1] === DOSSIER_PROFILAGE) ||
    (parties.length === 4 && parties[0] === "projets" && parties[2] === ".webaios" && parties[3] === DOSSIER_PROFILAGE));

const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Référence d'un profil gardé hors de l'espace : `profil:<nom de fichier>`. */
export const PREFIXE_PROFIL_PRIVE = "profil:";

/**
 * Profils bruts des outils de développement, écrits par le navigateur (spec §6). Ce que l'agent a construit va dans
 * l'espace : dans le projet pour une application (`projets/<dossier>/.webaios/profilage`), dans `.webaios/profilage`
 * sinon. Le profil d'un autre site (son tas contient jetons et données personnelles) reste hors du montage, dans
 * `dossierPrive` (le profil du navigateur), et l'agent n'en reçoit qu'une référence `profil:<nom>`. Seuls ces dossiers
 * sont lus ou effacés. L'espace est monté en écriture dans le conteneur : l'agent peut y poser des liens symboliques,
 * donc aucun lien n'est suivi, ni dans les dossiers ni pour le fichier.
 */
export function fichiersProfils(chemins: CheminsEspace, dossierPrive?: string): FichiersProfils {
  const refus = (cheminConteneur: string) => new Error(`Chemin hors des profils : ${cheminConteneur}`);

  /** Descend dans les segments sous la racine réelle sans suivre de lien ; crée les dossiers manquants si `creer`. */
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
    // Un lien posé entre deux vérifications serait vu ici.
    if ((await realpath(courant)) !== courant) throw refus(affiche);
    return courant;
  }

  /** Chemin du conteneur → segments sous la racine, seulement pour un fichier d'un dossier de profilage. */
  const segments = (cheminConteneur: string): string[] => {
    const prefixe = `${CHEMIN_CONTENEUR}/`;
    const normal = posix.normalize(cheminConteneur);
    if (!posix.isAbsolute(cheminConteneur) || !normal.startsWith(prefixe)) throw refus(cheminConteneur);
    const parties = normal.slice(prefixe.length).split("/");
    if (parties.length < 3 || !segmentSur(parties.at(-1)!) || !dossierProfilage(parties.slice(0, -1))) throw refus(cheminConteneur);
    return parties;
  };

  /** Le dossier privé (créé au besoin), sans lien symbolique. */
  async function dossierPriveReel(creer: boolean): Promise<string> {
    if (!dossierPrive) throw new Error("Enregistrement des profils indisponible.");
    if (creer) await mkdir(dossierPrive, { recursive: true, mode: 0o700 });
    return realpath(dossierPrive);
  }

  /** Le fichier, s'il est un vrai fichier (pas un lien) dans un vrai dossier de profilage, ou le dossier privé. */
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
        // « wx » : jamais par-dessus un fichier ou un lien existant.
        await writeFile(join(await dossierPriveReel(true), nom), contenu, { flag: "wx", mode: 0o600 });
        return PREFIXE_PROFIL_PRIVE + nom;
      }
      if (o.application !== undefined && !segmentSur(o.application)) throw new Error(`Dossier d'application invalide : ${o.application}`);
      const parties = o.application === undefined ? [".webaios", DOSSIER_PROFILAGE] : ["projets", o.application, ".webaios", DOSSIER_PROFILAGE];
      const cheminConteneur = `${CHEMIN_CONTENEUR}/${[...parties, nom].join("/")}`;
      const dossier = await descendre(parties, true, cheminConteneur);
      // « wx » : jamais par-dessus un fichier ou un lien existant.
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

/** Le résultat d'une exécution d'action tel que sa page le montre : la page résolue à la lecture. */
export type PageAction = {
  execution: string;
  debut: string;
  fin: string | null;
  saisie: string | null;
  statut: Execution["statut"];
  erreur?: string;
  page: PageRendue | null;
  /** L'action lit avec le compte de l'utilisateur (déclaration actuelle) : les images des résultats restent neutres. */
  compte: boolean;
};

/** Les actions : lancées à la demande, dans leur propre file, résultats et accords hors de l'espace. */
export interface ActionsNoyau {
  lister(): Promise<ActionLue[]>;
  /** Lance l'action (déclencheur « manuelle » par défaut) ; si elle tourne ou attend déjà, rend celle-là (`deja`). */
  lancer(id: string, o: { saisie?: string; declencheur?: Execution["declencheur"] }): LancementAction;
  arreter(id: string): void;
  direct(): EtatActions;
  surDirect(rappel: (e: EtatActions) => void): () => void;
  executions(id: string): Promise<ResumeExecution[]>;
  execution(id: string, execution: string): Promise<Execution | null>;
  /** Le résultat de cette exécution (null : le dernier résultat), sans rien relancer ; null s'il n'y en a pas. */
  page(id: string, execution: string | null): Promise<PageAction | null>;
  /** Comme pour un widget, mais rien n'est lancé : L'utilisateur relance depuis la page. */
  accorder(o: { id: string; profil: string; compte: string[]; publiques: string[] }): Promise<void>;
  /** Retire l'accord et efface exécutions, résultats et mémoire. */
  refuserAccord(id: string): Promise<void>;
  /** Essai du constructeur : une exécution « -essai » qui ne devient pas le dernier résultat. */
  rejouer(id: string, origine: string, depart: string): LancementAction;
  supprimerDonnees(id: string): Promise<void>;
}

export interface Noyau {
  chemins: CheminsEspace;
  actions: ActionsNoyau;
  politique: PolitiqueAcces;
  /** Nom de l'agent du profil de ce noyau (celui qui détient les accès). */
  agent: string;
  etatAtelier(): Promise<EtatAtelier>;
  /** Nouvelle conversation : efface les autorisations. Signaler l'onglet courant (interactionUtilisateur) après. */
  ouvrirSessionAgent(o: { cols: number; rows: number; fenetre?: string }): Promise<SessionAgent>;
  /** Widgets de la page d'accueil, avec leurs données et leur état (rangés hors de l'espace). */
  lireAccueil(): Promise<EtatAccueil>;
  surveillerAccueil(rappel: () => void): () => Promise<void>;
  /** Récolte ce widget tout de suite, après la récolte en cours (déclencheur : « manuelle » par défaut). */
  recolterMaintenant(id: string, declencheur?: Execution["declencheur"]): Promise<EtatWidget & { execution?: string }>;
  /**
   * Essai du constructeur : rejoue le workflow du widget depuis le bloc `depart`, avec les sorties amont de l'exécution
   * `origine`, dans la même file que les récoltes. N'écrit ni données, ni mémoire, ni état : seulement l'exécution d'essai.
   * Exception : un accord perdu pendant l'essai suit le chemin normal du retrait (données effacées, `accord-requis`).
   */
  rejouer(id: string, origine: string, depart: string): Promise<ResultatEssai>;
  /** L'exécution (ou l'essai) qui tourne, ses blocs au fil des traces, et les demandes en attente. */
  direct(): EtatDirect;
  /** Appelé à chaque changement de `direct()` ; rend de quoi se désabonner. */
  surDirect(rappel: (e: EtatDirect) => void): () => void;
  /** IA locale (Kev, Gemma) donnée par le navigateur ; null sans elle. */
  ia: IaLocale | null;
  /**
   * L'utilisateur autorise le widget à lire avec son compte, dans ce profil de connexion. Le navigateur a vérifié avant que ce
   * profil n'est pas celui d'un espace privé. `compte` et `publiques` sont les domaines montrés à l'utilisateur : refusé s'ils ne
   * sont plus exactement ceux de la déclaration (l'agent l'a réécrite entre-temps). Une récolte suit.
   */
  accorder(o: { id: string; profil: string; compte: string[]; publiques: string[] }): Promise<void>;
  /** Retire l'accord et efface les données lues avec : le widget attend un nouvel accord (`accord-requis`). */
  refuserAccord(id: string): Promise<void>;
  arreter(): Promise<void>;
}

/** Point d'entrée unique pour un navigateur (Electron, extension…) : il fournit son pont, le noyau fait le reste. */
export async function creerNoyau(o: {
  pont: PontNavigateur;
  racine?: string;
  executer?: Executeur;
  horloge?: () => Date;
  profilId?: string;
  /** Dossier contenant `modeles/` et `docker/` (par défaut, ceux du paquet). */
  ressources?: string;
  /** Atelier partagé avec le navigateur (qui lance aussi les applications) ; à défaut, le noyau crée le sien. */
  atelier?: Atelier;
  /** Outils MCP des applications (lancer, arrêter, journal). */
  applications?: OutilsApplications;
  /** Ports sur lesquels une démo locale ouverte par l'agent est « construite » (par défaut 5280–5299). */
  portConstruit?: (port: number) => boolean;
  /**
   * Dossier de l'hôte, hors de l'espace monté, pour les profils bruts des sites que l'agent n'a pas construits (le
   * navigateur donne `<profil>/profilage`). Absent, ces profils ne sont pas enregistrés.
   */
  dossierProfilage?: string;
  /** Dossier des données, états et accords des widgets, hors de l'espace (le navigateur donne `<profil>/widgets`). */
  dossierWidgets: string;
  /**
   * Dossier des exécutions, résultats, mémoire et accords des actions, hors de l'espace (le navigateur donne
   * `<profil>/actions`).
   */
  dossierActions: string;
  /** IA locale pour les récoltes ; arrêtée avec le noyau. */
  ia?: IaLocale;
  /** Moteur des workflows, monté dans le conteneur de récolte (par défaut `<ressources>/docker/moteur`). */
  moteur?: string;
  /** Le workflow ouvert dans le constructeur d'une fenêtre (outil MCP `workflow_ouvert`). */
  workflowOuvert?: (fenetre: string) => WorkflowOuvert | null;
  /** Appelé après chaque écriture de l'état ou des données d'un widget, et après un accord ou son retrait. */
  surChange?: () => void;
  /** Tests seulement : les récoltes peuvent lire des adresses locales (le serveur de test). */
  adressesLocales?: boolean;
  /** Tests seulement : la base des recherches DuckDuckGo (une page enregistrée servie en local). */
  urlRecherche?: string;
  /** Notification de fin d'une veille qui a de nouveaux éléments (le navigateur la montre, voir OptionsPlanificateur). */
  notifier?: (n: NotificationWidget) => void;
  /** Outils MCP des extensions (fournis par le navigateur). */
  extensions?: OutilsExtensions;
  /** Outils MCP des applis de site (fournis par le navigateur). */
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
  // Une action supprimée (ou mise à la corbeille) depuis le dernier lancement : ses données et son accord partent.
  await oublierActionsDisparues(chemins, dossierActions).catch((e) => console.error("[webaios] oubli des actions disparues :", e));
  const ia = o.ia ?? null;
  // Accès propre à ce noyau, fermé avec lui : une récolte encore en vol à l'arrêt ne relance pas Kev.
  const accesIa = ia?.acces() ?? null;
  // Un seul répartiteur pour les widgets et les actions : les appels d'une action passent avant ceux des widgets.
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
  // Lus par l'agent via ses outils MCP. Un widget dont la déclaration est illisible, ou qui a un accord enregistré, compte
  // comme lisant avec le compte de l'utilisateur : ses données ont pu être récoltées avec.
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
  // Le navigateur garde ses outils de développement d'un noyau à l'autre : celui-ci prend les siens, ce qui révoque ceux
  // d'un noyau précédent (ses appels en retard sont refusés, ses attachements tombent).
  const proprietaire = o.pont.outilsDev?.proprietaire?.();
  const outilsDev = proprietaire ?? o.pont.outilsDev;
  const jeton = genererJeton();
  // Lues par l'agent via ses outils MCP. Une action illisible, ou qui a un accord enregistré, compte comme lisant avec le
  // compte de l'utilisateur. `actions` est défini plus bas : ces fonctions ne servent qu'une fois le serveur lancé.
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
    // Configs de session laissées par un plantage : leurs jetons ne valent plus rien.
    // Un échec n'empêche pas de démarrer : des jetons morts sont inoffensifs.
    await rm(dossierSessions(chemins), { recursive: true, force: true }).catch((e) => console.error("[webaios] purge des configs de session :", e));
    await ecrireConfigMcp(chemins, profil.configMcp, { url: serveur.urlConteneur, jeton });
  } catch (e) {
    await serveur.arreter();
    proprietaire?.liberer();
    throw e;
  }

  // La navigation ne doit jamais attendre Docker (spec §9) : la première construction d'image prend
  // des minutes, et un échec (port occupé…) ne concerne que l'agent.
  const atelier = o.atelier ?? new Atelier({ chemins, executer, ...(o.ressources ? { dossierDocker: join(o.ressources, "docker") } : {}) });
  // Le conteneur se prépare dès le lancement. S'il échoue, la première session rend cet échec plutôt que de tout
  // reconstruire aussitôt ; les suivantes (Réessayer) tentent à nouveau. Réussi, il est revérifié (sonde rapide).
  // Avant toute session, les agents laissés par une app précédente sont arrêtés.
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
    // Gardé à part de `demarrage` (qu'ouvrirSessionAgent remet à null) : les récoltes attendent le premier démarrage.
    pret: atelierPret,
    ...(o.horloge ? { horloge: o.horloge } : {}),
    ...(o.adressesLocales ? { adressesLocales: true } : {}),
    // Un seul ménagement pour toute l'application (tous les noyaux, essais compris) : une recherche à la fois, une
    // lecture à la fois par hôte, même pendant les 15 s où l'ancien noyau s'arrête au changement de profil.
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
      // Illisible, ou un accord encore enregistré (réécrite sans compte, ses résultats ont pu être lus avec) : compte comme
      // lisant avec le compte (le plus prudent, comme les outils MCP et les images). Accords illisibles : de même.
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

  // Nettoyages des sessions avec fenêtre encore ouvertes, faits aussi à l'arrêt du noyau.
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
      // Nouvelle conversation : plus aucune autorisation. Les sessions partagent le serveur MCP et donc la politique :
      // une session d'une autre fenêtre perd aussi ses accès (elle redemandera), plutôt que d'en hériter.
      politique.reinitialiser();
      const id = randomBytes(8).toString("hex");
      // Avec une fenêtre : un jeton et une config à elle, pour que `workflow_ouvert` sache laquelle parle (sans fenêtre,
      // CLI de dev : la config principale).
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
      // La récolte prend du temps : elle suit en arrière-plan et signale elle-même ses changements.
      planificateur.recolterMaintenant(id).catch((e) => console.error("[webaios] récolte après accord :", e));
    },
    async refuserAccord(id) {
      await retirerAccord(dossierWidgets, id);
      // Les données lues avec ce compte partent avec l'accord : sans lui, plus rien ne les protège (compte retiré…).
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
      // Plus aucun accès : les cartes encore affichées sont retirées, et une réponse tardive n'accorde rien.
      politique.reinitialiser();
      await Promise.all([planificateur.arreter(), fileActions.arreterTout()]);
      await accesIa?.fermer().catch((e) => console.error("[webaios] arrêt de l'IA locale :", e));
      await serveur.arreter();
      proprietaire?.liberer();
    },
  };
}
