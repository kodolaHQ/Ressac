import { expect, test } from "vitest";
import { COLUMNS, move, GAP_PX, ROW_PX, resize, type Placement } from "../ui/grille";

const p = (id: string, x: number, y: number, l: number, h: number): Placement => ({ id, x, y, l, h });
const tailles = { min: { l: 2, h: 2 }, max: { l: 6, h: 4 } };
const chevauchent = (a: Placement, b: Placement) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;
function sansChevauchement(ps: Placement[]) {
  for (const a of ps) for (const b of ps) if (a !== b) expect(chevauchent(a, b), `${a.id} / ${b.id}`).toBe(false);
}

test("grid constants", () => {
  expect([COLUMNS, ROW_PX, GAP_PX]).toEqual([12, 90, 12]);
});

test("deplacer pushes overlapped widgets down, in a cascade", () => {
  const avant = [p("a", 0, 0, 4, 2), p("b", 4, 0, 4, 2), p("c", 4, 2, 4, 3), p("d", 0, 6, 2, 1)];
  const apres = move(avant, "a", 4, 0);
  const par = Object.fromEntries(apres.map((q) => [q.id, q]));
  expect(par.a).toEqual(p("a", 4, 0, 4, 2));
  expect(par.b).toEqual(p("b", 4, 2, 4, 2)); // juste sous a
  expect(par.c).toEqual(p("c", 4, 4, 4, 3)); // just under b, in a cascade
  expect(par.d).toEqual(p("d", 0, 6, 2, 1)); // not touched
  sansChevauchement(apres);
  expect(avant[0]).toEqual(p("a", 0, 0, 4, 2)); // the input is not modified
});

test("deplacer keeps the widget within the 12 columns and above 0", () => {
  const apres = move([p("a", 0, 0, 4, 2)], "a", 10, -3);
  expect(apres[0]).toEqual(p("a", 8, 0, 4, 2));
});

test("deplacer: an unknown id changes nothing", () => {
  const avant = [p("a", 0, 0, 4, 2)];
  expect(move(avant, "x", 3, 3)).toEqual(avant);
});

test("redimensionner clamps by min and max and does not overflow the 12 columns", () => {
  expect(resize([p("a", 0, 0, 4, 2)], "a", 1, 1, tailles)[0]).toEqual(p("a", 0, 0, 2, 2));
  expect(resize([p("a", 0, 0, 4, 2)], "a", 20, 20, tailles)[0]).toEqual(p("a", 0, 0, 6, 4));
  // Against the right edge: the width stops at the last column.
  expect(resize([p("a", 8, 0, 4, 2)], "a", 6, 2, tailles)[0]).toEqual(p("a", 8, 0, 4, 2));
  // The minimum does not fit before the edge: the widget steps back.
  expect(resize([p("a", 11, 0, 1, 2)], "a", 1, 2, tailles)[0]).toEqual(p("a", 10, 0, 2, 2));
});

test("redimensionner pushes overlapped widgets", () => {
  const apres = resize([p("a", 0, 0, 4, 2), p("b", 0, 2, 4, 2)], "a", 4, 4, tailles);
  expect(apres.find((q) => q.id === "b")).toEqual(p("b", 0, 4, 4, 2));
  sansChevauchement(apres);
});

test("a widget wider than the grid stays within the 12 columns", () => {
  expect(move([p("a", 0, 0, 14, 2)], "a", 3, 0)[0]).toMatchObject({ x: 0 });
  const large = { min: { l: 14, h: 2 }, max: { l: 14, h: 2 } };
  expect(resize([p("a", 5, 0, 4, 2)], "a", 4, 2, large)[0]).toEqual(p("a", 0, 0, 12, 2));
  // Inconsistent bounds (min > max): the minimum wins.
  const incoherent = { min: { l: 2, h: 5 }, max: { l: 6, h: 3 } };
  expect(resize([p("a", 0, 0, 4, 2)], "a", 4, 2, incoherent)[0]).toEqual(p("a", 0, 0, 4, 5));
});
