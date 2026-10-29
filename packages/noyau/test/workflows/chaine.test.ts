import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { chaineAuFilDeLEau, validerWorkflow } from "../../src/index.js";
import { REGISTRE_BLOCS } from "../../src/workflows/blocs/index.js";
import { CAS_CHAINE } from "../aide/cas-chaine.js";
import { MOTEUR, workflowEnvoye } from "../aide/moteur.js";

// L'interpréteur du conteneur recopie la règle : importé tel quel, sans types.
const { chaineDe, BLOCS_LIVRES } = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);

for (const cas of CAS_CHAINE) {
  test(`chaîne au fil de l'eau : ${cas.nom}`, () => {
    const r = validerWorkflow(cas.brut, cas.contexte);
    if (!r.ok) throw new Error(r.erreur);
    expect(chaineAuFilDeLEau(r.valide)).toEqual(cas.attendu);
  });

  test(`chaîne au fil de l'eau, la même dans le conteneur : ${cas.nom}`, () => {
    expect(chaineDe(workflowEnvoye(cas.brut, cas.contexte), BLOCS_LIVRES)).toEqual(cas.attendu);
  });
}

test("les blocs chaînables : source.page, source.recuperer, ia.rediger, web.chercher", () => {
  const chainables = [...REGISTRE_BLOCS.values()].filter((d) => d.chaine).map((d) => d.type).sort();
  expect(chainables).toEqual(["ia.rediger", "source.page", "source.recuperer", "web.chercher"]);
});

test("DefinitionBloc.chaine est cohérent avec les modules du conteneur", () => {
  for (const d of REGISTRE_BLOCS.values()) {
    const module = BLOCS_LIVRES[d.type];
    expect(module, d.type).toBeDefined();
    const chainable = module.parElement === "option" && !module.finaliser && module.echecSiTousEchouent !== true;
    expect(d.chaine, d.type).toBe(chainable);
  }
});
