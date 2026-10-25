import { app, BrowserWindow, session, shell, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { IdFenetre } from "../commun/modele";
import { chargerSession, EnregistreurSession } from "./etat/persistance";
import { brancherIpc, Magasin } from "./ipc";
import { versUrl } from "./adresse";
import { Historique } from "./historique";
import { installerMenu } from "./menu";
import { GestionnaireVues } from "./onglets/vues";
import { cheminProfil } from "./profil";
import { Telechargements } from "./telechargements";

app.setPath("userData", cheminProfil());

// Une exception oubliée ne doit ni figer l'app derrière une boîte de dialogue, ni la quitter.
process.on("uncaughtException", (e) => console.error("[webaios] exception non rattrapée :", e));

/** Fenêtres principales (avec l'interface WebAiOs), par id d'état. */
const fenetres = new Map<IdFenetre, BrowserWindow>();

function creerFenetre(id: IdFenetre): BrowserWindow {
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
  fenetre.on("closed", () => {
    fenetres.delete(id);
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
  });
  installerMenu({
    fenetreActive: () => {
      const focus = BrowserWindow.getFocusedWindow();
      for (const [id, f] of fenetres) if (f === focus) return id;
      return fenetres.keys().next().value;
    },
    ongletActif: (id) => {
      const f = magasin.etat.fenetres.find((x) => x.id === id);
      return f?.actif[f.espaceActif] ?? undefined;
    },
    commande: (id, c) => vues.commande(id, c),
    basculerCompact: (fenetreId) => magasin.agir({ type: "basculerCompact", fenetreId }),
    ouvrirPanneau: (id, p) => fenetres.get(id)?.webContents.send(CANAUX.panneau, p),
  });
  for (const f of magasin.etat.fenetres) creerFenetre(f.id);
  vues.synchroniser(magasin.etat);
});

app.on("will-quit", () => historique?.fermer());

// Les fenêtres principales décident seules de quitter (voir creerFenetre).
app.on("window-all-closed", () => {});

let sessionEcrite = false;
app.on("before-quit", (e) => {
  if (sessionEcrite || !enregistreur) return;
  e.preventDefault();
  void enregistreur.vider().finally(() => {
    sessionEcrite = true;
    app.quit();
  });
});
