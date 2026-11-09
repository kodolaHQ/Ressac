import { expect, test } from "vitest";
import { blockCatalog } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";

const catalog = blockCatalog();
const from = (type: string) => catalog.find((b) => b.type === type)!;
const field = (type: string, name: string) => from(type).champs.find((c) => c.nom === name)!;

test("each registry type has a label, a family and a field per key of its schema, and nothing else", () => {
  expect(catalog.map((b) => b.type).sort()).toEqual([...BLOCK_REGISTRY.keys()].sort());
  for (const [type, definition] of BLOCK_REGISTRY) {
    const block = from(type);
    expect(block.libelle.length, type).toBeGreaterThan(0);
    expect(block.famille, type).toBeTruthy();
    expect(block.description.length, type).toBeGreaterThan(0);
    expect(block.parElement, type).toBe(definition.parElement);
    const keys = Object.keys((definition.parametres as unknown as { shape: object }).shape).sort();
    expect(block.champs.map((c) => c.nom).sort(), type).toEqual(keys);
    for (const c of block.champs) expect(c.libelle.length, `${type}.${c.nom}`).toBeGreaterThan(0);
  }
  expect(field("source.page", "url").genre).toBe("gabarit");
  expect(from("sortie").libelle).toBe("Sortie vers le widget");
  expect(from("code").famille).toBe("Logique/Code");
});

test("the fields' defaults and bounds are those of the zod schemas", () => {
  expect(field("ia.trier", "seuil")).toMatchObject({ requis: false, defaut: 0.5, min: 0, max: 1, genre: "nombre" });
  expect(field("liste.garder", "nombre")).toMatchObject({ requis: true, min: 1, max: 1000, entier: true });
  expect(field("code", "appel")).toMatchObject({ genre: "choix", choix: ["entree", "recolte"], defaut: "entree" });
  expect(field("ia.rediger", "texteMax")).toMatchObject({ defaut: 12_000, min: 1, max: 200_000, entier: true });
  expect(field("source.page", "champ")).toMatchObject({ defaut: "page", requis: false });
  expect(field("source.page", "defiler")).toMatchObject({ genre: "nombre", requis: false, min: 0, max: 20, entier: true });
  expect(field("source.page", "defiler")).not.toHaveProperty("defaut");
  expect(field("sortie", "vers").genre).toBe("choix");
  expect(field("sortie", "vers").choix).toEqual(["widget", "page"]);
  expect(field("liste.dedoublonner", "cles").genre).toBe("textes");
  expect(field("source.page", "compte").genre).toBe("case");
});

test("required parameters have a neutral default to prefill the palette", () => {
  expect(field("liste.garder", "nombre").defaut).toBe(10);
  expect(field("liste.nouveaux", "cle").defaut).toBe("url");
  expect(field("liste.dedoublonner", "cles").defaut).toEqual(["url"]);
  // R23: never a default address, the block stays invalid until the address is entered.
  const urls = ["source.page.url", "source.recuperer.url", "source.flux.urls"];
  for (const b of catalog) {
    for (const c of b.champs) {
      const name = `${b.type}.${c.nom}`;
      if (urls.includes(name)) expect(c.defaut, name).toBeUndefined();
      else if (c.requis) expect(c.defaut, name).toBeDefined();
    }
  }
});

test("the common per-element mode fields are marked, except for ia.trier", () => {
  for (const name of ["siErreur", "budgetSecondes", "reutiliser"]) {
    expect(field("source.page", name).parElementSeulement).toBe(true);
    expect(field("ia.trier", name).parElementSeulement).toBeUndefined();
  }
  expect(field("source.page", "parElement").parElementSeulement).toBeUndefined();
  expect(field("source.page", "champ").parElementSeulement).toBeUndefined();
  expect(field("source.flux", "siErreur").parElementSeulement).toBeUndefined();
  expect(from("ia.trier").champs.some((c) => c.nom === "parElement")).toBe(false);
});

test("the input of each type", () => {
  const entries = Object.fromEntries(catalog.map((b) => [b.type, b.entree]));
  expect(entries).toEqual({
    "source.page": "parElement", "source.flux": "facultative", "source.recuperer": "parElement",
    "web.chercher": "parElement", "liste.nouveaux": "requise", "liste.dedoublonner": "requise", "liste.garder": "requise",
    "ia.trier": "requise", "ia.rediger": "parElement", code: "facultative", sortie: "requise",
  });
});

test("the catalog goes through structuredClone", () => {
  expect(structuredClone(catalog)).toEqual(catalog);
  expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
});

test("the families follow the order Sources, Listes, IA, Logique/Code, Sortie", () => {
  const order = ["Sources", "Listes", "IA", "Logique/Code", "Sortie"];
  const ranks = catalog.map((b) => order.indexOf(b.famille));
  expect(ranks.every((r) => r >= 0)).toBe(true);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(new Set(catalog.map((b) => b.famille))).toEqual(new Set(order));
});

test("garderJours, auFilDeLEau and the budgetSecondes bound in the catalog", () => {
  for (const type of ["source.page", "source.recuperer", "ia.rediger"]) {
    expect(field(type, "garderJours"), type).toMatchObject({ libelle: "Garder (jours)", aide: "Sans valeur : pour toujours.", requis: false, genre: "nombre", min: 1, max: 365, entier: true, parElementSeulement: true });
    expect(field(type, "budgetSecondes"), type).toMatchObject({ max: 3600, aide: "170 s au plus, ou la durée maximale de l'exécution" });
  }
  expect(field("ia.trier", "garderJours").parElementSeulement).toBeUndefined();
  expect(field("liste.nouveaux", "garderJours")).toMatchObject({ libelle: "Oublier après (jours)", requis: false, genre: "nombre", min: 1, max: 365, entier: true });
  expect(field("sortie", "auFilDeLEau")).toMatchObject({ libelle: "Publier au fil de l'eau", requis: false, genre: "case" });
  // Without a default value: the key stays absent until the user ticks it (absent = false).
  expect(field("sortie", "auFilDeLEau")).not.toHaveProperty("defaut");
  expect(from("source.page")).not.toHaveProperty("chaine");
});

test("web.chercher is in the Sources family, after Récupérer une adresse", () => {
  const types = catalog.map((b) => b.type);
  expect(types.indexOf("web.chercher")).toBe(types.indexOf("source.recuperer") + 1);
  expect(from("web.chercher")).toMatchObject({
    libelle: "Chercher sur le web",
    famille: "Sources",
    description: "Cherche sur DuckDuckGo et rend les résultats (titre, adresse, extrait).",
    parElement: "option",
    entree: "parElement",
  });
  expect(from("web.chercher").champs.map((c) => c.nom)).toEqual(["requete", "nombre", "parElement", "siErreur", "budgetSecondes", "reutiliser", "garderJours", "champ"]);
  expect(field("web.chercher", "requete")).toMatchObject({ genre: "gabarit", requis: true });
  expect(field("web.chercher", "nombre")).toMatchObject({ genre: "nombre", requis: false, defaut: 8, min: 1, max: 20, entier: true });
  expect(field("web.chercher", "champ")).toMatchObject({ genre: "texte", requis: false, defaut: "recherche" });
  expect(BLOCK_REGISTRY.get("web.chercher")!.chaine).toBe(true);
});
