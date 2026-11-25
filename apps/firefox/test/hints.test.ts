import { expect, test } from "vitest";
import { shortcutLabel } from "../shared/shortcuts";
import { HINT_IDS, TIPS, nextTip } from "../shared/hints";

test("nextTip walks the tips in order, then returns null", () => {
  expect(nextTip([])?.id).toBe("ctrl-tab");
  expect(nextTip(["ctrl-tab"])?.id).toBe("cmd-t");
  expect(nextTip(TIPS.map((t) => t.id))).toBeNull();
});

test("a tip's keys come from the action's binding, not from a literal", () => {
  expect(TIPS.filter((t) => t.shortcut).map((t) => [t.id, t.shortcut])).toEqual([["cmd-t", "command"], ["cmd-l", "address"], ["cmd-j", "agent"]]);
  expect(TIPS.filter((t) => t.shortcut).every((t) => !t.keys)).toBe(true);
  expect(shortcutLabel("agent", { shortcuts: {} })).toBe("⌘J");
  expect(shortcutLabel("agent", { shortcuts: { agent: { key: "k", shift: false, alt: false, ctrl: false, meta: true } } })).toBe("⌘K");
});

test("HINT_IDS holds every tip and first-time id, no duplicate", () => {
  expect(HINT_IDS).toHaveLength(9);
  expect(new Set(HINT_IDS).size).toBe(9);
});
