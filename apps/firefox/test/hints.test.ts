import { expect, test } from "vitest";
import { HINT_IDS, TIPS, nextTip } from "../shared/hints";

test("nextTip walks the tips in order, then returns null", () => {
  expect(nextTip([])?.id).toBe("ctrl-tab");
  expect(nextTip(["ctrl-tab"])?.id).toBe("cmd-t");
  expect(nextTip(TIPS.map((t) => t.id))).toBeNull();
});

test("HINT_IDS holds every tip and first-time id, no duplicate", () => {
  expect(HINT_IDS).toHaveLength(9);
  expect(new Set(HINT_IDS).size).toBe(9);
});
