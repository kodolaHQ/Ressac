import { app, BrowserWindow, type IpcMainEvent } from "electron";
import { join } from "node:path";
import { ARG_FENETRE, CANAUX } from "../commun/canaux";
import type { IdFenetre } from "../commun/modele";
import { chargerSession, EnregistreurSession } from "./etat/persistance";
import { brancherIpc, Magasin } from "./ipc";
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
  fenetre.on("closed", () => fenetres.delete(id));
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

app.whenReady().then(async () => {
  const dossier = app.getPath("userData");
  const magasin = new Magasin(await chargerSession(dossier));
  const enregistreur = new EnregistreurSession(dossier);
  magasin.abonner((etat) => {
    for (const f of fenetres.values()) if (!f.isDestroyed()) f.webContents.send(CANAUX.etat, etat);
    enregistreur.planifier(etat);
  });
  brancherIpc({
    magasin,
    fenetreDe,
    naviguer: () => {},
    commande: () => {},
    bornes: () => {},
  });
  for (const f of magasin.etat.fenetres) creerFenetre(f.id);
});

app.on("window-all-closed", () => app.quit());
