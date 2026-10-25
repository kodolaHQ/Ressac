import { expect, test } from "@playwright/test";
import { dansLaVue, lancer, nombreWebContents, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';

test("ouvrir un onglet charge la page, son titre apparaît dans la liste", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets, { hasText: "Page A" })).toBeVisible();
  await fermer();
});

test("seule la vue de l'onglet actif existe au départ ; une autre est créée à l'activation", async () => {
  const { app, fenetre, fermer } = await lancer();
  const depart = await nombreWebContents(app);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets, { hasText: "Page A" })).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`, { activer: false });
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  expect(await nombreWebContents(app)).toBe(depart + 1);
  await fenetre.locator(onglets).nth(1).click();
  await expect.poll(() => nombreWebContents(app)).toBe(depart + 2);
  await expect(fenetre.locator(onglets, { hasText: "Page B" })).toBeVisible();
  await fermer();
});

test("un lien target=_blank ouvre un onglet juste après la source", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/plante.html`, { activer: false });
  await expect(fenetre.locator(onglets, { hasText: "Page A" })).toBeVisible();
  await dansLaVue(app, "a.html", "document.getElementById('lien').click()");
  await expect(fenetre.locator(onglets)).toHaveCount(3);
  await expect(fenetre.locator(onglets).nth(1)).toContainText("Page B");
  await fermer();
});

test("window.open avec dimensions ouvre une popup ; la fermer ne quitte pas l'app", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/popup.html`);
  await expect(fenetre.locator(onglets, { hasText: "Popup source" })).toBeVisible();
  const popup = app.waitForEvent("window");
  await dansLaVue(app, "popup.html", "document.getElementById('ouvrir').click()");
  const page = await popup;
  await page.waitForEvent("close");
  await new Promise((r) => setTimeout(r, 500));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await fenetre.evaluate(() => 1 + 1)).toBe(2);
  expect(await nombreWebContents(app)).toBe(2);
  await fermer();
});

test("une page qui plante affiche le message et Recharger fonctionne ; le reste du navigateur continue de tourner", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/plante.html`);
  await expect.poll(() => dansLaVue(app, "plante.html", "document.title")).toBe("Plante");
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("plante.html"))?.forcefullyCrashRenderer());
  await expect(fenetre.getByText("Cette page a planté.")).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`, { activer: false });
  await expect(fenetre.locator(onglets, { hasText: "a.html" })).toBeVisible();
  await fenetre.getByTestId("zone-contenu").getByRole("button", { name: "Recharger" }).click();
  await expect(fenetre.getByText("Cette page a planté.")).toBeHidden();
  await expect.poll(() => dansLaVue(app, "plante.html", "document.title")).toBe("Plante");
  await fermer();
});

test("macOS : fermer la dernière fenêtre garde l'app ; le Dock la rouvre avec ses onglets", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.evaluate(() => 1 + 1)).toBe(2); // toujours vivante
  // Fenêtre fermée : ses pages aussi (une vidéo ne continue pas de jouer sans fenêtre).
  expect(await nombreWebContents(app)).toBe(0);
  // Un changement d'état ensuite (ici le moteur de recherche) ne doit pas la faire réapparaître.
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("moteur-qwant")?.click());
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(1);
  const rouverte = app.windows().find((p) => p.url().includes("/renderer/index.html"))!;
  await expect(rouverte.locator(onglets)).toHaveCount(1);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await fermer();
});

test("macOS : ⌘N sans fenêtre ouverte rouvre la fenêtre fermée, sans en créer une seconde", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("une page injoignable affiche un message d'erreur et Recharger, au lieu d'une page blanche", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, "http://127.0.0.1:1/");
  const zone = fenetre.getByTestId("zone-contenu");
  await expect(zone.getByText("Impossible d'ouvrir cette page.")).toBeVisible();
  await expect(zone.getByText(/ERR_[A-Z_]+/)).toBeVisible();
  await expect(zone.getByRole("button", { name: "Recharger" })).toBeVisible();
  await fermer();
});

test("⇧clic sur un lien ouvre un onglet, pas une petite popup", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/lien.html`);
  await expect.poll(() => dansLaVue(app, "lien.html", "document.title")).toBe("Lien");
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("lien.html"))!;
    for (const type of ["mouseDown", "mouseUp"] as const) wc.sendInputEvent({ type, x: 30, y: 30, button: "left", clickCount: 1, modifiers: ["shift"] });
  });
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await fermer();
});

test("popup : son titre montre le site ; un lien target=_blank y ouvre un onglet ; une étape suivante reste une popup", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/popup.html`);
  await expect.poll(() => dansLaVue(app, "popup.html", "document.title")).toBe("Popup source");
  await dansLaVue(app, "popup.html", "document.getElementById('ouvrir-reste').click()");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  const titrePopup = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("popup-reste"))?.getTitle());
  await expect.poll(titrePopup).toBe(`${new URL(serveur.url).host} — Connexion`);
  await dansLaVue(app, "popup-reste.html", "document.getElementById('lien-blank').click()");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  await dansLaVue(app, "popup-reste.html", "document.getElementById('sous-popup').click()");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(3);
  await fermer();
});
