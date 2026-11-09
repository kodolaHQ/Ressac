import { expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  grantCovers, grantNeeded, accorderSite, droitsDe, siteExtensionsHash, siteReadHash, lireAccordsSites, retirerAccordSite,
} from "../../src/sites/accords.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";
import { tempFolder } from "../aide/temporaire.js";

const base: DeclarationSite = {
  nom: "Vidola", description: "", adresse: "https://vidola-a.example/", domaines: ["vidola-a.example"],
  connexion: [], retouches: [{ correspond: ["/series/*"], js: ["a.js"], css: [], cadres: ["https://*.clipsy.*/*"] }], reprise: false,
};

test("without tweak or reprise: no grant needed", () => {
  expect(grantNeeded({ ...base, retouches: [] })).toBe(false);
  expect(grantNeeded(base)).toBe(true);
  expect(grantNeeded({ ...base, retouches: [], reprise: true })).toBe(true);
});

test("droitsDe: union of the frame patterns", () => {
  const d = { ...base, retouches: [...base.retouches, { correspond: ["/a"], js: [], css: ["b.css"], cadres: ["https://x.example/*"] }, { correspond: ["/b"], js: [], css: ["c.css"], cadres: false as const }] };
  expect(droitsDe(d).cadres).toEqual(["https://*.clipsy.*/*", "https://x.example/*"]);
});

test("granted then tweaks code changed: still covers", () => {
  const a = droitsDe(base);
  expect(grantCovers(a, { ...base, retouches: [{ ...base.retouches[0]!, js: ["autre.js", "encore.js"] }] })).toBe(true);
  expect(grantCovers(null, base)).toBe(false);
});

test("domain, login domain, frame pattern added, or reprise set to true: no longer covers", () => {
  const a = droitsDe(base);
  expect(grantCovers(a, { ...base, domaines: ["vidola-a.example", "autre.example"] })).toBe(false);
  expect(grantCovers(a, { ...base, connexion: ["login.example"] })).toBe(false);
  expect(grantCovers(a, { ...base, retouches: [{ ...base.retouches[0]!, cadres: ["https://*.clipsy.*/*", "https://pub.example/*"] }] })).toBe(false);
  expect(grantCovers(a, { ...base, reprise: true })).toBe(false);
  expect(grantCovers(a, base)).toBe(true);
});

test("correspond changed: still covers", () => {
  const a = droitsDe(base);
  expect(grantCovers(a, { ...base, retouches: [{ ...base.retouches[0]!, correspond: ["/films/*"] }] })).toBe(true);
});

test("retirerAccordSite then lireAccordsSites: absent; file in the profile, simultaneous grants kept", async () => {
  const p = await tempFolder();
  await Promise.all([accorderSite(p, "a", base), accorderSite(p, "b", base)]);
  expect(Object.keys(await lireAccordsSites(p)).sort()).toEqual(["a", "b"]);
  expect(JSON.parse(await readFile(join(p, "sites-accords.json"), "utf8")).a.domaines).toEqual(["vidola-a.example"]);
  await retirerAccordSite(p, "a");
  expect(Object.keys(await lireAccordsSites(p))).toEqual(["b"]);
  await expect(accorderSite(p, "../x", base)).rejects.toThrow();
});

test("ids constructor, toString, __proto__: no grant, nothing throws", async () => {
  const p = await tempFolder();
  const a = await lireAccordsSites(p);
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(a[id]).toBeUndefined();
    expect(() => grantCovers(a[id] ?? null, base)).not.toThrow();
  }
  await accorderSite(p, "constructor", base);
  await writeFile(join(p, "sites-accords.json"), JSON.stringify({ constructor: droitsDe(base) }));
  expect((await lireAccordsSites(p))["constructor"]).toEqual(droitsDe(base));
  expect((await lireAccordsSites(p))["toString"]).toBeUndefined();
});

test("failing read (neither absent nor damaged): the write fails without erasing the other grants", async () => {
  const p = await tempFolder();
  await accorderSite(p, "a", base);
  await rm(join(p, "sites-accords.json"));
  await mkdir(join(p, "sites-accords.json")); // read a folder: EISDIR
  await expect(accorderSite(p, "b", base)).rejects.toThrow();
  await rm(join(p, "sites-accords.json"), { recursive: true });
  await writeFile(join(p, "sites-accords.json"), "{abîmé");
  await accorderSite(p, "c", base); // damaged: starts from zero
  expect(Object.keys(await lireAccordsSites(p))).toEqual(["c"]);
});

test("empreinteLectureSite: name, domains and login; the order and case of the domains change nothing", () => {
  const updateEntry = { ...base, connexion: ["compte.example"] };
  const e = siteReadHash(updateEntry);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(siteReadHash({ ...updateEntry, domaines: ["Vidola-A.example", "vidola-a.example"] })).toBe(e);
  expect(siteReadHash({ ...updateEntry, domaines: ["b.example", "vidola-a.example"] })).toBe(siteReadHash({ ...updateEntry, domaines: ["vidola-a.example", "b.example"] }));
  // What the card does not show does not count.
  expect(siteReadHash({ ...updateEntry, description: "autre", retouches: [], reprise: true })).toBe(e);
  // One more domain, login or name: another hash.
  expect(siteReadHash({ ...updateEntry, domaines: [...updateEntry.domaines, "mail.example.com"] })).not.toBe(e);
  expect(siteReadHash({ ...updateEntry, connexion: [...updateEntry.connexion, "accounts.google.com"] })).not.toBe(e);
  expect(siteReadHash({ ...updateEntry, nom: "Mail" })).not.toBe(e);
  // The fields are not confused (a domain moved to login changes the hash).
  expect(siteReadHash({ ...updateEntry, domaines: [], connexion: ["vidola-a.example", "compte.example"] })).not.toBe(e);
});

test("empreinteExtensionsSite: stable for another name, other tweaks, another reprise, another order or another case; changes with one more domain", () => {
  const e = siteExtensionsHash(base);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(siteExtensionsHash({ ...base, nom: "Autre", retouches: [], reprise: true })).toBe(e);
  const two = { ...base, domaines: ["a.example", "B.example"], connexion: ["c.example", "d.example"] };
  expect(siteExtensionsHash({ ...two, domaines: ["b.EXAMPLE", "a.example", "a.example"], connexion: ["D.example", "c.example"] })).toBe(siteExtensionsHash(two));
  expect(siteExtensionsHash({ ...base, domaines: [...base.domaines, "autre.example"] })).not.toBe(e);
  expect(siteExtensionsHash({ ...base, connexion: ["login.example"] })).not.toBe(e);
  expect(siteExtensionsHash({ ...base, domaines: [], connexion: ["vidola-a.example"] })).not.toBe(e);
});
