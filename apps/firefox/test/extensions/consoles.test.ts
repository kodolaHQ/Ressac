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
  const c = new ConsolesExtensions({ onCrashes: () => {} });
  for (let i = 0; i < 501; i++) c.note(ID, { timestamp: i, level: "log", text: `m${i}` });
  const m = c.messages(ID);
  expect(m).toHaveLength(500);
  expect(m[0]!.text).toBe("m1");
  expect(m[499]!.text).toBe("m500");
  // Another extension has its own console.
  expect(c.messages(OTHER)).toEqual([]);
});

test("messages since a timestamp; errors: only the error-level texts", () => {
  const c = new ConsolesExtensions({ onCrashes: () => {} });
  c.note(ID, { timestamp: 10, level: "log", text: "a" });
  c.note(ID, { timestamp: 20, level: "error", text: "b" });
  c.note(ID, { timestamp: 30, level: "warn", text: "c" });
  expect(c.messages(ID, 20).map((m) => m.text)).toEqual(["b", "c"]);
  expect(c.errors(ID)).toEqual(["b"]);
  // The returned copy does not touch the console.
  c.messages(ID).pop();
  expect(c.messages(ID)).toHaveLength(3);
});

test("3 crashes in 60 s: deactivation reminder; 3 in 61 s: no", () => {
  const calls: string[] = [];
  const c = new ConsolesExtensions({ onCrashes: (id) => calls.push(id) });
  c.crash(ID, 0);
  c.crash(ID, 30_000);
  expect(calls).toEqual([]);
  c.crash(ID, 60_000);
  expect(calls).toEqual([ID]);

  const d: string[] = [];
  const c2 = new ConsolesExtensions({ onCrashes: (id) => d.push(id) });
  c2.crash(OTHER, 0);
  c2.crash(OTHER, 30_000);
  c2.crash(OTHER, 61_000);
  expect(d).toEqual([]);
  // The fourth, within the minute of the last two: yes.
  c2.crash(OTHER, 62_000);
  expect(d).toEqual([OTHER]);
});

test("after the reminder, crashes restart from zero; oublier clears console and crashes", () => {
  const calls: string[] = [];
  const c = new ConsolesExtensions({ onCrashes: (id) => calls.push(id) });
  for (const t of [0, 1, 2]) c.crash(ID, t);
  expect(calls).toHaveLength(1);
  c.crash(ID, 3);
  c.crash(ID, 4);
  expect(calls).toHaveLength(1);
  c.note(ID, { timestamp: 1, level: "error", text: "x" });
  c.forget(ID);
  expect(c.messages(ID)).toEqual([]);
  c.crash(ID, 5);
  expect(calls).toHaveLength(1);
});

// ——— Task 17: the console filtered for the agent ———

const fresh = () => new ConsolesExtensions({ onCrashes: () => {} });
const without = { unlocked: false, unreadableRunning: false, observer: false };

test("for the agent: a readable tab message is kept, an unreadable one is hidden and counted", () => {
  const c = fresh();
  c.note(ID, { timestamp: 1, level: "log", text: "fond" });
  c.note(ID, { timestamp: 2, level: "log", text: "onglet partagé" }, { readable: true });
  c.note(ID, { timestamp: 3, level: "error", text: "secret" }, { readable: false });
  c.note(ID, { timestamp: 4, level: "log", text: "secret 2" }, { readable: false });
  const r = c.forAgent(ID, without);
  expect(r.messages.map((m) => m.text)).toEqual(["fond", "onglet partagé"]);
  expect(r).toMatchObject({ hidden: 2, hiddenBackground: false, observedBackground: false, unlocked: false });
  expect(c.forAgent(ID, { ...without, since: 4 })).toMatchObject({ messages: [], hidden: 1 });
  expect(c.errorsForAgent(ID, without)).toEqual([]);
  expect(c.errors(ID)).toEqual(["secret"]);
  expect(c.messages(ID)).toHaveLength(4);
});

test("for the agent: ran in an unreadable tab (registry flag) → service worker and pages hidden, the whole history", () => {
  const c = fresh();
  c.note(ID, { timestamp: 1, level: "log", text: "avant" });
  c.note(ID, { timestamp: 2, level: "error", text: "lu dans l'onglet" });
  c.note(ID, { timestamp: 3, level: "log", text: "partagé" }, { readable: true });
  const r = c.forAgent(ID, { ...without, unreadableRunning: true });
  expect(r.hiddenBackground).toBe(true);
  expect(r.messages.map((m) => m.text)).toEqual(["partagé"]);
  expect(c.errorsForAgent(ID, { ...without, unreadableRunning: true })).toEqual([]);
});

test("for the agent: with a right that observes (decided at read time), service worker and pages always hidden, even without a message; readable tabs pass", () => {
  const c = fresh();
  // No message: the reason is still given (the agent knows why it will see nothing).
  expect(c.forAgent(ID, { ...without, observer: true })).toMatchObject({ messages: [], observedBackground: true, hiddenBackground: false });
  c.note(ID, { timestamp: 1, level: "log", text: "fond" });
  c.note(ID, { timestamp: 2, level: "error", text: "fond erreur" });
  c.note(ID, { timestamp: 3, level: "log", text: "partagé" }, { readable: true });
  const r = c.forAgent(ID, { ...without, observer: true });
  expect(r.messages.map((m) => m.text)).toEqual(["partagé"]);
  expect(r).toMatchObject({ observedBackground: true, hiddenBackground: false });
  expect(c.errorsForAgent(ID, { ...without, observer: true })).toEqual([]);
  // The same history, read without the right: everything passes (nothing is decided at write time).
  expect(c.forAgent(ID, without).messages.map((m) => m.text)).toEqual(["fond", "fond erreur", "partagé"]);
});

test("unlocked: nothing is hidden nor counted", () => {
  const c = fresh();
  c.note(ID, { timestamp: 1, level: "error", text: "fond" });
  c.note(ID, { timestamp: 2, level: "log", text: "caché" }, { readable: false });
  const r = c.forAgent(ID, { unlocked: true, unreadableRunning: true, observer: true });
  expect(r).toMatchObject({ hidden: 0, hiddenBackground: false, observedBackground: false, unlocked: true });
  expect(r.messages.map((m) => m.text)).toEqual(["fond", "caché"]);
  expect(c.errorsForAgent(ID, { unlocked: true, unreadableRunning: true, observer: true })).toEqual(["fond"]);
  expect(Object.keys(r.messages[1]!).sort()).toEqual(["horodatage", "niveau", "texte"]);
});
