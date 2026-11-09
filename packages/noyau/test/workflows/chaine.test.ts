import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { chaineAuFilDeLEau, validerWorkflow } from "../../src/index.js";
import { REGISTRE_BLOCS } from "../../src/workflows/blocs/index.js";
import { CAS_CHAINE } from "../aide/cas-chaine.js";
import { MOTEUR, workflowEnvoye } from "../aide/moteur.js";

// The container's interpreter copies the rule: imported as is, without types.
const { chaineDe, BLOCS_LIVRES } = await import(pathToFileURL(join(MOTEUR, "interpreteur.mjs")).href);

for (const cas of CAS_CHAINE) {
  test(`streaming chain: ${cas.nom}`, () => {
    const r = validerWorkflow(cas.brut, cas.contexte);
    if (!r.ok) throw new Error(r.erreur);
    expect(chaineAuFilDeLEau(r.valide)).toEqual(cas.attendu);
  });

  test(`streaming chain, the same in the container: ${cas.nom}`, () => {
    expect(chaineDe(workflowEnvoye(cas.brut, cas.contexte), BLOCS_LIVRES)).toEqual(cas.attendu);
  });
}

test("the chainable blocks: source.page, source.recuperer, ia.rediger, web.chercher", () => {
  const chainables = [...REGISTRE_BLOCS.values()].filter((d) => d.chaine).map((d) => d.type).sort();
  expect(chainables).toEqual(["ia.rediger", "source.page", "source.recuperer", "web.chercher"]);
});

test("DefinitionBloc.chaine is consistent with the container's modules", () => {
  for (const d of REGISTRE_BLOCS.values()) {
    const module = BLOCS_LIVRES[d.type];
    expect(module, d.type).toBeDefined();
    const chainable = module.parElement === "option" && !module.finaliser && module.echecSiTousEchouent !== true;
    expect(d.chaine, d.type).toBe(chainable);
  }
});
