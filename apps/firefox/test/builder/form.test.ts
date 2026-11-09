import { blockCatalog } from "@webaios/kernel";
import { expect, test } from "vitest";
import { shownFields, entryOf, paramsWith, textOf } from "../../ui/builder/form";

const catalog = (type: string) => blockCatalog().find((c) => c.type === type)!;
const field = (type: string, name: string) => catalog(type).fields.find((c) => c.name === name)!;
const names = (type: string, params: Record<string, unknown>) => shownFields(catalog(type), params).map((c) => c.name);

test("the « only per item » fields only appear if parElement is ticked", () => {
  expect(names("ia.rediger", {})).not.toContain("siErreur");
  expect(names("ia.rediger", { perItem: false })).not.toContain("reutiliser");
  expect(names("ia.rediger", { perItem: true })).toEqual(expect.arrayContaining(["siErreur", "budgetSecondes", "reutiliser"]));
  expect(names("ia.rediger", {})).toContain("parElement");
});

test("ia.trier (always item by item) shows siErreur, budget, reutiliser and a field without the parElement box", () => {
  expect(names("ia.trier", {})).toEqual(expect.arrayContaining(["seuil", "champ", "siErreur", "budgetSecondes", "reutiliser"]));
  expect(names("ia.trier", {})).not.toContain("parElement");
});

test("a cleared non-required text field removes its key; required, it stays empty", () => {
  expect(paramsWith({ field: "p", threshold: 0.5 }, field("ia.trier", "champ"), "")).toEqual({ threshold: 0.5 });
  expect(paramsWith({ question: "q" }, field("ia.trier", "question"), "")).toEqual({ question: "" });
  expect(paramsWith({}, field("ia.trier", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("number: converted, cleared removes the key, unreadable changes nothing", () => {
  expect(paramsWith({ threshold: 0.5 }, field("ia.trier", "seuil"), "0.7")).toEqual({ threshold: 0.7 });
  expect(paramsWith({ threshold: 0.5 }, field("ia.trier", "seuil"), " ")).toEqual({});
  expect(paramsWith({ threshold: 0.5 }, field("ia.trier", "seuil"), "abc")).toBeNull();
});

test("texts: one line per value, empty lines ignored", () => {
  const keys = field("liste.dedoublonner", "cles");
  expect(paramsWith({}, keys, "url\n\n titre \n")).toEqual({ keys: ["url", "titre"] });
  expect(textOf(keys, ["url", "titre"])).toBe("url\ntitre");
  expect(paramsWith({ keys: ["url"] }, keys, "")).toEqual({ keys: [] });
});

test("checkbox and choice: values as is; displayed value by default the catalog's", () => {
  expect(paramsWith({}, field("ia.rediger", "parElement"), true)).toEqual({ perItem: true });
  expect(paramsWith({ call: "entree" }, field("code", "appel"), "recolte")).toEqual({ call: "recolte" });
  expect(entryOf(field("ia.trier", "seuil"), {})).toBe(0.5);
  expect(entryOf(field("ia.trier", "seuil"), { threshold: 0.9 })).toBe(0.9);
  expect(textOf(field("ia.trier", "seuil"), 0.9)).toBe("0.9");
  expect(textOf(field("ia.trier", "question"), undefined)).toBe("");
});

test("a cleared required number changes nothing", () => {
  expect(paramsWith({ count: 10 }, field("liste.garder", "nombre"), "")).toBeNull();
});

test("checkbox without a default value (auFilDeLEau): unticked, the key goes; ticked, true", () => {
  const f = field("sortie", "auFilDeLEau");
  expect(paramsWith({ to: "widget" }, f, true)).toEqual({ to: "widget", live: true });
  expect(paramsWith({ to: "widget", live: true }, f, false)).toEqual({ to: "widget" });
  expect(entryOf(f, {})).toBeUndefined();
  // A checkbox with a default value keeps the unticked value as is.
  expect(paramsWith({ perItem: true }, field("ia.rediger", "parElement"), false)).toEqual({ perItem: false });
});
