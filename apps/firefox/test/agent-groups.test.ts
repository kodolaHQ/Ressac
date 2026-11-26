import { expect, test } from "vitest";
import type { ChatSummary } from "../shared/chat";
import { agentGroups } from "../ui/components/agentGroups";

const chat = (id: string, updatedAt: number) => ({ id, title: id, engine: "claude", profile: "claude", mode: "browser", state: "ready", updatedAt, messages: 1 }) as ChatSummary;

test("the shown discussion first, then the most recent, the tabs of no known discussion last", () => {
  const owner: Record<string, string | undefined> = { t1: "old", t2: "new", t3: undefined, t4: "shown", t5: "gone", t6: "old" };
  const groups = agentGroups(["t1", "t2", "t3", "t4", "t5", "t6"], (t) => owner[t], [chat("old", 1), chat("new", 3), chat("shown", 2)], "shown");
  expect(groups.map((g) => [g.chat?.id ?? null, g.tabs])).toEqual([
    ["shown", ["t4"]],
    ["new", ["t2"]],
    ["old", ["t1", "t6"]],
    [null, ["t3", "t5"]],
  ]);
});

test("no tab of no discussion: no « Sans discussion » group; a discussion with no tab: no group", () => {
  expect(agentGroups(["t1"], () => "a", [chat("a", 1), chat("b", 2)], undefined).map((g) => g.chat?.id)).toEqual(["a"]);
  expect(agentGroups([], () => "a", [chat("a", 1)], "a")).toEqual([]);
});
