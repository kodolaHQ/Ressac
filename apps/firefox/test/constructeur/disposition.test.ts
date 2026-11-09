import { expect, test } from "vitest";
import type { Brouillon } from "../../ui/constructeur/brouillon";
import { COLUMN_PX, disposer, shownPositions, ROW_PX, sansDisposition } from "../../ui/constructeur/disposition";

const bloc = (id: string, x = 0, y = 0, type = "code") => ({ id, type, position: { x, y }, parametres: {} });
const lien = (de: string, to: string) => ({ de, vers: to });

const actus = (): Brouillon => ({
  version: 1,
  blocs: ["flux", "uniques", "tri", "top", "a-resumer", "pages", "resumes", "articles", "sortie"].map((id) => bloc(id)),
  liens: [lien("flux", "uniques"), lien("uniques", "tri"), lien("tri", "top"), lien("top", "a-resumer"), lien("a-resumer", "pages"), lien("pages", "resumes"), lien("top", "articles"), lien("resumes", "articles"), lien("articles", "sortie")],
});

test("disposer: news in columns (flux 0, uniques 1, …, articles 7, sortie 8)", () => {
  const p = disposer(actus());
  expect(p.flux).toEqual({ x: 0, y: 0 });
  expect(p.uniques!.x).toBe(COLUMN_PX);
  expect(p.articles!.x).toBe(7 * COLUMN_PX);
  expect(p.sortie!.x).toBe(8 * COLUMN_PX);
});

test("disposer: longest path and rows in array order", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c"), bloc("d")], liens: [lien("a", "b"), lien("b", "d"), lien("a", "d"), lien("c", "d")] };
  const p = disposer(b);
  expect(p.d!.x).toBe(2 * COLUMN_PX);
  expect(p.c).toEqual({ x: 0, y: ROW_PX });
});

test("no pair of blocks at the same position for 30 blocks", () => {
  const blocs = Array.from({ length: 30 }, (_, i) => bloc(`b${i}`));
  const liens = Array.from({ length: 29 }, (_, i) => lien(`b${i}`, `b${i + 1}`)).filter((_, i) => i % 3 !== 0);
  const p = disposer({ version: 1, blocs, liens });
  expect(new Set(Object.values(p).map((q) => `${q.x},${q.y}`)).size).toBe(30);
});

test("a cycle does not loop", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c")], liens: [lien("a", "b"), lien("b", "c"), lien("c", "a")] };
  const p = disposer(b);
  expect(Object.keys(p)).toHaveLength(3);
  expect(p.a!.x).toBe(0);
  expect(p.c!.x).toBe(2 * COLUMN_PX);
  expect(disposer({ version: 1, blocs: [bloc("a")], liens: [lien("a", "a")] }).a).toEqual({ x: 0, y: 0 });
});

test("sansDisposition: at least two blocks, all in the same place", () => {
  expect(sansDisposition({ version: 1, blocs: [bloc("a")], liens: [] })).toBe(false);
  expect(sansDisposition({ version: 1, blocs: [bloc("a"), bloc("b")], liens: [] })).toBe(true);
  expect(sansDisposition({ version: 1, blocs: [bloc("a"), bloc("b", 5, 0)], liens: [] })).toBe(false);
});

test("positionsAffichees keeps the place of an already displayed block when the file changes", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a"), bloc("b"), bloc("c")], liens: [lien("a", "b"), lien("b", "c")] };
  const p = shownPositions(b, { a: { x: 500, y: 40 } });
  expect(p.a).toEqual({ x: 500, y: 40 });
  expect(p.b).toEqual({ x: COLUMN_PX, y: 0 });
});

test("an already placed workflow keeps its positions", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a", 10, 20), bloc("b", 300, 40)], liens: [lien("a", "b")] };
  expect(shownPositions(b, null)).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
  expect(shownPositions(b, { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } })).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
});

test("a new block at {0,0} among placed blocks is placed under its column", () => {
  const b: Brouillon = { version: 1, blocs: [bloc("a", 0, 0), bloc("b", COLUMN_PX, 30), bloc("n")], liens: [lien("a", "b"), lien("a", "n")] };
  const p = shownPositions(b, { a: { x: 0, y: 0 }, b: { x: COLUMN_PX, y: 30 } });
  expect(p.n).toEqual({ x: COLUMN_PX, y: 30 + ROW_PX });
  expect(p.b).toEqual({ x: COLUMN_PX, y: 30 });
});
