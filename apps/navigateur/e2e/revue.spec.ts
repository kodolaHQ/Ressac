import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const interfaces = (app: ElectronApplication) => app.windows().filter((p) => p.url().includes("/renderer/index.html"));
const nbFenetres = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
/** Met au premier plan la fenêtre dont l'interface ou la page porte cette URL. */
const focaliser = (app: ElectronApplication, morceau: string) =>
  app.evaluate(({ BrowserWindow }, morceau) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes(morceau));
    w?.focus();
    return BrowserWindow.getFocusedWindow() === w;
  }, morceau);

async function ouvrirPopupDurable(app: ElectronApplication, fenetre: import("@playwright/test").Page) {
  await ouvrirOnglet(fenetre, `${serveur.url}/popup.html`);
  await expect.poll(() => dansLaVue(app, "popup.html", "document.title")).toBe("Popup source");
  await dansLaVue(app, "popup.html", "document.getElementById('ouvrir-reste').click()");
  await expect.poll(() => nbFenetres(app)).toBe(2);
  await expect.poll(() => focaliser(app, "popup-reste.html")).toBe(true);
}

test("⌘W dans une popup ferme la popup, pas l'onglet de la fenêtre principale", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirPopupDurable(app, fenetre);
  await menu(app, "fermer-onglet");
  await expect.poll(() => nbFenetres(app)).toBe(1);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("⌘W dans une popup quand la fenêtre principale est sur une page vide ne quitte pas l'app", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirPopupDurable(app, fenetre);
  await fenetre.evaluate(() => {
    const w = window as unknown as { webaios: { agir(a: unknown): void; fenetreId: string } };
    w.webaios.agir({ type: "afficherPageVide", fenetreId: w.webaios.fenetreId });
  });
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect.poll(() => focaliser(app, "popup-reste.html")).toBe(true);
  await menu(app, "fermer-onglet");
  await expect.poll(() => nbFenetres(app)).toBe(1);
  expect(await fenetre.evaluate(() => 1 + 1)).toBe(2);
  await fermer();
});

test("la recherche ⌘F reste ouverte quand l'état change ailleurs (onglet en arrière-plan)", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  await menu(app, "rechercher");
  await expect(fenetre.getByTestId("recherche-page")).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`, { activer: false });
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.getByTestId("recherche-page")).toBeVisible();
  await fermer();
});

test("⌘W sur le dernier onglet : la page vide a vraiment le focus clavier", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("a.html"))?.focus());
  await menu(app, "fermer-onglet");
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await expect
    .poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().includes("/renderer/index.html"))?.isFocused()))
    .toBe(true);
  await fermer();
});

test("⌘W sur une page vide ne ferme pas une fenêtre qui a encore des onglets dans un autre espace", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "nouvelle-fenetre");
  await expect.poll(() => interfaces(app).length).toBe(2);
  const seconde = interfaces(app).find((p) => p !== fenetre)!;
  await seconde.evaluate((url) => {
    const w = window as unknown as { webaios: { agir(a: unknown): void; fenetreId: string } };
    w.webaios.agir({ type: "creerEspace", nom: "Boulot", icone: "💼", fenetreId: w.webaios.fenetreId });
    setTimeout(() => w.webaios.agir({ type: "ouvrirOnglet", fenetreId: w.webaios.fenetreId, url }), 100);
  }, `${serveur.url}/b.html`);
  await expect(seconde.locator(onglets)).toHaveCount(1);
  await seconde.locator('[data-testid^="espace-"]', { hasText: "🏠" }).click();
  await expect(seconde.getByTestId("page-vide")).toBeVisible();
  // Mettre la seconde fenêtre (la plus récente) au premier plan, et s'assurer qu'elle l'est.
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().sort((a, b) => b.id - a.id)[0]!;
        w.focus();
        return BrowserWindow.getFocusedWindow() === w;
      }),
    )
    .toBe(true);
  await menu(app, "fermer-onglet");
  await new Promise((r) => setTimeout(r, 500));
  expect(interfaces(app)).toHaveLength(2);
  await fermer();
});

test("« Oublier les autorisations de ce site » : la page redemandera", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/notif.html`);
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("Notifications");
  await dansLaVue(app, "notif.html", "document.getElementById('demander').click()");
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser" }).click();
  await expect.poll(() => dansLaVue(app, "notif.html", "Notification.permission")).toBe("granted");
  await menu(app, "oublier-autorisations");
  await dansLaVue(app, "notif.html", "location.reload()");
  await expect.poll(() => dansLaVue(app, "notif.html", "document.title")).toBe("Notifications");
  // Électron ne sait pas dire « pas encore demandé » : ce qui compte, c'est que la question revienne.
  await dansLaVue(app, "notif.html", "document.getElementById('demander').click()");
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await fermer();
});

test("un lien mailto: demande avant d'ouvrir une autre application", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/mailto.html`);
  await expect.poll(() => dansLaVue(app, "mailto.html", "document.title")).toBe("Mailto");
  await dansLaVue(app, "mailto.html", "document.getElementById('lien').click()");
  const bandeau = fenetre.getByTestId("demande-permission");
  await expect(bandeau).toContainText("mailto:user@example.com");
  await bandeau.getByRole("button", { name: "Refuser" }).click();
  await expect(bandeau).toBeHidden();
  await fermer();
});
