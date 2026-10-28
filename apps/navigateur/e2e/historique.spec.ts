import { expect, test } from "@playwright/test";
import { dansLaVue, lancer, ouvrirOnglet, reglerEspaceActifPrive, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';

test("visiter deux pages puis ⌘Y : elles apparaissent ; un clic rouvre la page", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await fenetre.locator(onglets).first().hover();
  await fenetre.locator(onglets).first().getByRole("button", { name: "Fermer l'onglet" }).click();
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const panneau = fenetre.getByTestId("historique");
  await expect(panneau.getByRole("link", { name: /Page A/ })).toBeVisible();
  await expect(panneau.getByRole("link", { name: /Page B/ })).toBeVisible();
  await panneau.getByRole("link", { name: /Page A/ }).click();
  await expect(panneau).toBeHidden();
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(onglets, { hasText: "Page A" })).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("la recherche du panneau filtre et « Effacer l'historique » vide la liste", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const panneau = fenetre.getByTestId("historique");
  await panneau.getByRole("searchbox").fill("page b");
  await expect(panneau.getByRole("link")).toHaveCount(1);
  await panneau.getByRole("searchbox").fill("");
  await panneau.getByRole("button", { name: "Effacer l'historique" }).click();
  await panneau.getByRole("button", { name: "Tout" }).click();
  await expect(panneau.getByRole("link")).toHaveCount(0);
  await fermer();
});

test("la barre d'adresse suggère une page visitée", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill("page a");
  const suggestions = fenetre.getByTestId("suggestion");
  await expect(suggestions).toHaveCount(1);
  await expect(suggestions.first()).toContainText("Page A");
  await barre.press("ArrowDown");
  await barre.press("Enter");
  await expect(fenetre.locator(onglets, { hasText: "Page B" })).toHaveCount(0);
  await expect(fenetre.locator(onglets).nth(1)).toContainText("Page A");
  await fermer();
});

test("⌘Y : une visite faite dans un espace privé porte un cadenas, pas les autres", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await reglerEspaceActifPrive(fenetre, true);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "b.html", "document.title")).toBe("Page B");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const panneau = fenetre.getByTestId("historique");
  // L'espace est devenu privé après la visite de A : ses lignes déjà notées le sont aussi.
  await expect(panneau.locator('[data-prive="true"]', { hasText: "Page B" })).toContainText("🔒");
  await expect(panneau.locator('[data-prive="true"]', { hasText: "Page A" })).toHaveCount(1);
  await fermer();
});
