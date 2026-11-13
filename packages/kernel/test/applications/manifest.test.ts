import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spacePaths } from "../../src/paths.js";
import { validFolder, writeType, readProjects, watchProjects } from "../../src/applications/manifest.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.projects, { recursive: true });
  return c;
}

async function write(c: ReturnType<typeof spacePaths>, folder: string, content: string) {
  await mkdir(join(c.projects, folder), { recursive: true });
  await writeFile(join(c.projects, folder, "ressac.json"), content);
}

test("a project with a valid manifest", async () => {
  const c = await space();
  await write(c, "todo", '{"name":"Todo","type":"app","launch":"npx vite --port {port}"}');
  const projects = await readProjects(c);
  expect(projects).toHaveLength(1);
  expect(projects[0]).toMatchObject({
    folder: "todo",
    name: "Todo",
    path: join(c.projects, "todo"),
    manifest: { type: "app", launch: "npx vite --port {port}" },
  });
  expect(Number.isNaN(Date.parse(projects[0]!.createdAt))).toBe(false);
});

test("without a manifest: sans fiche", async () => {
  const c = await space();
  await mkdir(join(c.projects, "demo-vite"));
  await mkdir(join(c.projects, ".cache"));
  expect(await readProjects(c)).toMatchObject([{ folder: "demo-vite", name: "demo-vite", noManifest: "pas de ressac.json" }]);
});

test("cut manifest: sans fiche with the reason, then normal", async () => {
  const c = await space();
  await write(c, "a", '{"type":"app');
  const [cut] = await readProjects(c);
  expect(cut).toHaveProperty("noManifest");
  expect((cut as { noManifest: string }).noManifest.startsWith("ressac.json invalide")).toBe(true);
  await write(c, "a", '{"type":"poc","launch":"node s.mjs"}');
  const [good] = await readProjects(c);
  expect(good).toMatchObject({ name: "a", manifest: { type: "poc" } });
});

test("unknown type or empty launch: sans fiche", async () => {
  const c = await space();
  await write(c, "a", '{"type":"jeu","launch":"x"}');
  await write(c, "b", '{"type":"poc","launch":""}');
  const projects = await readProjects(c);
  expect(projects).toHaveLength(2);
  for (const p of projects) expect((p as { noManifest: string }).noManifest).toMatch(/^ressac\.json invalide/);
});

test("folder with an unsupported name: sans fiche", async () => {
  const c = await space();
  await write(c, "mon projet", '{"type":"poc","launch":"x"}');
  expect(await readProjects(c)).toMatchObject([{ folder: "mon projet", noManifest: "nom de dossier non pris en charge" }]);
  expect(validFolder("mon projet")).toBe(false);
  expect(validFolder("-a")).toBe(false);
  expect(validFolder("a.b_c-1")).toBe(true);
});

test("writeType keeps the other fields", async () => {
  const c = await space();
  await write(c, "a", '{"type":"poc","launch":"x","origin":"https://exemple.fr/","x":{"y":1}}');
  await writeType(c, "a", "app");
  const written = JSON.parse(await readFile(join(c.projects, "a", "ressac.json"), "utf8"));
  expect(written).toEqual({ type: "app", launch: "x", origin: "https://exemple.fr/", x: { y: 1 } });
});

test("watchProjects signals a new manifest and ignores node_modules", async () => {
  const c = await space();
  await mkdir(join(c.projects, "a", "node_modules", "p"), { recursive: true });
  let calls = 0;
  const stop = watchProjects(c, () => calls++);
  await sleep(400);
  await writeFile(join(c.projects, "a", "node_modules", "p", "ressac.json"), "{}");
  await sleep(500);
  expect(calls).toBe(0);
  await write(c, "a", '{"type":"poc","launch":"x"}');
  await sleep(500);
  await stop();
  expect(calls).toBe(1);
});
