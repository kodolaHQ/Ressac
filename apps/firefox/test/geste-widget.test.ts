import { expect, test } from "vitest";
import { DELAI_GESTE_MS, gardienGestes } from "../shared/geste-widget";

function horloge() {
  const h = { t: 10_000, maintenant: () => h.t };
  return h;
}

test("sans geste réel, aucun lien", () => {
  const g = gardienGestes<string>(horloge().maintenant);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("un geste récent et du bon widget accepte un seul lien", () => {
  const h = horloge();
  const g = gardienGestes<string>(h.maintenant);
  g.geste("f1", "meteo");
  h.t += 400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("un geste d'un autre widget refuse, et ne l'use pas", () => {
  const g = gardienGestes<string>(horloge().maintenant);
  g.geste("f1", "meteo");
  expect(g.accepter("f1", "actus")).toBe(false);
  expect(g.accepter("f1", "meteo")).toBe(true);
});

test("un geste d'une autre fenêtre ne compte pas", () => {
  const g = gardienGestes<string>(horloge().maintenant);
  g.geste("f2", "meteo");
  expect(g.accepter("f1", "meteo")).toBe(false);
  expect(g.accepter("f2", "meteo")).toBe(true);
});

test("un geste de plus de 1 500 ms refuse", () => {
  const h = horloge();
  const g = gardienGestes<string>(h.maintenant);
  expect(DELAI_GESTE_MS).toBe(1500);
  g.geste("f1", "meteo");
  h.t += 1400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  g.geste("f1", "meteo");
  h.t += 1600;
  expect(g.accepter("f1", "meteo")).toBe(false);
});
