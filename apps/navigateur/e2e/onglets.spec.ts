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

test("fermer la dernière fenêtre principale quitte l'app", async () => {
  const { app } = await lancer();
  const fin = app.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await fin;
});
