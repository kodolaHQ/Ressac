import { expect, test } from "vitest";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { cheminsEspace } from "../../src/chemins.js";
import { ERREUR_ID_SITE, fichierRetoucheIntrouvable } from "../../src/sites/schemas.js";
import { lireRetouches, lireSite, lireSites, surveillerSites, type SiteLu } from "../../src/sites/lire.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const o = { adressesLocales: false };
const decl = (nom: string, extra: object = {}) =>
  JSON.stringify({ nom, adresse: "https://a.example/", domaines: ["a.example"], ...extra });

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.sites, { recursive: true });
  return c;
}
async function site(c: ReturnType<typeof cheminsEspace>, id: string, json: string) {
  await mkdir(join(c.sites, id), { recursive: true });
  await writeFile(join(c.sites, id, "site.json"), json);
}
function avecDeclaration(s: SiteLu | null) {
  if (!s || !("declaration" in s)) throw new Error("site sans déclaration");
  return s;
}

test("two sites read, sorted; a damaged site.json gives a SiteLu in error without bothering the other", async () => {
  const c = await espace();
  await site(c, "zeta", decl("Zeta"));
  await site(c, "alpha", "{pas du json");
  await site(c, "milieu", decl("Milieu"));
  const sites = await lireSites(c, o);
  expect(sites.map((s) => s.id)).toEqual(["alpha", "milieu", "zeta"]);
  expect(sites[0]).toMatchObject({ id: "alpha", dossier: join(c.sites, "alpha") });
  expect("erreur" in sites[0]!).toBe(true);
  expect(sites[1]).toMatchObject({ declaration: { nom: "Milieu" }, aAccueil: false });
});

test("an invalid declaration or one that fails verifierDeclarationSite is an error", async () => {
  const c = await espace();
  await site(c, "a", JSON.stringify({ nom: "A", adresse: "http://a.example/", domaines: ["a.example"] }));
  await site(c, "b", JSON.stringify({ nom: "B", adresse: "https://a.example/", domaines: ["a.example"], permissions: [] }));
  await site(c, "c", "x".repeat(70 * 1024));
  const [a, b, cc] = await lireSites(c, o);
  expect(a).toMatchObject({ erreur: expect.stringContaining("https seulement") });
  expect(b).toMatchObject({ erreur: expect.stringContaining("site.json invalide") });
  expect(cc).toMatchObject({ erreur: expect.stringContaining("64 Ko") });
  expect(await lireSites(c, { adressesLocales: true })).toHaveLength(3);
});

test("aAccueil true only with accueil/index.html", async () => {
  const c = await espace();
  await site(c, "avec", decl("Avec"));
  await mkdir(join(c.sites, "avec", "accueil"), { recursive: true });
  await writeFile(join(c.sites, "avec", "accueil", "index.html"), "<p>");
  await site(c, "sans", decl("Sans"));
  await mkdir(join(c.sites, "sans", "accueil", "index.html"), { recursive: true });
  expect(avecDeclaration(await lireSite(c, "avec", o)).aAccueil).toBe(true);
  expect(avecDeclaration(await lireSite(c, "sans", o)).aAccueil).toBe(false);
});

test("hidden folder, .corbeille or symbolic link ignored; a name outside the rule is « sans fiche » with the rule", async () => {
  const c = await espace();
  await site(c, "ok", decl("Ok"));
  await site(c, ".cache", decl("Caché"));
  await site(c, ".corbeille", decl("Corbeille"));
  await site(c, "nom invalide", decl("Invalide"));
  await site(c, "MonSite", decl("Majuscules"));
  await site(c, "a_b", decl("Souligné"));
  await site(c, "x".repeat(61), decl("Long"));
  await symlink(join(c.sites, "ok"), join(c.sites, "lien"));
  const sites = await lireSites(c, o);
  expect(sites.map((s) => s.id).sort()).toEqual(["MonSite", "a_b", "nom invalide", "ok", "x".repeat(61)].sort());
  for (const s of sites.filter((s) => s.id !== "ok")) expect(s).toMatchObject({ erreur: ERREUR_ID_SITE });
  expect(await lireSite(c, "lien", o)).toBeNull();
  expect(await lireSite(c, "absent", o)).toBeNull();
  expect(await lireSite(c, "../ok", o)).toBeNull();
  expect(await lireSite(c, ".cache", o)).toBeNull();
  expect(await lireSite(c, "MonSite", o)).toMatchObject({ erreur: ERREUR_ID_SITE });
});

