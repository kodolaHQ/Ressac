import { expect, test } from "vitest";
import { CODE_DELAI_DEPASSE, executeurParDefaut } from "../../src/conteneur/executeur.js";

test("un code non nul est renvoyé tel quel, sans maquiller stderr", async () => {
  expect(await executeurParDefaut("sh", ["-c", "echo sortie; exit 3"])).toEqual({ code: 3, stdout: "sortie\n", stderr: "" });
});

test("commande introuvable → 127", async () => {
  expect((await executeurParDefaut("commande-qui-n-existe-pas", [])).code).toBe(127);
});

test("délai dépassé → 124", async () => {
  expect((await executeurParDefaut("sleep", ["5"], { delaiMs: 100 })).code).toBe(CODE_DELAI_DEPASSE);
});
