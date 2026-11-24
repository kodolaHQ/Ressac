import { expect, test } from "vitest";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_STOPPED, RUN_MAX_BYTES, KEPT_ATTEMPTS, ID_EXECUTION, OUTPUT_MAX_BYTES, writeRun, clearRunsAndMemory, attemptId, idExecution, listRuns, readRun,
  type Execution, type BlockTrace,
} from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

const block = (id: string, output?: unknown): BlockTrace => ({
  id, type: "code", status: "succeeded", start: null, end: null, items: null, log: [],
  ...(output === undefined ? {} : { output: output }),
});
const execution = (start: string, blocks: BlockTrace[] = []): Execution => ({
  version: 1, id: idExecution(start), owner: { type: "widget", id: "w" },
  trigger: "manual", start: start, end: start, status: "succeeded", blocks: blocks,
});
const timestamp = (i: number) => new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString();

test("idExecution replaces : and . with -", () => {
  expect(idExecution("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z");
});

test("an output over 256 KB is kept truncated, as text, and marked truncatedOutput", async () => {
  const d = await tempFolder();
  const big = { list: Array.from({ length: 40000 }, (_, i) => ({ i, t: "abcdefghij" })) };
  const e = execution(timestamp(0), [block("a", big), block("b", { small: 1 })]);
  await writeRun(d, e, "fr");
  const loaded = await readRun(d, e.id);
  const a = loaded!.blocks[0]!;
  expect(a.outputTruncated).toBe(true);
  expect(typeof a.output).toBe("string");
  expect(Buffer.byteLength(a.output as string)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
  expect(a.output).toBe(JSON.stringify(big).slice(0, (a.output as string).length));
  expect(loaded!.blocks[1]).toEqual(block("b", { small: 1 }));
});

test("a run file never exceeds 4 MB: the biggest outputs go first", async () => {
  const d = await tempFolder();
  const blocks = Array.from({ length: 20 }, (_, i) => block(`b${i}`, "x".repeat(250 * 1024 - 2 - i)));
  const e = execution(timestamp(0), blocks);
  await writeRun(d, e, "fr");
  const file = join(d, "runs", `${e.id}.json`);
  expect((await stat(file)).size).toBeLessThanOrEqual(RUN_MAX_BYTES);
  const loaded = (await readRun(d, e.id))!;
  const without = loaded.blocks.filter((b) => b.output === undefined);
  expect(without.length).toBeGreaterThan(0);
  expect(without.every((b) => b.outputTruncated === true)).toBe(true);
  expect(without.map((b) => b.id)).toContain("b0"); // the biggest goes first
  expect(loaded.blocks.filter((b) => b.output !== undefined).every((b) => b.outputTruncated === undefined)).toBe(true);
});

test("only the last 20 runs are kept", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 25; i++) await writeRun(d, execution(timestamp(i)));
  const names = (await readdir(join(d, "runs"))).sort();
  expect(names).toHaveLength(20);
  expect(names[0]).toBe(`${idExecution(timestamp(5))}.json`);
  expect(names).not.toContain(`${idExecution(timestamp(4))}.json`);
});

test("listRuns returns the most recent first and ignores a damaged file", async () => {
  const d = await tempFolder();
  await writeRun(d, execution(timestamp(1), [block("a", 1)]));
  await writeRun(d, execution(timestamp(3)));
  await writeRun(d, execution(timestamp(2)));
  await writeFile(join(d, "runs", `${idExecution(timestamp(9))}.json`), "{ abîmé");
  const list = await listRuns(d);
  expect(list.map((r) => r.id)).toEqual([timestamp(3), timestamp(2), timestamp(1)].map(idExecution));
  expect(list[2]).toEqual({
    id: idExecution(timestamp(1)), trigger: "manual", start: timestamp(1), end: timestamp(1), status: "succeeded",
    blocks: [{ id: "a", status: "succeeded", items: null }],
  });
  expect(await listRuns(await tempFolder())).toEqual([]);
});

test("readRun refuses an id that leaves the folder", async () => {
  const d = await tempFolder();
  await writeFile(join(d, "state.json"), "{}");
  expect(await readRun(d, "../etat")).toBeNull();
  expect(await readRun(d, "a/b")).toBeNull();
  expect(await readRun(d, idExecution(timestamp(0)))).toBeNull();
  expect(await readFile(join(d, "state.json"), "utf8")).toBe("{}");
});

test("huge logs and errors are bounded: the file stays under 4 MB", async () => {
  const d = await tempFolder();
  const blocks = Array.from({ length: 100 }, (_, i) => ({
    ...block(`b${i}`), error: "e".repeat(100 * 1024),
    log: Array.from({ length: 300 }, (_, j) => `${j} ` + "l".repeat(5000)),
  }));
  const e = { ...execution(timestamp(0), blocks), error: "E".repeat(1024 * 1024) };
  await writeRun(d, e, "fr");
  expect((await stat(join(d, "runs", `${e.id}.json`))).size).toBeLessThanOrEqual(RUN_MAX_BYTES);
  const loaded = (await readRun(d, e.id))!;
  expect(Buffer.byteLength(loaded.error!)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(loaded.blocks[0]!.error!)).toBeLessThanOrEqual(2048);
  expect(loaded.blocks.every((b) => b.log.length >= 1 && b.log.length <= 201)).toBe(true);
  expect(loaded.blocks[0]!.log.some((l) => l.includes("lignes coupées"))).toBe(true);
}, 60_000); // ~150 MB of input: 4 s on an M5 Pro, 21 s on the 3-core CI runner

