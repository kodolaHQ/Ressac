import { app, BrowserWindow, session, shell, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { Decision, DemandeEnAttente, EtatNavigateur, IdFenetre } from "../commun/modele";
import { randomUUID } from "node:crypto";
import { chargerSession, EnregistreurSession } from "./etat/persistance";
import { brancherIpc, Magasin } from "./ipc";
import { versUrl } from "./adresse";
import { Historique } from "./historique";
import { installerMenu, type CiblesMenu } from "./menu";
import { GestionnaireVues } from "./onglets/vues";
import { Permissions } from "./permissions";
import { cheminProfil } from "./profil";
import { Telechargements } from "./telechargements";
import { demarrerAgent, type ServiceAgent } from "./agent/agent";
import { attendreReponse, ongletActifDe, questionCaduque } from "./agent/pont";
import { Atelier, cheminsEspace } from "@webaios/noyau";
import { cadreVisible } from "./applications/fenetres";
import { demarrerApplications, type ServiceApplications } from "./applications/service";
import { enregistrerSchemaBloc, lireBlocsAffiches, ordonnerBlocs, protegerWebviews, retirerBloc, servirBlocs } from "./agent/accueil";

declare const __RESSOURCES_NOYAU__: string;

// Avant tout getPath : le nom fixe aussi le dossier du profil (~/Library/Application Support/WebAiOs).
app.setName("WebAiOs");
app.setPath("userData", cheminProfil());

// Une seule instance par profil : deux processus écriraient la même session et le même historique.
// (Le verrou d'Electron porte sur userData, d'où l'appel après setPath.)
if (!app.requestSingleInstanceLock()) app.exit(0);
enregistrerSchemaBloc();

/** Tests automatiques : aucune fenêtre à l'écran ni icône dans le Dock (elles gênent l'utilisateur pendant qu'il travaille). */
export const INVISIBLE = process.env.WEBAIOS_INVISIBLE === "1";
if (INVISIBLE) app.dock?.hide();

// Une exception oubliée ne doit ni figer l'app derrière une boîte de dialogue, ni la quitter.
process.on("uncaughtException", (e) => console.error("[webaios] exception non rattrapée :", e));

/** Fenêtres principales (avec l'interface WebAiOs), par id d'état. */
const fenetres = new Map<IdFenetre, BrowserWindow>();

/** Vrai dès que l'app quitte : les fenêtres qui se ferment alors restent dans la session, pour la restauration. */
let enSortie = false;
const enFermeture = new WeakSet<BrowserWindow>();
/** Fenêtres fermées mais gardées dans l'état (macOS) : à ne pas recréer avant que l'utilisateur les rouvre. */
const gardees = new Set<IdFenetre>();
/** Dernière fenêtre principale passée au premier plan : celle que l'agent considère comme « active ». */
let derniereFocalisee: IdFenetre | undefined;

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
    backgroundColor: "#1e1e22",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Blocs d'app de la page d'accueil, filtrés par protegerWebviews.
      webviewTag: true,
      additionalArguments: [`${ARG_FENETRE}${id}`],
    },
  });
  fenetres.set(id, fenetre);
  fenetre.on("focus", () => (derniereFocalisee = id));
  // Sortie du plein écran par la fenêtre (bouton vert) : la page doit sortir aussi.
  fenetre.on("leave-full-screen", () => fenetre.webContents.send(CANAUX.pleinEcran, false));
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
  // Fermer une fenêtre parmi d'autres la retire de la session (avec ses onglets) ; la dernière reste, pour la
  // restauration. Sur « closed » : un window.close() de la page détruit la fenêtre sans émettre « close ».
  fenetre.on("closed", () => {
    fenetres.delete(id);
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
  // Seul un lien d'un bloc de la page d'accueil demande une fenêtre : il devient un onglet.
  fenetre.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:\/\//.test(url)) magasin.agir({ type: "ouvrirOnglet", fenetreId: id, url, activer: disposition !== "background-tab" });
    return { action: "deny" };
  });
  protegerWebviews(fenetre.webContents, (vue) => vues.brancherVueAccueil(vue, id));
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

function fenetreDe(e: IpcMainEvent): IdFenetre | undefined {
  for (const [id, f] of fenetres) if (!f.isDestroyed() && f.webContents === e.sender) return id;
  return undefined;
}

