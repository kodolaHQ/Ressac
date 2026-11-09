import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMOIRE_MAX_OCTETS, ecrireMemoire, empreinteParametres, lireMemoire } from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("a memory over 3 MB is not written; a damaged memory reads as empty", async () => {
  const d = await dossierTemporaire();
  expect(await lireMemoire(d)).toEqual({});
  const petite = { tri: { type: "ia.trier", valeur: { cle: { p: 0.5 } } } };
  expect(await ecrireMemoire(d, petite)).toBe(true);
  expect(await lireMemoire(d)).toEqual(petite);
  expect(await readdir(d)).toEqual(["memoire.json"]); // no .tmp left lying around

  const grosse = { tri: { type: "ia.trier", valeur: "x".repeat(MEMOIRE_MAX_OCTETS) } };
  expect(await ecrireMemoire(d, grosse)).toBe(false);
  expect(await lireMemoire(d)).toEqual(petite); // nothing was overwritten

  await writeFile(join(d, "memoire.json"), "{ abîmé");
  expect(await lireMemoire(d)).toEqual({});
  await writeFile(join(d, "memoire.json"), JSON.stringify({ version: 2, blocs: {} }));
  expect(await lireMemoire(d)).toEqual({});
});

test("empreinteParametres does not depend on key order, but on values", () => {
  const a = { cle: "url", n: { x: 1, y: [1, { b: 2, a: 1 }] } };
  const b = { n: { y: [1, { a: 1, b: 2 }], x: 1 }, cle: "url" };
  expect(empreinteParametres(a)).toBe(empreinteParametres(b));
  expect(empreinteParametres(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(empreinteParametres({ cle: "titre" })).not.toBe(empreinteParametres({ cle: "url" }));
});

test("the hash survives lireMemoire / ecrireMemoire (R5); an old memory without a hash still reads", async () => {
  const d = await dossierTemporaire();
  const m = { tri: { type: "ia.trier", valeur: 1, empreinte: "0123456789abcdef" }, vieux: { type: "code", valeur: 2 } };
  await ecrireMemoire(d, m);
  expect(await lireMemoire(d)).toEqual(m);
});

test("empreinteParametres ignore garderJours", () => {
  expect(empreinteParametres({ cle: "url", garderJours: 7 })).toBe(empreinteParametres({ cle: "url" }));
  expect(empreinteParametres({ cle: "url", garderJours: 7 })).toBe(empreinteParametres({ cle: "url", garderJours: 30 }));
  expect(empreinteParametres({ cle: "titre", garderJours: 7 })).not.toBe(empreinteParametres({ cle: "url", garderJours: 7 }));
});
