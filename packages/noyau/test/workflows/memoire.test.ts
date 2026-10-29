import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMOIRE_MAX_OCTETS, ecrireMemoire, empreinteParametres, lireMemoire } from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

test("une mémoire de plus de 3 Mo n'est pas écrite ; une mémoire abîmée se lit vide", async () => {
  const d = await dossierTemporaire();
  expect(await lireMemoire(d)).toEqual({});
  const petite = { tri: { type: "ia.trier", valeur: { cle: { p: 0.5 } } } };
  expect(await ecrireMemoire(d, petite)).toBe(true);
  expect(await lireMemoire(d)).toEqual(petite);
  expect(await readdir(d)).toEqual(["memoire.json"]); // pas de .tmp qui traîne

  const grosse = { tri: { type: "ia.trier", valeur: "x".repeat(MEMOIRE_MAX_OCTETS) } };
  expect(await ecrireMemoire(d, grosse)).toBe(false);
  expect(await lireMemoire(d)).toEqual(petite); // rien n'a été écrasé

  await writeFile(join(d, "memoire.json"), "{ abîmé");
  expect(await lireMemoire(d)).toEqual({});
  await writeFile(join(d, "memoire.json"), JSON.stringify({ version: 2, blocs: {} }));
  expect(await lireMemoire(d)).toEqual({});
});

test("empreinteParametres ne dépend pas de l'ordre des clés, mais des valeurs", () => {
  const a = { cle: "url", n: { x: 1, y: [1, { b: 2, a: 1 }] } };
  const b = { n: { y: [1, { a: 1, b: 2 }], x: 1 }, cle: "url" };
  expect(empreinteParametres(a)).toBe(empreinteParametres(b));
  expect(empreinteParametres(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(empreinteParametres({ cle: "titre" })).not.toBe(empreinteParametres({ cle: "url" }));
});

test("l'empreinte survit à lireMemoire / ecrireMemoire (R5) ; une ancienne mémoire sans empreinte se lit encore", async () => {
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
