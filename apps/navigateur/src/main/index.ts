import "./garde-exceptions"; // en premier, avant toute dépendance
import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, session, shell, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import {
  contexteHistorique,
  profilsChanges,
  profilDOnglet,
  type Decision,
  type Issue,
  type Demande,
  type DemandeEnAttente,
  type EtatAcces,
  type EtatNavigateur,
  type IdFenetre,
  type IdProfil,
} from "../commun/modele";
import { randomUUID } from "node:crypto";
import { chargerSession, EnregistreurSession } from "./etat/persistance";
import { brancherIpc, Magasin } from "./ipc";
import { versUrl } from "./adresse";
import { Historique } from "./historique";
import { installerMenu, type CiblesMenu } from "./menu";
import { ParcoursOnglets } from "./parcours-onglets";
import { GestionnaireVues } from "./onglets/vues";
import { Permissions } from "./permissions";
import { cheminProfil } from "./profil";
import { estInvisible } from "./contenus-invisibles";
import { fichierPermissions, SessionsProfils } from "./profils-connexion";
import { Telechargements } from "./telechargements";
import { demarrerAgent, type ServiceAgent } from "./agent/agent";
import { creerNotifieur } from "./notifications";
import { attendreDroits, attendreReponse, decisionPermise, DELAI_QUESTION_MS, espacesDevenusPrives, infosOnglets, origineDe, ongletActifDe, ongletApplication, PREFIXE_SITE, questionCaduque, questionSiteCaduque } from "./agent/pont";
import { Atelier, catalogueBlocs, cheminsEspace, lireAccueil, lireAction, retirerAccord, supprimerDonnees, type DroitDev, type EtatActions, type OngletInfo } from "@webaios/noyau";
import { SchemaIdWidget, type EtatIaAffiche } from "../commun/api";
import { cadreVisible } from "./applications/fenetres";
import { demarrerApplications, type ServiceApplications } from "./applications/service";
import { demarrerSites, type ServiceSites } from "./sites/service";
import { sessionSite } from "./sites/session";
import { repondreAccueilSite } from "./sites/accueil";
import { requetesDe } from "./image-distante";
import { SCHEMA_SITE } from "../commun/sites";
import { gardienGestes } from "./agent/geste-widget";
import { enregistrerSchemaWidget, executionWidget, executionsWidget, navigationCadrePermise, widgetDuCadre, lireWidgetsAffiches, permissionInterface, placerWidgets, profilsPourAccord, retirerWidget, SCHEMA_WIDGET, servirWidgets, urlOuvrable } from "./agent/accueil";
import { creerServiceActions, espaceActifPrive, repondreComposant, repondreImage, SCHEMA_COMPOSANT, SCHEMA_IMAGE } from "./agent/actions";
import {
  creerConstructeurActions,
  enregistrerCodeSur,
  enregistrerEdition,
  FileEcritures,
  lireCodeSur,
  lireEdition,
  workflowOuvertDe,
  type SelectionConstructeur,
} from "./agent/constructeur";
import { profilsLisibles } from "./agent/lecture-invisible";
import { couperReseauInterface, repondreIcone, SCHEMA_ICONE } from "./reseau-interface";
import { brancherPagesAgent } from "./extensions/reseau";
import { ExtensionsProfils, servirIconesExtensions } from "./extensions/sessions";
import { ouvrirOngletPourExtension, ServiceExtensions } from "./extensions/service";
import { avantInstallation, idDepuisSaisie, SAISIE_INVALIDE } from "./extensions/store";
// Mode design et relecture (plan 17).
import { armerViseur, capturerElement, desarmerViseur, lireSource } from "./design/viseur";
import { ServiceDesign } from "./design/service";
import { choisirCibleDesign } from "./design/premier-plan";
import { INDISPONIBLE_DESIGN_SITE, plagesConteneur, PORT_MCP_EXTERNE, RegistreExternes, Remarques } from "@webaios/noyau";
import { creerEnvoi } from "./design/envoi";
import { demarrerExternes, raisonEchec, type ServiceExternes } from "./design/externes";
import { ServiceRelecture } from "./design/relecture";
import { homedir } from "node:os";

declare const __RESSOURCES_NOYAU__: string;

// Avant tout getPath : le nom fixe aussi le dossier du profil (~/Library/Application Support/WebAiOs).
app.setName("WebAiOs");
app.setPath("userData", cheminProfil());

// Une seule instance par profil : deux processus écriraient la même session et le même historique.
// (Le verrou d'Electron porte sur userData, d'où l'appel après setPath.)
if (!app.requestSingleInstanceLock()) app.exit(0);
// La bibliothèque d'extensions enregistre `crx:` (icônes des boutons) avec `bypassCSP` à son chargement ; cet appel-ci,
// le seul autre, remplace le sien. Voulu : avec `bypassCSP`, les affichages des widgets pourraient charger ces icônes
// malgré leur CSP. L'interface a `crx:` dans son `img-src` (index.html) : sans privilège, l'icône s'y charge quand même
// (vérifié par e2e/extensions-interface.spec.ts).
enregistrerSchemaWidget([SCHEMA_ICONE, SCHEMA_IMAGE, SCHEMA_COMPOSANT, SCHEMA_SITE]);
// Aucune résolution de nom anticipée, nulle part (<link rel=dns-prefetch>, liens) : dans un affichage de widget, elle
// ferait sortir des données dans une requête DNS, sans passer par la CSP ni par le proxy de l'interface. Les onglets y
// perdent un peu de vitesse ; leurs navigations résolvent les noms normalement.
app.commandLine.appendSwitch("blink-settings", "dnsPrefetchingEnabled=false");

/** Tests automatiques : aucune fenêtre à l'écran ni icône dans le Dock (elles gênent l'utilisateur pendant qu'il travaille). */
export const INVISIBLE = process.env.WEBAIOS_INVISIBLE === "1";
if (INVISIBLE) app.dock?.hide();

// Arrêt demandé par le système ou le terminal (electron-vite qui relance, Ctrl-C) : la sortie normale, qui arrête
// l'agent et l'IA locale (sinon Kev reste chargé en mémoire).
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => app.quit());

/** Fenêtres principales (avec l'interface WebAiOs), par id d'état. */
const fenetres = new Map<IdFenetre, BrowserWindow>();
/** Boutons de la fenêtre (macOS) voulus visibles ou non par l'interface de chaque fenêtre (voir creerFenetre). */
/** Le bloc sélectionné dans le constructeur de chaque fenêtre (pour l'outil `workflow_ouvert` de l'agent). */
const selectionsConstructeur = new Map<IdFenetre, SelectionConstructeur>();
const boutonsFenetre = new Map<IdFenetre, (visibles: boolean) => void>();

/** Vrai dès que l'app quitte : les fenêtres qui se ferment alors restent dans la session, pour la restauration. */
let enSortie = false;
const enFermeture = new WeakSet<BrowserWindow>();
/** Fenêtres fermées mais gardées dans l'état (macOS) : à ne pas recréer avant que l'utilisateur les rouvre. */
const gardees = new Set<IdFenetre>();
/** Dernière fenêtre principale passée au premier plan : celle que l'agent considère comme « active ». */
let derniereFocalisee: IdFenetre | undefined;
/**
 * La fenêtre principale au premier plan, sinon la dernière focalisée, sinon la première. Au niveau du module : une
 * extension peut l'appeler (`tabs.create`, `premierPlan`) dès que son service worker démarre, avant les fenêtres.
 */
function fenetreAgent(): IdFenetre | undefined {
  const focus = BrowserWindow.getFocusedWindow();
  for (const [id, f] of fenetres) if (f === focus) return id;
  return derniereFocalisee && fenetres.has(derniereFocalisee) ? derniereFocalisee : fenetres.keys().next().value;
}
/** Vrais clics dans l'interface de chaque fenêtre : seuls eux permettent à un widget d'ouvrir un lien. */
const gestesWidgets = gardienGestes<IdFenetre>();

function noterCadre(id: IdFenetre, f: BrowserWindow, magasin: Magasin): void {
  if (f.isDestroyed() || f.isFullScreen() || f.isMinimized()) return;
  const { x, y, width, height } = f.getNormalBounds();
  magasin.agir({ type: "cadrerFenetre", id, cadre: { x, y, largeur: width, hauteur: height } });
}

