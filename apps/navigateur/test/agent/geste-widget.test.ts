import { expect, test } from "vitest";
import { DELAI_GESTE_MS, gardienGestes } from "../../src/main/agent/geste-widget";

function horloge() {
  const h = { t: 10_000, maintenant: () => h.t };
  return h;
}

test("sans geste réel, aucun lien (chargement, minuterie, focus forcé)", () => {
  const g = gardienGestes(horloge().maintenant);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("un geste réel dans le widget permet un lien, un seul", () => {
  const h = horloge();
  const g = gardienGestes(h.maintenant);
  g.geste("f1", "meteo");
  h.t += 400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("un autre widget ne profite pas du geste, et ne l'use pas", () => {
  const g = gardienGestes(horloge().maintenant);
  g.geste("f1", "meteo");
  expect(g.accepter("f1", "actus")).toBe(false);
  expect(g.accepter("f1", "meteo")).toBe(true);
});

test("le geste d'une autre fenêtre ne compte pas", () => {
  const g = gardienGestes(horloge().maintenant);
  g.geste("f2", "meteo");
  expect(g.accepter("f1", "meteo")).toBe(false);
  expect(g.accepter("f2", "meteo")).toBe(true);
});

test("le geste expire après le délai (appui long compris jusqu'à 1,5 s)", () => {
  const h = horloge();
  const g = gardienGestes(h.maintenant);
  expect(DELAI_GESTE_MS).toBe(1500);
  g.geste("f1", "meteo");
  h.t += 1400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  g.geste("f1", "meteo");
  h.t += 1600;
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("seul le dernier geste de la fenêtre compte", () => {
  const g = gardienGestes(horloge().maintenant);
  g.geste("f1", "meteo");
  g.geste("f1", "actus");
  expect(g.accepter("f1", "meteo")).toBe(false);
  expect(g.accepter("f1", "actus")).toBe(true);
});
