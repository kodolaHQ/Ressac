import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installerStoreFactice } from "./extensions/fixtures";
import { appelerOutil, nouveauProfil, dansLaVue, ecrireProjet, lancer, nouvelleRacine, ouvrirOnglet, reglerEspaceActifPrive, serveurTest } from "./aide";

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
  // La session du panneau démarre une nouvelle conversation (qui retire cartes, droits et coupes) : on l'attend.
  await expect.poll(() => existsSync(join(racine, "faux-agent-pid")), { timeout: 10_000 }).toBe(true);
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
  // La session du panneau démarre une nouvelle conversation (qui retire les cartes et les droits) : on l'attend.
  await expect.poll(() => existsSync(join(l.racine, "faux-agent-pid")), { timeout: 10_000 }).toBe(true);
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

test("espace rendu privé : la pastille disparaît, le débogueur est détaché et les outils répondent privé sans carte", async () => {
  const { app, fenetre, racine, id, fermer } = await avecOngletTiers();
  await accorder(fenetre, racine, id, ["console", "agir"]);
  await expect(fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE)).toHaveAttribute("data-niveau", "agir");
  const attache = () =>
    app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("texte.html"))?.debugger.isAttached());
  await expect.poll(attache).toBe(true);
  await reglerEspaceActifPrive(fenetre, true);
  await expect(fenetre.getByTestId(PASTILLE)).toHaveCount(0);
  await expect.poll(attache).toBe(false);
  const prive = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";
  expect(await outil(racine, "lire_console", { id })).toBe(prive);
  expect(await outil(racine, "executer_js", { id, code: "document.title" })).toBe(prive);
  await expect(fenetre.getByTestId(CARTE)).toHaveCount(0);
  // Redevenu partagé : les droits ne reviennent pas, l'outil redemande.
  await reglerEspaceActifPrive(fenetre, false);
  const appel = outil(racine, "lire_console", { id });
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Refuser" }).click();
  expect(await appel).toBe(REFUS);
  await fermer();
});

test("la bulle d'accès ne rencontre pas la vue de la page (une vue native couvre l'interface) et reste dans la barre latérale", async () => {
  const { app, fenetre, racine, id, fermer } = await avecOngletTiers();
  await accorder(fenetre, racine, id, ["console", "reseau", "performances", "agir"]);
  const vue = () =>
    app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        for (const v of w.contentView.children as unknown as { getBounds(): { x: number; y: number; width: number; height: number }; webContents: { getURL(): string } }[])
          if (v.webContents.getURL().includes("texte.html")) return v.getBounds();
      return null;
    });
  for (const pastille of [fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE), fenetre.locator("form").getByTestId(PASTILLE)]) {
    await pastille.click();
    const bulle = fenetre.getByTestId(BULLE);
    await expect(bulle).toBeVisible();
    const b = (await bulle.boundingBox())!;
    const v = (await vue())!;
    const barre = (await fenetre.getByTestId("barre-laterale").boundingBox())!;
    expect(v.width).toBeGreaterThan(0);
    const croise = b.x < v.x + v.width && b.x + b.width > v.x && b.y < v.y + v.height && b.y + b.height > v.y;
    expect(croise, JSON.stringify({ b, v, barre })).toBe(false);
    expect(b.x).toBeGreaterThanOrEqual(barre.x);
    expect(b.x + b.width).toBeLessThanOrEqual(barre.x + barre.width);
    await pastille.click();
    await expect(bulle).toHaveCount(0);
  }
  await fermer();
});

test("mode compact : la vue de la page est à zéro tant que la bulle est ouverte, rétablie à la fermeture (deux fois), sans erreur Svelte", async () => {
  const { app, fenetre, racine, id, fermer } = await avecOngletTiers();
  const erreurs: string[] = [];
  fenetre.on("pageerror", (e) => erreurs.push(e.message));
  fenetre.on("console", (m) => m.type() === "error" && erreurs.push(m.text()));
  await accorder(fenetre, racine, id, ["console"]);
  const largeurVue = () =>
    app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        for (const v of w.contentView.children as unknown as { getBounds(): { width: number }; webContents: { getURL(): string } }[])
          if (v.webContents.getURL().includes("texte.html")) return v.getBounds().width;
      return -1;
    });
  await fenetre.evaluate(() => {
    const w = window as unknown as { webaios: { fenetreId: string; agir(a: unknown): void } };
    w.webaios.agir({ type: "basculerCompact", fenetreId: w.webaios.fenetreId });
  });
  await expect.poll(largeurVue).toBeGreaterThan(0);
  for (let i = 0; i < 2; i++) {
    // La barre latérale se révèle au bord gauche de la fenêtre.
    await fenetre.mouse.move(2, 300);
    const pastille = fenetre.getByTestId(`onglet-${id}`).getByTestId(PASTILLE);
    await pastille.click();
    await expect(fenetre.getByTestId(BULLE)).toBeVisible();
    await expect.poll(largeurVue).toBe(0);
    await fenetre.keyboard.press("Escape");
    await expect(fenetre.getByTestId(BULLE)).toHaveCount(0);
    await expect.poll(largeurVue).toBeGreaterThan(0);
  }
  expect(erreurs).toEqual([]);
  await fermer();
});