function creerFenetre(id: IdFenetre, magasin: Magasin, vues: GestionnaireVues, parcours: ParcoursOnglets): BrowserWindow {
  const cadre = cadreVisible(magasin.etat.fenetres.find((f) => f.id === id)?.cadre);
  const fenetre = new BrowserWindow({
    width: 1400,
    height: 900,
    ...cadre,
    show: !INVISIBLE,
    // Tests : macOS montrerait la fenêtre pour la passer en plein écran ; la page y passe quand même (vidéo en plein écran).
    fullscreenable: !INVISIBLE,
    titleBarStyle: "hiddenInset",
    // Boutons de la fenêtre centrés sur la rangée du haut de la barre latérale (← → recharger, centre vers 27 px,
    // mesuré à l'écran par l'utilisateur) ; ceux de macOS font 14 px de haut et s'arrêtent avant les 70 px laissés à gauche.
    trafficLightPosition: { x: 16, y: 20 },
    backgroundColor: "#1e1e22",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Le preload tourne aussi dans les affichages des widgets, sans rien y exposer : il y voit les vrais clics de
      // L'utilisateur (voir preload/index.ts et CANAUX.gesteWidget).
      nodeIntegrationInSubFrames: true,
      additionalArguments: [`${ARG_FENETRE}${id}`],
    },
  });
  fenetres.set(id, fenetre);
  fenetre.on("focus", () => (derniereFocalisee = id));
  // Parcours ⌃Tab : ⌃ relâché dans l'interface le valide (dans une page, voir l'option `saisie` des vues) ; la fenêtre
  // qui perd le focus (⌘Tab vers une autre appli) l'annule, car le relâchement peut ne jamais arriver.
  fenetre.webContents.on("before-input-event", (_e, input) => {
    if (estRelachementCtrl(input)) parcours.toucheRelachee(id);
  });
  fenetre.on("blur", () => parcours.fenetreQuittee(id));
  // macOS : les boutons de la fenêtre sont dans la rangée du haut de la barre latérale. L'interface les cache avec
  // elle (mode compact, barre non révélée) : rien d'autre ne passe dessous. En plein écran, macOS les gère seul.
  let boutonsVoulus = true;
  const appliquerBoutons = () => {
    if (process.platform === "darwin" && !fenetre.isDestroyed()) fenetre.setWindowButtonVisibility(boutonsVoulus || fenetre.isFullScreen());
  };
  boutonsFenetre.set(id, (visibles) => {
    boutonsVoulus = visibles;
    appliquerBoutons();
  });
  fenetre.on("enter-full-screen", appliquerBoutons);
  // Sortie du plein écran par la fenêtre (bouton vert) : la page doit sortir aussi.
  fenetre.on("leave-full-screen", () => {
    appliquerBoutons();
    fenetre.webContents.send(CANAUX.pleinEcran, false);
  });
  // Taille et position retenues pour le prochain lancement (regroupées : un glissement émet des dizaines d'événements).
  let minuterieCadre: NodeJS.Timeout | undefined;
  const planifierCadre = () => {
    clearTimeout(minuterieCadre);
    minuterieCadre = setTimeout(() => noterCadre(id, fenetre, magasin), 300);
  };
  fenetre.on("resize", planifierCadre);
  fenetre.on("move", planifierCadre);
  fenetre.on("close", () => {
    clearTimeout(minuterieCadre);
    noterCadre(id, fenetre, magasin);
    enFermeture.add(fenetre);
  });
  // L'interface retient la fermeture quand du code du constructeur n'est pas enregistré (« beforeunload ») : L'utilisateur
  // choisit. En quittant WebAiOs (⌘Q), la sortie est déjà engagée (agent arrêté) : la fenêtre se ferme sans demander.
  fenetre.webContents.on("will-prevent-unload", (e) => {
    if (enSortie) return void e.preventDefault();
    const choix = dialog.showMessageBoxSync(fenetre, {
      type: "question",
      buttons: ["Fermer", "Rester"],
      defaultId: 1,
      cancelId: 1,
      message: "Fermer la fenêtre ?",
      detail: "Du code du constructeur de workflow n'est pas enregistré : il sera perdu.",
    });
    if (choix === 0) e.preventDefault();
    else enFermeture.delete(fenetre);
  });
  // Fermer une fenêtre parmi d'autres la retire de la session (avec ses onglets) ; la dernière reste, pour la
  // restauration. Sur « closed » : un window.close() de la page détruit la fenêtre sans émettre « close ».
  fenetre.on("closed", () => {
    fenetres.delete(id);
    questionsFenetreFermee(id);
    boutonsFenetre.delete(id);
    selectionsConstructeur.delete(id);
    design?.oublier({ type: "fenetre", fenetreId: id });
    void agent?.sessions.fermerFenetre(id);
    if (!enSortie && magasin.etat.fenetres.length > 1) magasin.agir({ type: "fermerFenetre", id });
    // Dernière fenêtre (gardée dans l'état) : ses pages se ferment, elles reviendront avec elle.
    else if (!enSortie) {
      gardees.add(id);
      vues.oublierFenetre(magasin.etat, id);
    }
    // Seule la fermeture de la dernière fenêtre principale quitte l'app, jamais celle d'une popup.
    // Sur macOS, l'app reste ouverte (comme Safari ou Chrome) : le Dock ou ⌘N rouvrent la fenêtre.
    if (fenetres.size === 0 && process.platform !== "darwin") app.quit();
  });
  // L'interface ne quitte jamais sa propre page.
  fenetre.webContents.on("will-navigate", (e) => e.preventDefault());
  // Un cadre de l'interface (l'affichage d'un widget) ne va jamais ailleurs que sur son propre affichage (premier
  // chargement, ou rechargement quand l'agent le réécrit) : une navigation vers le web porterait des données dans son
  // URL, une autre vers l'affichage d'un autre widget en prendrait la place. Ses liens passent par api.accueil.ouvrir.
  fenetre.webContents.on("will-frame-navigate", (e) => {
    if (!e.isMainFrame && !navigationCadrePermise(e.frame?.url ?? "", e.url)) e.preventDefault();
  });
  // L'interface n'ouvre aucune fenêtre (les widgets n'ont pas allow-popups).
  fenetre.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Les affichages des widgets sont des cadres de cette page : WebRTC (s'il échappait à la garde du preload) ne passe
  // que par le proxy de la session, qui ne mène nulle part (reseau-interface.ts) ; jamais d'UDP direct (STUN).
  fenetre.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const chargerInterface = () =>
    process.env.ELECTRON_RENDERER_URL
      ? fenetre.loadURL(process.env.ELECTRON_RENDERER_URL)
      : fenetre.loadFile(join(__dirname, "../renderer/index.html"));
  // Interface plantée : on la recharge (elle relit l'état au démarrage), sans boucler si elle replante aussitôt.
  let plantages: number[] = [];
  fenetre.webContents.on("render-process-gone", (_e, { reason }) => {
    if (reason === "clean-exit" || fenetre.isDestroyed()) return;
    plantages = [...plantages.filter((t) => Date.now() - t < 10_000), Date.now()];
    if (plantages.length <= 3) void chargerInterface().catch(() => {});
    else console.error("[webaios] l'interface plante en boucle, abandon du rechargement");
  });
  void chargerInterface();
  return fenetre;
}

/** ⌃ relâché, ou une touche relâchée sans ⌃ (le relâchement de ⌃ lui-même a pu échapper). */
function estRelachementCtrl(input: Electron.Input): boolean {
  return input.type === "keyUp" && (input.key === "Control" || !input.control);
}

/**
 * Vrai appui de l'utilisateur dans l'affichage d'un widget, signalé par le preload de ce cadre. Retenu seulement s'il vient
 * d'un cadre `webaios-widget://<id>/affichage.html` placé directement dans la page d'une fenêtre principale.
 */
ipcMain.on(CANAUX.gesteWidget, (e) => {
  const cadre = e.senderFrame;
  if (!cadre) return;
  for (const [id, f] of fenetres) {
    if (f.isDestroyed() || f.webContents !== e.sender) continue;
    const principal = f.webContents.mainFrame;
    if (cadre.frameTreeNodeId === principal.frameTreeNodeId || cadre.parent?.frameTreeNodeId !== principal.frameTreeNodeId) return;
    const widget = widgetDuCadre(cadre.url);
    if (widget) gestesWidgets.geste(id, widget);
    return;
  }
});

/** La fenêtre principale émettrice, seulement si le message vient de sa page (pas d'un cadre, comme un widget). */
function fenetreDe(e: Pick<IpcMainEvent, "sender" | "senderFrame">): IdFenetre | undefined {
  for (const [id, f] of fenetres) {
    if (f.isDestroyed() || f.webContents !== e.sender) continue;
    return e.senderFrame === f.webContents.mainFrame ? id : undefined;
  }
  return undefined;
}