test("lireSites: sites folder absent", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireSites(c, o)).toEqual([]);
});

test("lireRetouches : contenus lus", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js", "sous/b.js"], css: ["c.css"] }, { correspond: ["/x"], js: ["a.js"] }] }));
  await mkdir(join(c.sites, "r", "retouches", "sous"), { recursive: true });
  await writeFile(join(c.sites, "r", "retouches", "a.js"), "A");
  await writeFile(join(c.sites, "r", "retouches", "sous", "b.js"), "B");
  await writeFile(join(c.sites, "r", "retouches", "c.css"), "C");
  expect(await lireRetouches(avecDeclaration(await lireSite(c, "r", o)))).toEqual({ js: { "a.js": "A", "sous/b.js": "B" }, css: { "c.css": "C" } });
});

test("lireRetouches : fichier absent, lien symbolique vers /etc/hosts, fichier de 300 Ko, total > 1 Mo", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js"] }] }));
  const s = avecDeclaration(await lireSite(c, "r", o));
  expect(await lireRetouches(s)).toEqual({ erreur: fichierRetoucheIntrouvable("a.js") });
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await symlink("/etc/hosts", join(c.sites, "r", "retouches", "a.js"));
  expect(await lireRetouches(s)).toEqual({ erreur: fichierRetoucheIntrouvable("a.js") });
  await writeFile(join(c.sites, "r", "retouches", "b.js"), "x".repeat(300 * 1024));
  const gros = avecDeclaration({ ...s, declaration: { ...s.declaration, retouches: [{ correspond: ["/*"], js: ["b.js"], css: [], cadres: false }] } });
  expect(await lireRetouches(gros)).toEqual({ erreur: fichierRetoucheIntrouvable("b.js") });
  // Five 250 KB files: each passes, the total (1.2 MB) does not.
  const noms = ["m1.js", "m2.js", "m3.js", "m4.js", "m5.js"];
  for (const n of noms) await writeFile(join(c.sites, "r", "retouches", n), "x".repeat(250 * 1024));
  const total = avecDeclaration({ ...s, declaration: { ...s.declaration, retouches: [{ correspond: ["/*"], js: noms, css: [], cadres: false }] } });
  expect(await lireRetouches(total)).toMatchObject({ erreur: expect.stringContaining("fichier introuvable ou trop gros") });
});

test("lireRetouches: a retouches/ folder that is a link outside the site is refused", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js"] }] }));
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "a.js"), "secret");
  await symlink(dehors, join(c.sites, "r", "retouches"));
  expect(await lireRetouches(avecDeclaration(await lireSite(c, "r", o)))).toEqual({ erreur: fichierRetoucheIntrouvable("a.js") });
});

test("surveillerSites signals « retouches » when retouches/a.js changes and « declaration » for site.json", async () => {
  const c = await espace();
  await site(c, "w", decl("W"));
  await mkdir(join(c.sites, "w", "retouches"), { recursive: true });
  await mkdir(join(c.sites, "w", ".corbeille"), { recursive: true });
  const vus: string[] = [];
  const arreter = surveillerSites(c, (id, quoi) => vus.push(`${id}:${quoi}`));
  await attendre(400);
  await writeFile(join(c.sites, "w", "retouches", "a.js"), "1");
  await attendre(600);
  expect(vus).toContain("w:retouches");
  expect(vus).not.toContain("w:declaration");
  await writeFile(join(c.sites, "w", "site.json"), decl("W2"));
  await attendre(600);
  expect(vus).toContain("w:declaration");
  await mkdir(join(c.sites, "w", "accueil"), { recursive: true });
  await writeFile(join(c.sites, "w", "accueil", "index.html"), "<p>");
  await attendre(600);
  expect(vus).toContain("w:accueil");
  const avant = vus.length;
  await writeFile(join(c.sites, "w", ".corbeille", "x.json"), "{}");
  await attendre(600);
  expect(vus.length).toBe(avant);
  await arreter();
});

