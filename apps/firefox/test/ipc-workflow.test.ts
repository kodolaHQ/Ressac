import { expect, test } from "vitest";
import { WorkflowBlockSchema, DraftSchema, TargetSchema, SchemaCodeWorkflow, NameCodeSchema, builderSelection } from "../shared/api";

const block = (i: number, extra: object = {}) => ({ id: `b${i}`, type: "code", position: { x: 0, y: 0 }, params: {}, ...extra });

test("DraftSchema refuses 101 blocks, an id or a name over 200 characters, a NaN position", () => {
  const ok = { version: 1, blocks: [block(1)], links: [] };
  expect(DraftSchema.safeParse(ok).success).toBe(true);
  expect(DraftSchema.safeParse({ ...ok, blocks: Array.from({ length: 101 }, (_, i) => block(i)) }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocks: [block(1, { id: "x".repeat(201) })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocks: [block(1, { id: "" })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocks: [block(1, { name: "n".repeat(201) })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, links: [{ from: "x".repeat(201), to: "b1" }] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocks: [block(1, { position: { x: NaN, y: 0 } })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocks: [block(1, { position: { x: 0, y: Infinity } })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, version: 2 }).success).toBe(false);
});

test("DraftSchema lets through an id or a name that only the engine refuses: saveWorkflow names the block", () => {
  const ok = { version: 1, blocks: [block(1, { id: "Tri", name: "n".repeat(70) })], links: [{ from: "Tri", to: "../x" }] };
  expect(DraftSchema.safeParse(ok).success).toBe(true);
});

test("WorkflowBlockSchema: only bounded in size (never a path, the engine answers)", () => {
  expect(WorkflowBlockSchema.safeParse("source-1").success).toBe(true);
  expect(WorkflowBlockSchema.safeParse("Tri").success).toBe(true);
  expect(WorkflowBlockSchema.safeParse("").success).toBe(false);
  expect(WorkflowBlockSchema.safeParse("x".repeat(201)).success).toBe(false);
});

test("builderSelection: an invalid block becomes null (never a stale block), an invalid target ignores the message", () => {
  const news = { type: "widget", id: "actus" };
  expect(builderSelection({ target: news, block: "tri" })).toEqual({ widget: "actus", block: "tri" });
  expect(builderSelection({ target: news, block: "Tri" })).toEqual({ widget: "actus", block: "Tri" });
  expect(builderSelection({ target: news, block: null })).toEqual({ widget: "actus", block: null });
  expect(builderSelection({ target: news, block: "x".repeat(201) })).toEqual({ widget: "actus", block: null });
  expect(builderSelection({ target: news, block: 3 })).toEqual({ widget: "actus", block: null });
  expect(builderSelection({ target: news })).toEqual({ widget: "actus", block: null });
  expect(builderSelection({ target: { type: "action", id: "gitlab" }, block: "lire" })).toEqual({ action: "gitlab", block: "lire" });
  expect(builderSelection({ target: { type: "widget", id: "../x" }, block: "tri" })).toBeNull();
  expect(builderSelection({ target: { type: "action", id: "x".repeat(61) }, block: "tri" })).toBeNull();
  expect(builderSelection({ id: "actus", block: "tri" })).toBeNull();
  expect(builderSelection(null)).toBeNull();
});

test("TargetSchema: a widget or an action, nothing else", () => {
  expect(TargetSchema.safeParse({ type: "widget", id: "meteo" }).success).toBe(true);
  expect(TargetSchema.safeParse({ type: "action", id: "gitlab" }).success).toBe(true);
  for (const c of [{ type: "widget", id: "../x" }, { type: "action", id: "A" }, { type: "autre", id: "x" }, { type: "widget", id: "x", plus: 1 }, "meteo", null]) {
    expect(TargetSchema.safeParse(c).success, JSON.stringify(c)).toBe(false);
  }
});

test("NameCodeSchema refuse ../x.mjs, x.js, /etc/x.mjs", () => {
  expect(NameCodeSchema.safeParse("trier.mjs").success).toBe(true);
  for (const n of ["../x.mjs", "x.js", "/etc/x.mjs"]) expect(NameCodeSchema.safeParse(n).success).toBe(false);
});

test("a code over 256 KB is refused", () => {
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024)).success).toBe(true);
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024 + 1)).success).toBe(false);
});
