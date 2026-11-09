import { catalogueBlocs } from "@webaios/noyau";
import { expect, test } from "vitest";
import { champsAffiches, entreeDe, parametresAvec, texteDe } from "../../ui/constructeur/formulaire";

const catalogue = (type: string) => catalogueBlocs().find((c) => c.type === type)!;
const champ = (type: string, nom: string) => catalogue(type).champs.find((c) => c.nom === nom)!;
const noms = (type: string, parametres: Record<string, unknown>) => champsAffiches(catalogue(type), parametres).map((c) => c.nom);

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
  expect(parametresAvec({ champ: "p", seuil: 0.5 }, champ("ia.trier", "champ"), "")).toEqual({ seuil: 0.5 });
  expect(parametresAvec({ question: "q" }, champ("ia.trier", "question"), "")).toEqual({ question: "" });
  expect(parametresAvec({}, champ("ia.trier", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("number: converted, cleared removes the key, unreadable changes nothing", () => {
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), "0.7")).toEqual({ seuil: 0.7 });
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), " ")).toEqual({});
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), "abc")).toBeNull();
});

test("texts: one line per value, empty lines ignored", () => {
  const cles = champ("liste.dedoublonner", "cles");
  expect(parametresAvec({}, cles, "url\n\n titre \n")).toEqual({ cles: ["url", "titre"] });
  expect(texteDe(cles, ["url", "titre"])).toBe("url\ntitre");
  expect(parametresAvec({ cles: ["url"] }, cles, "")).toEqual({ cles: [] });
});

test("checkbox and choice: values as is; displayed value by default the catalog's", () => {
  expect(parametresAvec({}, champ("ia.rediger", "parElement"), true)).toEqual({ parElement: true });
  expect(parametresAvec({ appel: "entree" }, champ("code", "appel"), "recolte")).toEqual({ appel: "recolte" });
  expect(entreeDe(champ("ia.trier", "seuil"), {})).toBe(0.5);
  expect(entreeDe(champ("ia.trier", "seuil"), { seuil: 0.9 })).toBe(0.9);
  expect(texteDe(champ("ia.trier", "seuil"), 0.9)).toBe("0.9");
  expect(texteDe(champ("ia.trier", "question"), undefined)).toBe("");
});

test("a cleared required number changes nothing", () => {
  expect(parametresAvec({ nombre: 10 }, champ("liste.garder", "nombre"), "")).toBeNull();
});

test("checkbox without a default value (auFilDeLEau): unticked, the key goes; ticked, true", () => {
  const f = champ("sortie", "auFilDeLEau");
  expect(parametresAvec({ vers: "widget" }, f, true)).toEqual({ vers: "widget", auFilDeLEau: true });
  expect(parametresAvec({ vers: "widget", auFilDeLEau: true }, f, false)).toEqual({ vers: "widget" });
  expect(entreeDe(f, {})).toBeUndefined();
  // A checkbox with a default value keeps the unticked value as is.
  expect(parametresAvec({ parElement: true }, champ("ia.rediger", "parElement"), false)).toEqual({ parElement: false });
});
