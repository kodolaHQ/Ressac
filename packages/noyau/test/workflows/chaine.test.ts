import { expect, test } from "vitest";
import { chaineAuFilDeLEau, validerWorkflow } from "../../src/index.js";
import { REGISTRE_BLOCS } from "../../src/workflows/blocs/index.js";
import { CAS_CHAINE } from "../aide/cas-chaine.js";

for (const cas of CAS_CHAINE) {
  test(`chaîne au fil de l'eau : ${cas.nom}`, () => {
    const r = validerWorkflow(cas.brut);
    if (!r.ok) throw new Error(r.erreur);
    expect(chaineAuFilDeLEau(r.valide)).toEqual(cas.attendu);
  });
}

test("les blocs chaînables : source.page, source.recuperer, ia.rediger", () => {
  const chainables = [...REGISTRE_BLOCS.values()].filter((d) => d.chaine).map((d) => d.type).sort();
  expect(chainables).toEqual(["ia.rediger", "source.page", "source.recuperer"]);
});
