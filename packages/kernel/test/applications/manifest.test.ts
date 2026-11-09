import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { spacePaths } from "../../src/paths.js";
import { validFolder, writeType, readProjects, watchProjects } from "../../src/applications/manifest.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.projets, { recursive: true });
  return c;
}

async function write(c: ReturnType<typeof spacePaths>, folder: string, content: string) {
  await mkdir(join(c.projets, folder), { recursive: true });
  await writeFile(join(c.projets, folder, "webaios.json"), content);
}

test("a project with a valid manifest", async () => {
  const c = await space();
  await write(c, "todo", '{"nom":"Todo","type":"application","lancement":"npx vite --port {port}"}');
  const projects = await readProjects(c);
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({
    dossier: "todo",
    nom: "Todo",
    chemin: join(c.projets, "todo"),
    manifeste: { type: "application", lancement: "npx vite --port {port}" },
  });
  expect(Number.isNaN(Date.parse(projects[0]!.creeLe))).toBe(false);
});

test("without a manifest: sans fiche", async () => {
  const c = await space();
  await mkdir(join(c.projets, "demo-vite"));
  await mkdir(join(c.projets, ".cache"));
  expect(await readProjects(c)).toMatchObject([{ dossier: "demo-vite", nom: "demo-vite", sansFiche: "pas de webaios.json" }]);
});

test("cut manifest: sans fiche with the reason, then normal", async () => {
  const c = await space();
  await write(c, "a", '{"type":"app');
  const [cut] = await readProjects(c);
  expect(cut).toHaveProperty("sansFiche");
  expect((cut as { sansFiche: string }).sansFiche.startsWith("webaios.json invalide")).toBe(true);
  await write(c, "a", '{"type":"poc","lancement":"node s.mjs"}');
  const [good] = await readProjects(c);
  expect(good).toMatchObject({ nom: "a", manifeste: { type: "poc" } });
});

test("unknown type or empty launch: sans fiche", async () => {
  const c = await space();
  await write(c, "a", '{"type":"jeu","lancement":"x"}');
  await write(c, "b", '{"type":"poc","lancement":""}');
  const projects = await readProjects(c);
  expect(projects).toHaveLength(2);
  for (const p of projects) expect((p as { sansFiche: string }).sansFiche).toMatch(/^webaios\.json invalide/);
});

test("folder with an unsupported name: sans fiche", async () => {
  const c = await space();
  await write(c, "mon projet", '{"type":"poc","lancement":"x"}');
  expect(await readProjects(c)).toMatchObject([{ dossier: "mon projet", sansFiche: "nom de dossier non pris en charge" }]);
  expect(validFolder("mon projet")).toBe(false);
  expect(validFolder("-a")).toBe(false);
  expect(validFolder("a.b_c-1")).toBe(true);
});

test("writeType keeps the other fields", async () => {
  const c = await space();
  await write(c, "a", '{"type":"poc","lancement":"x","origine":"https://exemple.fr/","x":{"y":1}}');
  await writeType(c, "a", "application");
  const written = JSON.parse(await readFile(join(c.projets, "a", "webaios.json"), "utf8"));
  expect(written).toEqual({ type: "application", lancement: "x", origine: "https://exemple.fr/", x: { y: 1 } });
});

test("watchProjects signals a new manifest and ignores node_modules", async () => {
  const c = await space();
  await mkdir(join(c.projets, "a", "node_modules", "p"), { recursive: true });
  let calls = 0;
  const stop = watchProjects(c, () => calls++);
  await attendre(400);
  await writeFile(join(c.projets, "a", "node_modules", "p", "webaios.json"), "{}");
  await attendre(500);
  expect(calls).toBe(0);
  await write(c, "a", '{"type":"poc","lancement":"x"}');
  await attendre(500);
  await stop();
  expect(calls).toBe(1);
});
