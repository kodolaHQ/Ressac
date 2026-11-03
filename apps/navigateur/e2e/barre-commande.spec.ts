import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const actif = '[data-testid^="onglet-"][aria-selected="true"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`entrée de menu inconnue : ${id}`);
    item.click();
  }, id);

test("⌘T ouvre la modale vide, focus dans le champ", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toBeFocused();
  await expect(saisie).toHaveValue("");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fermer();
});

test("⌘T + Entrée à vide affiche l'accueil", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌘T + adresse ouvre un nouvel onglet", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(actif)).toContainText("Page B");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌘L préremplit l'URL active, tout sélectionné", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "adresse");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toHaveValue(`${serveur.url}/a.html`);
  await expect(saisie).toBeFocused();
  const sel = await saisie.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length]);
  expect(sel).toEqual([0, `${serveur.url}/a.html`.length, `${serveur.url}/a.html`.length]);
  await saisie.fill(`${serveur.url}/b.html`);
  await saisie.press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(actif)).toContainText("Page B");
  await fermer();
});

test("⌘L sur l'accueil = champ vide", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "adresse");
  const saisie = fenetre.getByTestId("saisie-commande");
  await expect(saisie).toHaveValue("");
  await saisie.press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fermer();
});

test("Échap ferme et la page réapparaît", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("modale-apercu")).toBeVisible();
  await fenetre.getByTestId("saisie-commande").press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("modale-apercu")).toHaveCount(0);
  await fermer();
});

test("frappe pendant la capture conservée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await fenetre.keyboard.type("abc");
  await expect(fenetre.getByTestId("saisie-commande")).toHaveValue("abc");
  await fermer();
});

const deuxOnglets = async (fenetre: Page) => {
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(2);
};

test("se ferme quand l'onglet actif change pendant qu'elle est ouverte", async () => {
  const { app, fenetre, fermer } = await lancer();
  await deuxOnglets(fenetre);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.locator(onglets).nth(0).evaluate((el: HTMLElement) => el.click());
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("un clic sur le voile ferme la barre", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.mouse.click(5, 5);
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("⌃Tab par-dessus la barre : Échap annule le panneau ⌃Tab, la barre reste", async () => {
  const { app, fenetre, fermer } = await lancer();
  await deuxOnglets(fenetre);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await menu(app, "onglet-suivant");
  const panneau = fenetre.getByTestId("panneau-onglets");
  await expect(panneau).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.getByTestId("barre-commande")).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await fermer();
});

test("Entrée à vide sur l'accueil avec l'historique ouvert : l'accueil, sans panneau", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "historique");
  await expect(fenetre.getByTestId("historique")).toBeVisible();
  await menu(app, "nouvel-onglet");
  await fenetre.getByTestId("saisie-commande").press("Enter");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect(fenetre.getByTestId("historique")).toHaveCount(0);
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await fermer();
});

test("Échap rend le clavier à la page affichée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-commande")).toBeFocused();
  await app.evaluate(({ webContents }) => {
    const g = globalThis as { focusVues?: number[] };
    g.focusVues = [];
    for (const wc of webContents.getAllWebContents()) {
      const focus = wc.focus.bind(wc);
      wc.focus = () => {
        g.focusVues!.push(wc.id);
        focus();
      };
    }
  });
  await fenetre.keyboard.press("Escape");
  await expect(fenetre.getByTestId("barre-commande")).toHaveCount(0);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const appels = (globalThis as { focusVues?: number[] }).focusVues ?? [];
        const affichee = BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => (v as Electron.WebContentsView).webContents).find(Boolean);
        return appels.length > 0 && appels.at(-1) === affichee?.id;
      }),
    )
    .toBe(true);
  await fermer();
});
