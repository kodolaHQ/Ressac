import { expect, test } from "vitest";
import type { DirectWidget, Execution } from "@ressac/kernel";
import { badgesOf } from "../../ui/builder/badges";

const trace = (id: string, status: string, items: number | null) => ({ id, type: "code", status: status, start: null, end: null, items: items, log: [] });
const exec = { version: 1, id: "e", owner: { type: "widget", id: "w" }, trigger: "manual", start: "d", end: null, status: "succeeded", blocks: [trace("a", "succeeded", 3), trace("b", "not-run", null)] } as unknown as Execution;

test("badgesOf: the live replaces the status of the chosen run for the blocks in progress", () => {
  const direct: DirectWidget = { widget: "w", kind: "execution", start: "d", blocks: { b: { status: "running", items: null } } };
  expect(badgesOf(exec, direct)).toEqual({ a: { status: "succeeded", items: 3 }, b: { status: "running", items: null } });
});
test("badgesOf: without live or without a run", () => {
  expect(badgesOf(exec, null).a).toEqual({ status: "succeeded", items: 3 });
  expect(badgesOf(null, null)).toEqual({});
  expect(badgesOf(null, { widget: "w", kind: "attempt", start: "d", blocks: { x: { status: "succeeded", items: 1 } } })).toEqual({ x: { status: "succeeded", items: 1 } });
});
