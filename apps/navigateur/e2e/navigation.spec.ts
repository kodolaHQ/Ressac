import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const titreVue = (app: ElectronApplication, morceau: string) => dansLaVue(app, morceau, "document.title");

/** Bornes des vues web attachées à la première fenêtre. */
const bornesVues = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));

test("taper une adresse charge la page ; taper un texte lance une recherche Google", async () => {
  const { app, fenetre, fermer } = await lancer();
  await app.evaluate(({ session }) => {
    const g = globalThis as unknown as { demandes: string[] };
    g.demandes = [];
    session.fromPartition("persist:webaios").webRequest.onBeforeRequest({ urls: ["https://www.google.com/*"] }, (d, rappel) => {
      g.demandes.push(d.url);
      rappel({ cancel: true });
    });
  });
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await expect(barre).toHaveValue("127.0.0.1");
  await barre.click();
  await expect(barre).toHaveValue(`${serveur.url}/a.html`);
  await barre.fill(`${serveur.url}/b.html`);
  await barre.press("Enter");
  await expect.poll(() => titreVue(app, "b.html")).toBe("Page B");
  await barre.click();
  await barre.fill("chats mignons");
  await barre.press("Enter");
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { demandes: string[] }).demandes))
    .toContain("https://www.google.com/search?q=chats%20mignons");
  await fermer();
});

test("javascript:alert(1) dans la barre ne fait rien", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill("javascript:document.title='pirate'");
  await barre.press("Enter");
  await new Promise((r) => setTimeout(r, 500));
  expect(await titreVue(app, "a.html")).toBe("Page A");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("← et → suivent l'historique de l'onglet", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await expect(fenetre.getByRole("button", { name: "Reculer" })).toBeDisabled();
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill(`${serveur.url}/b.html`);
  await barre.press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fenetre.getByRole("button", { name: "Reculer" }).click();
  await expect(fenetre.locator(onglets).first()).toContainText("Page A");
  await fenetre.getByRole("button", { name: "Avancer" }).click();
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fermer();
});

test("⌘+ puis redémarrage : le zoom de l'onglet est conservé", async () => {
  const premier = await lancer();
  await ouvrirOnglet(premier.fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(premier.app, "a.html")).toBe("Page A");
  await premier.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("zoom-plus")?.click());
  const zoom = (app: ElectronApplication) =>
    app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.getZoomFactor());
  await expect.poll(() => zoom(premier.app)).toBeCloseTo(1.1);
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  await expect.poll(() => zoom(second.app)).toBeCloseTo(1.1);
  await second.fermer();
});

test("le zoom est propre à l'onglet, pas au site", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => titreVue(app, "b.html")).toBe("Page B");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("zoom-plus")?.click());
  await fenetre.locator(onglets).first().click();
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  expect(
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.getZoomFactor()),
  ).toBeCloseTo(1);
  await fermer();
});

test("mode compact : barre cachée, réapparaît au bord gauche, le contenu prend toute la largeur", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => titreVue(app, "a.html")).toBe("Page A");
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(240);
  await fenetre.getByRole("button", { name: "Mode compact" }).click();
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  // La souris arrive au bord gauche, au-dessus de la page web.
  await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.sendInputEvent({ type: "mouseMove", x: 3, y: 300 }),
  );
  await expect(fenetre.getByTestId("barre-laterale")).toBeVisible();
  await fenetre.mouse.move(120, 300);
  await fenetre.mouse.move(700, 300);
  await expect(fenetre.getByTestId("barre-laterale")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.x).toBe(0);
  await fermer();
});
