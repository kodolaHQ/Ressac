import { expect, test } from "vitest";
import { SchemaBlocWorkflow, SchemaBrouillon, SchemaCible, SchemaCodeWorkflow, SchemaNomCode, selectionConstructeur } from "../shared/api";

const bloc = (i: number, extra: object = {}) => ({ id: `b${i}`, type: "code", position: { x: 0, y: 0 }, parametres: {}, ...extra });

test("SchemaBrouillon refuse 101 blocs, un id ou un nom de plus de 200 caractères, une position NaN", () => {
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

test("SchemaBrouillon laisse passer un id ou un nom que seul le moteur refuse : enregistrerWorkflow nomme le bloc", () => {
  const ok = { version: 1, blocs: [bloc(1, { id: "Tri", nom: "n".repeat(70) })], liens: [{ de: "Tri", vers: "../x" }] };
  expect(SchemaBrouillon.safeParse(ok).success).toBe(true);
});

test("SchemaBlocWorkflow : seulement borné en taille (jamais un chemin, le moteur répond)", () => {
  expect(SchemaBlocWorkflow.safeParse("source-1").success).toBe(true);
  expect(SchemaBlocWorkflow.safeParse("Tri").success).toBe(true);
  expect(SchemaBlocWorkflow.safeParse("").success).toBe(false);
  expect(SchemaBlocWorkflow.safeParse("x".repeat(201)).success).toBe(false);
});

test("selectionConstructeur : un bloc invalide devient null (jamais un bloc périmé), une cible invalide ignore le message", () => {
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

test("SchemaCible : un widget ou une action, rien d'autre", () => {
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

test("un code de plus de 256 Ko est refusé", () => {
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024)).success).toBe(true);
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024 + 1)).success).toBe(false);
});
