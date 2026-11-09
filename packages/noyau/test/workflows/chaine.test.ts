import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { streamingChain, validateWorkflow } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocs/index.js";
import { CASE_CHAIN } from "../aide/cas-chaine.js";
import { ENGINE, sentWorkflow } from "../aide/moteur.js";

// The container's interpreter copies the rule: imported as is, without types.
const { chaineDe: chainOf, BLOCS_LIVRES } = await import(pathToFileURL(join(ENGINE, "interpreteur.mjs")).href);

for (const cas of CASE_CHAIN) {
  test(`streaming chain: ${cas.nom}`, () => {
    const r = validateWorkflow(cas.brut, cas.contexte);
    if (!r.ok) throw new Error(r.erreur);
    expect(streamingChain(r.valide)).toEqual(cas.attendu);
  });

  test(`streaming chain, the same in the container: ${cas.nom}`, () => {
    expect(chainOf(sentWorkflow(cas.brut, cas.contexte), BLOCS_LIVRES)).toEqual(cas.attendu);
  });
}

test("the chainable blocks: source.page, source.recuperer, ia.rediger, web.chercher", () => {
  const chainable = [...BLOCK_REGISTRY.values()].filter((d) => d.chaine).map((d) => d.type).sort();
  expect(chainable).toEqual(["ia.rediger", "source.page", "source.recuperer", "web.chercher"]);
});

test("DefinitionBloc.chaine is consistent with the container's modules", () => {
  for (const d of BLOCK_REGISTRY.values()) {
    const module = BLOCS_LIVRES[d.type];
    expect(module, d.type).toBeDefined();
    const chainable = module.parElement === "option" && !module.finaliser && module.echecSiTousEchouent !== true;
    expect(d.chaine, d.type).toBe(chainable);
  }
});