let enregistreur: EnregistreurSession | undefined;
let rouvrirFenetres = (): boolean => false;
/** Une fenêtre principale fermée : ses questions passent dans une autre, ou valent refus s'il n'en reste aucune. */
let questionsFenetreFermee = (_id: IdFenetre): void => {};
let agent: ServiceAgent | undefined;
const fileEcritures = new FileEcritures();
const MESSAGE_AGENT_ARRETE = "Le service des widgets ne répond pas (agent arrêté ?)";
let applications: ServiceApplications | undefined;
let sites: ServiceSites | undefined;
/** Mode design des onglets et des fenêtres d'appli ; créé avec les applis (il lit leurs ports). */
let design: ServiceDesign | undefined;
/** Le MCP externe et ses projets (page Applications) ; prêt une fois le registre ouvert. */
let externes: ServiceExternes | undefined;
/** Le registre des projets externes illisible (ou le MCP externe en échec) : la raison montrée dans la section. */
let echecExternes: string | null = null;
/** Page Relecture : photos de prise en charge des applis, comparaison gardée par projet. */
let relecture: ServiceRelecture | undefined;
/** La relecture, ou une erreur tant qu'elle n'est pas prête. */
function prete(): ServiceRelecture {
  if (!relecture) throw new Error("la relecture n'est pas prête");
  return relecture;
}
let minuteurPriseEnCharge: NodeJS.Timeout | undefined;
/** Reprend la prise en charge des applis après 1 s de calme ; branché quand la relecture est prête. */
let planifierPriseEnCharge = (): void => undefined;
let magasinGlobal: Magasin | undefined;
let historique: Historique | undefined;
let minuteurPurge: NodeJS.Timeout | undefined;
let minuteurPurgeLots: NodeJS.Timeout | undefined;
/** Arrête la vérification périodique des mises à jour du Store. */
let arreterMisesAJour: (() => void) | undefined;
const serviceExtensions = new ServiceExtensions();

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  // Avant toute fenêtre : la session de l'interface (et donc les affichages des widgets) ne sort jamais sur le réseau.
  // Les favicons arrivent par webaios-icone:, cherchés dans une session à part (en mémoire, sans le profil de l'utilisateur).
  try {
    await couperReseauInterface(session.defaultSession, process.env.ELECTRON_RENDERER_URL);
  } catch (e) {
    console.error("[webaios] le réseau de l'interface n'a pas pu être coupé :", e);
  }
  // Avant toute fenêtre : les icônes des boutons d'extension (crx:), même si aucune session n'est encore équipée.
  servirIconesExtensions();
  const sessionIcones = session.fromPartition("webaios-icones");
  const requetesIcones = requetesDe(sessionIcones);
  protocol.handle(SCHEMA_ICONE, (requete) => repondreIcone((url, init) => sessionIcones.fetch(url, init), requete.url));
  // Exécutions, résultats et accords des actions : hors de l'espace, à côté de ceux des widgets.
  const dossierActions = join(dossier, "actions");
  // Les images des résultats d'une action sans compte : la même session sans cookies que les favicons.
  protocol.handle(SCHEMA_IMAGE, (requete) =>
    repondreImage(
      { dossierActions, lireAction: async (id) => (agent ? lireAction(agent.chemins, id) : null), ouvrir: requetesIcones },
      requete.url,
    ),
  );
  // Les composants de l'agent, dessinés dans un cadre sans réseau comme un affichage de widget.
  protocol.handle(SCHEMA_COMPOSANT, (requete) => repondreComposant(agent?.chemins.composants ?? null, requete.url));
  // L'écran d'accueil des applis de site (`~/WebAiOs/sites/<id>/accueil/`), dans un cadre sans réseau de leur fenêtre.
  const cheminsAccueilSites = cheminsEspace();
  protocol.handle(SCHEMA_SITE, (requete) => repondreAccueilSite(cheminsAccueilSites, requete.url));
  const magasin = new Magasin(await chargerSession(dossier));
  magasinGlobal = magasin;
  enregistreur = new EnregistreurSession(dossier);
  historique = new Historique(join(dossier, "historique.sqlite"));
  // Le texte retenu des pages a une durée et une taille limitées : purgé au démarrage puis toutes les 6 heures.
  historique.purger();
  minuteurPurge = setInterval(() => historique?.purger(), 6 * 60 * 60 * 1000);
  const diffuser = (canal: string, valeur: unknown) => {
    for (const f of fenetres.values()) if (!f.isDestroyed()) f.webContents.send(canal, valeur);
  };
  /** Le registre ou ce qui est chargé a changé : les fenêtres principales et l'interface de chaque appli de site relisent. */
  const diffuserExtensions = () => {
    diffuser(CANAUX.extensionsChange, null);
    sites?.fenetres.diffuserATous(CANAUX.extensionsChange, null);
  };
  /**
   * État de l'IA locale pour l'indicateur. Arrêtée, elle est vérifiée : sans Kev (et sans WEBAIOS_KEV_URL des tests),
   * sans uv, ou sans le modèle Gemma dans un Ollama qui répond, elle est « non installée ».
   */
  const etatIa = async (): Promise<EtatIaAffiche> => {
    const ia = agent?.ia;
    if (!ia) return { etat: "arretee" };
    const courant = ia.etat();
    if (courant.etat !== "arretee" && courant.etat !== "non-installee") return courant;
    const verification = await ia.verifier();
    // Pendant la vérification, l'IA a pu démarrer : son état actuel l'emporte.
    const apres = ia.etat();
    if (apres.etat !== "arretee" && apres.etat !== "non-installee") return apres;
    const kevPret = Boolean(process.env.WEBAIOS_KEV_URL) || (verification.kev && verification.uv);
    const manque = !kevPret || (verification.ollama && !verification.gemma);
    return { ...courant, etat: manque ? "non-installee" : "arretee", verification };
  };
  /** Diffuse l'état de l'IA ; un résultat dépassé par une diffusion plus récente (vérification plus lente) est jeté. */
  let diffusionIa = 0;
  const diffuserEtatIa = () => {
    const n = ++diffusionIa;
    void etatIa().then((e) => {
      if (n === diffusionIa) diffuser(CANAUX.iaEtatChange, e);
    });
  };
  /** Dernier lien de widget ouvert, par fenêtre. */
  const dernierLienWidget = new Map<IdFenetre, number>();
  // Session de l'interface (et des pastilles) : seule la page elle-même a des permissions, jamais un affichage de widget.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, rappel, details) => rappel(permissionInterface(details)));
  session.defaultSession.setPermissionCheckHandler((_wc, _permission, _origine, details) => permissionInterface(details));
  /** Installation en cours (une seule à la fois). Jamais lancée sans un clic de l'utilisateur (api.ia.installer). */
  let installation: Promise<{ ok: boolean; erreur?: string }> | undefined;
  const installerIa = () => {
    const ia = agent?.ia;
    if (!ia) return Promise.resolve({ ok: false, erreur: "IA locale indisponible" });
    installation ??= ia
      .installer((ligne) => diffuser(CANAUX.iaProgres, ligne))
      .then(
        () => ({ ok: true }),
        (e: Error) => ({ ok: false, erreur: e.message }),
      )
      .finally(() => {
        installation = undefined;
        diffuserEtatIa();
      });
    return installation;
  };
  let diffusionAcces: NodeJS.Timeout | undefined;
  const etatAcces = (): EtatAcces => {
    const noyau = agent?.noyau();
    return { agent: noyau?.agent ?? "L'agent", onglets: noyau?.politique.etat() ?? {} };
  };
  const telechargements = new Telechargements({
    dossier: process.env.WEBAIOS_TELECHARGEMENTS ?? app.getPath("downloads"),
    diffuser: (liste) => diffuser(CANAUX.telechargements, liste),
    shell,
  });
  // Questions d'autorisation en attente d'une réponse de l'utilisateur (bandeau de l'onglet concerné).
  const questions = new Map<string, { demande: DemandeEnAttente; repondre: (d: Issue, droits?: DroitDev[]) => void }>();
  const enAttente = () => [...questions.values()].map((q) => q.demande);
  const demander = (d: Demande) =>
    new Promise<Decision>((repondre) => {
      const id = randomUUID();
      // Une question de site retirée vaut refus.
      questions.set(id, { demande: { ...d, id }, repondre: (r) => repondre(r === "autoriser" ? "autoriser" : "refuser") });
      diffuser(CANAUX.permissions, enAttente());
    });
  /** Autorisations des sites, une instance par profil de connexion. */
  const permissions = new Map<IdProfil, Permissions>();
  const permissionsDe = (id: IdProfil) => {
    let p = permissions.get(id);
    if (!p) permissions.set(id, (p = new Permissions({ fichier: fichierPermissions(dossier, id), demander })));
    return p;
  };
  /** La règle des outils de lecture de l'agent (lire_onglet) : onglet visible (ni page interne, ni espace privé) et partagé. */
  const ongletLisibleParAgent = (id: string): boolean => {
    const info = infosOnglets(magasin.etat).find((x) => x.id === id);
    return !!info && agent?.noyau()?.politique.peutLire(info) === true;
  };
  // Extensions : une instance de la bibliothèque par session de profil de connexion, et par session d'appli de site où
  // une extension du Store est active (plan 16) ; jamais l'interface, la lecture publique, les icônes ni les applications
  // du plan 4. Branchée sur les vues des onglets, et sur la vue du site de chaque appli (son seul onglet web).
  const extensions = new ExtensionsProfils({
    dossier: join(dossier, "extensions"),
    etat: () => magasin.etat,
    premierPlan: () => fenetreAgent(),
    ouvrirOnglet: (cible, url, actif) => ouvrirOngletPourExtension(magasin, vues)(cible, url, actif),
    fenetreDe: (wc) => {
      const id = vues.ongletDe(wc);
      const o = id ? magasin.etat.onglets[id] : undefined;
      return (o && fenetres.get(o.fenetreId)) ?? null;
    },
    // Jamais de changement d'espace par une extension : l'onglet devient celui de son espace, la fenêtre reste où elle est.
    activer: (wc) => {
      const id = vues.ongletDe(wc);
      if (id) magasin.agir({ type: "activerOnglet", id, garderEspace: true });
    },
    fermer: (wc) => {
      const id = vues.ongletDe(wc);
      if (id) vues.fermer(id);
    },
    // Une vue d'onglet (ou sa popup) ; les lectures invisibles n'en sont jamais (ExtensionsProfils.estOnglet le revérifie).
    estOnglet: (wc) => vues.ongletDe(wc) !== null && !estInvisible(wc),
    // Console filtrée (spec §5) : l'agent lit-il cet onglet ? La règle de ses outils de lecture (lire_onglet) : onglet
    // visible (ni page interne, ni espace privé) et partagé (politique d'accès du noyau). Sans noyau : non.
    lisibleParAgent: (wc) => {
      const id = vues.ongletDe(wc);
      return !!id && ongletLisibleParAgent(id);
    },
    // Noté au registre (durable) : sa console de service worker et de pages reste masquée à l'agent.
    aTourneDansOnglet: (id, profil, lisible) =>
      void serviceExtensions.aTourneDansOnglet(id, profil, lisible).catch((e) => console.error(`[extensions] ${id} : onglet non lisible non noté :`, e)),
    invisible: INVISIBLE,
    ...(process.env.WEBAIOS_TEST_NOTIFICATIONS ? { fichierNotifications: process.env.WEBAIOS_TEST_NOTIFICATIONS } : {}),
    preloadCorrectifs: join(__dirname, "../preload/extensions.js"),
    noterVue: (cle, profil, version) => serviceExtensions.noterVue(cle, profil, version),
    noterIdChrome: (cle, id) => void serviceExtensions.noterIdChrome(cle, id).catch((e) => console.error(`[extensions] idChrome de ${cle} non noté :`, e)),
    // La page du Chrome Web Store passe par notre installation (carte, téléchargement vérifié, préparation).
    avantInstallationStore: (s, profil) =>
      avantInstallation({
        profil,
        session: s,
        contexteDe: (wc) => {
          const id = vues.ongletDe(wc);
          const o = id ? magasin.etat.onglets[id] : undefined;
          const espace = o && magasin.etat.espaces.find((e) => e.id === o.espaceId);
          return o && espace ? { profil: espace.profil, espace, fenetre: o.fenetreId } : null;
        },
        installer: (id, c) => serviceExtensions.installerStore(id, c),
      }),
    // « Retirer de Chrome » sur la page du Store : notre désinstallation (registre, tous les profils), jamais celle de la
    // bibliothèque.
    desinstallerDepuisStore: (id, profil) => serviceExtensions.desinstallerDepuisStore(id, profil),
    // Consoles et plantages en boucle (désactivée partout au troisième en une minute).
    consoles: serviceExtensions.consoles,
    // Ce qui est chargé a pu changer : la barre, la page Extensions et la barre de chaque appli de site relisent.
    apresSynchro: () => diffuserExtensions(),
    // verifierUrl / verifierHote : les extensions de l'agent sont vérifiées par `ExtensionsProfils` (reseau.ts).
    // Les applis de site (plan 16) : `sites` démarre plus loin, d'où ces fermetures paresseuses (avant lui, rien n'est
    // ouvert : aucune vue, aucune empreinte, aucune adresse permise).
    site: {
      vue: (id) => sites?.fenetres.vueEtFenetre(id) ?? null,
      empreinte: (id) => serviceExtensions.empreinteSite(id),
      urlPermise: (id, extensionId, url) => sites?.fenetres.urlPermisePourExtension(id, extensionId, url) ?? false,
      ouvrir: (id, url) => {
        if (!sites) return Promise.reject(new Error("applis de site pas prêtes"));
        return sites.fenetres.ouvrirPourExtension(id, url);
      },
      fermer: (wc) => sites?.fenetres.fermerPageExtension(wc),
      peutCharger: (id, wc, url) => sites?.fenetres.peutChargerPourExtension(id, wc, url) ?? false,
    },
  });
  // Pages des extensions de l'agent : navigations, ouvertures et WebRTC (reseau.ts).
  brancherPagesAgent((id) => extensions.accordAgent(id));
  // Chaque session de profil de connexion a ses téléchargements et ses autorisations, comme l'avait la session unique.
  const sessions = new SessionsProfils({
    dossier,
    brancher: (s, id) => {
      // Une lecture invisible pour un widget ne télécharge jamais rien (voir agent/lecture-invisible.ts).
      s.on("will-download", (e, item, wc) => {
        if (!estInvisible(wc)) return telechargements.suivre(item);
        e.preventDefault();
        item.cancel();
      });
      permissionsDe(id).brancher(s, (wc) => vues.ongletDe(wc));
      // La session reste utilisable sans extensions si la bibliothèque échoue.
      try {
        extensions.brancher(s, id);
      } catch (e) {
        console.error(`[extensions] profil ${id} sans extensions :`, e);
      }
    },
    // Le profil quitte les extensions (profils actifs, versions vues) et elles sont déchargées, avant que leurs réglages
    // ne soient effacés du disque.
    avantEffacer: (id) => serviceExtensions.retirerProfil(id),
    oublier: (id) => permissions.get(id)?.toutOublier(),
  });
  const vues = new GestionnaireVues({
    sessionDe: (o) => sessions.session(profilDOnglet(magasin.etat, o)),
    fenetres,
    agir: (a) => magasin.agir(a),
    zoneGauche: (id, zone) => fenetres.get(id)?.webContents.send(CANAUX.zoneGauche, zone),
    historique,
    contexteHistorique: (id) => contexteHistorique(magasin.etat, id),
    retenir: (r) => historique?.retenir(r),
    resultatRecherche: (id, r) => fenetres.get(id)?.webContents.send(CANAUX.resultatRecherche, r),
    // Électron met lui-même la fenêtre en plein écran natif : l'interface n'a qu'à s'effacer.
    pleinEcran: (id, actif) => fenetres.get(id)?.webContents.send(CANAUX.pleinEcran, actif),
    // La fenêtre est lue au moment de la frappe : un onglet peut changer de fenêtre.
    saisie: (ongletId, input) => {
      const f = magasin.etat.onglets[ongletId]?.fenetreId;
      if (f && estRelachementCtrl(input)) parcours.toucheRelachee(f);
    },
    extensions: {
      creee: (wc, f) => extensions.ongletCree(wc, f),
      activee: (wc) => extensions.ongletActive(wc),
      detruite: (wc) => extensions.ongletDetruit(wc),
    },
  });
  // Lancé ici, attendu plus bas (avant les fenêtres) : son abonnement au magasin, posé tout de suite, passe ainsi avant
  // celui des vues (un espace devenu privé perd ses extensions de l'agent avant que ses pages ne se chargent).
  const demarrageExtensions = serviceExtensions
    .demarrer({
      dossier: join(dossier, "extensions"),
      profils: extensions,
      sessions,
      vues,
      magasin,
      dossierGardes: join(__RESSOURCES_NOYAU__, "extensions"),
      // Ce qu'écrit l'agent (~/WebAiOs/extensions) : jamais un droit, seulement la source des copies accordées.
      dossierAgent: cheminsEspace().extensions,
      surChange: () => diffuserExtensions(),
      // C9 : injectée (le service ne charge pas sites/session.ts) ; appelée seulement une fois les applis démarrées.
      sessionSite,
      // C11 : sans toucher aux ids montrés par la section « Sites ».
      nomsSites: async () => (await sites?.noms()) ?? {},
    })
    .catch((e) => console.error("[extensions] démarrage :", e));
  // Nos mises à jour du Store (jamais celles de la bibliothèque) : 60 s après le démarrage, puis toutes les 5 h.
  arreterMisesAJour = serviceExtensions.planifierMisesAJour();
  // Un onglet fermé (ou parti vers un autre site, pour les outils de développement) ne répondra jamais : ses questions
  // sont refusées. Une fenêtre d'appli (`app:<dossier>`) n'est pas dans l'état : on regarde ses fenêtres ouvertes.
  const ecarterQuestionsCaduques = () => {
    let change = false;
    for (const [id, q] of questions) {
      const d = q.demande;
      const appli = d.cible?.startsWith("app:") ? applications?.fenetres.ouvertes().find((a) => `app:${a.dossier}` === d.cible) : undefined;
      const appliCaduque = d.cible?.startsWith("app:") && (!appli || origineDe(appli.url) !== d.origine);
      // Fenêtre d'appli de site : fermée, ou (outils de développement) partie sur une autre origine.
      const siteCaduque = questionSiteCaduque(d, sites?.fenetres.ouvertes() ?? []);
      if (appliCaduque || siteCaduque || questionCaduque(d, magasin.etat)) {
        questions.delete(id);
        // Tombée sans réponse de l'utilisateur : retirée, pas refusée (les cartes de l'agent le disent).
        q.repondre("retiree");
        change = true;
      }
    }
    if (change) diffuser(CANAUX.permissions, enAttente());
  };
  // ⌃Tab : ordre d'utilisation récente et parcours en cours, par fenêtre. Seul l'envoi du panneau vise l'interface.
  const parcours = new ParcoursOnglets({
    etat: () => magasin.etat,
    agir: (a) => magasin.agir(a),
    envoyer: (id, p) => {
      const f = fenetres.get(id);
      if (f && !f.isDestroyed()) f.webContents.send(CANAUX.panneauOnglets, p);
    },
    apercu: (id) => vues.apercuEnCache(id),
    capturer: (id) => vues.capturerAffiche(id),
    rendreFocus: (id) => vues.focaliserAffiche(id),
    // En mode invisible (e2e), aucune fenêtre n'a jamais le focus : le parcours y est quand même testé.
    estFocalisee: (id) => INVISIBLE || fenetres.get(id)?.isFocused() === true,
  });
  parcours.surEtat(magasin.etat);
  magasin.abonner((etat) => parcours.surEtat(etat));
  magasin.abonner(ecarterQuestionsCaduques);
  magasin.abonner((etat, avant) => {
    diffuser(CANAUX.etat, etat);
    vues.synchroniser(etat);
    // Après les vues : aucune page n'est plus dans la session d'un profil effacé.
    if (profilsChanges(avant, etat)) void sessions.synchroniser(etat);
    enregistreur?.planifier(etat);
  });
  // L'historique se met à jour même sans agent : un espace devenu privé garde ses visites mais les marque.
  magasin.abonner((etat, avant) => {
    for (const id of espacesDevenusPrives(avant, etat)) historique?.rendrePrive(id);
  });
  /** Les actions qui tournent ne sont montrées qu'aux fenêtres dont l'espace actif n'est pas privé. */
  let actionsCourantes = new Set<string>();
  const diffuserDirectActions = (e: EtatActions) => {
    for (const [id, f] of fenetres) if (!f.isDestroyed() && !espaceActifPrive(magasin.etat, id)) f.webContents.send(CANAUX.actionsDirect, e);
    // Une action finie a un nouveau dernier résultat (écrit hors de l'espace surveillé) : la liste se relit.
    const courantes = new Set(e.courantes.map((c) => c.action));
    if ([...actionsCourantes].some((a) => !courantes.has(a))) diffuser(CANAUX.actionsChange, null);
    actionsCourantes = courantes;
  };
  const serviceActions = creerServiceActions({
    etat: () => magasin.etat,
    agir: (a) => magasin.agir(a),
    noyau: () => agent?.noyau() ?? null,
    chemins: () => agent?.chemins ?? null,
    dossierActions,
    surChange: () => diffuser(CANAUX.actionsChange, null),
  });
  const constructeurActions = creerConstructeurActions({
    etat: () => magasin.etat,
    noyau: () => agent?.noyau() ?? null,
    chemins: () => agent?.chemins ?? null,
    dossierActions,
    file: fileEcritures,
    messageArrete: MESSAGE_AGENT_ARRETE,
  });
  brancherIpc({
    magasin,
    fenetreDe,
    actions: serviceActions,
    naviguer: (fenetreId, ongletId, saisie) => {
      const url = versUrl(saisie, magasin.etat.reglages.moteur);
      if (!url) return;
      if (ongletId) vues.naviguer(ongletId, url);
      else magasin.agir({ type: "ouvrirOnglet", fenetreId, url });
    },
    commande: (id, c) => vues.commande(id, c),
    bornes: (f, b) => vues.bornes(f, b),
    boutonsFenetre: (f, visibles) => boutonsFenetre.get(f)?.(visibles),
    apercu: (f, id) => vues.apercu(f, id),
    fermerOnglet: (id) => vues.fermer(id),
    parcoursOnglets: (f, m) => parcours.message(f, m),
    historique,
    telechargements,
    accueil: {
      // Lue sans le noyau : la page s'affiche même s'il n'a pas pu démarrer.
      async lire() {
        if (!agent) return [];
        try {
          return await lireWidgetsAffiches(await lireAccueil(agent.chemins, agent.dossierWidgets));
        } catch (e) {
          console.error("[webaios] page d'accueil illisible :", e);
          return [];
        }
      },
      // La surveillance du dossier renvoie la page à jour aux fenêtres.
      placer: (placements) => {
        if (agent) placerWidgets(agent.chemins, placements).catch((e) => console.error("[webaios] disposition non écrite :", e));
      },
      retirer: (id) => {
        const a = agent;
        if (!a) return;
        // L'accord et les données lues avec le compte partent avec le widget (par le noyau, qui écrit aussi les accords).
        const oublier = async (w: string) => {
          const noyau = a.noyau();
          if (noyau) return noyau.refuserAccord(w);
          await retirerAccord(a.dossierWidgets, w);
          await supprimerDonnees(a.dossierWidgets, w);
        };
        retirerWidget(a.chemins, id, oublier).catch((e) => console.error(`[webaios] widget ${id} non retiré :`, e));
      },
      ouvrir: (url, widget, fenetreId) => {
        // Seulement juste après un vrai clic de l'utilisateur dans l'affichage de ce widget (un lien par clic).
        if (!gestesWidgets.accepter(fenetreId, widget)) return console.warn("[webaios] lien de widget ignoré (pas de clic dans le widget) :", url);
        // Un affichage qui ouvrirait des liens en rafale (pour faire sortir des données) : un par seconde au plus.
        const maintenant = Date.now();
        if (maintenant - (dernierLienWidget.get(fenetreId) ?? 0) < 1000) return console.warn("[webaios] lien de widget ignoré (trop rapproché) :", url);
        if (!urlOuvrable(url)) return console.warn("[webaios] lien de widget refusé :", url);
        dernierLienWidget.set(fenetreId, maintenant);
        magasin.agir({ type: "ouvrirOnglet", fenetreId, url, activer: true });
      },
      profilsPourAccord: (fenetreId) => profilsPourAccord(magasin.etat, fenetreId),
      accorder: async (a) => {
        const noyau = agent?.noyau();
        // Jamais un profil utilisé par un espace privé : l'état est relu au moment de l'accord.
        if (!noyau || !profilsLisibles(magasin.etat).includes(a.profil)) {
          console.warn(`[webaios] accord refusé pour ${a.id} (profil ${a.profil}, noyau ${noyau ? "prêt" : "absent"})`);
          return { ok: false as const, erreur: noyau ? "Ce profil ne peut pas servir à un accord" : "Le service des widgets ne répond pas (agent arrêté ?)" };
        }
        try {
          // Le noyau refuse si la déclaration n'est plus celle que la carte a montrée.
          await noyau.accorder(a);
          return { ok: true as const };
        } catch (e) {
          console.error(`[webaios] accord du widget ${a.id} :`, e);
          // L'interface relit la page : la nouvelle demande s'affiche.
          diffuser(CANAUX.accueilChange, null);
          return { ok: false as const, erreur: (e as Error).message };
        }
      },
      refuserAccord: (id) => {
        agent?.noyau()?.refuserAccord(id).catch((e) => console.error(`[webaios] retrait de l'accord du widget ${id} :`, e));
      },
      recolter: (id) => {
        agent?.noyau()?.recolterMaintenant(id).catch((e) => console.error(`[webaios] récolte du widget ${id} :`, e));
      },
      // Lues sans le noyau, comme la page d'accueil : les exécutions, hors de l'espace.
      executions: async (id) => (agent ? executionsWidget(agent.dossierWidgets, id) : []),
      execution: async (id, execution) => (agent ? executionWidget(agent.dossierWidgets, id, execution) : null),
    },
    workflow: {
      catalogue: () => catalogueBlocs(),
      lire: async (f, cible) => {
        if (!agent) return null;
        if (cible.type === "widget") return lireEdition({ chemins: agent.chemins, dossierWidgets: agent.dossierWidgets }, cible.id);
        return constructeurActions.lire(f, cible.id);
      },
      enregistrer: async (f, cible, brouillon) => {
        if (!agent) return { ok: false as const, erreur: MESSAGE_AGENT_ARRETE, avertissements: [] };
        const a = agent;
        if (cible.type === "widget") {
          return fileEcritures.enSerie(cible.id, () => enregistrerEdition({ chemins: a.chemins, dossierWidgets: a.dossierWidgets }, cible.id, brouillon));
        }
        return constructeurActions.enregistrer(f, cible.id, brouillon);
      },
      lireCode: async (f, cible, nom) => {
        if (!agent) return { erreur: MESSAGE_AGENT_ARRETE };
        if (cible.type === "widget") return lireCodeSur(agent.chemins, cible.id, nom);
        return constructeurActions.lireCode(f, cible.id, nom);
      },
      enregistrerCode: async (f, cible, nom, texte) => {
        if (!agent) return { ok: false as const, erreur: MESSAGE_AGENT_ARRETE };
        const a = agent;
        if (cible.type === "widget") return fileEcritures.enSerie(cible.id, () => enregistrerCodeSur(a.chemins, cible.id, nom, texte));
        return constructeurActions.enregistrerCode(f, cible.id, nom, texte);
      },
      rejouer: async (f, cible, execution, bloc) => {
        const noyau = agent?.noyau();
        if (!noyau) return { ok: false as const, erreur: MESSAGE_AGENT_ARRETE };
        if (cible.type === "widget") return noyau.rejouer(cible.id, execution, bloc);
        return constructeurActions.rejouer(f, cible.id, execution, bloc);
      },
      // Sans noyau : {} (l'interface ne sélectionne alors aucune exécution) ; une récolte qui échoue ne lève rien.
      lancer: async (f, cible, saisie) => {
        const noyau = agent?.noyau();
        if (!noyau) return {};
        if (cible.type === "action") return constructeurActions.lancer(f, cible.id, saisie);
        const id = cible.id;
        try {
          const r = await noyau.recolterMaintenant(id, "manuelle");
          return r.execution === undefined ? {} : { execution: r.execution };
        } catch (e) {
          console.error(`[webaios] exécution du widget ${id} :`, e);
          return {};
        }
      },
      selection: (f, s) => {
        selectionsConstructeur.set(f, s);
      },
      direct: async () => agent?.noyau()?.direct() ?? { courants: [], enAttente: [] },
    },
    ia: {
      etat: () => etatIa(),
      installer: () => installerIa(),
    },
    applications: {
      liste: async () => (await applications?.liste()) ?? { atelier: "ok", applications: [] },
      agir: (dossier, action, f) => applications?.agir(dossier, action, f),
    },
    sites: {
      liste: async () => (await sites?.liste()) ?? [],
      agir: (id, action, f) => void sites?.agir(id, action, f).catch((e) => console.error(`[sites] ${id} : ${action} impossible :`, e)),
    },
    site: {
      idDe: (sender) => sites?.fenetres.idDeInterface(sender),
      etat: (id) => sites?.fenetres.etat(id) ?? null,
      geste: (id, g) => sites?.fenetres[g](id),
      accorder: async (id, oui, empreinte) => sites?.accorder(id, oui, empreinte),
      memoire: async (id) => {
        if (!sites) throw new Error("applis de site pas prêtes");
        return sites.memoireAccueil(id);
      },
      ouvrir: async (id, adresse) => sites?.ouvrirDepuisAccueil(id, adresse) ?? false,
      image: async (id, url) => (await sites?.imageAccueil(id, url)) ?? null,
      gesteAccueil: (id) => sites?.gesteAccueil(id),
      extensionsListe: (id) => serviceExtensions.pourSite(id),
      extensionsBasculer: async (id, cle, actif) => {
        // La vue d'avant l'écriture : une appli fermée (ou rouverte) pendant l'attente n'est pas rechargée.
        const avant = sites?.fenetres.vueEtFenetre(id)?.wc;
        const r = await serviceExtensions.basculerSite(cle, id, actif);
        if (r.ok && avant && sites?.fenetres.vueEtFenetre(id)?.wc === avant) sites.fenetres.rechargerVue(id);
        return r;
      },
      extensionsBarre: (id) => {
        const vue = sites?.fenetres.etat(id)?.vue === "site" ? sites.fenetres.vueEtFenetre(id)?.wc : undefined;
        return serviceExtensions.barreSite(id, vue ? vue.id : null);
      },
      // La page Extensions dans la fenêtre principale au premier plan (rouverte s'il n'y en a plus), montrée hors test.
      extensionsGerer: () => {
        if (!fenetreAgent()) rouvrirFenetres();
        const id = fenetreAgent();
        if (!id) return;
        magasin.agir({ type: "ouvrirExtensions", fenetreId: id });
        const f = fenetres.get(id);
        if (!f || INVISIBLE) return;
        if (f.isMinimized()) f.restore();
        f.show();
        f.focus();
      },
      extensionsPanneau: (id, hauteur) => sites?.fenetres.panneauExtensions(id, hauteur),
    },
    extensions: {
      // Dans l'espace actif de la fenêtre émettrice ; la carte s'ouvre dans cette fenêtre.
      installerStore: async (saisie, fenetreId) => {
        const id = idDepuisSaisie(saisie);
        if (!id) return { ok: false, erreur: SAISIE_INVALIDE };
        const f = magasin.etat.fenetres.find((x) => x.id === fenetreId);
        const espace = f && magasin.etat.espaces.find((e) => e.id === f.espaceActif);
        if (!espace) return { ok: false, erreur: "Aucun espace actif dans cette fenêtre" };
        return serviceExtensions.installerStore(id, { profil: espace.profil, espace, fenetre: fenetreId, depuisInterface: true });
      },
      pourEspace: (espaceId) => serviceExtensions.pourEspace(espaceId),
      basculer: (cle, espaceId, actif, fenetreId) => serviceExtensions.basculer(cle, espaceId, actif, fenetreId),
      liste: () => serviceExtensions.liste(),
      coupees: () => serviceExtensions.etatExtensions().toutesCoupees,
      barre: async (fenetreId) => serviceExtensions.barre(fenetreId),
      epingler: (cle, oui) => serviceExtensions.epingler(cle, oui),
      desactiverPartout: (cle) => serviceExtensions.desactiverPartout(cle),
      supprimer: (cle) => serviceExtensions.supprimer(cle),
      toutCouper: (oui) => serviceExtensions.toutCouper(oui),
      revoir: (cle, fenetreId) => serviceExtensions.revoir(cle, fenetreId),
      reactiver: (cle) => serviceExtensions.reactiver(cle),
      couperDeblocage: async (cle) => serviceExtensions.couperDeblocage(cle),
    },
    acces: {
      etat: etatAcces,
      couper: (id, droit) => agent?.noyau()?.politique.couper(id, droit),
    },
    pastille: {
      dossierDe: (sender) => applications?.fenetres.dossierDePastille(sender),
      etat: (dossier) => applications?.fenetres.accesDe(dossier) ?? { agent: "L'agent", onglets: {} },
      redimensionner: (dossier, ouverte) => applications?.fenetres.redimensionnerPastille(dossier, ouverte),
    },
    agent: {
      demarrer: (f, t) => void agent?.sessions.demarrer(f, t),
      ecrire: (f, d) => agent?.sessions.ecrire(f, d),
      redimensionner: (f, t) => agent?.sessions.redimensionner(f, t),
      profils: async () => (await agent?.profils()) ?? [],
    },
    permissions: {
      enAttente,
      repondre: (id, d, droits, confirme) => {
        const q = questions.get(id);
        if (!q) return;
        questions.delete(id);
        q.repondre(decisionPermise(q.demande, d, confirme), droits);
        diffuser(CANAUX.permissions, enAttente());
      },
    },
    design: {
      calqueDe: (sender) => design?.cibleDeCalque(sender),
      etat: async (c) => {
        if (!design) throw new Error("mode design pas prêt");
        return design.etat(c);
      },
      basculer: (c) => void design?.basculer(c),
      relire: (c) => void design?.relire(c),
      ouvrirPanier: (c) => void design?.ouvrirPanier(c),
      projetDe: async (c) => (await design?.projetCourant(c))?.projet ?? null,
      contexte: (c) => design?.contexteCalque(c) ?? null,
      ajouter: async (c, texte) => (await design?.ajouter(c, texte)) ?? { ok: false, erreur: "mode design pas prêt" },
      annuler: (c) => design?.annuler(c),
      panier: async (p) => (await design?.panier(p)) ?? [],
      retirer: async (p, id) => design?.retirer(p, id),
      envoyer: async (p) => (await design?.envoyer(p)) ?? { ok: false, erreur: "mode design pas prêt" },
      lots: async (p) => (await design?.lots(p)) ?? [],
      traite: async (p, lot) => design?.traite(p, lot),
    },
    externes: {
      liste: async () => (await externes?.etat()) ?? { serveur: { etat: "eteint", raison: echecExternes ?? "Le MCP externe démarre" }, projets: [], clients: [] },
      brancher: async (nom) => {
        if (!externes) throw new Error(echecExternes ?? "Le MCP externe démarre");
        return externes.brancher(nom);
      },
      revoquer: async (id) => void (await externes?.revoquer(id)),
      oublier: async (id) => {
        await externes?.oublier(id);
        relecture?.oublier(`ext-${id}`);
      },
      // « Relire » : la page Relecture du projet, dans la fenêtre qui l'a demandée.
      relire: (f, id) =>
        void design?.projetSuivi(`ext-${id}`).then((p) => {
          if (p?.type === "externe") ouvrirRelecture(f, p.projet, p.nom);
        }),
    },
    relecture: {
      ouvrir: async (p, jeton) => {
        if (!relecture) throw new Error("la relecture n'est pas prête");
        return relecture.ouvrir(p, jeton);
      },
      fichier: async (p, jeton, chemin) => {
        if (!relecture) throw new Error("la relecture n'est pas prête");
        return relecture.fichier(p, jeton, chemin);
      },
      lignes: async (p, jeton, chemin, debut, fin) => {
        if (!relecture) throw new Error("la relecture n'est pas prête");
        return relecture.lignes(p, jeton, chemin, debut, fin);
      },
      commentaires: async (p) => prete().commentaires(p),
      commenter: async (p, jeton, c) => prete().commenter(p, jeton, c),
      modifierCommentaire: async (p, id, texte) => prete().modifierCommentaire(p, id, texte),
      resoudre: async (p, id, resolu) => prete().resoudre(p, id, resolu),
      supprimerCommentaire: async (p, id) => prete().supprimerCommentaire(p, id),
      envoyer: async (p) => prete().envoyer(p),
      relu: async (p, jeton) => prete().relu(p, jeton),
    },
  });
  const cibles: CiblesMenu = {
    fenetreActive: () => {
      const focus = BrowserWindow.getFocusedWindow();
      for (const [id, f] of fenetres) if (f === focus) return id;
      // Une popup a le focus : les raccourcis de fenêtre ne doivent pas viser la fenêtre principale derrière.
      return focus ? undefined : fenetres.keys().next().value;
    },
    fermerPopup: () => {
      const focus = BrowserWindow.getFocusedWindow();
      if (!focus || [...fenetres.values()].includes(focus)) return false;
      focus.close();
      return true;
    },
    oublierAutorisations: (id) => {
      const f = magasin.etat.fenetres.find((x) => x.id === id);
      const onglet = f && magasin.etat.onglets[f.actif[f.espaceActif] ?? ""];
      if (!onglet) return;
      try {
        permissionsDe(profilDOnglet(magasin.etat, onglet)).oublier(new URL(onglet.url).origin);
      } catch {
        // URL sans origine : rien à oublier.
      }
    },
    etat: () => magasin.etat,
    agir: (a) => magasin.agir(a),
    parcourir: (id, delta) => parcours.parcourir(id, delta),
    commande: (id, c) => vues.commande(id, c),
    ouvrirPanneau: (id, p) => fenetres.get(id)?.webContents.send(CANAUX.panneau, p),
    raccourci: (id, r) => {
      const f = fenetres.get(id);
      if (!f) return;
      f.webContents.focus(); // ⌘F depuis une page : le champ de l'interface doit recevoir la frappe
      f.webContents.send(CANAUX.raccourci, r);
    },
    fermerFenetre: (id) => fenetres.get(id)?.close(),
    fermerOnglet: (id) => vues.fermer(id),
    rouvrirFenetres: () => rouvrirFenetres(),
    outilsInterface: (id) => fenetres.get(id)?.webContents.toggleDevTools(),
    surApplication: (action) => (applications?.fenetres.surPremierPlan(action) || sites?.fenetres.surPremierPlan(action)) ?? false,
    design: (action) => {
      // Appli de l'agent, appli de site, petite fenêtre d'une appli de site, autre fenêtre (rien, jamais l'onglet de la
      // fenêtre principale derrière), sinon la fenêtre principale active (spec §4.3).
      const auPremierPlan = BrowserWindow.getFocusedWindow();
      const choix = choisirCibleDesign({
        appli: applications?.fenetres.dossierAuPremierPlan(),
        site: sites?.fenetres.idAuPremierPlan(),
        petiteDeSite: sites?.fenetres.idDePetiteAuPremierPlan(),
        autreFenetre: !!auPremierPlan && ![...fenetres.values()].includes(auPremierPlan),
        fenetreActive: cibles.fenetreActive(),
      });
      if (choix.type === "avis-site") {
        if (action === "basculer") sites?.fenetres.avisInfo(choix.id, INDISPONIBLE_DESIGN_SITE);
        return;
      }
      if (choix.type !== "cible" || !design) return;
      void (action === "basculer" ? design.basculer(choix.cible) : design.relire(choix.cible));
    },
  };
  installerMenu(cibles);
  // La coche du moteur de recherche suit l'état.
  magasin.abonner((etat, avant) => {
    if (etat.reglages.moteur !== avant.reglages.moteur) installerMenu(cibles);
  });
  // Avant les fenêtres : un bloqueur actif agit dès la première page. Une lecture ou un chargement trop lent ne retarde
  // pas la fenêtre plus de 2 s (les extensions arrivent alors un peu après).
  await Promise.race([demarrageExtensions, new Promise((ok) => setTimeout(ok, 2000))]);
  // Une fenêtre principale par EtatFenetre : ⌘N en ajoute une, sa fermeture la retire.
  const synchroniserFenetres = (etat: EtatNavigateur) => {
    for (const f of etat.fenetres) if (!fenetres.has(f.id) && !gardees.has(f.id)) creerFenetre(f.id, magasin, vues, parcours);
    for (const [id, f] of fenetres) if (!etat.fenetres.some((x) => x.id === id) && !f.isDestroyed() && !enFermeture.has(f)) f.close();
  };
  magasin.abonner(synchroniserFenetres);
  synchroniserFenetres(magasin.etat);
  vues.synchroniser(magasin.etat);
  // Reprend les effacements de profils restés en suspens (liste profils-a-effacer.json).
  void sessions.synchroniser(magasin.etat);
  // Une session d'une version précédente est réécrite à la version actuelle, même si rien ne change.
  enregistreur.planifier(magasin.etat);
  // Après les fenêtres : l'agent ne retarde jamais la navigation.
  servirWidgets(() => agent?.chemins.widgets ?? null);
  // Un seul conteneur pour l'agent (quel que soit son profil) et les applis qu'il lance.
  const chemins = cheminsEspace();
  const atelier = new Atelier({ chemins, dossierDocker: join(__RESSOURCES_NOYAU__, "docker") });
  // Lien sortant d'une appli (ou d'une appli de site, sur un clic de l'utilisateur) : un onglet dans la fenêtre principale
  // active, mise au premier plan.
  const ouvrirDansOnglet = (url: string) => {
    if (!fenetreAgent()) rouvrirFenetres();
    const id = fenetreAgent();
    if (!id) return;
    magasin.agir({ type: "ouvrirOnglet", fenetreId: id, url });
    const f = fenetres.get(id);
    if (!f || INVISIBLE) return;
    if (f.isMinimized()) f.restore();
    f.focus();
  };
  applications = demarrerApplications({
    chemins,
    atelier,
    dossierProfil: dossier,
    ouvrirOnglet: ouvrirDansOnglet,
    // La page Applications relit la liste ; le mode design aussi (les ports des applis en marche ont pu changer).
    diffuser: () => {
      diffuser(CANAUX.applicationsChange, null);
      diffuser(CANAUX.designChange, null);
      planifierPriseEnCharge();
    },
    // L'accès de l'agent à « app:<dossier> » tombe avec la fenêtre, son mode design aussi.
    surFenetreFermee: (dossier) => {
      agent?.noyau()?.politique.ongletFerme(`app:${dossier}`);
      design?.oublier({ type: "app", dossier });
      ecarterQuestionsCaduques();
    },
    // Une fenêtre d'appli montre toujours ce que l'agent a construit : de nouveau « construite » sur sa nouvelle origine.
    surNavigation: (dossier, url) => {
      const politique = agent?.noyau()?.politique;
      if (!politique) return;
      politique.ongletNavigue(`app:${dossier}`, url);
      const fenetre = applications?.fenetres.ouvertes().find((a) => a.dossier === dossier);
      politique.construite(ongletApplication({ dossier, titre: fenetre?.titre ?? "", url }));
      ecarterQuestionsCaduques();
    },
    // Comme ⌘J : le panneau s'ouvre et le terminal prend le clavier.
    deboguer: (f, texte, acces) => {
      agent?.preRemplir(f, texte, acces);
      cibles.raccourci(f, "agent");
    },
    relire: (f, dossier, nom) => ouvrirRelecture(f, `app-${dossier}`, nom),
  });
  // Mode design. Les paniers et lots des applis et des démos vont dans l'espace (l'agent les lit) ; les registres des
  // projets externes et des clients, dans le profil du navigateur (jamais monté dans le conteneur).
  const dossiersDesign = { remarquesEspace: join(chemins.interne, "remarques"), prive: join(dossier, "design") };
  const remarques = new Remarques({ dossiers: dossiersDesign });
  let registreExternes: RegistreExternes | null = null;
  const diffuserDesign = () => {
    diffuser(CANAUX.designChange, null);
    diffuser(CANAUX.externesChange, null);
    // La barre des applis de site : le bouton ✎ et le compteur de leur panier.
    sites?.fenetres.diffuserATous(CANAUX.designChange, null);
    design?.calques.notifier();
  };
  // Les clients et projets branchés par un Claude Code : une notification à la première déclaration d'un projet.
  const notifierExterne = creerNotifieur({
    creer: (opts) => new Notification(opts),
    auClic: () => {
      const id = fenetreAgent();
      const f = id ? fenetres.get(id) : undefined;
      if (!f || INVISIBLE) return;
      if (f.isMinimized()) f.restore();
      f.focus();
    },
    ...(process.env.WEBAIOS_TEST_NOTIFICATIONS ? { fichierTest: process.env.WEBAIOS_TEST_NOTIFICATIONS } : {}),
    invisible: INVISIBLE,
  });
  // Le lot envoyé à l'agent (mode design, relecture) : une ligne pré-remplie dans sa session, jamais envoyée.
  const envoiLot = creerEnvoi({
    chemins,
    fenetreAgent,
    rouvrir: () => void rouvrirFenetres(),
    dossierLot: (p, l) => remarques.dossierLot(p, l),
    preRemplir: (f, texte) => agent?.preRemplir(f, texte),
    donnerLeTerminal: (f) => cibles.raccourci(f, "agent"),
    devant: (f) => {
      const fenetre = fenetres.get(f);
      if (!fenetre || fenetre.isDestroyed() || INVISIBLE) return;
      if (fenetre.isMinimized()) fenetre.restore();
      fenetre.focus();
    },
  });
  design = new ServiceDesign({
    remarques,
    registre: () => registreExternes,
    applis: async () =>
      ((await applications?.gestionnaire.liste()) ?? []).flatMap((a) =>
        a.etat === "en-marche" && a.port !== undefined ? [{ dossier: a.dossier, nom: a.nom, port: a.port }] : [],
      ),
    plages: plagesConteneur(process.env.WEBAIOS_PORTS_APPS),
    vueOnglet: (f) => {
      const fenetre = fenetres.get(f);
      const v = vues.vueAffichee(f);
      return fenetre && !fenetre.isDestroyed() && v ? { ...v, fenetre, url: v.wc.getURL() } : null;
    },
    fenetreApp: (d) => applications?.fenetres.fenetre(d) ?? null,
    diffuser: diffuserDesign,
    // « Relire ce projet » (bouton, menu, pastille) : la page Relecture dans la fenêtre principale (celle de l'onglet, ou l'active).
    relire: (p, c) => {
      if (p.type !== "demo") ouvrirRelecture(c.type === "fenetre" ? c.fenetreId : undefined, p.projet, p.nom);
    },
    // Avant le premier lot d'une appli de site, sa première photo de relecture (sans elle, rien à relire ensuite).
    envoyer: async (p, lot) => {
      if (p.type === "site") await relecture?.assurer(p.projet).catch(() => undefined);
      await envoiLot(p, lot);
    },
    // Les applis de site (plan 18) : `sites` démarre plus loin, d'où ces fermetures paresseuses.
    vueSite: (id) => sites?.fenetres.vueDesign(id) ?? null,
    sites: async () => ((await sites?.liste()) ?? []).map(({ id, nom }) => ({ id, nom })),
    messageSite: (id, t) => sites?.fenetres.avisInfo(id, t),
    fermerMenuSite: async (id) => sites?.fenetres.fermerMenu(id),
  });
  // Relecture : la première photo de chaque appli au démarrage, puis à chaque changement de la liste (après 1 s de calme).
  relecture = new ServiceRelecture({
    dossiers: dossiersDesign,
    chemins,
    registre: () => registreExternes,
    applis: async () => (await applications?.gestionnaire.liste()) ?? [],
    sites: async () => ((await sites?.liste()) ?? []).map(({ id, nom }) => ({ id, nom })),
    remarques,
    envoyer: envoiLot,
  });
  const prendreEnCharge = () => {
    void applications?.gestionnaire
      .liste()
      .then((l) => relecture?.priseEnCharge(l.map((a) => a.dossier)))
      .catch((e) => console.error("[relecture] prise en charge :", e));
    // Les applis de site aussi (plan 18) : `sites` démarre plus loin, leur liste suit à chaque changement.
    void sites
      ?.liste()
      .then((l) => relecture?.priseEnChargeSites(l.map((s) => s.id)))
      .catch((e) => console.error("[relecture] prise en charge des sites :", e));
  };
  planifierPriseEnCharge = () => {
    clearTimeout(minuteurPriseEnCharge);
    minuteurPriseEnCharge = setTimeout(prendreEnCharge, 1000);
  };
  prendreEnCharge();
  // Les lots traités ou trop anciens sont purgés au démarrage puis toutes les 24 heures.
  void remarques.purger().catch(() => undefined);
  minuteurPurgeLots = setInterval(() => void remarques.purger().catch(() => undefined), 24 * 60 * 60 * 1000);
  remarques.surChange(diffuserDesign);
  RegistreExternes.ouvrir(dossiersDesign.prive)
    .then((r) => {
      registreExternes = r;
      r.surChange(diffuserDesign);
      // Port demandé, sinon celui de tout le monde ; jamais un autre port si celui-là est pris.
      return demarrerExternes({
        registre: r,
        remarques,
        dossiers: dossiersDesign,
        port: Number(process.env.WEBAIOS_PORT_MCP_EXTERNE ?? PORT_MCP_EXTERNE),
        plages: plagesConteneur(process.env.WEBAIOS_PORTS_APPS),
        racineEspace: chemins.racine,
        maison: homedir(),
        notifier: (n) => notifierExterne({ widget: "externes", ...n }),
      }).then((service) => {
        externes = service;
        diffuserDesign();
      });
    })
    .catch((e) => {
      console.error("[design] projets externes indisponibles :", e);
      echecExternes = raisonEchec(e);
      diffuserDesign();
    });
  /** La page Relecture d'un projet dans la fenêtre `f` (sinon la fenêtre principale active, rouverte au besoin), mise devant. */
  function ouvrirRelecture(f: IdFenetre | undefined, projet: string, nom: string): void {
    if (!f) {
      if (!fenetreAgent()) rouvrirFenetres();
      f = fenetreAgent();
    }
    if (!f) return;
    magasin.agir({ type: "ouvrirRelecture", fenetreId: f, projet, nom: nom.slice(0, 80) });
    const fenetre = fenetres.get(f);
    if (!fenetre || fenetre.isDestroyed() || INVISIBLE) return;
    if (fenetre.isMinimized()) fenetre.restore();
    fenetre.focus();
  }
  // Un autre onglet affiché (ou l'onglet fermé) arrête le mode design de la fenêtre ; après la synchro des vues.
  magasin.abonner(() => design?.verifierOnglets());
  // Les applis de site : leurs fenêtres n'attendent ni Docker ni l'agent.
  sites = demarrerSites({
    chemins,
    dossierProfil: dossier,
    preloadSite: join(__dirname, "../preload/site.js"),
    cheminGarde: join(__RESSOURCES_NOYAU__, "extensions", "webaios-garde-page.js"),
    adressesLocales: process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1",
    ouvrirOnglet: (url) => {
      if (/^https?:\/\//.test(url)) ouvrirDansOnglet(url);
    },
    deboguer: (f, texte) => {
      agent?.preRemplir(f, texte);
      cibles.raccourci(f, "agent");
    },
    // La section « Sites » de la page Applications relit la liste ; la relecture prend la photo d'une nouvelle appli.
    diffuser: () => {
      diffuser(CANAUX.sitesChange, null);
      planifierPriseEnCharge();
    },
    // « Relire » de la carte : la page Relecture du dossier de l'appli, sous son nom.
    relire: (f, id) =>
      void sites
        ?.liste()
        .then((l) => ouvrirRelecture(f, `site-${id}`, l.find((s) => s.id === id)?.nom ?? id))
        .catch((e) => console.error("[relecture] relire un site :", e)),
    // L'agent perd ses outils de développement sur la fenêtre fermée ; ses cartes d'outils sur elle tombent. La carte de
    // l'appli et son accord, eux, valent pour l'appli et la conversation (rouverte, elle reste ouverte à l'agent).
    surFermee: (id) => {
      agent?.noyau()?.politique.ongletFerme(`${PREFIXE_SITE}${id}`);
      ecarterQuestionsCaduques();
      // Son mode design s'arrête et son calque est fermé (le panier reste).
      design?.oublier({ type: "site", id });
    },
    // L'accueil (⌂), la carte d'accord, le plein écran d'un élément ou le menu « Extensions » arrêtent son mode design.
    surInterruption: (id) => void design?.arreter({ type: "site", id }),
    // Supprimée : l'accord de lecture de l'agent sur l'appli tombe (une appli recréée au même id redemande la carte).
    // Son mode design, son panier, ses lots, son dépôt de relecture et ses commentaires sont effacés avec elle.
    surSupprimee: (id) => {
      agent?.noyau()?.politique.retirerLectureSite(id);
      design?.oublier({ type: "site", id });
      void remarques.oublier(`site-${id}`).catch((e) => console.error(`[design] remarques de ${id} non effacées :`, e));
      void relecture?.effacer(`site-${id}`).catch((e) => console.error(`[relecture] relecture de ${id} non effacée :`, e));
    },
    // Les extensions du Store activées dans l'appli (plan 16) : chargées avant sa première page, et seulement pendant
    // qu'elle est ouverte ; la vue du site est leur seul onglet ; retirées (stockage effacé) à la suppression.
    extensions: {
      ouverture: (id, empreinte) => serviceExtensions.ouvertureSite(id, empreinte),
      fermeture: (id) => serviceExtensions.fermetureSite(id),
      suppression: (id) => serviceExtensions.retirerSite(id),
      surVue: (_id, quoi, wc, f) => {
        if (quoi === "detruite") return extensions.ongletDetruit(wc);
        extensions.ongletCree(wc, f);
        extensions.ongletActive(wc);
      },
    },
  });
  // La première photo de relecture des applis de site déjà là (la prise en charge du démarrage les précède).
  void sites
    .liste()
    .then((l) => relecture?.priseEnChargeSites(l.map((s) => s.id)))
    .catch((e) => console.error("[relecture] prise en charge des sites :", e));
  // Tests seulement : la console des retouches, lue par les e2e (l'agent la lit par son outil MCP).
  if (process.env.WEBAIOS_TEST_ADRESSES_LOCALES === "1") {
    (globalThis as { __webaiosErreursRetouches?: (id: string) => unknown }).__webaiosErreursRetouches = (id) => sites?.erreurs(id) ?? [];
  }
  // Mode design, tests seulement : le viseur est appelé directement par les e2e (l'interface le branche à la tâche suivante).
  if (INVISIBLE) {
    (globalThis as { __webaiosViseur?: unknown }).__webaiosViseur = { armer: armerViseur, desarmer: desarmerViseur, lireSource, capturer: capturerElement };
  }
  /**
   * Où s'affiche une question de l'agent : sa fenêtre (ou `champs.fenetreId`, la fenêtre d'un clic de l'utilisateur), quel que
   * soit l'onglet affiché.
   */
  const poserQuestion = (champs: Omit<Demande, "ongletId">, repondre: (d: Issue, droits?: DroitDev[]) => void): (() => void) => {
    const id = randomUUID();
    const { fenetreId: demandee, ...reste } = champs;
    const fenetreId = demandee && fenetres.has(demandee) ? demandee : fenetreAgent();
    questions.set(id, {
      demande: { id, ongletId: ongletActifDe(magasin.etat, fenetreId)?.id ?? null, ...(fenetreId ? { fenetreId } : {}), ...reste },
      repondre,
    });
    diffuser(CANAUX.permissions, enAttente());
    return () => {
      questions.delete(id);
      diffuser(CANAUX.permissions, enAttente());
    };
  };
  // Une question qui vise une fenêtre fermée ne serait plus jamais vue (et une carte sans délai ne tomberait jamais).
  questionsFenetreFermee = (fermee) => {
    const autre = fenetreAgent();
    let change = false;
    for (const [id, q] of questions) {
      if (q.demande.fenetreId !== fermee) continue;
      change = true;
      if (autre) q.demande = { ...q.demande, fenetreId: autre, ongletId: ongletActifDe(magasin.etat, autre)?.id ?? null };
      else {
        questions.delete(id);
        q.repondre("retiree");
      }
    }
    if (change) diffuser(CANAUX.permissions, enAttente());
  };
  // Les cartes d'accord des extensions passent par les mêmes questions (modale de la fenêtre). La carte de test des
  // e2e n'est posée qu'en mode invisible.
  serviceExtensions.brancherQuestions(poserQuestion, {
    ...(INVISIBLE && process.env.WEBAIOS_TEST_CARTE_EXTENSION ? { carteTest: process.env.WEBAIOS_TEST_CARTE_EXTENSION } : {}),
  });
  /** Une question de l'agent sur un onglet (lecture, outils de développement) : elle tombe avec l'onglet. */
  const poserQuestionAgent = (
    o: OngletInfo,
    repondre: (d: Issue, droits?: DroitDev[]) => void,
    plus: Pick<Demande, "permissions" | "droits" | "raison" | "agent">,
  ): (() => void) => poserQuestion({ cible: o.id, origine: origineDe(o.url), titre: o.titre, ...plus }, repondre);
  agent = demarrerAgent({
    // Outils MCP des extensions : lister, demander (carte d'accord), recharger, console filtrée et son déblocage.
    extensions: serviceExtensions.outilsAgent({ fenetreAgent }),
    // Outils MCP des applis de site ; relus à chaque appel (le service est créé plus haut, jamais remplacé).
    sites: {
      lister: async () =>
        ((await sites?.listeAgent()) ?? []).map((s) => ({
          id: s.id, nom: s.nom, domaine: s.domaine, ouverte: s.ouverte, ...(s.erreur !== undefined ? { erreur: s.erreur } : {}),
          ...(s.empreinte !== undefined ? { empreinte: s.empreinte } : {}),
        })),
      ouvrir: async (id) => (await sites?.ouvrirParId(id)) ?? false,
      memoire: async (id) => {
        if (!sites || !(await sites.liste()).some((s) => s.id === id)) return null;
        return (await sites.memoire(id)).contenu();
      },
      erreurs: async (id) => {
        if (!sites || !(await sites.liste()).some((s) => s.id === id)) return null;
        return sites.erreurs(id).map(({ quand, texte, source }) => ({ quand, texte, source }));
      },
    },
    atelier,
    historique,
    // Profils bruts des sites tiers : dans le profil du navigateur, jamais dans l'espace que l'agent lit.
    dossierProfilage: join(dossier, "profilage"),
    // Données récoltées et accords des widgets : hors de l'espace, que l'agent lit.
    dossierWidgets: join(dossier, "widgets"),
    dossierActions,
    surDirectActions: diffuserDirectActions,
    surActions: () => diffuser(CANAUX.actionsChange, null),
    // Lectures invisibles des widgets avec un compte : la session du profil de connexion (non privé, vérifié au pont).
    sessionProfil: (id) => sessions.session(id),
    applications: applications.gestionnaire,
    fenetresApplications: applications.fenetres,
    // La vue du site de chaque appli ouverte (jamais sa barre ni son accueil) ; relu à chaque appel.
    fenetresSites: {
      ouvertes: () => sites?.fenetres.ouvertes() ?? [],
      webContents: (id) => sites?.fenetres.vueSite(id),
      adressePermise: (id, url) => sites?.adressePermise(id, url) ?? false,
      naviguer: (id, url) => sites?.fenetres.naviguerPourAgent(id, url) ?? "refuse",
    },
    magasin,
    vues,
    fenetres,
    fenetreActive: fenetreAgent,
    surAccueil: () => diffuser(CANAUX.accueilChange, null),
    workflowOuvert: (f) => workflowOuvertDe(magasin.etat, selectionsConstructeur, f),
    surDirect: (e) => diffuser(CANAUX.workflowDirect, e),
    dossierIa: join(dossier, "ia-locale"),
    surEtatIa: diffuserEtatIa,
    // Les pastilles suivent la politique d'accès ; une rafale de changements ne donne qu'une diffusion par 50 ms.
    surAcces: () => {
      if (diffusionAcces) return;
      diffusionAcces = setTimeout(() => {
        diffusionAcces = undefined;
        const acces = etatAcces();
        diffuser(CANAUX.acces, acces);
        applications?.fenetres.diffuserAcces(acces);
      }, 50);
    },
    // « L'agent veut lire l'onglet … » dans la fenêtre active ; jamais mémorisé hors de la politique du noyau.
    demanderLecture: (o) => attendreReponse((repondre) => poserQuestionAgent(o, repondre, { permissions: ["lire-onglet"] })),
    // La carte des outils de développement : les droits cochés par l'utilisateur, `[]` s'il refuse ou ne répond pas. Le noyau
    // la retire (signal) quand une nouvelle conversation commence ou qu'il s'arrête.
    demanderOutilsDev: (o, d, signal) =>
      attendreDroits(
        (repondre) => poserQuestionAgent(o, repondre, { permissions: ["outils-dev"], droits: d.droits, raison: d.raison, agent: d.agent }),
        DELAI_QUESTION_MS,
        signal,
      ),
    // « L'agent veut voir les données du widget « <nom> » (lues avec ton compte). » Le noyau retient l'accord pour la
    // conversation en cours et retire la carte (signal) quand une nouvelle commence.
    demanderDonneesWidget: (w, signal) =>
      attendreReponse(
        (repondre) =>
          poserQuestion(
            w.genre === "action"
              ? { origine: `webaios://action/${w.id}`, permissions: ["donnees-widget"], titre: w.nom, action: w.id, agent: w.agent }
              : w.genre === "site"
                ? { origine: `${SCHEMA_SITE}://${w.id}`, permissions: ["donnees-widget"], titre: w.nom, site: w.id, agent: w.agent }
                : { origine: `${SCHEMA_WIDGET}://${w.id}`, permissions: ["donnees-widget"], titre: w.nom, widget: w.id, agent: w.agent },
            repondre,
          ),
        DELAI_QUESTION_MS,
        signal,
      ),
    // Fin d'une veille avec de nouveaux éléments : titre = nom du widget, texte = leur nombre. Un clic rouvre les
    // fenêtres s'il n'y en a plus, puis met au premier plan la dernière utilisée, sans changer d'onglet.
    notifier: creerNotifieur({
      creer: (opts) => new Notification(opts),
      auClic: () => {
        if (!fenetreAgent()) rouvrirFenetres();
        const id = fenetreAgent();
        const f = id ? fenetres.get(id) : undefined;
        if (!f || INVISIBLE) return;
        if (f.isMinimized()) f.restore();
        f.focus();
      },
      ...(process.env.WEBAIOS_TEST_NOTIFICATIONS ? { fichierTest: process.env.WEBAIOS_TEST_NOTIFICATIONS } : {}),
      invisible: INVISIBLE,
    }),
  });
  // macOS, plus aucune fenêtre : la rouvrir telle qu'elle était (vrai si c'est le cas).
  rouvrirFenetres = () => {
    if (fenetres.size > 0) return false;
    gardees.clear();
    synchroniserFenetres(magasin.etat);
    vues.synchroniser(magasin.etat);
    return true;
  };
});

