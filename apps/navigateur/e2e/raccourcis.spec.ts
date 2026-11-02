import { expect, test, type ElectronApplication } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    if (!item) throw new Error(`entrée de menu inconnue : ${id}`);
    item.click();
  }, id);
const bornesVues = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((v) => v.getBounds()));

test("⌘T puis ⌘W : l'onglet s'ouvre puis se ferme ; ⇧⌘T le rouvre avec son URL", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvel-onglet");
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await fenetre.getByTestId("saisie-page-vide").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("saisie-page-vide").press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await menu(app, "fermer-onglet");
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "rouvrir-onglet");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await menu(app, "adresse");
  await expect(fenetre.getByTestId("barre-adresse")).toBeFocused();
  await fermer();
});

test("⌘N ouvre une seconde fenêtre avec ses propres onglets ; les fermer une à une laisse l'app ouverte (macOS)", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await menu(app, "nouvelle-fenetre");
  const interfaces = () => app.windows().filter((p) => p.url().includes("/renderer/index.html"));
  await expect.poll(() => interfaces().length).toBe(2);
  const seconde = interfaces().find((p) => p !== fenetre)!;
  await expect(seconde.getByTestId("page-vide")).toBeVisible();
  await expect(seconde.locator(onglets)).toHaveCount(0);
  await seconde.getByTestId("saisie-page-vide").fill(`${serveur.url}/b.html`);
  await seconde.getByTestId("saisie-page-vide").press("Enter");
  await expect(seconde.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  // Même espace que la fenêtre d'origine.
  await expect(seconde.locator('[data-testid^="espace-"][aria-current="true"]')).toHaveText("🏠");

  await seconde.evaluate(() => window.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await fenetre.evaluate(() => 1 + 1)).toBe(2);
  await menu(app, "fermer-fenetre");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
  expect(await app.evaluate(() => 1 + 1)).toBe(2); // toujours vivante
  await fermer();
});

/** Trois onglets a, b, plante ; ordre récent : plante (actif), a, b. */
async function troisOnglets(app: ElectronApplication, fenetre: import("@playwright/test").Page) {
  for (const p of ["a.html", "b.html", "plante.html"]) await ouvrirOnglet(fenetre, `${serveur.url}/${p}`, { activer: false });
  await expect(fenetre.locator(onglets)).toHaveCount(3);
  await menu(app, "onglet-1");
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await menu(app, "onglet-3");
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
}

/**
 * Relâche ⌃ dans l'interface. `fenetre.keyboard.up` (CDP) n'atteint pas `before-input-event` : seul `sendInputEvent`
 * passe par là, comme une vraie touche (le process principal valide le parcours).
 */
const relacherCtrl = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Control" }));

test("⌃Tab bref revient à l'onglet précédent", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  await menu(app, "onglet-suivant");
  await relacherCtrl(app);
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await new Promise((r) => setTimeout(r, 300));
  await expect(panneau).toHaveCount(0);
  await menu(app, "onglet-9");
  await expect(fenetre.locator(onglets).nth(2)).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("⌃Tab tenu ouvre le panneau des onglets récents", async () => {
  const { app, fenetre, fermer } = await lancer();
  await troisOnglets(app, fenetre);
  const panneau = fenetre.getByTestId("panneau-onglets");
  const cartes = panneau.getByTestId("carte-onglet");
  await menu(app, "onglet-suivant");
  // Visible : le focus donné à l'interface par la capture du fond ne fait pas perdre le focus à la fenêtre.
  await expect(panneau).toBeVisible();
  await expect(cartes).toHaveCount(3);
  await expect(cartes.nth(1)).toHaveAttribute("aria-selected", "true");
  await menu(app, "onglet-suivant");
  await expect(cartes.nth(2)).toHaveAttribute("aria-selected", "true");
  await relacherCtrl(app);
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(1)).toHaveAttribute("aria-current", "page");

  // Échap annule : l'onglet ne change pas.
  await menu(app, "onglet-suivant");
  await expect(panneau).toBeVisible();
  await fenetre.keyboard.press("Escape");
  await expect(panneau).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(1)).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("⌃2 active le deuxième espace", async () => {
  const { app, fenetre, fermer } = await lancer();
  await fenetre.evaluate(() => {
    const w = window as unknown as { webaios: { agir(a: unknown): void } };
    w.webaios.agir({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  });
  await expect(fenetre.locator('[data-testid^="espace-"]')).toHaveCount(2);
  await menu(app, "espace-2");
  await expect(fenetre.locator('[data-testid^="espace-"][aria-current="true"]')).toHaveText("💼");
  await fermer();
});

test("⌘J affiche puis masque le panneau agent, et la vue web se redimensionne", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const largeur = (await bornesVues(app))[0]!.width;
  await menu(app, "panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeVisible();
  await expect.poll(async () => Math.abs(((await bornesVues(app))[0]?.width ?? 0) - (largeur - 420))).toBeLessThanOrEqual(1);
  await menu(app, "panneau-agent");
  await expect(fenetre.getByTestId("panneau-agent")).toBeHidden();
  await expect.poll(async () => (await bornesVues(app))[0]?.width).toBe(largeur);
  await fermer();
});

test("⇧⌘J ouvre les téléchargements ; ⌘[ et ⌘] suivent l'historique", async () => {
  const { app, fenetre, fermer } = await lancer();
  await menu(app, "telechargements");
  await expect(fenetre.getByTestId("telechargements")).toBeVisible();
  await menu(app, "telechargements");
  await expect(fenetre.getByTestId("telechargements")).toBeHidden();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await fenetre.getByTestId("barre-adresse").click();
  await fenetre.getByTestId("barre-adresse").fill(`${serveur.url}/b.html`);
  await fenetre.getByTestId("barre-adresse").press("Enter");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await menu(app, "reculer");
  await expect(fenetre.locator(onglets).first()).toContainText("Page A");
  await menu(app, "avancer");
  await expect(fenetre.locator(onglets).first()).toContainText("Page B");
  await fermer();
});
