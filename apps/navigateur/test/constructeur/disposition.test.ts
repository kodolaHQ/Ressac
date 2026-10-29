import { expect, test } from "vitest";
import type { Brouillon } from "../../src/renderer/constructeur/brouillon";
import { COLONNE_PX, disposer, positionsAffichees, RANGEE_PX, sansDisposition } from "../../src/renderer/constructeur/disposition";

const bloc = (id: string, x = 0, y = 0, type = "code") => ({ id, type, position: { x, y }, parametres: {} });
const lien = (de: string, vers: string) => ({ de, vers });

const actus = (): Brouillon => ({
  version: 1,
  blocs: ["flux", "uniques", "nouveaux", "tries", "garder", "rediger", "code", "articles", "sortie"].map((id) => bloc(id)),
  liens: [lien("flux", "uniques"), lien("uniques", "nouveaux"), lien("nouveaux", "tries"), lien("tries", "garder"), lien("garder", "rediger"), lien("rediger", "code"), lien("code", "articles"), lien("articles", "sortie")],
});

test("disposer : actus en colonnes (flux 0, uniques 1, …, articles 7, sortie 8)", () => {
  const p = disposer(actus());
  expect(p.flux).toEqual({ x: 0, y: 0 });
  expect(p.uniques!.x).toBe(COLONNE_PX);
  expect(p.articles!.x).toBe(7 * COLONNE_PX);
  expect(p.sortie!.x).toBe(8 * COLONNE_PX);
});

test("disposer : plus long chemin et rangées dans l'ordre du tableau", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c"), bloc("d")], liens: [lien("a", "b"), lien("b", "d"), lien("a", "d"), lien("c", "d")] };
  const p = disposer(b);
  expect(p.d!.x).toBe(2 * COLONNE_PX);
  expect(p.c).toEqual({ x: 0, y: RANGEE_PX });
});

test("aucune paire de blocs à la même position pour 30 blocs", () => {
  const blocs = Array.from({ length: 30 }, (_, i) => bloc(`b${i}`));
  const liens = Array.from({ length: 29 }, (_, i) => lien(`b${i}`, `b${i + 1}`)).filter((_, i) => i % 3 !== 0);
  const p = disposer({ version: 1, blocs, liens });
  expect(new Set(Object.values(p).map((q) => `${q.x},${q.y}`)).size).toBe(30);
});

test("un cycle ne boucle pas", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c")], liens: [lien("a", "b"), lien("b", "c"), lien("c", "a")] };
  const p = disposer(b);
  expect(Object.keys(p)).toHaveLength(3);
  expect(p.a!.x).toBe(0);
  expect(p.c!.x).toBe(2 * COLONNE_PX);
  expect(disposer({ version: 1, blocs: [bloc("a")], liens: [lien("a", "a")] }).a).toEqual({ x: 0, y: 0 });
});

test("sansDisposition : deux blocs au moins, tous à la même place", () => {
  expect(sansDisposition({ version: 1, blocs: [bloc("a")], liens: [] })).toBe(false);
  expect(sansDisposition({ version: 1, blocs: [bloc("a"), bloc("b")], liens: [] })).toBe(true);
  expect(sansDisposition({ version: 1, blocs: [bloc("a"), bloc("b", 5, 0)], liens: [] })).toBe(false);
});

test("positionsAffichees garde la place d'un bloc déjà affiché quand le fichier change", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c")], liens: [lien("a", "b"), lien("b", "c")] };
  const p = positionsAffichees(b, { a: { x: 500, y: 40 } });
  expect(p.a).toEqual({ x: 500, y: 40 });
  expect(p.b).toEqual({ x: COLONNE_PX, y: 0 });
});

test("un workflow déjà placé garde ses positions", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a", 10, 20), bloc("b", 300, 40)], liens: [lien("a", "b")] };
  expect(positionsAffichees(b, null)).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
  expect(positionsAffichees(b, { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } })).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
});

test("un bloc nouveau à {0,0} parmi des blocs placés est placé sous sa colonne", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a", 0, 0), bloc("b", COLONNE_PX, 30), bloc("n")], liens: [lien("a", "b"), lien("a", "n")] };
  const p = positionsAffichees(b, { a: { x: 0, y: 0 }, b: { x: COLONNE_PX, y: 30 } });
  expect(p.n).toEqual({ x: COLONNE_PX, y: 30 + RANGEE_PX });
  expect(p.b).toEqual({ x: COLONNE_PX, y: 30 });
});
