import { expect, test } from "vitest";
import type { DirectWidget, Execution } from "@webaios/kernel";
import { badgesOf } from "../../ui/builder/badges";

const trace = (id: string, status: string, items: number | null) => ({ id, type: "code", status: status, start: null, end: null, elements: items, log: [] });
const exec = { version: 1, id: "e", owner: { type: "widget", id: "w" }, trigger: "manuelle", start: "d", end: null, status: "reussie", blocks: [trace("a", "reussi", 3), trace("b", "pas-lance", null)] } as unknown as Execution;

test("badgesOf: the live replaces the status of the chosen run for the blocks in progress", () => {
  const direct: DirectWidget = { widget: "w", kind: "execution", start: "d", blocks: { b: { status: "en-cours", items: null } } };
  expect(badgesOf(exec, direct)).toEqual({ a: { status: "reussi", items: 3 }, b: { status: "en-cours", items: null } });
});
test("badgesOf: without live or without a run", () => {
  expect(badgesOf(exec, null).a).toEqual({ status: "reussi", items: 3 });
  expect(badgesOf(null, null)).toEqual({});
  expect(badgesOf(null, { widget: "w", kind: "essai", start: "d", blocks: { x: { status: "reussi", items: 1 } } })).toEqual({ x: { status: "reussi", items: 1 } });
});
