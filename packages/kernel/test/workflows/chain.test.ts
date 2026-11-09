import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { streamingChain, validateWorkflow } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";
import { CASE_CHAIN } from "../helpers/chain-cases.js";
import { ENGINE, sentWorkflow } from "../helpers/engine.js";

// The container's interpreter copies the rule: imported as is, without types.
const { chainOf, SHIPPED_BLOCKS } = await import(pathToFileURL(join(ENGINE, "interpreter.mjs")).href);

for (const cas of CASE_CHAIN) {
  test(`streaming chain: ${cas.name}`, () => {
    const r = validateWorkflow(cas.raw, cas.context);
    if (!r.ok) throw new Error(r.error);
    expect(streamingChain(r.valid)).toEqual(cas.expected);
  });

  test(`streaming chain, the same in the container: ${cas.name}`, () => {
    expect(chainOf(sentWorkflow(cas.raw, cas.context), SHIPPED_BLOCKS)).toEqual(cas.expected);
  });
}

test("the chainable blocks: source.page, source.fetch, ai.write, web.search", () => {
  const chainable = [...BLOCK_REGISTRY.values()].filter((d) => d.chain).map((d) => d.type).sort();
  expect(chainable).toEqual(["ai.write", "source.fetch", "source.page", "web.search"]);
});

test("BlockDefinition.chain is consistent with the container's modules", () => {
  for (const d of BLOCK_REGISTRY.values()) {
    const module = SHIPPED_BLOCKS[d.type];
    expect(module, d.type).toBeDefined();
    const chainable = module.perItem === "option" && !module.finalize && module.failIfAllFail !== true;
    expect(d.chain, d.type).toBe(chainable);
  }
});
