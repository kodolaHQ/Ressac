import { expect, test } from "vitest";
import { CONSOLE_MAX, ConsolesExtensions, FENETRE_PLANTAGES_MS, PLANTAGES_MAX } from "../../src/main/extensions/consoles";

const ID = "a".repeat(32);
const AUTRE = "b".repeat(32);

test("valeurs : 500 messages, 3 plantages en 60 s", () => {
  expect(CONSOLE_MAX).toBe(500);
  expect(PLANTAGES_MAX).toBe(3);
  expect(FENETRE_PLANTAGES_MS).toBe(60_000);
});

test("501 messages : les 500 derniers", () => {
  const c = new ConsolesExtensions({ surPlantages: () => {} });
  for (let i = 0; i < 501; i++) c.noter(ID, { horodatage: i, niveau: "log", texte: `m${i}` });
  const m = c.messages(ID);
  expect(m).toHaveLength(500);
  expect(m[0]!.texte).toBe("m1");
  expect(m[499]!.texte).toBe("m500");
  // Une autre extension a sa propre console.
  expect(c.messages(AUTRE)).toEqual([]);
});

test("messages depuis un horodatage ; erreurs : les textes de niveau error seulement", () => {
  const c = new ConsolesExtensions({ surPlantages: () => {} });
  c.noter(ID, { horodatage: 10, niveau: "log", texte: "a" });
  c.noter(ID, { horodatage: 20, niveau: "error", texte: "b" });
  c.noter(ID, { horodatage: 30, niveau: "warn", texte: "c" });
  expect(c.messages(ID, 20).map((m) => m.texte)).toEqual(["b", "c"]);
  expect(c.erreurs(ID)).toEqual(["b"]);
  // La copie rendue ne touche pas la console.
  c.messages(ID).pop();
  expect(c.messages(ID)).toHaveLength(3);
});

test("3 plantages en 60 s : rappel de désactivation ; 3 en 61 s : non", () => {
  const appels: string[] = [];
  const c = new ConsolesExtensions({ surPlantages: (id) => appels.push(id) });
  c.plantage(ID, 0);
  c.plantage(ID, 30_000);
  expect(appels).toEqual([]);
  c.plantage(ID, 60_000);
  expect(appels).toEqual([ID]);

  const d: string[] = [];
  const c2 = new ConsolesExtensions({ surPlantages: (id) => d.push(id) });
  c2.plantage(AUTRE, 0);
  c2.plantage(AUTRE, 30_000);
  c2.plantage(AUTRE, 61_000);
  expect(d).toEqual([]);
  // Le quatrième, dans la minute des deux derniers : oui.
  c2.plantage(AUTRE, 62_000);
  expect(d).toEqual([AUTRE]);
});

test("après le rappel, les plantages repartent de zéro ; oublier efface console et plantages", () => {
  const appels: string[] = [];
  const c = new ConsolesExtensions({ surPlantages: (id) => appels.push(id) });
  for (const t of [0, 1, 2]) c.plantage(ID, t);
  expect(appels).toHaveLength(1);
  c.plantage(ID, 3);
  c.plantage(ID, 4);
  expect(appels).toHaveLength(1);
  c.noter(ID, { horodatage: 1, niveau: "error", texte: "x" });
  c.oublier(ID);
  expect(c.messages(ID)).toEqual([]);
  c.plantage(ID, 5);
  expect(appels).toHaveLength(1);
});
