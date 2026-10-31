import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  accordCouvre, accordNecessaire, accorderSite, droitsDe, lireAccordsSites, retirerAccordSite,
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
