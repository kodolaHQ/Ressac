import { expect, test } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startUrl, effectiveDomains } from "../../src/sites/urls.js";
import { storeSiteGrant, readSiteGrants } from "../../src/sites/grants.js";
import { SiteMemory } from "../../src/sites/memory.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";
import { changeUrl, readUrlState, deleteSiteData } from "../../src/sites/tracking.js";
import { tempFolder } from "../helpers/temp.js";

const decl: DeclarationSite = {
  nom: "Vidola", description: "", adresse: "https://www.vidola-a.example/film?x=1", domaines: ["vidola-a.example"],
  connexion: [], retouches: [], reprise: true,
};
const exists = (p: string) => stat(p).then(() => true, () => false);

test("changeUrl a → b: anciens [a]; then c: anciens [a, b]", async () => {
  const d = await tempFolder();
  expect(await readUrlState(d, "w")).toBeNull();
  const e1 = await changeUrl(d, "w", decl, "vidola-b.example");
  expect(e1).toMatchObject({ actuel: "vidola-b.example", anciens: ["www.vidola-a.example"] });
  expect(e1.depuis).not.toBeNull();
  const e2 = await changeUrl(d, "w", decl, "vidola-c.example");
  expect(e2.anciens).toEqual(["www.vidola-a.example", "vidola-b.example"]);
  expect(await readUrlState(d, "w")).toEqual(e2);
  // going back to an old one: no longer in anciens; no duplicate
  const e3 = await changeUrl(d, "w", decl, "VIDOLA-B.example.");
  expect(e3.actuel).toBe("vidola-b.example");
  expect(e3.anciens).toEqual(["www.vidola-a.example", "vidola-c.example"]);
  await expect(changeUrl(d, "w", decl, "pas valide/")).rejects.toThrow();
});

test("effectiveDomains unites them with those of site.json", async () => {
  const d = await tempFolder();
  const e = await changeUrl(d, "w", { ...decl, adresse: "https://vidola-a.example/" }, "vidola-b.example");
  expect(effectiveDomains(decl, e)).toEqual(["vidola-a.example", "vidola-b.example"]);
});

test("startUrl keeps path and query on the current domain", async () => {
  const d = await tempFolder();
  const e = await changeUrl(d, "w", decl, "vidola-b.example");
  expect(startUrl(decl, e)).toBe("https://vidola-b.example/film?x=1");
});

test("deleteSiteData erases memory, address and grant of that site only", async () => {
  const p = await tempFolder();
  const ds = join(p, "sites");
  for (const id of ["a", "b"]) {
    const m = await SiteMemory.ouvrir(ds, id);
    m.retenir("k", 1, null);
    await m.vider();
    await changeUrl(ds, id, decl, "vidola-b.example");
    await storeSiteGrant(p, id, decl);
  }
  await deleteSiteData(p, "a");
  expect(await exists(join(ds, "a", "memoire.json"))).toBe(false);
  expect(await readUrlState(ds, "a")).toBeNull();
  expect(Object.keys(await readSiteGrants(p))).toEqual(["b"]);
  expect(await exists(join(ds, "b", "memoire.json"))).toBe(true);
  expect(await readUrlState(ds, "b")).not.toBeNull();
  await mkdir(ds, { recursive: true });
  await writeFile(join(ds, "x"), "");
  await expect(deleteSiteData(p, "../b")).rejects.toThrow();
});

test("deleteSiteData removes the whole folder, .bak included", async () => {
  const p = await tempFolder();
  const ds = join(p, "sites");
  await mkdir(join(ds, "a"), { recursive: true });
  await writeFile(join(ds, "a", "memoire.json.bak"), "x");
  await deleteSiteData(p, "a");
  expect(await exists(join(ds, "a"))).toBe(false);
});

test("changeUrl keeps the 100 most recent old ones", async () => {
  const d = await tempFolder();
  let e = await changeUrl(d, "w", decl, "s0.example");
  for (let i = 1; i <= 105; i++) e = await changeUrl(d, "w", decl, `s${i}.example`);
  expect(e.anciens).toHaveLength(100);
  expect(e.anciens.at(-1)).toBe("s104.example");
  expect(await readUrlState(d, "w")).toEqual(e);
});

test("a deletion ordered after an in-flight changeUrl leaves the site erased", async () => {
  const p = await tempFolder();
  const ds = join(p, "sites");
  const c = changeUrl(ds, "w", decl, "vidola-b.example");
  await deleteSiteData(p, "w");
  await c;
  expect(await readUrlState(ds, "w")).toBeNull();
});
