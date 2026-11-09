import { expect, test } from "vitest";
import { champsDisponibles } from "../../ui/constructeur/champs";

test("champsDisponibles of a list of articles: titre, url, …, config.interets", () => {
  expect(champsDisponibles([{ titre: "t", url: "u", date: "d" }, { autre: 1 }], { interets: "ia" })).toEqual(["titre", "url", "date", "config.interets"]);
});
test("champsDisponibles of an object, an empty list, a simple value", () => {
  expect(champsDisponibles({ a: { b: 1 } }, null)).toEqual(["a"]);
  expect(champsDisponibles([], { k: 1 })).toEqual(["config.k"]);
  expect(champsDisponibles("texte", undefined)).toEqual([]);
});
test("champsDisponibles: 50 at most", () => {
  const o = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`c${i}`, i]));
  expect(champsDisponibles(o, { x: 1 })).toHaveLength(50);
});
