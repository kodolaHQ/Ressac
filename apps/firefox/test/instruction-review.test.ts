import { expect, test } from "vitest";
import { fileName, foldLines, shownPath } from "../ui/components/instructionReview";

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

test("fileName gives each watched file a plain name, the skill its folder name", () => {
  expect(fileName("/workspace/AGENTS.md")).toEqual({ id: "agent-review-name-instructions" });
  expect(fileName("/workspace/AGENTS.override.md")).toEqual({ id: "agent-review-name-override" });
  expect(fileName("/workspace/guides/widgets.md")).toEqual({ id: "agent-review-name-guide" });
  expect(fileName("/home/node/.codex/AGENTS.md")).toEqual({ id: "agent-review-name-codex-instructions" });
  expect(fileName("/home/node/.codex/config.toml")).toEqual({ id: "agent-review-name-codex-config" });
  expect(fileName("/workspace/.codex/config.toml")).toEqual({ id: "agent-review-name-codex-config" });
  expect(fileName("/home/node/.codex/skills/pdf/scripts/run.py")).toEqual({ id: "agent-review-name-skill", args: { name: "pdf" } });
  expect(fileName("/home/node/.codex/skills/.system/imagegen/SKILL.md")).toEqual({ id: "agent-review-name-skill", args: { name: "imagegen" } });
  expect(fileName("/workspace/.agents/skills")).toEqual({ id: "agent-review-name-skills" });
  expect(fileName("/workspace/.codex/hooks.json")).toEqual({ id: "agent-review-name-other" });
});
