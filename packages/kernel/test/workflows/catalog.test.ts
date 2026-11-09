import { expect, test } from "vitest";
import { blockCatalog } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";

const catalog = blockCatalog();
const from = (type: string) => catalog.find((b) => b.type === type)!;
const field = (type: string, name: string) => from(type).fields.find((c) => c.name === name)!;

test("each registry type has a label, a family and a field per key of its schema, and nothing else", () => {
  expect(catalog.map((b) => b.type).sort()).toEqual([...BLOCK_REGISTRY.keys()].sort());
  for (const [type, definition] of BLOCK_REGISTRY) {
    const block = from(type);
    expect(block.label.length, type).toBeGreaterThan(0);
    expect(block.family, type).toBeTruthy();
    expect(block.description.length, type).toBeGreaterThan(0);
    expect(block.perItem, type).toBe(definition.perItem);
    const keys = Object.keys((definition.params as unknown as { shape: object }).shape).sort();
    expect(block.fields.map((c) => c.name).sort(), type).toEqual(keys);
    for (const c of block.fields) expect(c.label.length, `${type}.${c.name}`).toBeGreaterThan(0);
  }
  expect(field("source.page", "url").kind).toBe("template");
  expect(from("output").label).toBe("Sortie vers le widget");
  expect(from("code").family).toBe("Logique/Code");
});

test("the fields' defaults and bounds are those of the zod schemas", () => {
  expect(field("ai.sort", "threshold")).toMatchObject({ required: false, default: 0.5, min: 0, max: 1, kind: "number" });
  expect(field("list.keep", "count")).toMatchObject({ required: true, min: 1, max: 1000, integer: true });
  expect(field("code", "call")).toMatchObject({ kind: "choice", choices: ["input", "harvest"], default: "input" });
  expect(field("ai.write", "maxText")).toMatchObject({ default: 12_000, min: 1, max: 200_000, integer: true });
  expect(field("source.page", "field")).toMatchObject({ default: "page", required: false });
  expect(field("source.page", "scroll")).toMatchObject({ kind: "number", required: false, min: 0, max: 20, integer: true });
  expect(field("source.page", "scroll")).not.toHaveProperty("default");
  expect(field("output", "to").kind).toBe("choice");
  expect(field("output", "to").choices).toEqual(["widget", "page"]);
  expect(field("list.dedupe", "keys").kind).toBe("texts");
  expect(field("source.page", "account").kind).toBe("checkbox");
});

test("required parameters have a neutral default to prefill the palette", () => {
  expect(field("list.keep", "count").default).toBe(10);
  expect(field("list.new", "key").default).toBe("url");
  expect(field("list.dedupe", "keys").default).toEqual(["url"]);
  // R23: never a default address, the block stays invalid until the address is entered.
  const urls = ["source.page.url", "source.fetch.url", "source.feed.urls"];
  for (const b of catalog) {
    for (const c of b.fields) {
      const name = `${b.type}.${c.name}`;
      if (urls.includes(name)) expect(c.default, name).toBeUndefined();
      else if (c.required) expect(c.default, name).toBeDefined();
    }
  }
});

test("the common per-element mode fields are marked, except for ai.sort", () => {
  for (const name of ["onError", "budgetSeconds", "reuse"]) {
    expect(field("source.page", name).perItemOnly).toBe(true);
    expect(field("ai.sort", name).perItemOnly).toBeUndefined();
  }
  expect(field("source.page", "perItem").perItemOnly).toBeUndefined();
  expect(field("source.page", "field").perItemOnly).toBeUndefined();
  expect(field("source.feed", "onError").perItemOnly).toBeUndefined();
  expect(from("ai.sort").fields.some((c) => c.name === "perItem")).toBe(false);
});

test("the input of each type", () => {
  const entries = Object.fromEntries(catalog.map((b) => [b.type, b.input]));
  expect(entries).toEqual({
    "source.page": "perItem", "source.feed": "optional", "source.fetch": "perItem",
    "web.search": "perItem", "list.new": "required", "list.dedupe": "required", "list.keep": "required",
    "ai.sort": "required", "ai.write": "perItem", code: "optional", output: "required",
  });
});

test("the catalog goes through structuredClone", () => {
  expect(structuredClone(catalog)).toEqual(catalog);
  expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
});

test("the families follow the order Sources, Listes, IA, Logique/Code, Sortie", () => {
  const order = ["Sources", "Listes", "IA", "Logique/Code", "Sortie"];
  const ranks = catalog.map((b) => order.indexOf(b.family));
  expect(ranks.every((r) => r >= 0)).toBe(true);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(new Set(catalog.map((b) => b.family))).toEqual(new Set(order));
});

test("keepDays, live and the budgetSeconds bound in the catalog", () => {
  for (const type of ["source.page", "source.fetch", "ai.write"]) {
    expect(field(type, "keepDays"), type).toMatchObject({ label: "Garder (jours)", help: "Sans valeur : pour toujours.", required: false, kind: "number", min: 1, max: 365, integer: true, perItemOnly: true });
    expect(field(type, "budgetSeconds"), type).toMatchObject({ max: 3600, help: "170 s au plus, ou la durée maximale de l'exécution" });
  }
  expect(field("ai.sort", "keepDays").perItemOnly).toBeUndefined();
  expect(field("list.new", "keepDays")).toMatchObject({ label: "Oublier après (jours)", required: false, kind: "number", min: 1, max: 365, integer: true });
  expect(field("output", "live")).toMatchObject({ label: "Publier au fil de l'eau", required: false, kind: "checkbox" });
  // Without a default value: the key stays absent until the user ticks it (absent = false).
  expect(field("output", "live")).not.toHaveProperty("default");
  expect(from("source.page")).not.toHaveProperty("chain");
});

test("web.search is in the Sources family, after Récupérer une adresse", () => {
  const types = catalog.map((b) => b.type);
  expect(types.indexOf("web.search")).toBe(types.indexOf("source.fetch") + 1);
  expect(from("web.search")).toMatchObject({
    label: "Chercher sur le web",
    family: "Sources",
    description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
    perItem: "option",
    input: "perItem",
  });
  expect(from("web.search").fields.map((c) => c.name)).toEqual(["query", "count", "perItem", "onError", "budgetSeconds", "reuse", "keepDays", "field"]);
  expect(field("web.search", "query")).toMatchObject({ kind: "template", required: true });
  expect(field("web.search", "count")).toMatchObject({ kind: "number", required: false, default: 8, min: 1, max: 20, integer: true });
  expect(field("web.search", "field")).toMatchObject({ kind: "text", required: false, default: "search" });
  expect(BLOCK_REGISTRY.get("web.search")!.chain).toBe(true);
});
