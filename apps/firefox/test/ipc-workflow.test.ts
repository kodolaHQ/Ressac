import { expect, test } from "vitest";
import { SchemaBlocWorkflow, SchemaBrouillon, SchemaCible, SchemaCodeWorkflow, SchemaNomCode, selectionConstructeur } from "../shared/api";

const bloc = (i: number, extra: object = {}) => ({ id: `b${i}`, type: "code", position: { x: 0, y: 0 }, parametres: {}, ...extra });

test("SchemaBrouillon refuses 101 blocks, an id or a name over 200 characters, a NaN position", () => {
  const ok = { version: 1, blocs: [bloc(1)], liens: [] };
  expect(SchemaBrouillon.safeParse(ok).success).toBe(true);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: Array.from({ length: 101 }, (_, i) => bloc(i)) }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { id: "x".repeat(201) })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { id: "" })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { nom: "n".repeat(201) })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, liens: [{ de: "x".repeat(201), vers: "b1" }] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { position: { x: NaN, y: 0 } })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { position: { x: 0, y: Infinity } })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, version: 2 }).success).toBe(false);
});

test("SchemaBrouillon lets through an id or a name that only the engine refuses: enregistrerWorkflow names the block", () => {
  const ok = { version: 1, blocs: [bloc(1, { id: "Tri", nom: "n".repeat(70) })], liens: [{ de: "Tri", vers: "../x" }] };
  expect(SchemaBrouillon.safeParse(ok).success).toBe(true);
});

test("SchemaBlocWorkflow: only bounded in size (never a path, the engine answers)", () => {
  expect(SchemaBlocWorkflow.safeParse("source-1").success).toBe(true);
  expect(SchemaBlocWorkflow.safeParse("Tri").success).toBe(true);
  expect(SchemaBlocWorkflow.safeParse("").success).toBe(false);
  expect(SchemaBlocWorkflow.safeParse("x".repeat(201)).success).toBe(false);
});

test("selectionConstructeur: an invalid block becomes null (never a stale block), an invalid target ignores the message", () => {
  const actus = { type: "widget", id: "actus" };
  expect(selectionConstructeur({ cible: actus, bloc: "tri" })).toEqual({ widget: "actus", bloc: "tri" });
  expect(selectionConstructeur({ cible: actus, bloc: "Tri" })).toEqual({ widget: "actus", bloc: "Tri" });
  expect(selectionConstructeur({ cible: actus, bloc: null })).toEqual({ widget: "actus", bloc: null });
  expect(selectionConstructeur({ cible: actus, bloc: "x".repeat(201) })).toEqual({ widget: "actus", bloc: null });
  expect(selectionConstructeur({ cible: actus, bloc: 3 })).toEqual({ widget: "actus", bloc: null });
  expect(selectionConstructeur({ cible: actus })).toEqual({ widget: "actus", bloc: null });
  expect(selectionConstructeur({ cible: { type: "action", id: "gitlab" }, bloc: "lire" })).toEqual({ action: "gitlab", bloc: "lire" });
  expect(selectionConstructeur({ cible: { type: "widget", id: "../x" }, bloc: "tri" })).toBeNull();
  expect(selectionConstructeur({ cible: { type: "action", id: "x".repeat(61) }, bloc: "tri" })).toBeNull();
  expect(selectionConstructeur({ id: "actus", bloc: "tri" })).toBeNull();
  expect(selectionConstructeur(null)).toBeNull();
});

test("SchemaCible: a widget or an action, nothing else", () => {
  expect(SchemaCible.safeParse({ type: "widget", id: "meteo" }).success).toBe(true);
  expect(SchemaCible.safeParse({ type: "action", id: "gitlab" }).success).toBe(true);
  for (const c of [{ type: "widget", id: "../x" }, { type: "action", id: "A" }, { type: "autre", id: "x" }, { type: "widget", id: "x", plus: 1 }, "meteo", null]) {
    expect(SchemaCible.safeParse(c).success, JSON.stringify(c)).toBe(false);
  }
});

test("SchemaNomCode refuse ../x.mjs, x.js, /etc/x.mjs", () => {
  expect(SchemaNomCode.safeParse("trier.mjs").success).toBe(true);
  for (const n of ["../x.mjs", "x.js", "/etc/x.mjs"]) expect(SchemaNomCode.safeParse(n).success).toBe(false);
});

test("a code over 256 KB is refused", () => {
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024)).success).toBe(true);
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024 + 1)).success).toBe(false);
});
