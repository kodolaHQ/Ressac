import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, ecrireProjet, lancer, nouvelleRacine } from "./aide";

/** Ports d'essai, jamais ceux des vraies applis de l'utilisateur ; délai court avant « En erreur ». */
const ENV = { WEBAIOS_PORTS_APPS: "15285-15289", WEBAIOS_DELAI_APP_MS: "3000" };

const racines: string[] = [];
// Un test qui échoue en route ne doit pas laisser de serveur d'essai sur un port.
test.afterEach(() => {
  for (const racine of racines.splice(0))
    for (const f of existsSync(racine) ? readdirSync(racine) : [])
      if (/^faux-docker-app-.*\.pid$/.test(f))
        try {
          process.kill(-Number(readFileSync(join(racine, f), "utf8")), "SIGKILL");
        } catch {
          // déjà arrêté
        }
});

/** Serveur de l'appli d'essai : e2e/pages/console.html à la racine, texte.html à côté. */
const SERVEUR = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
createServer((req, res) => {
  const fichier = req.url === "/texte.html" ? "texte.html" : "console.html";
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(fichier));
}).listen(Number(process.env.PORT));
`;

/** Lance le navigateur et, par l'outil de l'agent, l'appli « essai » qui sert la page de console ; elle est construite. */
async function demarrer() {
  const racine = nouvelleRacine();
  racines.push(racine);
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" } });
  const projet = join(racine, "projets", "essai");
  writeFileSync(join(projet, "serveur.mjs"), SERVEUR);
  for (const page of ["console.html", "texte.html"]) copyFileSync(join(__dirname, "pages", page), join(projet, page));
  const l = await lancer({ racine, env: ENV });
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("(onglet app:essai)");
  return { ...l, page: await pageAppli(l.app) };
}

async function pageAppli(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    for (const p of app.windows()) if ((await p.title().catch(() => "")) === "Console") return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("la fenêtre de l'appli n'est pas apparue");
}

const outil = async (racine: string, nom: string, args: Record<string, unknown> = {}) => (await appelerOutil(racine, nom, { id: "app:essai", ...args })).texte;

/** Les outils de développement de la fenêtre d'appli, depuis le process principal. */
const devtools = (app: ElectronApplication, action: "ouvrir" | "fermer" | "ouverts") =>
  app.evaluate(({ BrowserWindow }, action) => {
    const wc = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http://localhost:"))?.webContents;
    // Ancrés dans la fenêtre (invisible) : aucune fenêtre ne s'ouvre à l'écran.
    if (action === "ouvrir") wc?.openDevTools({ mode: "right", activate: false });
    if (action === "fermer") wc?.closeDevTools();
    return wc?.isDevToolsOpened() ?? false;
  }, action);

test("appli construite : lire_console renvoie le console.log et l'erreur de la page, sans demande", async () => {
  const { fenetre, racine, page, fermer } = await demarrer();
  // Le premier appel attache : seuls les messages écrits ensuite comptent (ceux d'avant, rejoués par le protocole, non).
  expect(await outil(racine, "lire_console")).not.toContain("bonjour de la page");
  await page.evaluate(() => document.getElementById("parler")!.click());
  await expect.poll(() => outil(racine, "lire_console")).toContain("[log] bonjour de la page");
  await page.evaluate(() => document.getElementById("boum")!.click());
  await expect.poll(() => outil(racine, "lire_console")).toContain("[error] Uncaught Error: boum");
  const console = await outil(racine, "lire_console");
  expect(console).toContain("[warn] attention");
  expect(console).toMatch(/at boum \(http:\/\/localhost:1528\d\/:\d+:\d+\)/);
  await expect(fenetre.getByTestId("demande-permission")).toHaveCount(0);
  await fermer();
});

test("appli construite : executer_js renvoie document.title ; recharger garde les messages avec « — page rechargée — »", async () => {
  const { racine, fermer } = await demarrer();
  expect(await outil(racine, "executer_js", { code: "document.title" })).toBe('"Console"');
  expect(await outil(racine, "executer_js", { code: "await Promise.resolve({ a: [1, 2] })" })).toBe('{"a":[1,2]}');
  // Une valeur non sérialisable revient en aperçu ; une exception avec sa pile.
  expect(await outil(racine, "executer_js", { code: "window" })).toBe("Window");
  expect(await outil(racine, "executer_js", { code: "(function f() { throw new Error('raté') })()" })).toMatch(/^Exception : Error: raté\n\s+at f/);
  await outil(racine, "executer_js", { code: "document.getElementById('parler').click()" });
  await expect.poll(() => outil(racine, "lire_console")).toContain("bonjour de la page");
  expect(await outil(racine, "recharger")).toBe("Onglet app:essai rechargé.");
  await expect.poll(() => outil(racine, "lire_console")).toMatch(/bonjour de la page[\s\S]*— page rechargée —[\s\S]*page chargée/);
  // La requête de la page rechargée, avec sa réponse.
  await expect.poll(() => outil(racine, "lire_reseau", { filtre: "texte.html" })).toMatch(/GET · 200 · http:\/\/localhost:1528\d\/texte\.html/);
  await fermer();
});

test("appli construite : profiler_performances écrit un fichier sous projets/<dossier>/.webaios/profilage", async () => {
  const { racine, fermer } = await demarrer();
  const r = await outil(racine, "profiler_performances", { duree_s: 0.5 });
  const chemin = /Profil : (\/workspace\/projets\/essai\/\.webaios\/profilage\/\S+\.cpuprofile)/.exec(r)?.[1];
  expect(chemin, r).toBeDefined();
  const profil = JSON.parse(readFileSync(join(racine, chemin!.slice("/workspace/".length)), "utf8"));
  expect(profil.nodes.length).toBeGreaterThan(0);
  expect(r).toContain("JSHeapUsedSize");
  const instantane = await outil(racine, "instantane_memoire");
  expect(instantane).toMatch(/Instantané : \/workspace\/projets\/essai\/\.webaios\/profilage\/\S+\.heapsnapshot/);
  await fermer();
});

test("L'utilisateur ouvre les DevTools (wc.openDevTools() via app.evaluate) : lire_console renvoie « Les outils de développement de l'utilisateur sont ouverts sur cet onglet. » et les DevTools restent ouverts", async () => {
  const { app, racine, fermer } = await demarrer();
  expect(await outil(racine, "executer_js", { code: "1 + 1" })).toBe("2"); // l'agent est attaché
  await devtools(app, "ouvrir");
  await expect.poll(() => devtools(app, "ouverts")).toBe(true);
  await expect.poll(() => outil(racine, "lire_console")).toBe("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
  expect(await outil(racine, "executer_js", { code: "1 + 1" })).toBe("Les outils de développement de l'utilisateur sont ouverts sur cet onglet.");
  // L'agent s'est effacé : les outils de l'utilisateur sont toujours là.
  await new Promise((r) => setTimeout(r, 500));
  expect(await devtools(app, "ouverts")).toBe(true);
  // Refermés : l'agent se rattache au prochain appel.
  await devtools(app, "fermer");
  await expect.poll(() => outil(racine, "executer_js", { code: "1 + 1" })).toBe("2");
  await fermer();
});
