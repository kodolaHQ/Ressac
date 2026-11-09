import { expect, test } from "vitest";
import { availableFields } from "../../ui/constructeur/champs";

test("champsDisponibles of a list of articles: titre, url, …, config.interets", () => {
  expect(availableFields([{ titre: "t", url: "u", date: "d" }, { autre: 1 }], { interets: "ia" })).toEqual(["titre", "url", "date", "config.interets"]);
});
test("champsDisponibles of an object, an empty list, a simple value", () => {
  expect(availableFields({ a: { b: 1 } }, null)).toEqual(["a"]);
  expect(availableFields([], { k: 1 })).toEqual(["config.k"]);
  expect(availableFields("texte", undefined)).toEqual([]);
});
test("champsDisponibles: 50 at most", () => {
  const o = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`c${i}`, i]));
  expect(availableFields(o, { x: 1 })).toHaveLength(50);
});
