// Spike jetable : la connexion Google passe-t-elle dans Electron ?
// Usage : pnpm start -- --url https://accounts.google.com
//         SPIKE_UA=chrome pnpm start -- --url https://accounts.google.com
import { app, BrowserWindow, Menu, session } from "electron";

const argUrl = process.argv.indexOf("--url");
const urlDepart = argUrl > -1 ? process.argv[argUrl + 1] : "https://accounts.google.com";

if (process.env.SPIKE_UA === "chrome") {
  // Agent utilisateur de Chrome pour la même version de Chromium, sans "Electron/…" ni nom d'app.
  const majeure = process.versions.chrome.split(".")[0];
  app.userAgentFallback =
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majeure}.0.0.0 Safari/537.36`;
}

app.whenReady().then(() => {
  const ses = session.fromPartition("persist:spike");
  const fenetre = new BrowserWindow({
    width: 1200,
    height: 850,
    title: `Spike Google — UA ${process.env.SPIKE_UA === "chrome" ? "chrome" : "défaut"}`,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // Raccourcis minimaux en guise de barre d'adresse : ⌘1 Gmail, ⌘2 YouTube, ⌘3 daily.dev, ⌘[ retour.
  const aller = (url) => fenetre.webContents.loadURL(url);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { label: "Aller", submenu: [
      { label: "Google", accelerator: "CmdOrCtrl+0", click: () => aller("https://accounts.google.com") },
      { label: "Gmail", accelerator: "CmdOrCtrl+1", click: () => aller("https://mail.google.com") },
      { label: "YouTube", accelerator: "CmdOrCtrl+2", click: () => aller("https://www.youtube.com") },
      { label: "daily.dev", accelerator: "CmdOrCtrl+3", click: () => aller("https://app.daily.dev") },
      { label: "Retour", accelerator: "CmdOrCtrl+[", click: () => fenetre.webContents.navigationHistory.goBack() },
      { role: "reload" },
    ] },
  ]));
  // Les popups OAuth (ex. « Se connecter avec Google » de daily.dev) restent dans la même session.
  fenetre.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { webPreferences: { session: ses, sandbox: true, contextIsolation: true } },
  }));
  console.log("UA :", fenetre.webContents.getUserAgent());
  aller(urlDepart);
});

app.on("window-all-closed", () => app.quit());
