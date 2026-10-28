import { expect, test, type Page } from "@playwright/test";
import { creerEspace, dansLaVue, lancer, ouvrirOnglet, reglerEspaceActifPrive, serveurTest } from "./aide";

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

test("la barre d'adresse ne suggère qu'une fois une URL visitée dans deux espaces", async () => {
  const { app, fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await creerEspace(fenetre, "Travail", "💼");
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const barre = fenetre.getByTestId("barre-adresse");
  await barre.click();
  await barre.fill("page a");
  await expect(fenetre.getByTestId("suggestion")).toHaveCount(1);
  await fermer();
});

// Le serveur de test est sur 127.0.0.1 : la mémoire n'en retient rien, sauf en mode test (boucle locale permise).
const memoire = { env: { WEBAIOS_MEMOIRE_BOUCLE: "1" } };

/** Les lignes de l'historique (une par URL et par espace) dont l'URL contient `morceau`, vues par l'interface. */
const lignes = (fenetre: Page, morceau: string) =>
  fenetre.evaluate(async (morceau) => {
    const w = window as unknown as Window & { webaios: { historique: { recents(): Promise<{ url: string; retenu: boolean; prive: boolean }[]> } } };
    return (await w.webaios.historique.recents()).filter((v) => v.url.includes(morceau)).map((v) => ({ retenu: v.retenu, prive: v.prive }));
  }, morceau);

test("mémoire : le texte d'une page vue dans un espace non privé est retenu, marqué dans ⌘Y", async () => {
  const { app, fenetre, fermer } = await lancer(memoire);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => lignes(fenetre, "texte.html"), { timeout: 10_000 }).toEqual([{ retenu: true, prive: false }]);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const ligne = fenetre.getByTestId("historique").locator("li", { hasText: "texte.html" });
  await expect(ligne).toHaveAttribute("data-retenu", "true");
  await expect(ligne.getByLabel("Texte retenu pour l'agent")).toBeVisible();
  await fermer();
});

test("mémoire : rien n'est retenu d'une page vue dans un espace privé", async () => {
  const { fenetre, fermer } = await lancer(memoire);
  await reglerEspaceActifPrive(fenetre, true);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await creerEspace(fenetre, "Travail", "💼");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  // B, visitée après A dans un espace non privé, est retenue : la capture de A, si elle devait avoir lieu, est passée.
  await expect.poll(() => lignes(fenetre, "b.html"), { timeout: 10_000 }).toEqual([{ retenu: true, prive: false }]);
  expect(await lignes(fenetre, "a.html")).toEqual([{ retenu: false, prive: true }]);
  await fermer();
});

test("mémoire : « Oublier le texte retenu » ôte le repère et garde la visite", async () => {
  const { app, fenetre, fermer } = await lancer(memoire);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => lignes(fenetre, "a.html"), { timeout: 10_000 }).toEqual([{ retenu: true, prive: false }]);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const ligne = fenetre.getByTestId("historique").locator("li", { hasText: "Page A" });
  await expect(ligne).toHaveAttribute("data-retenu", "true");
  await ligne.click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Oublier le texte retenu" }).click();
  await expect(ligne).not.toHaveAttribute("data-retenu", "true");
  await expect(ligne.getByLabel("Texte retenu pour l'agent")).toHaveCount(0);
  expect(await lignes(fenetre, "a.html")).toEqual([{ retenu: false, prive: false }]);
  await fermer();
});

test("mémoire : rien n'est retenu d'une page qui n'a pas pu se charger, même dans un espace non privé", async () => {
  const { app, fenetre, fermer } = await lancer(memoire);
  const zone = fenetre.getByTestId("zone-contenu");
  // Injoignable (port 1, connexion refusée) : ni visite ni texte.
  await ouvrirOnglet(fenetre, "http://127.0.0.1:1/injoignable.html");
  await expect(zone.getByText("Impossible d'ouvrir cette page.")).toBeVisible();
  // Coupée en plein envoi : la visite est notée, la page finit en erreur.
  await ouvrirOnglet(fenetre, `${serveur.url}/coupee`);
  await expect(zone.getByText("Impossible d'ouvrir cette page.")).toBeVisible();
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  // B, visitée après, est retenue : la capture des pages en erreur, si elle devait avoir lieu, est passée.
  await expect.poll(() => lignes(fenetre, "b.html"), { timeout: 10_000 }).toEqual([{ retenu: true, prive: false }]);
  expect(await lignes(fenetre, "injoignable")).toEqual([]);
  expect(await lignes(fenetre, "/coupee")).toEqual([{ retenu: false, prive: false }]);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("historique")?.click());
  const ligne = fenetre.getByTestId("historique").locator("li", { hasText: "/coupee" });
  await expect(ligne).toBeVisible();
  await expect(ligne).not.toHaveAttribute("data-retenu", "true");
  await expect(ligne.getByLabel("Texte retenu pour l'agent")).toHaveCount(0);
  await fermer();
});
