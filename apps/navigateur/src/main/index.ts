import { app, BrowserWindow, session, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { IdFenetre } from "../commun/modele";
import { chargerSession, EnregistreurSession } from "./etat/persistance";
import { brancherIpc, Magasin } from "./ipc";
import { versUrl } from "./adresse";
import { GestionnaireVues } from "./onglets/vues";
import { cheminProfil } from "./profil";

app.setPath("userData", cheminProfil());

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

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  const magasin = new Magasin(await chargerSession(dossier));
  enregistreur = new EnregistreurSession(dossier);
  const vues = new GestionnaireVues({ session: session.fromPartition("persist:webaios"), fenetres, agir: (a) => magasin.agir(a) });
  magasin.abonner((etat) => {
    for (const f of fenetres.values()) if (!f.isDestroyed()) f.webContents.send(CANAUX.etat, etat);
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
  });
  for (const f of magasin.etat.fenetres) creerFenetre(f.id);
  vues.synchroniser(magasin.etat);
});

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
