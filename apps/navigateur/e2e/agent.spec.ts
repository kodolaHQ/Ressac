import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appelerOutil, dansLaVue, lancer, ouvrirOnglet, serveurTest } from "./aide";

let serveur: Awaited<ReturnType<typeof serveurTest>>;
test.beforeAll(async () => (serveur = await serveurTest()));
test.afterAll(() => serveur.fermer());

test("au lancement, le noyau prépare l'espace dans WEBAIOS_RACINE et le serveur MCP répond", async () => {
  const { racine, fermer } = await lancer();
  await expect.poll(() => existsSync(join(racine, "AGENTS.md")) && existsSync(join(racine, ".webaios", "mcp.json")), { timeout: 10_000 }).toBe(true);
  expect(await appelerOutil(racine, "lister_onglets")).toEqual({ texte: "Aucun onglet ouvert.", erreur: false });
  await fermer();
});

test("sans Docker, la navigation fonctionne", async () => {
  const { app, fenetre, fermer } = await lancer({ env: { FAUX_DOCKER_ABSENT: "1" } });
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await fermer();
});

test("lister_onglets : un onglet que l'utilisateur n'a pas partagé apparaît comme « onglet privé »", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
  const { texte } = await appelerOutil(racine, "lister_onglets");
  expect(texte).toContain("onglet privé");
  expect(texte).not.toContain("a.html");
  await fermer();
});

test("ouvrir_onglet sur une démo locale : onglet actif marqué ✦, lisible et capturable par l'agent", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
  const { texte: id, erreur } = await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/texte.html` });
  expect(erreur).toBe(false);
  const onglet = fenetre.locator(`[data-testid="onglet-${id}"]`);
  await expect(onglet).toHaveAttribute("aria-current", "page");
  await expect(onglet.locator(".agent")).toHaveText("✦");
  const lu = await appelerOutil(racine, "lire_onglet", { id });
  expect(lu.texte).toContain(`URL : ${serveur.url}/texte.html`);
  expect(lu.texte).toContain("Le chat dort");
  const capture = await appelerOutil(racine, "capture_ecran", { id });
  expect(capture.image?.startsWith("iVBOR")).toBe(true);
  expect(capture.image!.length).toBeGreaterThan(1000);
  await fermer();
});

test("un onglet de l'agent passé en arrière-plan reste lisible et capturable", async () => {
  const { racine, fermer } = await lancer();
  await expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
  const { texte: premier } = await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/texte.html` });
  await appelerOutil(racine, "ouvrir_onglet", { url: `${serveur.url}/b.html` });
  const lu = await appelerOutil(racine, "lire_onglet", { id: premier });
  expect(lu.texte).toContain("Le chat dort");
  const capture = await appelerOutil(racine, "capture_ecran", { id: premier });
  expect(capture.image!.length).toBeGreaterThan(1000);
  await fermer();
});

const pret = (racine: string) => expect.poll(() => existsSync(join(racine, ".webaios", "mcp.json"))).toBe(true);
const idOnglet = async (fenetre: import("@playwright/test").Page, texte: string) =>
  (await fenetre.locator('[data-testid^="onglet-"]', { hasText: texte }).getAttribute("data-testid"))!.slice("onglet-".length);

test("lire un onglet de l'utilisateur demande la permission ; Refuser → refus renvoyé à l'agent", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const lecture = appelerOutil(racine, "lire_onglet", { id: await idOnglet(fenetre, "Page A") });
  const bandeau = fenetre.getByTestId("demande-permission");
  await expect(bandeau).toContainText("L'agent veut lire l'onglet « Page A »");
  await bandeau.getByRole("button", { name: "Refuser" }).click();
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await expect(bandeau).toBeHidden();
  await fermer();
});

test("Autoriser une fois → l'agent lit la page ; la question ne revient pas pour le même site", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`);
  await expect.poll(() => dansLaVue(app, "texte.html", "document.title")).toBe("Texte");
  const id = await idOnglet(fenetre, "Texte");
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser une fois" }).click();
  expect((await lecture).texte).toContain("Le chat dort");
  expect((await appelerOutil(racine, "lire_onglet", { id })).texte).toContain("Le chat dort");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("onglet jamais affiché : une fois autorisé, il est chargé pour être lu", async () => {
  const { fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/texte.html`, { activer: false });
  await expect(fenetre.locator('[data-testid^="onglet-"]')).toHaveCount(1);
  const id = (await fenetre.locator('[data-testid^="onglet-"]').getAttribute("data-testid"))!.slice("onglet-".length);
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await fenetre.getByTestId("demande-permission").getByRole("button", { name: "Autoriser une fois" }).click();
  expect((await lecture).texte).toContain("Le chat dort");
  await fermer();
});

test("onglet fermé pendant la question → refusée, bandeau retiré", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await ouvrirOnglet(fenetre, `${serveur.url}/b.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  const id = await idOnglet(fenetre, "Page A");
  const lecture = appelerOutil(racine, "lire_onglet", { id });
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await fenetre.evaluate((id) => (window as unknown as { webaios: { agir(a: unknown): void } }).webaios.agir({ type: "fermerOnglet", id }), id);
  expect((await lecture).texte).toBe("Accès refusé par l'utilisateur à cet onglet.");
  await expect(fenetre.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});

test("une question de lecture ne s'affiche que dans la fenêtre active", async () => {
  const { app, fenetre, racine, fermer } = await lancer();
  await pret(racine);
  await ouvrirOnglet(fenetre, `${serveur.url}/a.html`);
  await expect.poll(() => dansLaVue(app, "a.html", "document.title")).toBe("Page A");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("nouvelle-fenetre")?.click());
  await expect.poll(() => app.windows().filter((p) => p.url().includes("/renderer/index.html")).length).toBe(2);
  const seconde = app.windows().find((p) => p.url().includes("/renderer/index.html") && p !== fenetre)!;
  // Fenêtres cachées : aucune n'a le focus, la fenêtre active est la première.
  void appelerOutil(racine, "lire_onglet", { id: await idOnglet(fenetre, "Page A") });
  await expect(fenetre.getByTestId("demande-permission")).toBeVisible();
  await new Promise((r) => setTimeout(r, 300));
  await expect(seconde.getByTestId("demande-permission")).toBeHidden();
  await fermer();
});
