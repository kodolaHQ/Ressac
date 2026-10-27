import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, ecrireProjet, lancer, nouvelleRacine, ouvrirOnglet } from "./aide";

/** Ports d'essai, jamais ceux des vraies applis de l'utilisateur ; délai court avant « En erreur ». */
const ENV = { WEBAIOS_PORTS_APPS: "15280-15284", WEBAIOS_DELAI_APP_MS: "3000" };

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

async function demarrer(o: { serveur?: "ok" | "plante" } = {}) {
  const racine = nouvelleRacine();
  racines.push(racine);
  ecrireProjet(racine, "essai", { manifeste: { nom: "Essai" }, serveur: o.serveur ?? "ok" });
  const l = await lancer({ racine, env: ENV });
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
  return l;
}

/** Lance l'appli « essai » par l'outil de l'agent ; renvoie son port. */
async function lancerEssai(racine: string): Promise<number> {
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("en marche sur http://localhost:1528");
  return Number(/localhost:(\d+)/.exec(texte)![1]);
}

async function pageAppli(app: ElectronApplication): Promise<Page> {
  for (const fin = Date.now() + 10_000; Date.now() < fin; ) {
    for (const p of app.windows()) if ((await p.title().catch(() => "")) === "Essai essai") return p;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("la fenêtre de l'appli n'est pas apparue");
}

async function repond(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

const arrets = (racine: string) => {
  const f = join(racine, "faux-docker-arrets.log");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** URL des onglets de l'état, lue par l'interface. */
const urlsOnglets = (fenetre: Page) =>
  fenetre.evaluate(
    () =>
      new Promise<string[]>((ok) => {
        type Api = { webaios: { surEtat(r: (e: { onglets: Record<string, { url: string }> }) => void): () => void } };
        const fin = (window as unknown as Api).webaios.surEtat((e) => {
          setTimeout(() => fin());
          ok(Object.values(e.onglets).map((o) => o.url));
        });
      }),
  );

/** Agit sur la BrowserWindow de l'appli « Essai » depuis le process principal. */
const fenetreAppli = (app: ElectronApplication, action: "redimensionner" | "taille" | "fermer") =>
  app.evaluate(({ BrowserWindow }, action) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "Essai");
    if (!w) return undefined;
    if (action === "redimensionner") w.setBounds({ x: 120, y: 90, width: 640, height: 480 });
    if (action === "fermer") w.close();
    const { width, height } = w.getBounds();
    return [width, height];
  }, action);

test("lancer_application ouvre une fenêtre sans barre sur l'appli", async () => {
  const { app, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  const page = await pageAppli(app);
  expect(page.url()).toMatch(/^http:\/\/localhost:1528\d\/$/);
  await expect(page.getByTestId("barre-laterale")).toHaveCount(0);
  await fermer();
});

test("après lancer_application, l'agent lit et capture la fenêtre de l'appli sans demande", async () => {
  const { fenetre, racine, fermer } = await demarrer();
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("(onglet app:essai)");
  const lu = await appelerOutil(racine, "lire_onglet", { id: "app:essai" });
  // Titre de la fenêtre (le nom de l'appli) puis texte de la page ; « Essai essai » est le <title> de la page, pas son texte.
  expect(lu.texte).toContain("Titre : Essai");
  expect(lu.texte).toContain("lien");
  const capture = await appelerOutil(racine, "capture_ecran", { id: "app:essai" });
  expect(capture.image!.length).toBeGreaterThan(1000);
  await expect(fenetre.getByTestId("demande-permission")).toHaveCount(0);
  await fermer();
});

test("fermer la fenêtre de l'appli l'arrête", async () => {
  const { app, racine, fermer } = await demarrer();
  const port = await lancerEssai(racine);
  const page = await pageAppli(app);
  expect(await repond(port)).toBe(true);
  await page.close();
  await expect.poll(() => arrets(racine), { timeout: 5_000 }).toContain("WEBAIOS_APP=essai");
  await expect.poll(() => repond(port), { timeout: 5_000 }).toBe(false);
  await fermer();
});

test("fermer la fenêtre de l'agent n'arrête pas l'appli", async () => {
  const { app, fenetre, racine, fermer } = await demarrer();
  const port = await lancerEssai(racine);
  const page = await pageAppli(app);
  const menu = (id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await menu("panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await menu("panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await menu("fermer-fenetre");
  await expect.poll(() => app.windows().some((p) => p.url().includes("/renderer/index.html"))).toBe(false);
  expect(page.isClosed()).toBe(false);
  expect(await repond(port)).toBe(true);
  expect(arrets(racine)).not.toContain("WEBAIOS_APP=essai");
  await fermer();
});

test("un lien externe de l'appli s'ouvre dans un onglet de la fenêtre principale", async () => {
  const { app, fenetre, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  const page = await pageAppli(app);
  // Clic par la page : Playwright attendrait sans fin la navigation que l'appli annule.
  await page.evaluate(() => document.querySelector("a")!.click());
  await expect.poll(() => urlsOnglets(fenetre)).toContain("https://exemple.invalide/");
  expect(page.url()).toMatch(/^http:\/\/localhost:/);
  await fermer();
});

test("une appli qui plante n'ouvre pas de fenêtre", async () => {
  const { app, racine, fermer } = await demarrer({ serveur: "plante" });
  const { texte } = await appelerOutil(racine, "lancer_application", { dossier: "essai" });
  expect(texte).toContain("en erreur");
  expect(texte).toContain("boum");
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("au lancement, les applis orphelines sont arrêtées", async () => {
  const { racine, fermer } = await demarrer();
  await expect.poll(() => arrets(racine), { timeout: 10_000 }).toContain("WEBAIOS_APP=.*");
  await fermer();
});

test("⌘Q arrête les applis en marche", async () => {
  const { app, racine } = await demarrer();
  const port = await lancerEssai(racine);
  await pageAppli(app);
  await app.close();
  expect(arrets(racine)).toContain("WEBAIOS_APP=essai");
  expect(await repond(port)).toBe(false);
});

test("taille de la fenêtre d'appli retenue", async () => {
  const { app, racine, fermer } = await demarrer();
  await lancerEssai(racine);
  await pageAppli(app);
  await fenetreAppli(app, "redimensionner");
  await fenetreAppli(app, "fermer");
  // Fenêtre fermée : son arrêt est demandé ; la relance attend la fin du script d'arrêt.
  await expect.poll(() => fenetreAppli(app, "taille")).toBeUndefined();
  await lancerEssai(racine);
  await pageAppli(app);
  expect(await fenetreAppli(app, "taille")).toEqual([640, 480]);
  await fermer();
});

// --- La page Applications ---

const menu = (app: ElectronApplication, id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);

/**
 * Trois projets (`essai` en application, `zod` en POC, `vieux` sans manifeste) et la page ouverte par le menu.
 * `lent` : le serveur d'`essai` attend une seconde avant d'écouter, pour qu'on voie « En lancement ».
 */
async function ouvrirPage(o: { env?: Record<string, string>; projets?: boolean; lent?: boolean } = {}) {
  const racine = nouvelleRacine();
  racines.push(racine);
  if (o.projets ?? true) {
    ecrireProjet(racine, "essai", { manifeste: { nom: "Essai", ...(o.lent ? { lancement: "sleep 1 && node serveur.mjs" } : {}) } });
    ecrireProjet(racine, "zod", { manifeste: { type: "poc", origine: "https://github.com/colinhacks/zod" } });
    ecrireProjet(racine, "vieux");
  }
  const l = await lancer({ racine, env: { ...ENV, ...o.env } });
  await menu(l.app, "applications");
  await expect(l.fenetre.getByTestId("page-applications")).toBeVisible();
  return l;
}

const lignes = (fenetre: Page) => fenetre.locator('[data-testid^="appli-"]');

test("⇧⌘A et l'entrée de la barre latérale ouvrent une seule page Applications", async () => {
  const { app, fenetre, fermer } = await ouvrirPage();
  await menu(app, "applications");
  await ouvrirOnglet(fenetre, "about:blank");
  await expect(fenetre.getByTestId("page-applications")).toBeHidden();
  await fenetre.getByTestId("bouton-applications").click();
  await expect(fenetre.getByTestId("page-applications")).toBeVisible();
  expect((await urlsOnglets(fenetre)).filter((u) => u === "webaios://applications")).toHaveLength(1);
  await fermer();
});

test("la liste montre type, origine et état ; les compteurs du volet sont justes", async () => {
  const { fenetre, fermer } = await ouvrirPage();
  await expect(lignes(fenetre)).toHaveCount(3);
  for (const [filtre, texte] of [
    ["tout", "Tout 3"],
    ["application", "Applications 1"],
    ["poc", "POC et tests 1"],
    ["sans-fiche", "Sans fiche 1"],
    ["arretee", "Arrêtées 3"],
  ] as const)
    await expect(fenetre.getByTestId(`filtre-${filtre}`)).toHaveText(texte);
  await expect(fenetre.getByTestId("filtre-erreur")).toHaveCount(0);
  await expect(fenetre.getByTestId("appli-zod")).toContainText("github.com/colinhacks/zod");
  await expect(fenetre.getByTestId("appli-zod")).toContainText("POC");
  await expect(fenetre.getByTestId("appli-essai")).toContainText("Application");
  await expect(fenetre.getByTestId("appli-vieux")).toContainText("Sans fiche");
  await expect(fenetre.getByTestId("appli-essai")).toHaveAttribute("data-etat", "arretee");
  await fermer();
});

test("filtrer par type et chercher", async () => {
  const { fenetre, fermer } = await ouvrirPage();
  await fenetre.getByTestId("filtre-poc").click();
  await expect(lignes(fenetre)).toHaveCount(1);
  await expect(fenetre.getByTestId("appli-zod")).toBeVisible();
  await fenetre.getByTestId("filtre-tout").click();
  const recherche = fenetre.getByTestId("recherche-applications");
  await recherche.fill("colin");
  await expect(lignes(fenetre)).toHaveCount(1);
  await expect(fenetre.getByTestId("appli-zod")).toBeVisible();
  await recherche.fill("ess");
  await expect(lignes(fenetre)).toHaveCount(1);
  await expect(fenetre.getByTestId("appli-essai")).toBeVisible();
  await fermer();
});

test("Lancer depuis la page : En marche, port affiché, fenêtre ouverte ; Arrêter la ferme", async () => {
  const { app, fenetre, fermer } = await ouvrirPage({ lent: true });
  const ligne = fenetre.getByTestId("appli-essai");
  await ligne.getByRole("button", { name: "Lancer" }).click();
  await expect(ligne).toHaveAttribute("data-etat", "lancement");
  await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 10_000 });
  await expect(ligne).toContainText(/port 1528\d/);
  await expect(fenetre.getByTestId("filtre-en-marche")).toHaveText("En marche 1");
  const page = await pageAppli(app);
  // « Ouvrir » remet la fenêtre devant sans la recharger.
  await page.evaluate(() => ((window as unknown as { marque: number }).marque = 1));
  await ligne.getByRole("button", { name: "Ouvrir" }).click();
  await new Promise((r) => setTimeout(r, 300));
  expect(await page.evaluate(() => (window as unknown as { marque?: number }).marque)).toBe(1);
  await ligne.getByRole("button", { name: "Arrêter" }).click();
  await expect(ligne).toHaveAttribute("data-etat", "arretee");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("un manifeste qui apparaît met la page à jour en direct", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  await expect(lignes(fenetre)).toHaveCount(3);
  // La surveillance des projets commence après le ménage des orphelins.
  await expect.poll(() => arrets(racine), { timeout: 10_000 }).toContain("WEBAIOS_APP=.*");
  await new Promise((r) => setTimeout(r, 500));
  ecrireProjet(racine, "nouveau", { manifeste: { nom: "Nouveau" } });
  await expect(fenetre.getByTestId("appli-nouveau")).toBeVisible({ timeout: 10_000 });
  await expect(fenetre.getByTestId("filtre-tout")).toHaveText("Tout 4");
  await fermer();
});

test("sans Docker : bandeau et Lancer désactivé", async () => {
  const { fenetre, fermer } = await ouvrirPage({ env: { FAUX_DOCKER_ABSENT: "1" } });
  await expect(fenetre.getByTestId("page-applications")).toContainText("Docker n'est pas lancé");
  await expect(fenetre.getByTestId("appli-essai").getByRole("button", { name: "Lancer" })).toBeDisabled();
  await expect(lignes(fenetre)).toHaveCount(3);
  await fermer();
});

test("Docker qui tarde à répondre : la liste s'affiche sans l'attendre", async () => {
  const { fenetre, fermer } = await ouvrirPage({ env: { FAUX_DOCKER_LENT: "1" } });
  await expect(lignes(fenetre)).toHaveCount(3, { timeout: 3_000 });
  await fermer();
});

test("liste vide : texte d'aide", async () => {
  const { fenetre, fermer } = await ouvrirPage({ projets: false });
  await expect(fenetre.getByTestId("page-applications")).toContainText("Demande à l'agent de tester un package ou de construire une app");
  await fermer();
});

test("la page Applications revient après un redémarrage, sans page web ni historique", async () => {
  const premier = await ouvrirPage();
  await premier.fermer();
  const { app, fenetre, fermer } = await lancer({ profil: premier.profil, racine: premier.racine, env: ENV });
  await expect(fenetre.getByTestId("page-applications")).toBeVisible();
  await expect(lignes(fenetre)).toHaveCount(3);
  expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL().startsWith("webaios:")))).toBe(false);
  const recents = await fenetre.evaluate(() => (window as unknown as { webaios: { historique: { recents(): Promise<{ url: string }[]> } } }).webaios.historique.recents());
  expect(recents.some((v) => v.url.startsWith("webaios:"))).toBe(false);
  await fermer();
});

// --- Supprimer, passer en application, déboguer ---

/** Ouvre le menu ⋯ d'une ligne. */
const plusDActions = (fenetre: Page, dossier: string) => fenetre.getByTestId(`appli-${dossier}`).getByRole("button", { name: "Plus d'actions" }).click();
const terminal = (fenetre: Page) => fenetre.getByTestId("panneau-agent").locator(".xterm-rows");
const entreeAgent = (racine: string) => {
  const f = join(racine, "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

async function lancerDepuisLaPage(fenetre: Page) {
  const ligne = fenetre.getByTestId("appli-essai");
  await ligne.getByRole("button", { name: "Lancer" }).click();
  await expect(ligne).toHaveAttribute("data-etat", "en-marche", { timeout: 10_000 });
}

test("Supprimer demande confirmation, efface le dossier et la ligne", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  const dossier = join(racine, "projets", "essai");
  await plusDActions(fenetre, "essai");
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  const confirmation = fenetre.getByTestId("confirmation-suppression");
  await expect(confirmation).toHaveText(/Supprimer « Essai » \? Son dossier sera effacé\./);
  await confirmation.getByRole("button", { name: "Annuler" }).click();
  await expect(confirmation).toBeHidden();
  await new Promise((r) => setTimeout(r, 300));
  expect(existsSync(dossier)).toBe(true);
  await plusDActions(fenetre, "essai");
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  await confirmation.getByRole("button", { name: "Supprimer" }).click();
  await expect.poll(() => existsSync(dossier)).toBe(false);
  await expect(fenetre.getByTestId("appli-essai")).toHaveCount(0);
  await expect(lignes(fenetre)).toHaveCount(2);
  await fermer();
});

test("pas de Supprimer pour une appli en marche", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  await lancerDepuisLaPage(fenetre);
  await plusDActions(fenetre, "essai");
  await expect(fenetre.getByRole("menuitem", { name: "Relancer" })).toBeVisible();
  await expect(fenetre.getByRole("menuitem", { name: "Supprimer" })).toHaveCount(0);
  await fenetre.keyboard.press("Escape");
  // Refusée aussi par le process principal, pas seulement absente du menu.
  await fenetre.evaluate(() => (window as unknown as { webaios: { applications: { agir(d: string, a: string): void } } }).webaios.applications.agir("essai", "supprimer"));
  await new Promise((r) => setTimeout(r, 500));
  expect(existsSync(join(racine, "projets", "essai", "webaios.json"))).toBe(true);
  await expect(fenetre.getByTestId("appli-essai")).toHaveAttribute("data-etat", "en-marche");
  await fermer();
});

test("Passer en application réécrit le manifeste et déplace la ligne", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  await expect(fenetre.getByTestId("filtre-application")).toHaveText("Applications 1");
  await plusDActions(fenetre, "zod");
  await fenetre.getByRole("menuitem", { name: "Passer en application" }).click();
  const manifeste = () => JSON.parse(readFileSync(join(racine, "projets", "zod", "webaios.json"), "utf8")) as { type: string; origine?: string };
  await expect.poll(() => manifeste().type).toBe("application");
  expect(manifeste().origine).toBe("https://github.com/colinhacks/zod");
  await expect(fenetre.getByTestId("filtre-application")).toHaveText("Applications 2");
  await expect(fenetre.getByTestId("appli-zod")).toContainText("Application");
  await fermer();
});

test("Déboguer pré-remplit le terminal sans envoyer, avec le journal", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  // Panneau fermé, agent pas encore démarré : Déboguer ouvre le panneau, et le texte attend la session.
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await fenetre.getByTestId("appli-essai").getByRole("button", { name: "Déboguer" }).click();
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect(terminal(fenetre)).toContainText("faux agent prêt>");
  await expect.poll(() => entreeAgent(racine)).toBe("[application : Essai — /workspace/projets/essai — journal : /workspace/.webaios/journaux/essai.log] ");
  await new Promise((r) => setTimeout(r, 300));
  expect(entreeAgent(racine)).not.toContain("\r");
  await fermer();
});

test("Déboguer un projet sans fiche", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  await fenetre.getByTestId("appli-vieux").getByRole("button", { name: "Déboguer" }).click();
  await expect.poll(() => entreeAgent(racine)).toBe("[projet sans fiche webaios.json : /workspace/projets/vieux] ");
  await fermer();
});

test("Déboguer une appli en marche lui donne l'accès à sa fenêtre", async () => {
  const { fenetre, racine, fermer } = await ouvrirPage();
  await lancerDepuisLaPage(fenetre);
  // L'agent n'a pas encore démarré : Déboguer ouvre sa session, dont l'ouverture remet la politique à zéro.
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await plusDActions(fenetre, "essai");
  await fenetre.getByRole("menuitem", { name: "Déboguer" }).click();
  await expect.poll(() => entreeAgent(racine)).toContain("[application : Essai");
  const lu = await appelerOutil(racine, "lire_onglet", { id: "app:essai" });
  expect(lu.texte).toContain("lien");
  await expect(fenetre.getByTestId("demande-permission")).toHaveCount(0);
  await fermer();
});
