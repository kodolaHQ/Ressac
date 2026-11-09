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
    expect(blocks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 });
    expect(blocks[0]!.lines).toEqual([
      { mark: " ", text: "a", old: 1, new: 1 },
      { mark: "-", text: "b", old: 2, new: null },
      { mark: "+", text: "B", old: null, new: 2 },
      { mark: " ", text: "c", old: 3, new: 3 },
    ]);
    expect(blocks[1]).toMatchObject({ oldStart: 10, oldCount: 2, newStart: 10, newCount: 3 });
    expect(blocks[1]!.lines.map((l) => [l.mark, l.old, l.new])).toEqual([[" ", 10, 10], ["+", null, 11], [" ", 11, 12]]);
  });
  test("a « \\ No newline at end of file » line is not a line", () => {
    expect(parserDiff(patch)[1]!.lines).toHaveLength(3);
  });
  test("header without a count: « @@ -5 +5,0 @@ »", () => {
    const b = parserDiff("@@ -5 +4,0 @@\n-x\n")[0]!;
    expect(b).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 4, newCount: 0 });
  });
  test("newPosition of a deleted line = number of the new line that follows", () => {
    const b = parserDiff(patch)[0]!;
    expect(newPosition(b, 1)).toBe(2);
    expect(newPosition(b, 2)).toBe(2);
    expect(newPosition(parserDiff("@@ -1,2 +1,1 @@\n a\n-b\n")[0]!, 1)).toBe(2);
  });
});
