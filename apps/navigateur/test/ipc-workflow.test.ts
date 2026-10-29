import { expect, test } from "vitest";
import { SchemaBlocWorkflow, SchemaBrouillon, SchemaCodeWorkflow, SchemaNomCode } from "../src/commun/api";

const bloc = (i: number, extra: object = {}) => ({ id: `b${i}`, type: "code", position: { x: 0, y: 0 }, parametres: {}, ...extra });

test("SchemaBrouillon refuse 101 blocs, un id ../x, une position NaN", () => {
  const ok = { version: 1, blocs: [bloc(1)], liens: [] };
  expect(SchemaBrouillon.safeParse(ok).success).toBe(true);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: Array.from({ length: 101 }, (_, i) => bloc(i)) }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { id: "x".repeat(41) })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { position: { x: NaN, y: 0 } })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, blocs: [bloc(1, { position: { x: 0, y: Infinity } })] }).success).toBe(false);
  expect(SchemaBrouillon.safeParse({ ...ok, version: 2 }).success).toBe(false);
});

test("SchemaBlocWorkflow refuse un id ../x", () => {
  expect(SchemaBlocWorkflow.safeParse("../x").success).toBe(false);
  expect(SchemaBlocWorkflow.safeParse("source-1").success).toBe(true);
});

test("SchemaNomCode refuse ../x.mjs, x.js, /etc/x.mjs", () => {
  expect(SchemaNomCode.safeParse("trier.mjs").success).toBe(true);
  for (const n of ["../x.mjs", "x.js", "/etc/x.mjs"]) expect(SchemaNomCode.safeParse(n).success).toBe(false);
});

test("un code de plus de 256 Ko est refusé", () => {
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024)).success).toBe(true);
  expect(SchemaCodeWorkflow.safeParse("a".repeat(256 * 1024 + 1)).success).toBe(false);
});
