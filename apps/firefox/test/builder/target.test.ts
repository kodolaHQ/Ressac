import { expect, test } from "vitest";
import { targetOfKey, targetKey, actionsDirect, isActionKey } from "../../ui/builder/target";

test("targetKey: a widget's id as is, action:<id> for an action, and back", () => {
  expect(targetKey({ type: "widget", id: "gitlab" })).toBe("gitlab");
  expect(targetKey({ type: "action", id: "gitlab" })).toBe("action:gitlab");
  expect(targetOfKey("gitlab")).toEqual({ type: "widget", id: "gitlab" });
  expect(targetOfKey("action:gitlab")).toEqual({ type: "action", id: "gitlab" });
  expect(isActionKey("action:gitlab")).toBe(true);
  expect(isActionKey("gitlab")).toBe(false);
});

test("actionsDirect: a current action becomes a run (or a trial) of its key, without its progress traces", () => {
  const d = actionsDirect({
    running: [
      {
        action: "gitlab",
        start: "2026-10-31T08:00:00.000Z",
        input: "x",
        attempt: true,
        step: "workflow",
        blocks: { read: { status: "en-cours", items: null, host: "gitlab.com", done: 1, total: 3, type: "source.page" } },
      },
    ],
    waiting: [{ action: "autre", since: "2026-10-31T08:00:00.000Z" }],
  });
  expect(d).toEqual({
    running: [{ widget: "action:gitlab", kind: "essai", start: "2026-10-31T08:00:00.000Z", blocks: { read: { status: "en-cours", items: null } } }],
    waiting: ["action:autre"],
  });
});
