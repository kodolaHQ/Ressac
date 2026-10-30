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

// ——— Tâche 17 : la console filtrée pour l'agent ———

const nouvelle = () => new ConsolesExtensions({ surPlantages: () => {} });
const sans = { debloquee: false, tourneIllisible: false, observateur: false };

test("pour l'agent : un message d'onglet lisible est gardé, un non lisible est masqué et compté", () => {
  const c = nouvelle();
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "log", texte: "onglet partagé" }, { lisible: true });
  c.noter(ID, { horodatage: 3, niveau: "error", texte: "secret" }, { lisible: false });
  c.noter(ID, { horodatage: 4, niveau: "log", texte: "secret 2" }, { lisible: false });
  const r = c.pourAgent(ID, sans);
  expect(r.messages.map((m) => m.texte)).toEqual(["fond", "onglet partagé"]);
  expect(r).toMatchObject({ masques: 2, fondMasque: false, fondObserve: false, debloquee: false });
  expect(c.pourAgent(ID, { ...sans, depuis: 4 })).toMatchObject({ messages: [], masques: 1 });
  expect(c.erreursPourAgent(ID, sans)).toEqual([]);
  expect(c.erreurs(ID)).toEqual(["secret"]);
  expect(c.messages(ID)).toHaveLength(4);
});

test("pour l'agent : a tourné dans un onglet non lisible (drapeau du registre) → service worker et pages masqués, tout l'historique", () => {
  const c = nouvelle();
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "avant" });
  c.noter(ID, { horodatage: 2, niveau: "error", texte: "lu dans l'onglet" });
  c.noter(ID, { horodatage: 3, niveau: "log", texte: "partagé" }, { lisible: true });
  const r = c.pourAgent(ID, { ...sans, tourneIllisible: true });
  expect(r.fondMasque).toBe(true);
  expect(r.messages.map((m) => m.texte)).toEqual(["partagé"]);
  expect(c.erreursPourAgent(ID, { ...sans, tourneIllisible: true })).toEqual([]);
});

test("pour l'agent : avec un droit qui observe (décidé à la lecture), service worker et pages toujours masqués, même sans message ; les onglets lisibles passent", () => {
  const c = nouvelle();
  // Aucun message : la raison est dite quand même (l'agent sait pourquoi il ne verra rien).
  expect(c.pourAgent(ID, { ...sans, observateur: true })).toMatchObject({ messages: [], fondObserve: true, fondMasque: false });
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "error", texte: "fond erreur" });
  c.noter(ID, { horodatage: 3, niveau: "log", texte: "partagé" }, { lisible: true });
  const r = c.pourAgent(ID, { ...sans, observateur: true });
  expect(r.messages.map((m) => m.texte)).toEqual(["partagé"]);
  expect(r).toMatchObject({ fondObserve: true, fondMasque: false });
  expect(c.erreursPourAgent(ID, { ...sans, observateur: true })).toEqual([]);
  // Le même historique, lu sans le droit : tout passe (rien n'est décidé à l'écriture).
  expect(c.pourAgent(ID, sans).messages.map((m) => m.texte)).toEqual(["fond", "fond erreur", "partagé"]);
});

test("débloquée : rien n'est masqué ni compté", () => {
  const c = nouvelle();
  c.noter(ID, { horodatage: 1, niveau: "error", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "log", texte: "caché" }, { lisible: false });
  const r = c.pourAgent(ID, { debloquee: true, tourneIllisible: true, observateur: true });
  expect(r).toMatchObject({ masques: 0, fondMasque: false, fondObserve: false, debloquee: true });
  expect(r.messages.map((m) => m.texte)).toEqual(["fond", "caché"]);
  expect(c.erreursPourAgent(ID, { debloquee: true, tourneIllisible: true, observateur: true })).toEqual(["fond"]);
  expect(Object.keys(r.messages[1]!).sort()).toEqual(["horodatage", "niveau", "texte"]);
});
