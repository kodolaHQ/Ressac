import { describe, expect, test } from "vitest";
import { parserDiff, newPosition } from "../../src/review/diff.js";

const patch = [
  "diff --git a/f.txt b/f.txt",
  "index 111..222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -10,2 +10,3 @@ fonction",
  " x",
  "+y",
  " z",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parserDiff", () => {
  test("two-block patch: starts, counts, marks and old/new numbers of each line", () => {
    const blocks = parserDiff(patch);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ ancienDebut: 1, ancienNombre: 3, nouveauDebut: 1, nouveauNombre: 3 });
    expect(blocks[0]!.lignes).toEqual([
      { marque: " ", texte: "a", ancien: 1, nouveau: 1 },
      { marque: "-", texte: "b", ancien: 2, nouveau: null },
      { marque: "+", texte: "B", ancien: null, nouveau: 2 },
      { marque: " ", texte: "c", ancien: 3, nouveau: 3 },
    ]);
    expect(blocks[1]).toMatchObject({ ancienDebut: 10, ancienNombre: 2, nouveauDebut: 10, nouveauNombre: 3 });
    expect(blocks[1]!.lignes.map((l) => [l.marque, l.ancien, l.nouveau])).toEqual([[" ", 10, 10], ["+", null, 11], [" ", 11, 12]]);
  });
  test("a « \\ No newline at end of file » line is not a line", () => {
    expect(parserDiff(patch)[1]!.lignes).toHaveLength(3);
  });
  test("header without a count: « @@ -5 +5,0 @@ »", () => {
    const b = parserDiff("@@ -5 +4,0 @@\n-x\n")[0]!;
    expect(b).toMatchObject({ ancienDebut: 5, ancienNombre: 1, nouveauDebut: 4, nouveauNombre: 0 });
  });
  test("positionNouvelle of a deleted line = number of the new line that follows", () => {
    const b = parserDiff(patch)[0]!;
    expect(newPosition(b, 1)).toBe(2);
    expect(newPosition(b, 2)).toBe(2);
    expect(newPosition(parserDiff("@@ -1,2 +1,1 @@\n a\n-b\n")[0]!, 1)).toBe(2);
  });
});