test("listRuns does not re-read an unchanged file (same date, same size), re-reads a rewritten file", async () => {
  const d = await tempFolder();
  const e = execution(timestamp(1), [block("a")]);
  await writeRun(d, e, "fr");
  const path = join(d, "runs", `${e.id}.json`);
  // A round date, which utimes can restore identically.
  const date = new Date("2026-10-29T08:00:00.000Z");
  await utimes(path, date, date);
  expect((await listRuns(d)).map((x) => x.status)).toEqual(["succeeded"]);
  // Same size, same date: the file is not re-read (the kept summary stays).
  await writeFile(path, (await readFile(path, "utf8")).replace('"succeeded"', '"partial"  ')); // same size: the status is renamed, whitespace pads it
  await utimes(path, date, date);
  expect((await listRuns(d)).map((x) => x.status)).toEqual(["succeeded"]);
  // Date changed: re-read.
  await utimes(path, date, new Date(date.getTime() + 5000));
  expect((await listRuns(d)).map((x) => x.status)).toEqual(["partial"]);
  // Erased: no longer listed.
  await rm(path);
  expect(await listRuns(d)).toEqual([]);
});

const attempt = (start: string): Execution => ({
  ...execution(start), id: attemptId(start), trigger: "replay", attempt: { start: "b", origin: idExecution(timestamp(0)) },
});

test("attemptId adds -attempt to the run's identifier", () => {
  expect(attemptId("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z-attempt");
});

test("25 trials and 25 real runs: 10 trials and 20 real ones kept", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 25; i++) {
    await writeRun(d, attempt(timestamp(i)));
    await writeRun(d, execution(timestamp(i)));
  }
  const names = (await readdir(join(d, "runs"))).sort();
  expect(names.filter((n) => n.endsWith("-attempt.json"))).toHaveLength(KEPT_ATTEMPTS);
  expect(names.filter((n) => !n.endsWith("-attempt.json"))).toHaveLength(20);
  expect(names).toContain(`${attemptId(timestamp(24))}.json`);
  expect(names).not.toContain(`${attemptId(timestamp(14))}.json`);
  expect(names).toContain(`${idExecution(timestamp(5))}.json`);
});

test("a series of trials drives out no real run", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 20; i++) await writeRun(d, execution(timestamp(i)));
  for (let i = 20; i < 60; i++) await writeRun(d, attempt(timestamp(i)));
  const names = await readdir(join(d, "runs"));
  expect(names.filter((n) => !n.endsWith("-attempt.json"))).toHaveLength(20);
  expect(names).toContain(`${idExecution(timestamp(0))}.json`);
});

test("listRuns marks the trials", async () => {
  const d = await tempFolder();
  await writeRun(d, execution(timestamp(1)));
  await writeRun(d, attempt(timestamp(2)));
  const list = await listRuns(d);
  expect(list.find((r) => r.id === attemptId(timestamp(2)))!.attempt).toEqual({ start: "b", origin: idExecution(timestamp(0)) });
  expect(list.find((r) => r.id === idExecution(timestamp(1)))!.attempt).toBeUndefined();
});

test("readRun accepts <timestamp>-attempt and refuses ../x-attempt", async () => {
  const d = await tempFolder();
  await writeRun(d, attempt(timestamp(3)));
  expect((await readRun(d, attemptId(timestamp(3))))!.trigger).toBe("replay");
  // Regression guard (R21): already true before the widening of ID_EXECUTION.
  await writeFile(join(d, "x-attempt.json"), "{}");
  expect(await readRun(d, "../x-attempt")).toBeNull();
  expect(await readRun(d, "x-attempt")).toBeNull();
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-attempt")).toBe(true);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-attempt/../x")).toBe(false);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-attempt-attempt")).toBe(false);
});

test("clearRunsAndMemory also erases the trials", async () => {
  const d = await tempFolder();
  await writeRun(d, attempt(timestamp(3)));
  await clearRunsAndMemory(d);
  expect(await readRun(d, attemptId(timestamp(3)))).toBeNull();
  expect(await listRuns(d)).toEqual([]);
});

test("an action run (owner action, saisie « clio lyon ») is written and re-read", async () => {
  const d = await tempFolder();
  const e: Execution = { ...execution(timestamp(0), [block("a", { x: 1 })]), owner: { type: "action", id: "recherche" }, input: "clio lyon" };
  await writeRun(d, e, "fr");
  expect(await readRun(d, e.id)).toEqual(e);
  expect(ACTION_STOPPED("fr")).toBe("Arrêtée à votre demande");
});

test("a widget run written before this plan re-reads unchanged", async () => {
  const d = await tempFolder();
  const e = execution(timestamp(1), [block("a")]);
  await writeRun(d, e, "fr");
  const loaded = (await readRun(d, e.id))!;
  expect(loaded).toEqual(e);
  expect(loaded).not.toHaveProperty("saisie");
});
