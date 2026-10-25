import { expect, test } from "@playwright/test";
import { creerEspace, glisser, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

const onglets = '[data-testid^="onglet-"]';
const espaces = '[data-testid^="espace-"]';

test("nouvel onglet, fermer avec ✕, l'onglet suivant devient actif", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await fenetre.getByTestId("nouvel-onglet").click();
  const saisie = fenetre.getByTestId("saisie-page-vide");
  await expect(saisie).toBeFocused();
  await saisie.fill(`${serveur.url}/b.html`);
  await saisie.press("Enter");
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(onglets).nth(1)).toHaveAttribute("aria-current", "page");
  await fenetre.locator(onglets).nth(0).click();
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await fenetre.locator(onglets).nth(0).hover();
  await fenetre.locator(onglets).nth(0).getByRole("button", { name: "Fermer l'onglet" }).click();
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await expect(fenetre.locator(onglets).nth(0)).toHaveAttribute("aria-current", "page");
  await expect(fenetre.locator(onglets).nth(0)).toContainText("Page B");
  await fermer();
});

test("glisser-déposer réordonne la liste et l'ordre survit à un redémarrage", async () => {
  const premier = await lancer();
  for (const p of ["a.html", "b.html", "plante.html"]) await ouvrirOnglet(premier.fenetre, `${serveur.url}/${p}`, { activer: false });
  const liste = premier.fenetre.locator(onglets);
  await expect(liste).toHaveCount(3);
  await glisser(premier.fenetre, liste.nth(2), liste.nth(0));
  await expect(liste.nth(0)).toContainText("plante.html");
  await premier.fermer();
  const second = await lancer({ profil: premier.profil });
  const apres = second.fenetre.locator(onglets);
  await expect(apres).toHaveCount(3);
  await expect(apres.nth(0)).toContainText("plante.html");
  await expect(apres.nth(1)).toContainText("a.html");
  await second.fermer();
});

test("épingler par clic droit : l'onglet passe dans les épinglés de l'espace seulement", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await fenetre.locator(onglets).first().click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Épingler" }).click();
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  await expect(fenetre.getByTestId("epingles").locator('[data-testid^="favori-"]')).toHaveCount(1);
  await creerEspace(fenetre, "Boulot", "💼");
  await expect(fenetre.getByTestId("epingles").locator('[data-testid^="favori-"]')).toHaveCount(0);
  await fermer();
});

test("un essentiel est visible dans tous les espaces", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await fenetre.locator(onglets).first().click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Ajouter aux essentiels" }).click();
  await expect(fenetre.getByTestId("essentiels").locator('[data-testid^="favori-"]')).toHaveCount(1);
  await creerEspace(fenetre, "Boulot", "💼");
  await expect(fenetre.locator(espaces, { hasText: "💼" })).toHaveAttribute("aria-current", "true");
  await expect(fenetre.getByTestId("essentiels").locator('[data-testid^="favori-"]')).toHaveCount(1);
  await fermer();
});

test("changer d'espace affiche ses onglets et retrouve l'onglet actif de chaque espace", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/plante.html`, { activer: false });
  await creerEspace(fenetre, "Boulot", "💼");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fenetre.locator(espaces, { hasText: "🏠" }).click();
  await expect(fenetre.locator(onglets)).toHaveCount(2);
  await expect(fenetre.locator(onglets, { hasText: "Page A" })).toHaveAttribute("aria-current", "page");
  await fenetre.locator(espaces, { hasText: "💼" }).click();
  await expect(fenetre.locator(onglets, { hasText: "Page B" })).toHaveAttribute("aria-current", "page");
  await fermer();
});

test("supprimer un espace avec onglets demande confirmation puis les ferme", async () => {
  const { fenetre, fermer } = await lancer();
  await creerEspace(fenetre, "Boulot", "💼");
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets)).toHaveCount(1);
  await fenetre.locator(espaces, { hasText: "💼" }).click({ button: "right" });
  await fenetre.getByRole("menuitem", { name: "Supprimer" }).click();
  const confirmation = fenetre.getByRole("alertdialog");
  await expect(confirmation).toContainText("Boulot");
  await expect(fenetre.locator(espaces)).toHaveCount(2);
  await confirmation.getByRole("button", { name: "Supprimer" }).click();
  await expect(fenetre.locator(espaces)).toHaveCount(1);
  await expect(fenetre.locator(onglets)).toHaveCount(0);
  await fermer();
});

test("fermer le dernier onglet affiche la page vide avec la barre d'adresse au focus", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await fenetre.locator(onglets).first().hover();
  await fenetre.getByRole("button", { name: "Fermer l'onglet" }).click();
  await expect(fenetre.getByTestId("page-vide")).toBeVisible();
  await expect(fenetre.getByTestId("saisie-page-vide")).toBeFocused();
  await fermer();
});

test("un onglet ouvert par l'agent porte l'indicateur ✦", async () => {
  const { fenetre, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`, { ouvertParAgent: true });
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect(fenetre.locator(onglets).nth(0).getByTitle("Ouvert par l'agent")).toHaveText("✦");
  await expect(fenetre.locator(onglets).nth(1).getByTitle("Ouvert par l'agent")).toHaveCount(0);
  await fermer();
});