// Relancer l'app (Dock, Finder, terminal) ramène la fenêtre existante au premier plan.
app.on("second-instance", () => {
  const f = BrowserWindow.getFocusedWindow() ?? fenetres.values().next().value;
  if (!f) return;
  if (f.isMinimized()) f.restore();
  f.focus();
});

// Clic sur l'icône du Dock sans fenêtre ouverte.
app.on("activate", () => rouvrirFenetres());

app.on("will-quit", () => {
  clearInterval(minuteurPurge);
  clearInterval(minuteurPurgeLots);
  clearTimeout(minuteurPriseEnCharge);
  void externes?.arreter();
  arreterMisesAJour?.();
  historique?.fermer();
});

// Les fenêtres principales décident seules de quitter (voir creerFenetre).
app.on("window-all-closed", () => {});

let sessionEcrite = false;
app.on("before-quit", (e) => {
  enSortie = true;
  if (sessionEcrite || !enregistreur) return;
  e.preventDefault();
  // ⌘Q : les fenêtres se ferment après l'écriture de la session, leur cadre doit y être avant.
  if (magasinGlobal) for (const [id, f] of fenetres) noterCadre(id, f, magasinGlobal);
  // Les applis s'arrêtent (et leurs fenêtres se ferment) avant l'écriture de la session.
  const enregistrement = enregistreur;
  const ecriture = Promise.allSettled([applications?.arreter(), sites?.arreter()]).then(() => enregistrement.vider());
  void Promise.allSettled([agent?.arreter(), ecriture]).finally(() => {
    sessionEcrite = true;
    app.quit();
  });
});
