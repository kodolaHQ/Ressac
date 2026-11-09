import { expect, test } from "vitest";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MEMORY_MAX_BYTES, writeMemory, paramsHash, readMemory } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

test("a memory over 3 MB is not written; a damaged memory reads as empty", async () => {
  const d = await tempFolder();
  expect(await readMemory(d)).toEqual({});
  const small = { sort: { type: "ai.sort", value: { key: { p: 0.5 } } } };
  expect(await writeMemory(d, small)).toBe(true);
  expect(await readMemory(d)).toEqual(small);
  expect(await readdir(d)).toEqual(["memory.json"]); // no .tmp left lying around

  const big = { sort: { type: "ai.sort", value: "x".repeat(MEMORY_MAX_BYTES) } };
  expect(await writeMemory(d, big)).toBe(false);
  expect(await readMemory(d)).toEqual(small); // nothing was overwritten

  await writeFile(join(d, "memory.json"), "{ abîmé");
  expect(await readMemory(d)).toEqual({});
  await writeFile(join(d, "memory.json"), JSON.stringify({ version: 2, blocks: {} }));
  expect(await readMemory(d)).toEqual({});
});

test("paramsHash does not depend on key order, but on values", () => {
  const a = { key: "url", n: { x: 1, y: [1, { b: 2, a: 1 }] } };
  const b = { n: { y: [1, { a: 1, b: 2 }], x: 1 }, key: "url" };
  expect(paramsHash(a)).toBe(paramsHash(b));
  expect(paramsHash(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(paramsHash({ key: "titre" })).not.toBe(paramsHash({ key: "url" }));
});

test("the hash survives readMemory / writeMemory (R5); an old memory without a hash still reads", async () => {
  const d = await tempFolder();
  const m = { sort: { type: "ai.sort", value: 1, hash: "0123456789abcdef" }, old: { type: "code", value: 2 } };
  await writeMemory(d, m);
  expect(await readMemory(d)).toEqual(m);
});

test("paramsHash ignore garderJours", () => {
  expect(paramsHash({ key: "url", keepDays: 7 })).toBe(paramsHash({ key: "url" }));
  expect(paramsHash({ key: "url", keepDays: 7 })).toBe(paramsHash({ key: "url", keepDays: 30 }));
  expect(paramsHash({ key: "titre", keepDays: 7 })).not.toBe(paramsHash({ key: "url", keepDays: 7 }));
});
