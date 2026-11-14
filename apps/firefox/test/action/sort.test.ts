import { NO_RESULT as KERNEL_NO_RESULT, FALLBACK_MENTION as KERNEL_FALLBACK_MENTION } from "@ressac/kernel";
import { expect, test } from "vitest";
import { NO_RESULT, FALLBACK_MENTION } from "../../shared/actions";
import { sortLines } from "../../ui/action/sort";

const lines = (...v: string[]) => v.map((x) => ({ c: x }));
const values = (l: Record<string, string>[]) => l.map((x) => x.c);

test("« 10 » after « 9 »", () => {
  expect(values(sortLines(lines("10", "9", "100"), "c", "asc"))).toEqual(["9", "10", "100"]);
  // Numbers displayed in fr-FR (narrow no-break space for thousands, decimal comma).
  expect(values(sortLines(lines("1 200", "950", "2,5"), "c", "asc"))).toEqual(["2,5", "950", "1 200"]);
  expect(values(sortLines(lines("9", "10"), "c", "desc"))).toEqual(["10", "9"]);
});

test("« école » between « abri » and « zèbre »", () => {
  expect(values(sortLines(lines("zèbre", "école", "abri"), "c", "asc"))).toEqual(["abri", "école", "zèbre"]);
});

test("empties at the end in both directions", () => {
  expect(values(sortLines(lines("", "b", "a", ""), "c", "asc"))).toEqual(["a", "b", "", ""]);
  expect(values(sortLines(lines("", "b", "a", ""), "c", "desc"))).toEqual(["b", "a", "", ""]);
  // A field missing from the row counts as empty.
  expect(sortLines([{}, { c: "x" }], "c", "asc")).toEqual([{ c: "x" }, {}]);
});

test("does not modify the given list", () => {
  const l = lines("b", "a");
  sortLines(l, "c", "asc");
  expect(values(l)).toEqual(["b", "a"]);
});

test("the page's messages are the kernel's", () => {
  expect(FALLBACK_MENTION).toBe(KERNEL_FALLBACK_MENTION);
  expect(NO_RESULT).toBe(KERNEL_NO_RESULT);
});
