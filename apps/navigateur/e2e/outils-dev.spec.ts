import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, dansLaVue, ecrireProjet, lancer, nouvelleRacine, ouvrirOnglet, serveurTest } from "./aide";

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

// Carte de consentement : un onglet de l'utilisateur, servi par le serveur d'essai (jamais « construit »).
const CARTE = "demande-outils-dev";
const REFUS = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";

async function avecOngletTiers() {
  const serveur = await serveurTest();
  const l = await lancer();
  await expect.poll(() => existsSync(join(l.racine, ".webaios", "mcp.json"))).toBe(true);
  await ouvrirOnglet(l.fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(l.app, "texte.html", "document.title")).toBe("Texte");
  const titre = l.fenetre.locator('[data-testid^="onglet-"]', { hasText: "Texte" });
  await expect(titre).toHaveCount(1);
  const id = (await titre.getAttribute("data-testid"))!.slice("onglet-".length);
  return { ...l, id, serveur, fermer: async () => (await l.fermer(), await serveur.fermer()) };
}

test("onglet tiers : lire_console affiche la carte avec « Console et erreurs » coché et la raison ; Autoriser la sélection → messages renvoyés", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  const appel = outil(racine, "lire_console", { id });
  const carte = fenetre.getByTestId(CARTE);
  await expect(carte).toContainText("Claude Code veut accéder aux outils de développement");
  await expect(carte).toContainText("Texte");
  await expect(carte).toContainText("« L'agent veut utiliser lire_console. »");
  await expect(carte).toContainText("Valable pour cette conversation · tombe si l'onglet change de site");
  await expect(carte.locator('input[data-droit="console"]')).toBeChecked();
  for (const d of ["reseau", "performances", "agir"]) await expect(carte.locator(`input[data-droit="${d}"]`)).not.toBeChecked();
  await carte.getByRole("button", { name: "Autoriser la sélection" }).click();
  expect(await appel).toBe("Aucun message.");
  await expect(carte).toBeHidden();
  await fermer();
});

test("décocher Réseau dans une demande console+reseau : seul console est accordé ; lire_reseau suivant répond refusé sans carte", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  const appel = outil(racine, "demander_outils_dev", { id, droits: ["console", "reseau"], raison: "Le bouton ne réagit pas." });
  const carte = fenetre.getByTestId(CARTE);
  await expect(carte).toContainText("« Le bouton ne réagit pas. »");
  await expect(carte).toContainText("peut contenir des données de connexion");
  await expect(carte.locator('input[data-droit="console"]')).toBeChecked();
  await carte.locator('input[data-droit="reseau"]').uncheck();
  await carte.getByRole("button", { name: "Autoriser la sélection" }).click();
  expect(await appel).toBe("Droits accordés : console\nRefusés : reseau");
  expect(await outil(racine, "lire_reseau", { id })).toBe(REFUS);
  await expect(carte).toHaveCount(0);
  await fermer();
});

test("deux demandes : une seule carte à la fois, la seconde après réponse à la première", async () => {
  const { app, fenetre, racine, id, serveur, fermer } = await avecOngletTiers();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const autre = (await fenetre.locator('[data-testid^="onglet-"]', { hasText: "Page A" }).getAttribute("data-testid"))!.slice("onglet-".length);
  const premiere = outil(racine, "demander_outils_dev", { id, droits: ["console"], raison: "Première." });
  await expect(fenetre.getByTestId(CARTE)).toContainText("Première.");
  const seconde = outil(racine, "demander_outils_dev", { id: autre, droits: ["console"], raison: "Seconde." });
  await new Promise((r) => setTimeout(r, 500));
  await expect(fenetre.getByTestId(CARTE)).toHaveCount(1);
  await expect(fenetre.getByTestId(CARTE)).toContainText("Première.");
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Autoriser la sélection" }).click();
  expect(await premiere).toBe("Droits accordés : console");
  await expect(fenetre.getByTestId(CARTE)).toContainText("Seconde.");
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Refuser" }).click();
  expect(await seconde).toBe(REFUS);
  await expect(fenetre.getByTestId(CARTE)).toHaveCount(0);
  await fermer();
});

test("Refuser : l'outil répond refusé", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  const appel = outil(racine, "lire_console", { id });
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Refuser" }).click();
  expect(await appel).toBe(REFUS);
  await expect(fenetre.getByTestId(CARTE)).toHaveCount(0);
  await fermer();
});

// Pastille d'accès : sur la ligne de l'onglet et dans la barre d'adresse (onglet actif).
const PASTILLE = "pastille-acces";
const BULLE = "bulle-acces";

async function accorder(fenetre: Page, racine: string, id: string, droits: string[]) {
  const appel = outil(racine, "demander_outils_dev", { id, droits, raison: "Essai de la pastille." });
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Autoriser la sélection" }).click();
  await appel;
}

test("lecture accordée (Autoriser une fois) : pastille 👁 sur l'onglet et dans la barre d'adresse", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  await expect(fenetre.getByTestId(PASTILLE)).toHaveCount(0);
  const lecture = outil(racine, "lire_onglet", { id });
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser une fois" }).click();
  await lecture;
  await expect(fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE)).toHaveAttribute("data-niveau", "lecture");
  await expect(fenetre.locator("form").getByTestId(PASTILLE)).toHaveAttribute("data-niveau", "lecture");
  await fermer();
});

test("agir accordé : pastille ⚡", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  await accorder(fenetre, racine, id, ["agir"]);
  const p = fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE);
  await expect(p).toHaveAttribute("data-niveau", "agir");
  await expect(p).toContainText("⚡");
  await fermer();
});

test("clic sur la pastille : la bulle liste les droits ; Couper sur « console » retire ce droit (lire_console redemande)", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  await accorder(fenetre, racine, id, ["console", "reseau"]);
  await fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE).click();
  const bulle = fenetre.getByTestId(BULLE);
  await expect(bulle).toContainText("Claude Code");
  await expect(bulle).toContainText("Console et erreurs");
  await expect(bulle).toContainText("Réseau");
  await expect(bulle).toContainText("Cette conversation · tombe si l'onglet change de site");
  await expect(fenetre.getByTestId(`onglet-${id}`)).toHaveAttribute("aria-selected", "true");
  await bulle.locator('button[data-droit="console"]').click();
  await expect(bulle.locator('button[data-droit="console"]')).toHaveCount(0);
  await expect(bulle.locator('button[data-droit="reseau"]')).toHaveCount(1);
  await fenetre.keyboard.press("Escape");
  await expect(bulle).toHaveCount(0);
  const appel = outil(racine, "lire_console", { id });
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Refuser" }).click();
  expect(await appel).toBe(REFUS);
  await fermer();
});

test("Couper l'accès : la pastille disparaît, lire_onglet redemande", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  await accorder(fenetre, racine, id, ["console"]);
  await fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE).click();
  await fenetre.getByTestId(BULLE).getByRole("button", { name: "Couper l'accès" }).click();
  await expect(fenetre.getByTestId(PASTILLE)).toHaveCount(0);
  await expect(fenetre.getByTestId(BULLE)).toHaveCount(0);
  const appel = outil(racine, "lire_onglet", { id });
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Refuser" }).click();
  await appel;
  await fermer();
});
