import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_MAX_BYTES, writeMemory, paramsHash, readMemory } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

test("a memory over 3 MB is not written; a damaged memory reads as empty", async () => {
  const d = await tempFolder();
  expect(await readMemory(d)).toEqual({});
  const petite = { tri: { type: "ia.trier", valeur: { cle: { p: 0.5 } } } };
  expect(await writeMemory(d, petite)).toBe(true);
  expect(await readMemory(d)).toEqual(petite);
  expect(await readdir(d)).toEqual(["memoire.json"]); // no .tmp left lying around

  const big = { tri: { type: "ia.trier", valeur: "x".repeat(MEMORY_MAX_BYTES) } };
  expect(await writeMemory(d, big)).toBe(false);
  expect(await readMemory(d)).toEqual(petite); // nothing was overwritten

  await writeFile(join(d, "memoire.json"), "{ abîmé");
  expect(await readMemory(d)).toEqual({});
  await writeFile(join(d, "memoire.json"), JSON.stringify({ version: 2, blocs: {} }));
  expect(await readMemory(d)).toEqual({});
});

test("empreinteParametres does not depend on key order, but on values", () => {
  const a = { cle: "url", n: { x: 1, y: [1, { b: 2, a: 1 }] } };
  const b = { n: { y: [1, { a: 1, b: 2 }], x: 1 }, cle: "url" };
  expect(paramsHash(a)).toBe(paramsHash(b));
  expect(paramsHash(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(paramsHash({ cle: "titre" })).not.toBe(paramsHash({ cle: "url" }));
});

test("the hash survives lireMemoire / ecrireMemoire (R5); an old memory without a hash still reads", async () => {
  const d = await tempFolder();
  const m = { tri: { type: "ia.trier", valeur: 1, empreinte: "0123456789abcdef" }, vieux: { type: "code", valeur: 2 } };
  await writeMemory(d, m);
  expect(await readMemory(d)).toEqual(m);
});

test("empreinteParametres ignore garderJours", () => {
  expect(paramsHash({ cle: "url", garderJours: 7 })).toBe(paramsHash({ cle: "url" }));
  expect(paramsHash({ cle: "url", garderJours: 7 })).toBe(paramsHash({ cle: "url", garderJours: 30 }));
  expect(paramsHash({ cle: "titre", garderJours: 7 })).not.toBe(paramsHash({ cle: "url", garderJours: 7 }));
});
