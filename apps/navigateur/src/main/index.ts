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

// Avant tout getPath : le nom fixe aussi le dossier du profil (~/Library/Application Support/WebAiOs).
app.setName("WebAiOs");
app.setPath("userData", cheminProfil());

// Une exception oubliée ne doit ni figer l'app derrière une boîte de dialogue, ni la quitter.
process.on("uncaughtException", (e) => console.error("[webaios] exception non rattrapée :", e));

/** Fenêtres principales (avec l'interface WebAiOs), par id d'état. */
const fenetres = new Map<IdFenetre, BrowserWindow>();

/** Vrai dès que l'app quitte : les fenêtres qui se ferment alors restent dans la session, pour la restauration. */
let enSortie = false;
const enFermeture = new WeakSet<BrowserWindow>();

function creerFenetre(id: IdFenetre, magasin: Magasin): BrowserWindow {
  const fenetre = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1e1e22",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`${ARG_FENETRE}${id}`],
    },
  });
  fenetres.set(id, fenetre);
  // Sortie du plein écran par la fenêtre (bouton vert) : la page doit sortir aussi.
  fenetre.on("leave-full-screen", () => fenetre.webContents.send(CANAUX.pleinEcran, false));
  fenetre.on("close", () => enFermeture.add(fenetre));
  // Fermer une fenêtre parmi d'autres la retire de la session (avec ses onglets) ; la dernière reste, pour la
  // restauration. Sur « closed » : un window.close() de la page détruit la fenêtre sans émettre « close ».
  fenetre.on("closed", () => {
    fenetres.delete(id);
    if (!enSortie && magasin.etat.fenetres.length > 1) magasin.agir({ type: "fermerFenetre", id });
    // Seule la fermeture de la dernière fenêtre principale quitte l'app, jamais celle d'une popup.
    if (fenetres.size === 0) app.quit();
  });
  // L'interface ne quitte jamais sa propre page.
  fenetre.webContents.on("will-navigate", (e) => e.preventDefault());
  fenetre.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) void fenetre.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void fenetre.loadFile(join(__dirname, "../renderer/index.html"));
  return fenetre;
}

function fenetreDe(e: IpcMainEvent): IdFenetre | undefined {
  for (const [id, f] of fenetres) if (!f.isDestroyed() && f.webContents === e.sender) return id;
  return undefined;
}

let enregistreur: EnregistreurSession | undefined;
let historique: Historique | undefined;

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  const magasin = new Magasin(await chargerSession(dossier));
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
      if (q.demande.ongletId && !etat.onglets[q.demande.ongletId]) {
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
    historique,
    telechargements,
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
      return fenetres.keys().next().value;
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
    outilsInterface: (id) => fenetres.get(id)?.webContents.toggleDevTools(),
  };
  installerMenu(cibles);
  // La coche du moteur de recherche suit l'état.
  magasin.abonner((etat, avant) => {
    if (etat.reglages.moteur !== avant.reglages.moteur) installerMenu(cibles);
  });
  // Une fenêtre principale par EtatFenetre : ⌘N en ajoute une, sa fermeture la retire.
  const synchroniserFenetres = (etat: EtatNavigateur) => {
    for (const f of etat.fenetres) if (!fenetres.has(f.id)) creerFenetre(f.id, magasin);
    for (const [id, f] of fenetres) if (!etat.fenetres.some((x) => x.id === id) && !f.isDestroyed() && !enFermeture.has(f)) f.close();
  };
  magasin.abonner(synchroniserFenetres);
  synchroniserFenetres(magasin.etat);
  vues.synchroniser(magasin.etat);
});

app.on("will-quit", () => historique?.fermer());

// Les fenêtres principales décident seules de quitter (voir creerFenetre).
app.on("window-all-closed", () => {});

let sessionEcrite = false;
app.on("before-quit", (e) => {
  enSortie = true;
  if (sessionEcrite || !enregistreur) return;
  e.preventDefault();
  void enregistreur.vider().finally(() => {
    sessionEcrite = true;
    app.quit();
  });
});
