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
