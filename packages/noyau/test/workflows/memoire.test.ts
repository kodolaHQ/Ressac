import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMOIRE_MAX_OCTETS, ecrireMemoire, lireMemoire } from "../../src/index.js";
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
