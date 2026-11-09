import { expect, test } from "vitest";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spacePaths } from "../../src/paths.js";
import { SITE_ID_ERROR, tweakFileNotFound } from "../../src/sites/schemas.js";
import { readTweaks, readSite, readSites, watchSites, type SiteLu } from "../../src/sites/read.js";
import { tempFolder } from "../helpers/temp.js";

const o = { localAddresses: false };
const decl = (name: string, extra: object = {}) =>
  JSON.stringify({ name: name, url: "https://a.example/", domains: ["a.example"], ...extra });

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.sites, { recursive: true });
  return c;
}
async function site(c: ReturnType<typeof spacePaths>, id: string, json: string) {
  await mkdir(join(c.sites, id), { recursive: true });
  await writeFile(join(c.sites, id, "site.json"), json);
}
function withDeclaration(s: SiteLu | null) {
  if (!s || !("declaration" in s)) throw new Error("site sans déclaration");
  return s;
}

test("two sites read, sorted; a damaged site.json gives a SiteLu in error without bothering the other", async () => {
  const c = await space();
  await site(c, "zeta", decl("Zeta"));
  await site(c, "alpha", "{pas du json");
  await site(c, "milieu", decl("Milieu"));
  const sites = await readSites(c, o);
  expect(sites.map((s) => s.id)).toEqual(["alpha", "milieu", "zeta"]);
  expect(sites[0]).toMatchObject({ id: "alpha", folder: join(c.sites, "alpha") });
  expect("error" in sites[0]!).toBe(true);
  expect(sites[1]).toMatchObject({ declaration: { name: "Milieu" }, hasHome: false });
});

test("an invalid declaration or one that fails checkSiteDeclaration is an error", async () => {
  const c = await space();
  await site(c, "a", JSON.stringify({ name: "A", url: "http://a.example/", domains: ["a.example"] }));
  await site(c, "b", JSON.stringify({ name: "B", url: "https://a.example/", domains: ["a.example"], permissions: [] }));
  await site(c, "c", "x".repeat(70 * 1024));
  const [a, b, cc] = await readSites(c, o);
  expect(a).toMatchObject({ error: expect.stringContaining("https seulement") });
  expect(b).toMatchObject({ error: expect.stringContaining("site.json invalide") });
  expect(cc).toMatchObject({ error: expect.stringContaining("64 Ko") });
  expect(await readSites(c, { localAddresses: true })).toHaveLength(3);
});

test("aAccueil true only with accueil/index.html", async () => {
  const c = await space();
  await site(c, "avec", decl("Avec"));
  await mkdir(join(c.sites, "avec", "accueil"), { recursive: true });
  await writeFile(join(c.sites, "avec", "accueil", "index.html"), "<p>");
  await site(c, "sans", decl("Sans"));
  await mkdir(join(c.sites, "sans", "accueil", "index.html"), { recursive: true });
  expect(withDeclaration(await readSite(c, "avec", o)).hasHome).toBe(true);
  expect(withDeclaration(await readSite(c, "sans", o)).hasHome).toBe(false);
});

test("hidden folder, .corbeille or symbolic link ignored; a name outside the rule is « sans fiche » with the rule", async () => {
  const c = await space();
  await site(c, "ok", decl("Ok"));
  await site(c, ".cache", decl("Caché"));
  await site(c, ".corbeille", decl("Corbeille"));
  await site(c, "nom invalide", decl("Invalide"));
  await site(c, "MonSite", decl("Majuscules"));
  await site(c, "a_b", decl("Souligné"));
  await site(c, "x".repeat(61), decl("Long"));
  await symlink(join(c.sites, "ok"), join(c.sites, "lien"));
  const sites = await readSites(c, o);
  expect(sites.map((s) => s.id).sort()).toEqual(["MonSite", "a_b", "nom invalide", "ok", "x".repeat(61)].sort());
  for (const s of sites.filter((s) => s.id !== "ok")) expect(s).toMatchObject({ error: SITE_ID_ERROR });
  expect(await readSite(c, "lien", o)).toBeNull();
  expect(await readSite(c, "absent", o)).toBeNull();
  expect(await readSite(c, "../ok", o)).toBeNull();
  expect(await readSite(c, ".cache", o)).toBeNull();
  expect(await readSite(c, "MonSite", o)).toMatchObject({ error: SITE_ID_ERROR });
});

test("readSites: sites folder absent", async () => {
  const c = spacePaths(await tempFolder());
  expect(await readSites(c, o)).toEqual([]);
});

test("readTweaks : contenus lus", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js", "sous/b.js"], css: ["c.css"] }, { matches: ["/x"], js: ["a.js"] }] }));
  await mkdir(join(c.sites, "r", "retouches", "sous"), { recursive: true });
  await writeFile(join(c.sites, "r", "retouches", "a.js"), "A");
  await writeFile(join(c.sites, "r", "retouches", "sous", "b.js"), "B");
  await writeFile(join(c.sites, "r", "retouches", "c.css"), "C");
  expect(await readTweaks(withDeclaration(await readSite(c, "r", o)))).toEqual({ js: { "a.js": "A", "sous/b.js": "B" }, css: { "c.css": "C" } });
});

