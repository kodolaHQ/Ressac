import { expect, test } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accordCouvre, accordNecessaire, accorderSite, droitsDe, empreinteExtensionsSite, empreinteLectureSite, lireAccordsSites, retirerAccordSite,
} from "../../src/sites/accords.js";
import type { DeclarationSite } from "../../src/sites/schemas.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const base: DeclarationSite = {
  nom: "Vidola", description: "", adresse: "https://vidola-a.example/", domaines: ["vidola-a.example"],
  connexion: [], retouches: [{ correspond: ["/series/*"], js: ["a.js"], css: [], cadres: ["https://*.clipsy.*/*"] }], reprise: false,
};

test("sans retouche ni reprise : aucun accord nécessaire", () => {
  expect(accordNecessaire({ ...base, retouches: [] })).toBe(false);
  expect(accordNecessaire(base)).toBe(true);
  expect(accordNecessaire({ ...base, retouches: [], reprise: true })).toBe(true);
});

test("droitsDe : union des motifs de cadres", () => {
  const d = { ...base, retouches: [...base.retouches, { correspond: ["/a"], js: [], css: ["b.css"], cadres: ["https://x.example/*"] }, { correspond: ["/b"], js: [], css: ["c.css"], cadres: false as const }] };
  expect(droitsDe(d).cadres).toEqual(["https://*.clipsy.*/*", "https://x.example/*"]);
});

test("accordé puis code des retouches changé : couvre encore", () => {
  const a = droitsDe(base);
  expect(accordCouvre(a, { ...base, retouches: [{ ...base.retouches[0]!, js: ["autre.js", "encore.js"] }] })).toBe(true);
  expect(accordCouvre(null, base)).toBe(false);
});

test("domaine, domaine de connexion, motif de cadres ajouté, ou reprise passée à vrai : ne couvre plus", () => {
  const a = droitsDe(base);
  expect(accordCouvre(a, { ...base, domaines: ["vidola-a.example", "autre.example"] })).toBe(false);
  expect(accordCouvre(a, { ...base, connexion: ["login.example"] })).toBe(false);
  expect(accordCouvre(a, { ...base, retouches: [{ ...base.retouches[0]!, cadres: ["https://*.clipsy.*/*", "https://pub.example/*"] }] })).toBe(false);
  expect(accordCouvre(a, { ...base, reprise: true })).toBe(false);
  expect(accordCouvre(a, base)).toBe(true);
});

test("correspond changé : couvre encore", () => {
  const a = droitsDe(base);
  expect(accordCouvre(a, { ...base, retouches: [{ ...base.retouches[0]!, correspond: ["/films/*"] }] })).toBe(true);
});

test("retirerAccordSite puis lireAccordsSites : absent ; fichier dans le profil, accords simultanés conservés", async () => {
  const p = await dossierTemporaire();
  await Promise.all([accorderSite(p, "a", base), accorderSite(p, "b", base)]);
  expect(Object.keys(await lireAccordsSites(p)).sort()).toEqual(["a", "b"]);
  expect(JSON.parse(await readFile(join(p, "sites-accords.json"), "utf8")).a.domaines).toEqual(["vidola-a.example"]);
  await retirerAccordSite(p, "a");
  expect(Object.keys(await lireAccordsSites(p))).toEqual(["b"]);
  await expect(accorderSite(p, "../x", base)).rejects.toThrow();
});

test("ids constructor, toString, __proto__ : aucun accord, rien ne lève", async () => {
  const p = await dossierTemporaire();
  const a = await lireAccordsSites(p);
  for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    expect(a[id]).toBeUndefined();
    expect(() => accordCouvre(a[id] ?? null, base)).not.toThrow();
  }
  await accorderSite(p, "constructor", base);
  await writeFile(join(p, "sites-accords.json"), JSON.stringify({ constructor: droitsDe(base) }));
  expect((await lireAccordsSites(p))["constructor"]).toEqual(droitsDe(base));
  expect((await lireAccordsSites(p))["toString"]).toBeUndefined();
});

test("lecture en panne (pas absent ni abîmé) : l'écriture échoue sans effacer les autres accords", async () => {
  const p = await dossierTemporaire();
  await accorderSite(p, "a", base);
  await rm(join(p, "sites-accords.json"));
  await mkdir(join(p, "sites-accords.json")); // lire un dossier : EISDIR
  await expect(accorderSite(p, "b", base)).rejects.toThrow();
  await rm(join(p, "sites-accords.json"), { recursive: true });
  await writeFile(join(p, "sites-accords.json"), "{abîmé");
  await accorderSite(p, "c", base); // abîmé : repart de zéro
  expect(Object.keys(await lireAccordsSites(p))).toEqual(["c"]);
});

test("empreinteLectureSite : nom, domaines et connexion ; l'ordre et la casse des domaines n'y changent rien", () => {
  const avec = { ...base, connexion: ["compte.example"] };
  const e = empreinteLectureSite(avec);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(empreinteLectureSite({ ...avec, domaines: ["Vidola-A.example", "vidola-a.example"] })).toBe(e);
  expect(empreinteLectureSite({ ...avec, domaines: ["b.example", "vidola-a.example"] })).toBe(empreinteLectureSite({ ...avec, domaines: ["vidola-a.example", "b.example"] }));
  // Ce que la carte ne montre pas ne compte pas.
  expect(empreinteLectureSite({ ...avec, description: "autre", retouches: [], reprise: true })).toBe(e);
  // Un domaine, une connexion ou un nom de plus : une autre empreinte.
  expect(empreinteLectureSite({ ...avec, domaines: [...avec.domaines, "mail.example.com"] })).not.toBe(e);
  expect(empreinteLectureSite({ ...avec, connexion: [...avec.connexion, "accounts.google.com"] })).not.toBe(e);
  expect(empreinteLectureSite({ ...avec, nom: "Mail" })).not.toBe(e);
  // Les champs ne se confondent pas (un domaine passé en connexion change l'empreinte).
  expect(empreinteLectureSite({ ...avec, domaines: [], connexion: ["vidola-a.example", "compte.example"] })).not.toBe(e);
});

test("empreinteExtensionsSite : stable pour un autre nom, d'autres retouches, une autre reprise, un autre ordre ou une autre casse ; change avec un domaine en plus", () => {
  const e = empreinteExtensionsSite(base);
  expect(e).toMatch(/^[0-9a-f]{64}$/);
  expect(empreinteExtensionsSite({ ...base, nom: "Autre", retouches: [], reprise: true })).toBe(e);
  const deux = { ...base, domaines: ["a.example", "B.example"], connexion: ["c.example", "d.example"] };
  expect(empreinteExtensionsSite({ ...deux, domaines: ["b.EXAMPLE", "a.example", "a.example"], connexion: ["D.example", "c.example"] })).toBe(empreinteExtensionsSite(deux));
  expect(empreinteExtensionsSite({ ...base, domaines: [...base.domaines, "autre.example"] })).not.toBe(e);
  expect(empreinteExtensionsSite({ ...base, connexion: ["login.example"] })).not.toBe(e);
  expect(empreinteExtensionsSite({ ...base, domaines: [], connexion: ["vidola-a.example"] })).not.toBe(e);
});
