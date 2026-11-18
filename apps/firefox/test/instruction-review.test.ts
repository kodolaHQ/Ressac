import { expect, test } from "vitest";
import { foldLines, shownPath } from "../ui/components/instructionReview";

const same = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ kind: " " as const, text: `l${from + i}` }));

test("foldLines keeps 3 lines around each change and counts the unchanged runs between", () => {
  const lines = [...same(10), { kind: "+" as const, text: "new" }, ...same(10, 10)];
  expect(foldLines(lines)).toEqual([{ folded: 7 }, ...same(3, 7), { kind: "+", text: "new" }, ...same(3, 10), { folded: 7 }]);
  // Two changes close together share their context: nothing folds between them.
  const close = [{ kind: "-" as const, text: "a" }, ...same(5), { kind: "+" as const, text: "b" }];
  expect(foldLines(close)).toEqual(close);
});

test("shownPath drops /workspace/ and shows the home as ~/", () => {
  expect(shownPath("/workspace/AGENTS.md")).toBe("AGENTS.md");
  expect(shownPath("/home/node/.claude/CLAUDE.md")).toBe("~/.claude/CLAUDE.md");
  expect(shownPath("/etc/x")).toBe("/etc/x");
});
