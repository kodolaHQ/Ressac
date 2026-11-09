import { expect, test } from "vitest";
import type { Draft } from "../../ui/builder/draft";
import { COLUMN_PX, arrange, shownPositions, ROW_PX, withoutLayout } from "../../ui/builder/layout";

const block = (id: string, x = 0, y = 0, type = "code") => ({ id, type, position: { x, y }, parametres: {} });
const link = (from: string, to: string) => ({ de: from, vers: to });

const news = (): Draft => ({
  version: 1,
  blocs: ["flux", "uniques", "tri", "top", "a-resumer", "pages", "resumes", "articles", "sortie"].map((id) => block(id)),
  liens: [link("flux", "uniques"), link("uniques", "tri"), link("tri", "top"), link("top", "a-resumer"), link("a-resumer", "pages"), link("pages", "resumes"), link("top", "articles"), link("resumes", "articles"), link("articles", "sortie")],
});

test("disposer: news in columns (flux 0, uniques 1, …, articles 7, sortie 8)", () => {
  const p = arrange(news());
  expect(p.flux).toEqual({ x: 0, y: 0 });
  expect(p.uniques!.x).toBe(COLUMN_PX);
  expect(p.articles!.x).toBe(7 * COLUMN_PX);
  expect(p.sortie!.x).toBe(8 * COLUMN_PX);
});

test("disposer: longest path and rows in array order", () => {
  const b: Draft = { version: 1, blocs: [block("a"), block("b"), block("c"), block("d")], liens: [link("a", "b"), link("b", "d"), link("a", "d"), link("c", "d")] };
  const p = arrange(b);
  expect(p.d!.x).toBe(2 * COLUMN_PX);
  expect(p.c).toEqual({ x: 0, y: ROW_PX });
});

test("no pair of blocks at the same position for 30 blocks", () => {
  const blocks = Array.from({ length: 30 }, (_, i) => block(`b${i}`));
  const liens = Array.from({ length: 29 }, (_, i) => link(`b${i}`, `b${i + 1}`)).filter((_, i) => i % 3 !== 0);
  const p = arrange({ version: 1, blocs: blocks, liens });
  expect(new Set(Object.values(p).map((q) => `${q.x},${q.y}`)).size).toBe(30);
});

test("a cycle does not loop", () => {
  const b: Draft = { version: 1, blocs: [block("a"), block("b"), block("c")], liens: [link("a", "b"), link("b", "c"), link("c", "a")] };
  const p = arrange(b);
  expect(Object.keys(p)).toHaveLength(3);
  expect(p.a!.x).toBe(0);
  expect(p.c!.x).toBe(2 * COLUMN_PX);
  expect(arrange({ version: 1, blocs: [block("a")], liens: [link("a", "a")] }).a).toEqual({ x: 0, y: 0 });
});

test("withoutLayout: at least two blocks, all in the same place", () => {
  expect(withoutLayout({ version: 1, blocs: [block("a")], liens: [] })).toBe(false);
  expect(withoutLayout({ version: 1, blocs: [block("a"), block("b")], liens: [] })).toBe(true);
  expect(withoutLayout({ version: 1, blocs: [block("a"), block("b", 5, 0)], liens: [] })).toBe(false);
});

test("shownPositions keeps the place of an already displayed block when the file changes", () => {
  const b: Draft = { version: 1, blocs: [block("a"), block("b"), block("c")], liens: [link("a", "b"), link("b", "c")] };
  const p = shownPositions(b, { a: { x: 500, y: 40 } });
  expect(p.a).toEqual({ x: 500, y: 40 });
  expect(p.b).toEqual({ x: COLUMN_PX, y: 0 });
});

test("an already placed workflow keeps its positions", () => {
  const b: Draft = { version: 1, blocs: [block("a", 10, 20), block("b", 300, 40)], liens: [link("a", "b")] };
  expect(shownPositions(b, null)).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
  expect(shownPositions(b, { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } })).toEqual({ a: { x: 10, y: 20 }, b: { x: 300, y: 40 } });
});

test("a new block at {0,0} among placed blocks is placed under its column", () => {
  const b: Draft = { version: 1, blocs: [block("a", 0, 0), block("b", COLUMN_PX, 30), block("n")], liens: [link("a", "b"), link("a", "n")] };
  const p = shownPositions(b, { a: { x: 0, y: 0 }, b: { x: COLUMN_PX, y: 30 } });
  expect(p.n).toEqual({ x: COLUMN_PX, y: 30 + ROW_PX });
  expect(p.b).toEqual({ x: COLUMN_PX, y: 30 });
});