test("readTweaks : fichier absent, lien symbolique vers /etc/hosts, fichier de 300 Ko, total > 1 Mo", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js"] }] }));
  const s = withDeclaration(await readSite(c, "r", o));
  expect(await readTweaks(s)).toEqual({ error: tweakFileNotFound("a.js") });
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await symlink("/etc/hosts", join(c.sites, "r", "retouches", "a.js"));
  expect(await readTweaks(s)).toEqual({ error: tweakFileNotFound("a.js") });
  await writeFile(join(c.sites, "r", "retouches", "b.js"), "x".repeat(300 * 1024));
  const big = withDeclaration({ ...s, declaration: { ...s.declaration, tweaks: [{ matches: ["/*"], js: ["b.js"], css: [], frames: false }] } });
  expect(await readTweaks(big)).toEqual({ error: tweakFileNotFound("b.js") });
  // Five 250 KB files: each passes, the total (1.2 MB) does not.
  const names = ["m1.js", "m2.js", "m3.js", "m4.js", "m5.js"];
  for (const n of names) await writeFile(join(c.sites, "r", "retouches", n), "x".repeat(250 * 1024));
  const total = withDeclaration({ ...s, declaration: { ...s.declaration, tweaks: [{ matches: ["/*"], js: names, css: [], frames: false }] } });
  expect(await readTweaks(total)).toMatchObject({ error: expect.stringContaining("fichier introuvable ou trop gros") });
});

test("readTweaks: a retouches/ folder that is a link outside the site is refused", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js"] }] }));
  const outside = await tempFolder();
  await writeFile(join(outside, "a.js"), "secret");
  await symlink(outside, join(c.sites, "r", "retouches"));
  expect(await readTweaks(withDeclaration(await readSite(c, "r", o)))).toEqual({ error: tweakFileNotFound("a.js") });
});

test("watchSites signals « retouches » when retouches/a.js changes and « declaration » for site.json", async () => {
  const c = await space();
  await site(c, "w", decl("W"));
  await mkdir(join(c.sites, "w", "retouches"), { recursive: true });
  await mkdir(join(c.sites, "w", ".corbeille"), { recursive: true });
  const seen: string[] = [];
  const stop = watchSites(c, (id, what) => seen.push(`${id}:${what}`));
  await sleep(400);
  await writeFile(join(c.sites, "w", "retouches", "a.js"), "1");
  await sleep(600);
  expect(seen).toContain("w:retouches");
  expect(seen).not.toContain("w:declaration");
  await writeFile(join(c.sites, "w", "site.json"), decl("W2"));
  await sleep(600);
  expect(seen).toContain("w:declaration");
  await mkdir(join(c.sites, "w", "accueil"), { recursive: true });
  await writeFile(join(c.sites, "w", "accueil", "index.html"), "<p>");
  await sleep(600);
  expect(seen).toContain("w:accueil");
  const before = seen.length;
  await writeFile(join(c.sites, "w", ".corbeille", "x.json"), "{}");
  await sleep(600);
  expect(seen.length).toBe(before);
  await stop();
});

test("readTweaks: app folder replaced by a link after readSite", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js"] }] }));
  const s = withDeclaration(await readSite(c, "r", o));
  const outside = await tempFolder();
  await mkdir(join(outside, "retouches"));
  await writeFile(join(outside, "retouches", "a.js"), "secret");
  await rename(join(c.sites, "r"), join(c.sites, "r-ancien"));
  await symlink(outside, join(c.sites, "r"));
  expect(await readTweaks(s)).toMatchObject({ error: expect.any(String) });
});

test("readTweaks: a subfolder of retouches/ linking to the outside is refused", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["sous/a.js"] }] }));
  const outside = await tempFolder();
  await writeFile(join(outside, "a.js"), "secret");
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await symlink(outside, join(c.sites, "r", "retouches", "sous"));
  expect(await readTweaks(withDeclaration(await readSite(c, "r", o)))).toEqual({ error: tweakFileNotFound("sous/a.js") });
});

test("readTweaks: a file cited by several tweaks is read only once", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js"], css: ["a.css"] }, { matches: ["/x"], js: ["a.js"], css: ["a.css"] }] }));
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await writeFile(join(c.sites, "r", "retouches", "a.js"), "J");
  await writeFile(join(c.sites, "r", "retouches", "a.css"), "C");
  expect(await readTweaks(withDeclaration(await readSite(c, "r", o)))).toEqual({ js: { "a.js": "J" }, css: { "a.css": "C" } });
});

test("readTweaks: a tweak file that is a directory is refused", async () => {
  const c = await space();
  await site(c, "r", decl("R", { tweaks: [{ matches: ["/*"], js: ["a.js"] }] }));
  await mkdir(join(c.sites, "r", "retouches", "a.js"), { recursive: true });
  expect(await readTweaks(withDeclaration(await readSite(c, "r", o)))).toEqual({ error: tweakFileNotFound("a.js") });
});

test("site.json symbolic link, JSON null or [], BOM, exactly 64 KB", async () => {
  const c = await space();
  const outside = await tempFolder();
  await writeFile(join(outside, "site.json"), decl("Lien"));
  await mkdir(join(c.sites, "lien"), { recursive: true });
  await symlink(join(outside, "site.json"), join(c.sites, "lien", "site.json"));
  await site(c, "nul", "null");
  await site(c, "liste", "[]");
  await site(c, "bom", "\uFEFF" + decl("Bom"));
  const json = decl("Pile");
  await site(c, "pile", json + " ".repeat(64 * 1024 - Buffer.byteLength(json)));
  await site(c, "trop", json + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(json)));
  const by = Object.fromEntries((await readSites(c, o)).map((s) => [s.id, s]));
  expect(by.lien).toMatchObject({ error: expect.any(String) });
  expect(by.nul).toMatchObject({ error: expect.stringContaining("site.json invalide") });
  expect(by.liste).toMatchObject({ error: expect.stringContaining("site.json invalide") });
  expect(by.bom).toMatchObject({ declaration: { name: "Bom" } });
  expect(by.pile).toMatchObject({ declaration: { name: "Pile" } });
  expect(by.trop).toMatchObject({ error: expect.stringContaining("64 Ko") });
});
