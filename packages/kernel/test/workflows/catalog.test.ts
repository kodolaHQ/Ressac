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
  expect(field("source.page", "url").kind).toBe("gabarit");
  expect(from("sortie").label).toBe("Sortie vers le widget");
  expect(from("code").family).toBe("Logique/Code");
});

test("the fields' defaults and bounds are those of the zod schemas", () => {
  expect(field("ia.trier", "seuil")).toMatchObject({ required: false, default: 0.5, min: 0, max: 1, kind: "nombre" });
  expect(field("liste.garder", "nombre")).toMatchObject({ required: true, min: 1, max: 1000, integer: true });
  expect(field("code", "appel")).toMatchObject({ kind: "choix", choices: ["entree", "recolte"], default: "entree" });
  expect(field("ia.rediger", "texteMax")).toMatchObject({ default: 12_000, min: 1, max: 200_000, integer: true });
  expect(field("source.page", "champ")).toMatchObject({ default: "page", required: false });
  expect(field("source.page", "defiler")).toMatchObject({ kind: "nombre", required: false, min: 0, max: 20, integer: true });
  expect(field("source.page", "defiler")).not.toHaveProperty("defaut");
  expect(field("sortie", "vers").kind).toBe("choix");
  expect(field("sortie", "vers").choices).toEqual(["widget", "page"]);
  expect(field("liste.dedoublonner", "cles").kind).toBe("textes");
  expect(field("source.page", "compte").kind).toBe("case");
});

test("required parameters have a neutral default to prefill the palette", () => {
  expect(field("liste.garder", "nombre").default).toBe(10);
  expect(field("liste.nouveaux", "cle").default).toBe("url");
  expect(field("liste.dedoublonner", "cles").default).toEqual(["url"]);
  // R23: never a default address, the block stays invalid until the address is entered.
  const urls = ["source.page.url", "source.recuperer.url", "source.flux.urls"];
  for (const b of catalog) {
    for (const c of b.fields) {
      const name = `${b.type}.${c.name}`;
      if (urls.includes(name)) expect(c.default, name).toBeUndefined();
      else if (c.required) expect(c.default, name).toBeDefined();
    }
  }
});

test("the common per-element mode fields are marked, except for ia.trier", () => {
  for (const name of ["siErreur", "budgetSecondes", "reutiliser"]) {
    expect(field("source.page", name).perItemOnly).toBe(true);
    expect(field("ia.trier", name).perItemOnly).toBeUndefined();
  }
  expect(field("source.page", "parElement").perItemOnly).toBeUndefined();
  expect(field("source.page", "champ").perItemOnly).toBeUndefined();
  expect(field("source.flux", "siErreur").perItemOnly).toBeUndefined();
  expect(from("ia.trier").fields.some((c) => c.name === "parElement")).toBe(false);
});

test("the input of each type", () => {
  const entries = Object.fromEntries(catalog.map((b) => [b.type, b.input]));
  expect(entries).toEqual({
    "source.page": "parElement", "source.flux": "facultative", "source.recuperer": "parElement",
    "web.chercher": "parElement", "liste.nouveaux": "requise", "liste.dedoublonner": "requise", "liste.garder": "requise",
    "ia.trier": "requise", "ia.rediger": "parElement", code: "facultative", output: "requise",
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

test("garderJours, auFilDeLEau and the budgetSecondes bound in the catalog", () => {
  for (const type of ["source.page", "source.recuperer", "ia.rediger"]) {
    expect(field(type, "garderJours"), type).toMatchObject({ label: "Garder (jours)", help: "Sans valeur : pour toujours.", required: false, kind: "nombre", min: 1, max: 365, integer: true, perItemOnly: true });
    expect(field(type, "budgetSecondes"), type).toMatchObject({ max: 3600, help: "170 s au plus, ou la durée maximale de l'exécution" });
  }
  expect(field("ia.trier", "garderJours").perItemOnly).toBeUndefined();
  expect(field("liste.nouveaux", "garderJours")).toMatchObject({ label: "Oublier après (jours)", required: false, kind: "nombre", min: 1, max: 365, integer: true });
  expect(field("sortie", "auFilDeLEau")).toMatchObject({ label: "Publier au fil de l'eau", required: false, kind: "case" });
  // Without a default value: the key stays absent until the user ticks it (absent = false).
  expect(field("sortie", "auFilDeLEau")).not.toHaveProperty("defaut");
  expect(from("source.page")).not.toHaveProperty("chaine");
});

test("web.chercher is in the Sources family, after Récupérer une adresse", () => {
  const types = catalog.map((b) => b.type);
  expect(types.indexOf("web.chercher")).toBe(types.indexOf("source.recuperer") + 1);
  expect(from("web.chercher")).toMatchObject({
    label: "Chercher sur le web",
    family: "Sources",
    description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
    perItem: "option",
    input: "parElement",
  });
  expect(from("web.chercher").fields.map((c) => c.name)).toEqual(["requete", "nombre", "parElement", "siErreur", "budgetSecondes", "reutiliser", "garderJours", "champ"]);
  expect(field("web.chercher", "requete")).toMatchObject({ kind: "gabarit", required: true });
  expect(field("web.chercher", "nombre")).toMatchObject({ kind: "nombre", required: false, default: 8, min: 1, max: 20, integer: true });
  expect(field("web.chercher", "champ")).toMatchObject({ kind: "texte", required: false, default: "recherche" });
  expect(BLOCK_REGISTRY.get("web.chercher")!.chain).toBe(true);
});
