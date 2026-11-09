import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { dossierValide, ecrireType, lireProjets, surveillerProjets } from "../../src/applications/manifeste.js";
import { dossierTemporaire } from "../aide/temporaire.js";

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.projets, { recursive: true });
  return c;
}

async function ecrire(c: ReturnType<typeof cheminsEspace>, dossier: string, contenu: string) {
  await mkdir(join(c.projets, dossier), { recursive: true });
  await writeFile(join(c.projets, dossier, "webaios.json"), contenu);
}

test("a project with a valid manifest", async () => {
  const c = await espace();
  await ecrire(c, "todo", '{"nom":"Todo","type":"application","lancement":"npx vite --port {port}"}');
  const projets = await lireProjets(c);
  expect(projets).toHaveLength(1);
  expect(projets[0]).toMatchObject({
    dossier: "todo",
    nom: "Todo",
    chemin: join(c.projets, "todo"),
    manifeste: { type: "application", lancement: "npx vite --port {port}" },
  });
  expect(Number.isNaN(Date.parse(projets[0]!.creeLe))).toBe(false);
});

test("without a manifest: sans fiche", async () => {
  const c = await espace();
  await mkdir(join(c.projets, "demo-vite"));
  await mkdir(join(c.projets, ".cache"));
  expect(await lireProjets(c)).toMatchObject([{ dossier: "demo-vite", nom: "demo-vite", sansFiche: "pas de webaios.json" }]);
});

test("cut manifest: sans fiche with the reason, then normal", async () => {
  const c = await espace();
  await ecrire(c, "a", '{"type":"app');
  const [coupe] = await lireProjets(c);
  expect(coupe).toHaveProperty("sansFiche");
  expect((coupe as { sansFiche: string }).sansFiche.startsWith("webaios.json invalide")).toBe(true);
  await ecrire(c, "a", '{"type":"poc","lancement":"node s.mjs"}');
  const [bon] = await lireProjets(c);
  expect(bon).toMatchObject({ nom: "a", manifeste: { type: "poc" } });
});

test("unknown type or empty launch: sans fiche", async () => {
  const c = await espace();
  await ecrire(c, "a", '{"type":"jeu","lancement":"x"}');
  await ecrire(c, "b", '{"type":"poc","lancement":""}');
  const projets = await lireProjets(c);
  expect(projets).toHaveLength(2);
  for (const p of projets) expect((p as { sansFiche: string }).sansFiche).toMatch(/^webaios\.json invalide/);
});

test("folder with an unsupported name: sans fiche", async () => {
  const c = await espace();
  await ecrire(c, "mon projet", '{"type":"poc","lancement":"x"}');
  expect(await lireProjets(c)).toMatchObject([{ dossier: "mon projet", sansFiche: "nom de dossier non pris en charge" }]);
  expect(dossierValide("mon projet")).toBe(false);
  expect(dossierValide("-a")).toBe(false);
  expect(dossierValide("a.b_c-1")).toBe(true);
});

test("ecrireType keeps the other fields", async () => {
  const c = await espace();
  await ecrire(c, "a", '{"type":"poc","lancement":"x","origine":"https://exemple.fr/","x":{"y":1}}');
  await ecrireType(c, "a", "application");
  const ecrit = JSON.parse(await readFile(join(c.projets, "a", "webaios.json"), "utf8"));
  expect(ecrit).toEqual({ type: "application", lancement: "x", origine: "https://exemple.fr/", x: { y: 1 } });
});

test("surveillerProjets signals a new manifest and ignores node_modules", async () => {
  const c = await espace();
  await mkdir(join(c.projets, "a", "node_modules", "p"), { recursive: true });
  let appels = 0;
  const arreter = surveillerProjets(c, () => appels++);
  await attendre(400);
  await writeFile(join(c.projets, "a", "node_modules", "p", "webaios.json"), "{}");
  await attendre(500);
  expect(appels).toBe(0);
  await ecrire(c, "a", '{"type":"poc","lancement":"x"}');
  await attendre(500);
  await arreter();
  expect(appels).toBe(1);
});
