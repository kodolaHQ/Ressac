import { expect, test } from "vitest";
import { WorkflowBlockSchema, DraftSchema, TargetSchema, SchemaCodeWorkflow, NameCodeSchema, builderSelection } from "../shared/api";

const block = (i: number, extra: object = {}) => ({ id: `b${i}`, type: "code", position: { x: 0, y: 0 }, parametres: {}, ...extra });

test("DraftSchema refuses 101 blocks, an id or a name over 200 characters, a NaN position", () => {
  const ok = { version: 1, blocs: [block(1)], liens: [] };
  expect(DraftSchema.safeParse(ok).success).toBe(true);
  expect(DraftSchema.safeParse({ ...ok, blocs: Array.from({ length: 101 }, (_, i) => block(i)) }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocs: [block(1, { id: "x".repeat(201) })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocs: [block(1, { id: "" })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocs: [block(1, { nom: "n".repeat(201) })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, liens: [{ de: "x".repeat(201), vers: "b1" }] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocs: [block(1, { position: { x: NaN, y: 0 } })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, blocs: [block(1, { position: { x: 0, y: Infinity } })] }).success).toBe(false);
  expect(DraftSchema.safeParse({ ...ok, version: 2 }).success).toBe(false);
});

test("DraftSchema lets through an id or a name that only the engine refuses: saveWorkflow names the block", () => {
  const ok = { version: 1, blocs: [block(1, { id: "Tri", nom: "n".repeat(70) })], liens: [{ de: "Tri", vers: "../x" }] };
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
  expect(builderSelection({ cible: news, bloc: "tri" })).toEqual({ widget: "actus", bloc: "tri" });
  expect(builderSelection({ cible: news, bloc: "Tri" })).toEqual({ widget: "actus", bloc: "Tri" });
  expect(builderSelection({ cible: news, bloc: null })).toEqual({ widget: "actus", bloc: null });
  expect(builderSelection({ cible: news, bloc: "x".repeat(201) })).toEqual({ widget: "actus", bloc: null });
  expect(builderSelection({ cible: news, bloc: 3 })).toEqual({ widget: "actus", bloc: null });
  expect(builderSelection({ cible: news })).toEqual({ widget: "actus", bloc: null });
  expect(builderSelection({ cible: { type: "action", id: "gitlab" }, bloc: "lire" })).toEqual({ action: "gitlab", bloc: "lire" });
  expect(builderSelection({ cible: { type: "widget", id: "../x" }, bloc: "tri" })).toBeNull();
  expect(builderSelection({ cible: { type: "action", id: "x".repeat(61) }, bloc: "tri" })).toBeNull();
  expect(builderSelection({ id: "actus", bloc: "tri" })).toBeNull();
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
