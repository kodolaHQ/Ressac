import { catalogueBlocs } from "@webaios/noyau";
import { expect, test } from "vitest";
import { champsAffiches, entreeDe, parametresAvec, texteDe } from "../../src/renderer/constructeur/formulaire";

const catalogue = (type: string) => catalogueBlocs().find((c) => c.type === type)!;
const champ = (type: string, nom: string) => catalogue(type).champs.find((c) => c.nom === nom)!;
const noms = (type: string, parametres: Record<string, unknown>) => champsAffiches(catalogue(type), parametres).map((c) => c.nom);

test("les champs « seulement par élément » n'apparaissent que si parElement est coché", () => {
  expect(noms("ia.rediger", {})).not.toContain("siErreur");
  expect(noms("ia.rediger", { parElement: false })).not.toContain("reutiliser");
  expect(noms("ia.rediger", { parElement: true })).toEqual(expect.arrayContaining(["siErreur", "budgetSecondes", "reutiliser"]));
  expect(noms("ia.rediger", {})).toContain("parElement");
});

test("ia.trier (toujours élément par élément) montre siErreur, budget, reutiliser et champ sans case parElement", () => {
  expect(noms("ia.trier", {})).toEqual(expect.arrayContaining(["seuil", "champ", "siErreur", "budgetSecondes", "reutiliser"]));
  expect(noms("ia.trier", {})).not.toContain("parElement");
});

test("un champ texte vidé et non requis retire sa clé ; requis, il reste vide", () => {
  expect(parametresAvec({ champ: "p", seuil: 0.5 }, champ("ia.trier", "champ"), "")).toEqual({ seuil: 0.5 });
  expect(parametresAvec({ question: "q" }, champ("ia.trier", "question"), "")).toEqual({ question: "" });
  expect(parametresAvec({}, champ("ia.trier", "question"), "{config.x} ?")).toEqual({ question: "{config.x} ?" });
});

test("nombre : converti, vidé retire la clé, illisible ne change rien", () => {
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), "0.7")).toEqual({ seuil: 0.7 });
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), " ")).toEqual({});
  expect(parametresAvec({ seuil: 0.5 }, champ("ia.trier", "seuil"), "abc")).toBeNull();
});

test("textes : une ligne par valeur, lignes vides ignorées", () => {
  const cles = champ("liste.dedoublonner", "cles");
  expect(parametresAvec({}, cles, "url\n\n titre \n")).toEqual({ cles: ["url", "titre"] });
  expect(texteDe(cles, ["url", "titre"])).toBe("url\ntitre");
  expect(parametresAvec({ cles: ["url"] }, cles, "")).toEqual({ cles: [] });
});

test("case et choix : valeurs telles quelles ; valeur affichée par défaut celle du catalogue", () => {
  expect(parametresAvec({}, champ("ia.rediger", "parElement"), true)).toEqual({ parElement: true });
  expect(parametresAvec({ appel: "entree" }, champ("code", "appel"), "recolte")).toEqual({ appel: "recolte" });
  expect(entreeDe(champ("ia.trier", "seuil"), {})).toBe(0.5);
  expect(entreeDe(champ("ia.trier", "seuil"), { seuil: 0.9 })).toBe(0.9);
  expect(texteDe(champ("ia.trier", "seuil"), 0.9)).toBe("0.9");
  expect(texteDe(champ("ia.trier", "question"), undefined)).toBe("");
});
