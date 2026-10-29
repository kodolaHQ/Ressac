import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, session, shell, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import {
  contexteHistorique,
  profilsChanges,
  profilDOnglet,
  type Decision,
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
import { GestionnaireVues } from "./onglets/vues";
import { Permissions } from "./permissions";
import { cheminProfil } from "./profil";
import { estInvisible } from "./contenus-invisibles";
import { fichierPermissions, SessionsProfils } from "./profils-connexion";
import { Telechargements } from "./telechargements";
import { demarrerAgent, type ServiceAgent } from "./agent/agent";
import { creerNotifieur } from "./notifications";
import { attendreDroits, attendreReponse, DELAI_QUESTION_MS, espacesDevenusPrives, origineDe, ongletActifDe, ongletApplication, questionCaduque } from "./agent/pont";
import { Atelier, catalogueBlocs, cheminsEspace, lireAccueil, retirerAccord, supprimerDonnees, type DroitDev, type OngletInfo } from "@webaios/noyau";
import { SchemaIdWidget, type EtatIaAffiche } from "../commun/api";
import { cadreVisible } from "./applications/fenetres";
import { demarrerApplications, type ServiceApplications } from "./applications/service";
import { gardienGestes } from "./agent/geste-widget";
import { enregistrerSchemaWidget, executionWidget, executionsWidget, navigationCadrePermise, widgetDuCadre, lireWidgetsAffiches, permissionInterface, placerWidgets, profilsPourAccord, retirerWidget, SCHEMA_WIDGET, servirWidgets, urlOuvrable } from "./agent/accueil";
import { enregistrerCodeSur, enregistrerEdition, FileEcritures, lireCodeSur, lireEdition, workflowOuvertDe, type SelectionConstructeur } from "./agent/constructeur";
import { profilsLisibles } from "./agent/lecture-invisible";
import { couperReseauInterface, repondreIcone, SCHEMA_ICONE } from "./reseau-interface";

declare const __RESSOURCES_NOYAU__: string;

// Avant tout getPath : le nom fixe aussi le dossier du profil (~/Library/Application Support/WebAiOs).
app.setName("WebAiOs");
app.setPath("userData", cheminProfil());

// Une seule instance par profil : deux processus écriraient la même session et le même historique.
// (Le verrou d'Electron porte sur userData, d'où l'appel après setPath.)
if (!app.requestSingleInstanceLock()) app.exit(0);
enregistrerSchemaWidget([SCHEMA_ICONE]);
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

// Une exception oubliée ne doit ni figer l'app derrière une boîte de dialogue, ni la quitter.
process.on("uncaughtException", (e) => console.error("[webaios] exception non rattrapée :", e));

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
/** Vrais clics dans l'interface de chaque fenêtre : seuls eux permettent à un widget d'ouvrir un lien. */
const gestesWidgets = gardienGestes<IdFenetre>();

function noterCadre(id: IdFenetre, f: BrowserWindow, magasin: Magasin): void {
  if (f.isDestroyed() || f.isFullScreen() || f.isMinimized()) return;
  const { x, y, width, height } = f.getNormalBounds();
  magasin.agir({ type: "cadrerFenetre", id, cadre: { x, y, largeur: width, hauteur: height } });
}

function creerFenetre(id: IdFenetre, magasin: Magasin, vues: GestionnaireVues): BrowserWindow {
  const cadre = cadreVisible(magasin.etat.fenetres.find((f) => f.id === id)?.cadre);
  const fenetre = new BrowserWindow({
    width: 1400,
    height: 900,
    ...cadre,
    show: !INVISIBLE,
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
    boutonsFenetre.delete(id);
    selectionsConstructeur.delete(id);
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
let agent: ServiceAgent | undefined;
const fileEcritures = new FileEcritures();
const MESSAGE_AGENT_ARRETE = "Le service des widgets ne répond pas (agent arrêté ?)";
let applications: ServiceApplications | undefined;
let magasinGlobal: Magasin | undefined;
let historique: Historique | undefined;
let minuteurPurge: NodeJS.Timeout | undefined;

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  // Avant toute fenêtre : la session de l'interface (et donc les affichages des widgets) ne sort jamais sur le réseau.
  // Les favicons arrivent par webaios-icone:, cherchés dans une session à part (en mémoire, sans le profil de l'utilisateur).
  try {
    await couperReseauInterface(session.defaultSession, process.env.ELECTRON_RENDERER_URL);
  } catch (e) {
    console.error("[webaios] le réseau de l'interface n'a pas pu être coupé :", e);
  }
  const sessionIcones = session.fromPartition("webaios-icones");
  protocol.handle(SCHEMA_ICONE, (requete) => repondreIcone((url, init) => sessionIcones.fetch(url, init), requete.url));
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
  const questions = new Map<string, { demande: DemandeEnAttente; repondre: (d: Decision, droits?: DroitDev[]) => void }>();
  const enAttente = () => [...questions.values()].map((q) => q.demande);
  const demander = (d: Demande) =>
    new Promise<Decision>((repondre) => {
      const id = randomUUID();
      questions.set(id, { demande: { ...d, id }, repondre });
      diffuser(CANAUX.permissions, enAttente());
    });
  /** Autorisations des sites, une instance par profil de connexion. */
  const permissions = new Map<IdProfil, Permissions>();
  const permissionsDe = (id: IdProfil) => {
    let p = permissions.get(id);
    if (!p) permissions.set(id, (p = new Permissions({ fichier: fichierPermissions(dossier, id), demander })));
    return p;
  };
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
    },
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
  });
  // Un onglet fermé (ou parti vers un autre site, pour les outils de développement) ne répondra jamais : ses questions
  // sont refusées. Une fenêtre d'appli (`app:<dossier>`) n'est pas dans l'état : on regarde ses fenêtres ouvertes.
  const ecarterQuestionsCaduques = () => {
    let change = false;
    for (const [id, q] of questions) {
      const d = q.demande;
      const appli = d.cible?.startsWith("app:") ? applications?.fenetres.ouvertes().find((a) => `app:${a.dossier}` === d.cible) : undefined;
      const appliCaduque = d.cible?.startsWith("app:") && (!appli || origineDe(appli.url) !== d.origine);
      if (appliCaduque || questionCaduque(d, magasin.etat)) {
        questions.delete(id);
        q.repondre("refuser");
        change = true;
      }
    }
    if (change) diffuser(CANAUX.permissions, enAttente());
  };
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
  brancherIpc({
    magasin,
    fenetreDe,
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
      lire: async (id) => (agent ? lireEdition({ chemins: agent.chemins, dossierWidgets: agent.dossierWidgets }, id) : null),
      enregistrer: async (id, brouillon) =>
        agent
          ? fileEcritures.enSerie(id, () => enregistrerEdition({ chemins: agent!.chemins, dossierWidgets: agent!.dossierWidgets }, id, brouillon))
          : { ok: false as const, erreur: MESSAGE_AGENT_ARRETE, avertissements: [] },
      lireCode: async (id, nom) => (agent ? lireCodeSur(agent.chemins, id, nom) : { erreur: MESSAGE_AGENT_ARRETE }),
      enregistrerCode: async (id, nom, texte) =>
        agent ? fileEcritures.enSerie(id, () => enregistrerCodeSur(agent!.chemins, id, nom, texte)) : { ok: false as const, erreur: MESSAGE_AGENT_ARRETE },
      rejouer: async (id, execution, bloc) => {
        const noyau = agent?.noyau();
        return noyau ? noyau.rejouer(id, execution, bloc) : { ok: false as const, erreur: MESSAGE_AGENT_ARRETE };
      },
      // Sans noyau : {} (l'interface ne sélectionne alors aucune exécution) ; une récolte qui échoue ne lève rien.
      lancer: async (id) => {
        const noyau = agent?.noyau();
        if (!noyau) return {};
        try {
          const r = await noyau.recolterMaintenant(id, "manuelle");
          return r.execution === undefined ? {} : { execution: r.execution };
        } catch (e) {
          console.error(`[webaios] exécution du widget ${id} :`, e);
          return {};
        }
      },
      selection: (f, widget, bloc) => {
        selectionsConstructeur.set(f, { widget, bloc });
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
      repondre: (id, d, droits) => {
        const q = questions.get(id);
        if (!q) return;
        questions.delete(id);
        q.repondre(d, droits);
        diffuser(CANAUX.permissions, enAttente());
      },
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
    surApplication: (action) => applications?.fenetres.surPremierPlan(action) ?? false,
  };
  installerMenu(cibles);
  // La coche du moteur de recherche suit l'état.
  magasin.abonner((etat, avant) => {
    if (etat.reglages.moteur !== avant.reglages.moteur) installerMenu(cibles);
  });
  // Une fenêtre principale par EtatFenetre : ⌘N en ajoute une, sa fermeture la retire.
  const synchroniserFenetres = (etat: EtatNavigateur) => {
    for (const f of etat.fenetres) if (!fenetres.has(f.id) && !gardees.has(f.id)) creerFenetre(f.id, magasin, vues);
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
  const fenetreAgent = (): IdFenetre | undefined => {
    const focus = BrowserWindow.getFocusedWindow();
    for (const [id, f] of fenetres) if (f === focus) return id;
    return derniereFocalisee && fenetres.has(derniereFocalisee) ? derniereFocalisee : fenetres.keys().next().value;
  };
  servirWidgets(() => agent?.chemins.widgets ?? null);
  // Un seul conteneur pour l'agent (quel que soit son profil) et les applis qu'il lance.
  const chemins = cheminsEspace();
  const atelier = new Atelier({ chemins, dossierDocker: join(__RESSOURCES_NOYAU__, "docker") });
  applications = demarrerApplications({
    chemins,
    atelier,
    dossierProfil: dossier,
    // Lien sortant d'une appli : un onglet dans la fenêtre principale active, mise au premier plan.
    ouvrirOnglet: (url) => {
      if (!fenetreAgent()) rouvrirFenetres();
      const id = fenetreAgent();
      if (!id) return;
      magasin.agir({ type: "ouvrirOnglet", fenetreId: id, url });
      const f = fenetres.get(id);
      if (!f || INVISIBLE) return;
      if (f.isMinimized()) f.restore();
      f.focus();
    },
    // La page Applications relit la liste.
    diffuser: () => diffuser(CANAUX.applicationsChange, null),
    // L'accès de l'agent à « app:<dossier> » tombe avec la fenêtre.
    surFenetreFermee: (dossier) => {
      agent?.noyau()?.politique.ongletFerme(`app:${dossier}`);
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
  });
  /** Où s'affiche une question de l'agent : sa fenêtre, quel que soit l'onglet affiché. */
  const poserQuestion = (champs: Omit<Demande, "ongletId" | "fenetreId">, repondre: (d: Decision, droits?: DroitDev[]) => void): (() => void) => {
    const id = randomUUID();
    const fenetreId = fenetreAgent();
    questions.set(id, {
      demande: { id, ongletId: ongletActifDe(magasin.etat, fenetreId)?.id ?? null, ...(fenetreId ? { fenetreId } : {}), ...champs },
      repondre,
    });
    diffuser(CANAUX.permissions, enAttente());
    return () => {
      questions.delete(id);
      diffuser(CANAUX.permissions, enAttente());
    };
  };
  /** Une question de l'agent sur un onglet (lecture, outils de développement) : elle tombe avec l'onglet. */
  const poserQuestionAgent = (
    o: OngletInfo,
    repondre: (d: Decision, droits?: DroitDev[]) => void,
    plus: Pick<Demande, "permissions" | "droits" | "raison" | "agent">,
  ): (() => void) => poserQuestion({ cible: o.id, origine: origineDe(o.url), titre: o.titre, ...plus }, repondre);
  agent = demarrerAgent({
    atelier,
    historique,
    // Profils bruts des sites tiers : dans le profil du navigateur, jamais dans l'espace que l'agent lit.
    dossierProfilage: join(dossier, "profilage"),
    // Données récoltées et accords des widgets : hors de l'espace, que l'agent lit.
    dossierWidgets: join(dossier, "widgets"),
    // Lectures invisibles des widgets avec un compte : la session du profil de connexion (non privé, vérifié au pont).
    sessionProfil: (id) => sessions.session(id),
    applications: applications.gestionnaire,
    fenetresApplications: applications.fenetres,
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
        (repondre) => poserQuestion({ origine: `${SCHEMA_WIDGET}://${w.id}`, permissions: ["donnees-widget"], titre: w.nom, widget: w.id, agent: w.agent }, repondre),
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
  const ecriture = Promise.allSettled([applications?.arreter()]).then(() => enregistrement.vider());
  void Promise.allSettled([agent?.arreter(), ecriture]).finally(() => {
    sessionEcrite = true;
    app.quit();
  });
});