let enregistreur: EnregistreurSession | undefined;
let rouvrirFenetres = (): boolean => false;
let agent: ServiceAgent | undefined;
let applications: ServiceApplications | undefined;
let magasinGlobal: Magasin | undefined;
let historique: Historique | undefined;

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  const magasin = new Magasin(await chargerSession(dossier));
  magasinGlobal = magasin;
  enregistreur = new EnregistreurSession(dossier);
  historique = new Historique(join(dossier, "historique.sqlite"));
  const sessionWeb = session.fromPartition("persist:webaios");
  const diffuser = (canal: string, valeur: unknown) => {
    for (const f of fenetres.values()) if (!f.isDestroyed()) f.webContents.send(canal, valeur);
  };
  const telechargements = new Telechargements({
    dossier: process.env.WEBAIOS_TELECHARGEMENTS ?? app.getPath("downloads"),
    diffuser: (liste) => diffuser(CANAUX.telechargements, liste),
    shell,
  });
  sessionWeb.on("will-download", (_e, item) => telechargements.suivre(item));
  const vues = new GestionnaireVues({
    session: sessionWeb,
    fenetres,
    agir: (a) => magasin.agir(a),
    bordGauche: (id, dedans) => fenetres.get(id)?.webContents.send(CANAUX.bordGauche, dedans),
    historique,
    resultatRecherche: (id, r) => fenetres.get(id)?.webContents.send(CANAUX.resultatRecherche, r),
    // Électron met lui-même la fenêtre en plein écran natif : l'interface n'a qu'à s'effacer.
    pleinEcran: (id, actif) => fenetres.get(id)?.webContents.send(CANAUX.pleinEcran, actif),
  });
  // Questions d'autorisation en attente d'une réponse de l'utilisateur (bandeau de l'onglet concerné).
  const questions = new Map<string, { demande: DemandeEnAttente; repondre: (d: Decision) => void }>();
  const enAttente = () => [...questions.values()].map((q) => q.demande);
  const permissions = new Permissions({
    fichier: join(dossier, "permissions.json"),
    demander: (d) =>
      new Promise<Decision>((repondre) => {
        const id = randomUUID();
        questions.set(id, { demande: { ...d, id }, repondre });
        diffuser(CANAUX.permissions, enAttente());
      }),
  });
  permissions.brancher(sessionWeb, (wc) => vues.ongletDe(wc));
  // Un onglet fermé ne répondra jamais : ses questions sont refusées.
  magasin.abonner((etat) => {
    let change = false;
    for (const [id, q] of questions)
      if (questionCaduque(q.demande, etat)) {
        questions.delete(id);
        q.repondre("refuser");
        change = true;
      }
    if (change) diffuser(CANAUX.permissions, enAttente());
  });
  magasin.abonner((etat) => {
    diffuser(CANAUX.etat, etat);
    vues.synchroniser(etat);
    enregistreur?.planifier(etat);
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
    fermerOnglet: (id) => vues.fermer(id),
    historique,
    telechargements,
    accueil: {
      async lire() {
        if (!agent) return [];
        try {
          return await lireBlocsAffiches(agent.chemins);
        } catch (e) {
          console.error("[webaios] page d'accueil illisible :", e);
          return [];
        }
      },
      // La surveillance du dossier renvoie la page à jour aux fenêtres.
      ordonner: (ordre) => {
        if (agent) ordonnerBlocs(agent.chemins, ordre).catch((e) => console.error("[webaios] disposition non écrite :", e));
      },
      retirer: (id) => {
        if (agent) retirerBloc(agent.chemins, id).catch((e) => console.error(`[webaios] bloc ${id} non retiré :`, e));
      },
    },
    agent: {
      demarrer: (f, t) => void agent?.sessions.demarrer(f, t),
      ecrire: (f, d) => agent?.sessions.ecrire(f, d),
      redimensionner: (f, t) => agent?.sessions.redimensionner(f, t),
      profils: async () => (await agent?.profils()) ?? [],
    },
    permissions: {
      enAttente,
      repondre: (id, d) => {
        const q = questions.get(id);
        if (!q) return;
        questions.delete(id);
        q.repondre(d);
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
        permissions.oublier(new URL(onglet.url).origin);
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
  // Après les fenêtres : l'agent ne retarde jamais la navigation.
  const fenetreAgent = (): IdFenetre | undefined => {
    const focus = BrowserWindow.getFocusedWindow();
    for (const [id, f] of fenetres) if (f === focus) return id;
    return derniereFocalisee && fenetres.has(derniereFocalisee) ? derniereFocalisee : fenetres.keys().next().value;
  };
  servirBlocs(() => agent?.chemins.blocs ?? null);
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
    // La page des applications viendra s'y abonner.
    diffuser: () => {},
    // L'accès de l'agent à « app:<dossier> » tombe avec la fenêtre.
    surFenetreFermee: (dossier) => agent?.noyau()?.politique.ongletFerme(`app:${dossier}`),
  });
  agent = demarrerAgent({
    atelier,
    applications: applications.gestionnaire,
    fenetresApplications: applications.fenetres,
    magasin,
    vues,
    fenetres,
    fenetreActive: fenetreAgent,
    surAccueil: () => diffuser(CANAUX.accueilChange, null),
    // « L'agent veut lire l'onglet … » dans la fenêtre active ; jamais mémorisé hors de la politique du noyau.
    demanderLecture: (o) =>
      attendreReponse((repondre) => {
        const id = randomUUID();
        const fenetreId = fenetreAgent();
        let origine = o.url;
        try {
          origine = new URL(o.url).origin;
        } catch {
          // URL sans origine : affichée telle quelle
        }
        questions.set(id, {
          demande: {
            id,
            ongletId: ongletActifDe(magasin.etat, fenetreId)?.id ?? null,
            ...(fenetreId ? { fenetreId } : {}),
            cible: o.id,
            origine,
            titre: o.titre,
            permissions: ["lire-onglet"],
          },
          repondre,
        });
        diffuser(CANAUX.permissions, enAttente());
        return () => {
          questions.delete(id);
          diffuser(CANAUX.permissions, enAttente());
        };
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

app.on("will-quit", () => historique?.fermer());

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
