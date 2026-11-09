import { blockCatalog } from "@webaios/kernel";
import { expect, test } from "vitest";
import { shownFields, entryOf, paramsWith, textOf } from "../../ui/builder/form";

const catalog = (type: string) => blockCatalog().find((c) => c.type === type)!;
const field = (type: string, name: string) => catalog(type).champs.find((c) => c.nom === name)!;
const names = (type: string, params: Record<string, unknown>) => shownFields(catalog(type), params).map((c) => c.nom);

test("the « only per item » fields only appear if parElement is ticked", () => {
  expect(names("ia.rediger", {})).not.toContain("siErreur");
  expect(names("ia.rediger", { parElement: false })).not.toContain("reutiliser");
  expect(names("ia.rediger", { parElement: true })).toEqual(expect.arrayContaining(["siErreur", "budgetSecondes", "reutiliser"]));
  expect(names("ia.rediger", {})).toContain("parElement");
});

test("ia.trier (always item by item) shows siErreur, budget, reutiliser and a field without the parElement box", () => {
  expect(names("ia.trier", {})).toEqual(expect.arrayContaining(["seuil", "champ", "siErreur", "budgetSecondes", "reutiliser"]));
  expect(names("ia.trier", {})).not.toContain("parElement");
});

test("a cleared non-required text field removes its key; required, it stays empty", () => {
  expect(paramsWith({ champ: "p", seuil: 0.5 }, field("ia.trier", "champ"), "")).toEqual({ seuil: 0.5 });
  expect(paramsWith({ question: "q" }, field("ia.trier", "question"), "")).toEqual({ question: "" });
  expect(paramsWith({}, field("ia.trier", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("number: converted, cleared removes the key, unreadable changes nothing", () => {
  expect(paramsWith({ seuil: 0.5 }, field("ia.trier", "seuil"), "0.7")).toEqual({ seuil: 0.7 });
  expect(paramsWith({ seuil: 0.5 }, field("ia.trier", "seuil"), " ")).toEqual({});
  expect(paramsWith({ seuil: 0.5 }, field("ia.trier", "seuil"), "abc")).toBeNull();
});

test("texts: one line per value, empty lines ignored", () => {
  const keys = field("liste.dedoublonner", "cles");
  expect(paramsWith({}, keys, "url\n\n titre \n")).toEqual({ cles: ["url", "titre"] });
  expect(textOf(keys, ["url", "titre"])).toBe("url\ntitre");
  expect(paramsWith({ cles: ["url"] }, keys, "")).toEqual({ cles: [] });
});

test("checkbox and choice: values as is; displayed value by default the catalog's", () => {
  expect(paramsWith({}, field("ia.rediger", "parElement"), true)).toEqual({ parElement: true });
  expect(paramsWith({ appel: "entree" }, field("code", "appel"), "recolte")).toEqual({ appel: "recolte" });
  expect(entryOf(field("ia.trier", "seuil"), {})).toBe(0.5);
  expect(entryOf(field("ia.trier", "seuil"), { seuil: 0.9 })).toBe(0.9);
  expect(textOf(field("ia.trier", "seuil"), 0.9)).toBe("0.9");
  expect(textOf(field("ia.trier", "question"), undefined)).toBe("");
});

test("a cleared required number changes nothing", () => {
  expect(paramsWith({ nombre: 10 }, field("liste.garder", "nombre"), "")).toBeNull();
});

test("checkbox without a default value (auFilDeLEau): unticked, the key goes; ticked, true", () => {
  const f = field("sortie", "auFilDeLEau");
  expect(paramsWith({ vers: "widget" }, f, true)).toEqual({ vers: "widget", auFilDeLEau: true });
  expect(paramsWith({ vers: "widget", auFilDeLEau: true }, f, false)).toEqual({ vers: "widget" });
  expect(entryOf(f, {})).toBeUndefined();
  // A checkbox with a default value keeps the unticked value as is.
  expect(paramsWith({ parElement: true }, field("ia.rediger", "parElement"), false)).toEqual({ parElement: false });
});
