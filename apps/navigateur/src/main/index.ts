import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { cheminProfil } from "./profil";

app.setPath("userData", cheminProfil());

function creerFenetre(): BrowserWindow {
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
    },
  });
  // L'interface ne quitte jamais sa propre page.
  fenetre.webContents.on("will-navigate", (e) => e.preventDefault());
  fenetre.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) void fenetre.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void fenetre.loadFile(join(__dirname, "../renderer/index.html"));
  return fenetre;
}

app.whenReady().then(() => {
  creerFenetre();
});

app.on("window-all-closed", () => app.quit());
