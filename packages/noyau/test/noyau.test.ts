import { afterEach, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { creerNoyau, ErreurAtelier, type Noyau } from "../src/noyau.js";
import { PontFactice } from "../src/mcp/pont-factice.js";
import { dossierTemporaire } from "./aide/temporaire.js";
import { executeurFactice } from "./aide/executeur-factice.js";

let noyau: Noyau | undefined;
afterEach(async () => {
  await noyau?.arreter();
  noyau = undefined;
});

async function creerSansDocker() {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  noyau = await creerNoyau({ pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  return noyau;
}

const lireMcp = async (n: Noyau) => JSON.parse(await readFile(n.chemins.configMcp, "utf8")).mcpServers.webaios;

test("creerNoyau initialise l'espace et écrit mcp.json avec host.docker.internal", async () => {
  const n = await creerSansDocker();
  expect(existsSync(join(n.chemins.racine, "AGENTS.md"))).toBe(true);
  const mcp = await lireMcp(n);
  expect(mcp.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  expect(mcp.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test("Docker absent : creerNoyau réussit, etatAtelier → docker-absent, ouvrirSessionAgent lève ErreurAtelier", async () => {
  const n = await creerSansDocker();
  expect(await n.etatAtelier()).toBe("docker-absent");
  const erreur = await n.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(erreur).toBeInstanceOf(ErreurAtelier);
  expect(erreur.etat).toBe("docker-absent");
});

test("le serveur MCP répond avec le jeton, puis arreter le ferme", async () => {
  const n = await creerSansDocker();
  const mcp = await lireMcp(n);
  const local = mcp.url.replace("host.docker.internal", "127.0.0.1");
  expect((await fetch(local, { method: "POST" })).status).toBe(401);
  await n.arreter();
  noyau = undefined;
  await expect(fetch(local, { method: "POST" })).rejects.toThrow();
});

test("profil inconnu → erreur claire", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([[/ info$/, { code: 1 }]]);
  await expect(
    creerNoyau({ pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer, profilId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("creerNoyau n'attend pas une construction d'image lente", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // ne se termine jamais
  ]);
  const debut = Date.now();
  noyau = await creerNoyau({ pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  expect(Date.now() - debut).toBeLessThan(2000);
});

test("échec de démarrage du conteneur : creerNoyau réussit, la session lève ErreurAtelier avec le message", async () => {
  const racine = await dossierTemporaire();
  const { executer } = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  noyau = await creerNoyau({ pont: new PontFactice([], { actif: null, autoriser: false }), racine, executer });
  const erreur = await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(erreur).toBeInstanceOf(ErreurAtelier);
  expect(erreur.message).toContain("port is already allocated");
});
