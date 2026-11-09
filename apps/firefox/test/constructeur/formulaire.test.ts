import { catalogueBlocs } from "@webaios/noyau";
import { expect, test } from "vitest";
import { shownFields, entreeDe, paramsWith, textOf } from "../../ui/constructeur/formulaire";

const catalogue = (type: string) => catalogueBlocs().find((c) => c.type === type)!;
const champ = (type: string, nom: string) => catalogue(type).champs.find((c) => c.nom === nom)!;
const noms = (type: string, parametres: Record<string, unknown>) => shownFields(catalogue(type), parametres).map((c) => c.nom);

test("the « only per item » fields only appear if parElement is ticked", () => {
  expect(noms("ia.rediger", {})).not.toContain("siErreur");
  expect(noms("ia.rediger", { parElement: false })).not.toContain("reutiliser");
  expect(noms("ia.rediger", { parElement: true })).toEqual(expect.arrayContaining(["siErreur", "budgetSecondes", "reutiliser"]));
  expect(noms("ia.rediger", {})).toContain("parElement");
});

test("ia.trier (always item by item) shows siErreur, budget, reutiliser and a field without the parElement box", () => {
  expect(noms("ia.trier", {})).toEqual(expect.arrayContaining(["seuil", "champ", "siErreur", "budgetSecondes", "reutiliser"]));
  expect(noms("ia.trier", {})).not.toContain("parElement");
});

test("a cleared non-required text field removes its key; required, it stays empty", () => {
  expect(paramsWith({ champ: "p", seuil: 0.5 }, champ("ia.trier", "champ"), "")).toEqual({ seuil: 0.5 });
  expect(paramsWith({ question: "q" }, champ("ia.trier", "question"), "")).toEqual({ question: "" });
  expect(paramsWith({}, champ("ia.trier", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("number: converted, cleared removes the key, unreadable changes nothing", () => {
  expect(paramsWith({ seuil: 0.5 }, champ("ia.trier", "seuil"), "0.7")).toEqual({ seuil: 0.7 });
  expect(paramsWith({ seuil: 0.5 }, champ("ia.trier", "seuil"), " ")).toEqual({});
  expect(paramsWith({ seuil: 0.5 }, champ("ia.trier", "seuil"), "abc")).toBeNull();
});

test("texts: one line per value, empty lines ignored", () => {
  const cles = champ("liste.dedoublonner", "cles");
  expect(paramsWith({}, cles, "url\n\n titre \n")).toEqual({ cles: ["url", "titre"] });
  expect(textOf(cles, ["url", "titre"])).toBe("url\ntitre");
  expect(paramsWith({ cles: ["url"] }, cles, "")).toEqual({ cles: [] });
});

test("checkbox and choice: values as is; displayed value by default the catalog's", () => {
  expect(paramsWith({}, champ("ia.rediger", "parElement"), true)).toEqual({ parElement: true });
  expect(paramsWith({ appel: "entree" }, champ("code", "appel"), "recolte")).toEqual({ appel: "recolte" });
  expect(entreeDe(champ("ia.trier", "seuil"), {})).toBe(0.5);
  expect(entreeDe(champ("ia.trier", "seuil"), { seuil: 0.9 })).toBe(0.9);
  expect(textOf(champ("ia.trier", "seuil"), 0.9)).toBe("0.9");
  expect(textOf(champ("ia.trier", "question"), undefined)).toBe("");
});

test("a cleared required number changes nothing", () => {
  expect(paramsWith({ nombre: 10 }, champ("liste.garder", "nombre"), "")).toBeNull();
});

test("checkbox without a default value (auFilDeLEau): unticked, the key goes; ticked, true", () => {
  const f = champ("sortie", "auFilDeLEau");
  expect(paramsWith({ vers: "widget" }, f, true)).toEqual({ vers: "widget", auFilDeLEau: true });
  expect(paramsWith({ vers: "widget", auFilDeLEau: true }, f, false)).toEqual({ vers: "widget" });
  expect(entreeDe(f, {})).toBeUndefined();
  // A checkbox with a default value keeps the unticked value as is.
  expect(paramsWith({ parElement: true }, champ("ia.rediger", "parElement"), false)).toEqual({ parElement: false });
});
