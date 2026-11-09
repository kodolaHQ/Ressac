import { expect, test } from "vitest";
import { CONSOLE_MAX, ConsolesExtensions, CRASH_WINDOW_MS, MAX_CRASHES } from "../../core/extensions/consoles";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);

test("values: 500 messages, 3 crashes in 60 s", () => {
  expect(CONSOLE_MAX).toBe(500);
  expect(MAX_CRASHES).toBe(3);
  expect(CRASH_WINDOW_MS).toBe(60_000);
});

test("501 messages: the last 500", () => {
  const c = new ConsolesExtensions({ surPlantages: () => {} });
  for (let i = 0; i < 501; i++) c.noter(ID, { horodatage: i, niveau: "log", texte: `m${i}` });
  const m = c.messages(ID);
  expect(m).toHaveLength(500);
  expect(m[0]!.texte).toBe("m1");
  expect(m[499]!.texte).toBe("m500");
  // Another extension has its own console.
  expect(c.messages(OTHER)).toEqual([]);
});

test("messages since a timestamp; errors: only the error-level texts", () => {
  const c = new ConsolesExtensions({ surPlantages: () => {} });
  c.noter(ID, { horodatage: 10, niveau: "log", texte: "a" });
  c.noter(ID, { horodatage: 20, niveau: "error", texte: "b" });
  c.noter(ID, { horodatage: 30, niveau: "warn", texte: "c" });
  expect(c.messages(ID, 20).map((m) => m.texte)).toEqual(["b", "c"]);
  expect(c.erreurs(ID)).toEqual(["b"]);
  // The returned copy does not touch the console.
  c.messages(ID).pop();
  expect(c.messages(ID)).toHaveLength(3);
});

test("3 crashes in 60 s: deactivation reminder; 3 in 61 s: no", () => {
  const calls: string[] = [];
  const c = new ConsolesExtensions({ surPlantages: (id) => calls.push(id) });
  c.plantage(ID, 0);
  c.plantage(ID, 30_000);
  expect(calls).toEqual([]);
  c.plantage(ID, 60_000);
  expect(calls).toEqual([ID]);

  const d: string[] = [];
  const c2 = new ConsolesExtensions({ surPlantages: (id) => d.push(id) });
  c2.plantage(OTHER, 0);
  c2.plantage(OTHER, 30_000);
  c2.plantage(OTHER, 61_000);
  expect(d).toEqual([]);
  // The fourth, within the minute of the last two: yes.
  c2.plantage(OTHER, 62_000);
  expect(d).toEqual([OTHER]);
});

test("after the reminder, crashes restart from zero; oublier clears console and crashes", () => {
  const calls: string[] = [];
  const c = new ConsolesExtensions({ surPlantages: (id) => calls.push(id) });
  for (const t of [0, 1, 2]) c.plantage(ID, t);
  expect(calls).toHaveLength(1);
  c.plantage(ID, 3);
  c.plantage(ID, 4);
  expect(calls).toHaveLength(1);
  c.noter(ID, { horodatage: 1, niveau: "error", texte: "x" });
  c.oublier(ID);
  expect(c.messages(ID)).toEqual([]);
  c.plantage(ID, 5);
  expect(calls).toHaveLength(1);
});

// ——— Task 17: the console filtered for the agent ———

const fresh = () => new ConsolesExtensions({ surPlantages: () => {} });
const without = { debloquee: false, tourneIllisible: false, observateur: false };

test("for the agent: a readable tab message is kept, an unreadable one is hidden and counted", () => {
  const c = fresh();
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "log", texte: "onglet partagé" }, { lisible: true });
  c.noter(ID, { horodatage: 3, niveau: "error", texte: "secret" }, { lisible: false });
  c.noter(ID, { horodatage: 4, niveau: "log", texte: "secret 2" }, { lisible: false });
  const r = c.pourAgent(ID, without);
  expect(r.messages.map((m) => m.texte)).toEqual(["fond", "onglet partagé"]);
  expect(r).toMatchObject({ masques: 2, fondMasque: false, fondObserve: false, debloquee: false });
  expect(c.pourAgent(ID, { ...without, depuis: 4 })).toMatchObject({ messages: [], masques: 1 });
  expect(c.erreursPourAgent(ID, without)).toEqual([]);
  expect(c.erreurs(ID)).toEqual(["secret"]);
  expect(c.messages(ID)).toHaveLength(4);
});

test("for the agent: ran in an unreadable tab (registry flag) → service worker and pages hidden, the whole history", () => {
  const c = fresh();
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "avant" });
  c.noter(ID, { horodatage: 2, niveau: "error", texte: "lu dans l'onglet" });
  c.noter(ID, { horodatage: 3, niveau: "log", texte: "partagé" }, { lisible: true });
  const r = c.pourAgent(ID, { ...without, tourneIllisible: true });
  expect(r.fondMasque).toBe(true);
  expect(r.messages.map((m) => m.texte)).toEqual(["partagé"]);
  expect(c.erreursPourAgent(ID, { ...without, tourneIllisible: true })).toEqual([]);
});

test("for the agent: with a right that observes (decided at read time), service worker and pages always hidden, even without a message; readable tabs pass", () => {
  const c = fresh();
  // No message: the reason is still given (the agent knows why it will see nothing).
  expect(c.pourAgent(ID, { ...without, observateur: true })).toMatchObject({ messages: [], fondObserve: true, fondMasque: false });
  c.noter(ID, { horodatage: 1, niveau: "log", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "error", texte: "fond erreur" });
  c.noter(ID, { horodatage: 3, niveau: "log", texte: "partagé" }, { lisible: true });
  const r = c.pourAgent(ID, { ...without, observateur: true });
  expect(r.messages.map((m) => m.texte)).toEqual(["partagé"]);
  expect(r).toMatchObject({ fondObserve: true, fondMasque: false });
  expect(c.erreursPourAgent(ID, { ...without, observateur: true })).toEqual([]);
  // The same history, read without the right: everything passes (nothing is decided at write time).
  expect(c.pourAgent(ID, without).messages.map((m) => m.texte)).toEqual(["fond", "fond erreur", "partagé"]);
});

test("unlocked: nothing is hidden nor counted", () => {
  const c = fresh();
  c.noter(ID, { horodatage: 1, niveau: "error", texte: "fond" });
  c.noter(ID, { horodatage: 2, niveau: "log", texte: "caché" }, { lisible: false });
  const r = c.pourAgent(ID, { debloquee: true, tourneIllisible: true, observateur: true });
  expect(r).toMatchObject({ masques: 0, fondMasque: false, fondObserve: false, debloquee: true });
  expect(r.messages.map((m) => m.texte)).toEqual(["fond", "caché"]);
  expect(c.erreursPourAgent(ID, { debloquee: true, tourneIllisible: true, observateur: true })).toEqual(["fond"]);
  expect(Object.keys(r.messages[1]!).sort()).toEqual(["horodatage", "niveau", "texte"]);
});
