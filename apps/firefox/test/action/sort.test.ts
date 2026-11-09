import { ACTION_UNKNOWN as ACTION_INCONNUE_NOYAU, NO_RESULT as AUCUN_RESULTAT_NOYAU, FALLBACK_MENTION as MENTION_SECOURS_NOYAU } from "@webaios/kernel";
import { expect, test } from "vitest";
import { ACTION_UNKNOWN, NO_RESULT, FALLBACK_MENTION } from "../../shared/actions";
import { sortLines } from "../../ui/action/sort";

const lignes = (...v: string[]) => v.map((x) => ({ c: x }));
const values = (l: Record<string, string>[]) => l.map((x) => x.c);

test("« 10 » after « 9 »", () => {
  expect(values(sortLines(lignes("10", "9", "100"), "c", "asc"))).toEqual(["9", "10", "100"]);
  // Numbers displayed in fr-FR (narrow no-break space for thousands, decimal comma).
  expect(values(sortLines(lignes("1 200", "950", "2,5"), "c", "asc"))).toEqual(["2,5", "950", "1 200"]);
  expect(values(sortLines(lignes("9", "10"), "c", "desc"))).toEqual(["10", "9"]);
});

test("« école » between « abri » and « zèbre »", () => {
  expect(values(sortLines(lignes("zèbre", "école", "abri"), "c", "asc"))).toEqual(["abri", "école", "zèbre"]);
});

test("empties at the end in both directions", () => {
  expect(values(sortLines(lignes("", "b", "a", ""), "c", "asc"))).toEqual(["a", "b", "", ""]);
  expect(values(sortLines(lignes("", "b", "a", ""), "c", "desc"))).toEqual(["b", "a", "", ""]);
  // A field missing from the row counts as empty.
  expect(sortLines([{}, { c: "x" }], "c", "asc")).toEqual([{ c: "x" }, {}]);
});

test("does not modify the given list", () => {
  const l = lignes("b", "a");
  sortLines(l, "c", "asc");
  expect(values(l)).toEqual(["b", "a"]);
});

test("the page's messages are the kernel's", () => {
  expect(FALLBACK_MENTION).toBe(MENTION_SECOURS_NOYAU);
  expect(ACTION_UNKNOWN).toBe(ACTION_INCONNUE_NOYAU);
  expect(NO_RESULT).toBe(AUCUN_RESULTAT_NOYAU);
});