test("lireRetouches: app folder replaced by a link after lireSite", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js"] }] }));
  const s = avecDeclaration(await lireSite(c, "r", o));
  const dehors = await dossierTemporaire();
  await mkdir(join(dehors, "retouches"));
  await writeFile(join(dehors, "retouches", "a.js"), "secret");
  await rename(join(c.sites, "r"), join(c.sites, "r-ancien"));
  await symlink(dehors, join(c.sites, "r"));
  expect(await lireRetouches(s)).toMatchObject({ erreur: expect.any(String) });
});

test("lireRetouches: a subfolder of retouches/ linking to the outside is refused", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["sous/a.js"] }] }));
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "a.js"), "secret");
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await symlink(dehors, join(c.sites, "r", "retouches", "sous"));
  expect(await lireRetouches(avecDeclaration(await lireSite(c, "r", o)))).toEqual({ erreur: fichierRetoucheIntrouvable("sous/a.js") });
});

test("lireRetouches: a file cited by several tweaks is read only once", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js"], css: ["a.css"] }, { correspond: ["/x"], js: ["a.js"], css: ["a.css"] }] }));
  await mkdir(join(c.sites, "r", "retouches"), { recursive: true });
  await writeFile(join(c.sites, "r", "retouches", "a.js"), "J");
  await writeFile(join(c.sites, "r", "retouches", "a.css"), "C");
  expect(await lireRetouches(avecDeclaration(await lireSite(c, "r", o)))).toEqual({ js: { "a.js": "J" }, css: { "a.css": "C" } });
});

test("lireRetouches: a tweak file that is a directory is refused", async () => {
  const c = await espace();
  await site(c, "r", decl("R", { retouches: [{ correspond: ["/*"], js: ["a.js"] }] }));
  await mkdir(join(c.sites, "r", "retouches", "a.js"), { recursive: true });
  expect(await lireRetouches(avecDeclaration(await lireSite(c, "r", o)))).toEqual({ erreur: fichierRetoucheIntrouvable("a.js") });
});

test("site.json symbolic link, JSON null or [], BOM, exactly 64 KB", async () => {
  const c = await espace();
  const dehors = await dossierTemporaire();
  await writeFile(join(dehors, "site.json"), decl("Lien"));
  await mkdir(join(c.sites, "lien"), { recursive: true });
  await symlink(join(dehors, "site.json"), join(c.sites, "lien", "site.json"));
  await site(c, "nul", "null");
  await site(c, "liste", "[]");
  await site(c, "bom", "\uFEFF" + decl("Bom"));
  const json = decl("Pile");
  await site(c, "pile", json + " ".repeat(64 * 1024 - Buffer.byteLength(json)));
  await site(c, "trop", json + " ".repeat(64 * 1024 + 1 - Buffer.byteLength(json)));
  const par = Object.fromEntries((await lireSites(c, o)).map((s) => [s.id, s]));
  expect(par.lien).toMatchObject({ erreur: expect.any(String) });
  expect(par.nul).toMatchObject({ erreur: expect.stringContaining("site.json invalide") });
  expect(par.liste).toMatchObject({ erreur: expect.stringContaining("site.json invalide") });
  expect(par.bom).toMatchObject({ declaration: { nom: "Bom" } });
  expect(par.pile).toMatchObject({ declaration: { nom: "Pile" } });
  expect(par.trop).toMatchObject({ erreur: expect.stringContaining("64 Ko") });
});