// Les demandes d'accès de l'agent s'ouvrent en modale : la vue native de la page couvrirait l'interface, elle s'efface
// tant que la modale est ouverte (une capture floutée la remplace).
const MODALE = "modale-demande";
const largeurVueTexte = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      for (const v of w.contentView.children as unknown as { getBounds(): { width: number }; webContents: { getURL(): string } }[])
        if (v.webContents.getURL().includes("texte.html")) return v.getBounds().width;
    return -1;
  });

test("la demande d'accès s'ouvre en modale : la vue de la page est masquée tant qu'elle est ouverte, puis revient", async () => {
  const { app, fenetre, racine, id, fermer } = await avecOngletTiers();
  await expect.poll(() => largeurVueTexte(app)).toBeGreaterThan(0);
  const appel = outil(racine, "lire_console", { id });
  const modale = fenetre.getByTestId(MODALE);
  await expect(modale.getByTestId(CARTE)).toBeVisible();
  await expect.poll(() => largeurVueTexte(app)).toBe(0);
  // La capture de la page affichée, derrière la modale.
  await expect(modale.getByTestId("modale-apercu")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
  await modale.getByRole("button", { name: "Refuser" }).click();
  expect(await appel).toBe(REFUS);
  await expect(modale).toHaveCount(0);
  await expect.poll(() => largeurVueTexte(app)).toBeGreaterThan(0);
  await fermer();
});

test("Échap refuse la carte des outils de développement ; Entrée autorise la sélection", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  const dansLaModale = () => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'));
  const appel = outil(racine, "demander_outils_dev", { id, droits: ["console", "reseau"], raison: "Au clavier." });
  await expect(fenetre.getByTestId(CARTE)).toContainText("Au clavier.");
  await expect.poll(dansLaModale).toBe(true);
  // Le focus reste piégé dans la modale.
  for (let i = 0; i < 12; i++) {
    await fenetre.keyboard.press("Tab");
    expect(await dansLaModale()).toBe(true);
  }
  // Espace décoche « Réseau » sans valider ; Entrée, sur la case, autorise la sélection.
  await fenetre.getByTestId(CARTE).locator('input[data-droit="reseau"]').focus();
  await fenetre.keyboard.press("Space");
  await expect(fenetre.getByTestId(CARTE).locator('input[data-droit="reseau"]')).not.toBeChecked();
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await expect(fenetre.getByTestId(MODALE)).toHaveAttribute("data-armee");
  await fenetre.keyboard.press("Enter");
  expect(await appel).toBe("Droits accordés : console\nRefusés : reseau");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);

  const refus = outil(racine, "demander_outils_dev", { id, droits: ["performances"], raison: "Échap." });
  await expect(fenetre.getByTestId(CARTE)).toContainText("Échap.");
  await expect.poll(dansLaModale).toBe(true);
  await fenetre.keyboard.press("Escape");
  expect(await refus).toBe(REFUS);
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

test("la demande de lecture de l'agent est aussi une modale ; Entrée l'autorise une fois", async () => {
  const { app, fenetre, racine, id, fermer } = await avecOngletTiers();
  const lecture = outil(racine, "lire_onglet", { id });
  const modale = fenetre.getByTestId(MODALE);
  await expect(modale.getByTestId("demande-permission")).toContainText("L'agent veut lire l'onglet « Texte »");
  await expect.poll(() => largeurVueTexte(app)).toBe(0);
  await expect.poll(() => fenetre.evaluate(() => !!document.activeElement?.closest('[data-testid="modale-demande"]'))).toBe(true);
  await expect(modale).toHaveAttribute("data-armee");
  await fenetre.keyboard.press("Enter");
  expect(await lecture).toContain("Le chat dort");
  await expect(modale).toHaveCount(0);
  await expect.poll(() => largeurVueTexte(app)).toBeGreaterThan(0);
  await fermer();
});

test("Entrée frappée dès l'arrivée de la demande n'autorise rien ; une fois la carte visible depuis un moment, si", async () => {
  const { fenetre, racine, id, fermer } = await avecOngletTiers();
  let repondu = false;
  const appel = outil(racine, "demander_outils_dev", { id, droits: ["console"], raison: "Trop tôt." }).finally(() => (repondu = true));
  await expect(fenetre.getByTestId(CARTE)).toHaveCount(1);
  // L'utilisateur tapait dans la page à l'instant où la carte arrive : sa frappe ne vaut pas accord.
  await fenetre.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  expect(repondu).toBe(false);
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await expect(fenetre.getByTestId(MODALE)).toHaveAttribute("data-armee");
  await fenetre.keyboard.press("Enter");
  expect(await appel).toBe("Droits accordés : console");
  await expect(fenetre.getByTestId(MODALE)).toHaveCount(0);
  await fermer();
});

// Pastille d'accès dans la fenêtre d'une appli construite (vue transparente, sans interface WebAiOs).
async function pagePastille(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    const p = app.windows().find((x) => x.url().includes("pastille.html"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("la vue de la pastille n'est pas apparue");
}

test("fenêtre d'appli : la pastille ⚡ est affichée ; Couper l'accès la retire et lire_console sur app:<dossier> demande alors la carte", async () => {
  const { app, fenetre, racine, fermer } = await demarrer();
  const pastille = await pagePastille(app);
  await expect(pastille.getByTestId(PASTILLE)).toHaveAttribute("data-niveau", "agir");
  await expect(pastille.getByTestId(PASTILLE)).toContainText("⚡");
  // Fermée, avec l'accès de l'agent : 88×28 (la pastille d'accès et celle de WebAiOs), et l'état reçu ne parle que de
  // sa propre appli.
  await expect.poll(() => pastille.evaluate(() => [innerWidth, innerHeight])).toEqual([88, 28]);
  expect(await pastille.evaluate(async () => Object.keys((await window.webaios.acces.etat()).onglets))).toEqual(["app:essai"]);
  await pastille.getByTestId(PASTILLE).click();
  await expect(pastille.getByTestId(BULLE)).toContainText("Agir sur la page");
  // Bulle ouverte : la vue grandit pour la contenir, en entier et sous la pastille. La vue grandit par IPC, puis la bulle
  // se replace au « resize » suivant : entre les deux, une image où elle garde sa largeur de 120 px (bas ≈ 490 dans une
  // vue de 320). On attend donc l'état posé, sans délai fixe.
  await expect
    .poll(() =>
      pastille.evaluate(() => {
        const bas = document.querySelector("[data-testid=bulle-acces]")!.getBoundingClientRect().bottom;
        return innerHeight > 28 && bas <= innerHeight ? "contenue" : `bulle ${bas} > vue ${innerHeight}`;
      }),
    )
    .toBe("contenue");
  await pastille.getByTestId(BULLE).getByRole("button", { name: "Couper l'accès" }).click();
  await expect(pastille.getByTestId(PASTILLE)).toHaveCount(0);
  // Une construite coupée le reste jusqu'à la prochaine conversation : l'outil redemande.
  const appel = outil(racine, "lire_console");
  await expect(fenetre.getByTestId(CARTE)).toBeVisible();
  await fenetre.getByTestId(CARTE).getByRole("button", { name: "Refuser" }).click();
  expect(await appel).toBe(REFUS);
  await fermer();
});

test("lire_console et lire_reseau d'un onglet partagé ne montrent rien d'une extension Store de test qui écrit dans la console et fait une requête depuis son script de contenu", async () => {
  const serveur = await serveurTest();
  const profil = nouveauProfil();
  installerStoreFactice(profil, "bavard-store", { profils: ["defaut"] });
  const { app, fenetre, racine, fermer } = await lancer({ profil });
  try {
    await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
    await expect.poll(() => existsSync(join(racine, "faux-agent-pid")), { timeout: 10_000 }).toBe(true);
    await expect
      .poll(() => app.evaluate(({ session }) => session.fromPartition("persist:webaios").extensions.getAllExtensions().map((e) => e.name), undefined), { timeout: 15_000 })
      .toContain("Bavard du Store");
    await ouvrirOnglet(fenetre, `${serveur.url}/bavarde.html`);
    await expect.poll(() => dansLaVue(app, "bavarde.html", "document.title")).toBe("Bavarde");
    const titre = fenetre.locator('[data-testid^="onglet-"]', { hasText: "Bavarde" });
    await expect(titre).toHaveCount(1);
    const id = (await titre.getAttribute("data-testid"))!.slice("onglet-".length);
    await accorder(fenetre, racine, id, ["console", "reseau"]);
    // L'agent est attaché (premier appel après l'accord) ; l'événement déclenche la page et le script de l'extension.
    await outil(racine, "lire_console", { id });
    await dansLaVue(app, "bavarde.html", "document.dispatchEvent(new CustomEvent('declencher'))");
    await expect.poll(() => outil(racine, "lire_console", { id }), { timeout: 10_000 }).toContain("PAGE-LOG");
    await expect.poll(() => outil(racine, "lire_reseau", { id }), { timeout: 10_000 }).toContain("depuis-page");
    // L'extension pose un marqueur sur la page une fois ses requêtes finies et son exception levée.
    await expect.poll(() => dansLaVue(app, "bavarde.html", "document.documentElement.getAttribute('data-bavard-fini')"), { timeout: 10_000 }).toBe("1");
    await new Promise((r) => setTimeout(r, 300)); // les derniers événements du protocole
    const console_ = await outil(racine, "lire_console", { id });
    const reseau = await outil(racine, "lire_reseau", { id });
    expect(console_).not.toContain("BAVARD-EXT");
    expect(reseau).not.toContain("depuis-extension");
    for (const trace of ["absent-depuis-extension", "cors-depuis-extension", "Failed to load resource", "CORS"]) {
      expect(console_).not.toContain(trace);
      expect(reseau).not.toContain(trace);
    }
    expect(reseau).toContain("depuis-page");
  } finally {
    await fermer();
    await serveur.fermer();
  }
});
