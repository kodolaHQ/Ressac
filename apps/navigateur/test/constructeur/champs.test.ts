import { expect, test } from "vitest";
import { champsDisponibles } from "../../src/renderer/constructeur/champs";

test("champsDisponibles d'une liste d'articles : titre, url, …, config.interets", () => {
  expect(champsDisponibles([{ titre: "t", url: "u", date: "d" }, { autre: 1 }], { interets: "ia" })).toEqual(["titre", "url", "date", "config.interets"]);
});
test("champsDisponibles d'un objet, d'une liste vide, d'une valeur simple", () => {
  expect(champsDisponibles({ a: { b: 1 } }, null)).toEqual(["a"]);
  expect(champsDisponibles([], { k: 1 })).toEqual(["config.k"]);
  expect(champsDisponibles("texte", undefined)).toEqual([]);
});
test("champsDisponibles : 50 au plus", () => {
  const o = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`c${i}`, i]));
  expect(champsDisponibles(o, { x: 1 })).toHaveLength(50);
});
