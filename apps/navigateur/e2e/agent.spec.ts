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
