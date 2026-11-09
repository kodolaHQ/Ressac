import { expect, test } from "vitest";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_STOPPED, RUN_MAX_BYTES, KEPT_ATTEMPTS, ID_EXECUTION, OUTPUT_MAX_BYTES, writeRun, clearRunsAndMemory, attemptId, idExecution, listRuns, readRun,
  type Execution, type BlockTrace,
} from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

const block = (id: string, output?: unknown): BlockTrace => ({
  id, type: "code", statut: "reussi", debut: null, fin: null, elements: null, journal: [],
  ...(output === undefined ? {} : { sortie: output }),
});
const execution = (start: string, blocks: BlockTrace[] = []): Execution => ({
  version: 1, id: idExecution(start), proprietaire: { type: "widget", id: "w" },
  declencheur: "manuelle", debut: start, fin: start, statut: "reussie", blocs: blocks,
});
const timestamp = (i: number) => new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString();

test("idExecution replaces : and . with -", () => {
  expect(idExecution("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z");
});

test("an output over 256 KB is kept truncated, as text, and marked sortieTronquee", async () => {
  const d = await tempFolder();
  const big = { liste: Array.from({ length: 40000 }, (_, i) => ({ i, t: "abcdefghij" })) };
  const e = execution(timestamp(0), [block("a", big), block("b", { petit: 1 })]);
  await writeRun(d, e);
  const loaded = await readRun(d, e.id);
  const a = loaded!.blocs[0]!;
  expect(a.sortieTronquee).toBe(true);
  expect(typeof a.sortie).toBe("string");
  expect(Buffer.byteLength(a.sortie as string)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
  expect(a.sortie).toBe(JSON.stringify(big).slice(0, (a.sortie as string).length));
  expect(loaded!.blocs[1]).toEqual(block("b", { petit: 1 }));
});

test("a run file never exceeds 4 MB: the biggest outputs go first", async () => {
  const d = await tempFolder();
  const blocks = Array.from({ length: 20 }, (_, i) => block(`b${i}`, "x".repeat(250 * 1024 - 2 - i)));
  const e = execution(timestamp(0), blocks);
  await writeRun(d, e);
  const file = join(d, "executions", `${e.id}.json`);
  expect((await stat(file)).size).toBeLessThanOrEqual(RUN_MAX_BYTES);
  const loaded = (await readRun(d, e.id))!;
  const without = loaded.blocs.filter((b) => b.sortie === undefined);
  expect(without.length).toBeGreaterThan(0);
  expect(without.every((b) => b.sortieTronquee === true)).toBe(true);
  expect(without.map((b) => b.id)).toContain("b0"); // the biggest goes first
  expect(loaded.blocs.filter((b) => b.sortie !== undefined).every((b) => b.sortieTronquee === undefined)).toBe(true);
});

test("only the last 20 runs are kept", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 25; i++) await writeRun(d, execution(timestamp(i)));
  const names = (await readdir(join(d, "executions"))).sort();
  expect(names).toHaveLength(20);
  expect(names[0]).toBe(`${idExecution(timestamp(5))}.json`);
  expect(names).not.toContain(`${idExecution(timestamp(4))}.json`);
});

test("listerExecutions returns the most recent first and ignores a damaged file", async () => {
  const d = await tempFolder();
  await writeRun(d, execution(timestamp(1), [block("a", 1)]));
  await writeRun(d, execution(timestamp(3)));
  await writeRun(d, execution(timestamp(2)));
  await writeFile(join(d, "executions", `${idExecution(timestamp(9))}.json`), "{ abîmé");
  const list = await listRuns(d);
  expect(list.map((r) => r.id)).toEqual([timestamp(3), timestamp(2), timestamp(1)].map(idExecution));
  expect(list[2]).toEqual({
    id: idExecution(timestamp(1)), declencheur: "manuelle", debut: timestamp(1), fin: timestamp(1), statut: "reussie",
    blocs: [{ id: "a", statut: "reussi", elements: null }],
  });
  expect(await listRuns(await tempFolder())).toEqual([]);
});

test("lireExecution refuses an id that leaves the folder", async () => {
  const d = await tempFolder();
  await writeFile(join(d, "etat.json"), "{}");
  expect(await readRun(d, "../etat")).toBeNull();
  expect(await readRun(d, "a/b")).toBeNull();
  expect(await readRun(d, idExecution(timestamp(0)))).toBeNull();
  expect(await readFile(join(d, "etat.json"), "utf8")).toBe("{}");
});

test("huge logs and errors are bounded: the file stays under 4 MB", async () => {
  const d = await tempFolder();
  const blocks = Array.from({ length: 100 }, (_, i) => ({
    ...block(`b${i}`), erreur: "e".repeat(100 * 1024),
    journal: Array.from({ length: 300 }, (_, j) => `${j} ` + "l".repeat(5000)),
  }));
  const e = { ...execution(timestamp(0), blocks), erreur: "E".repeat(1024 * 1024) };
  await writeRun(d, e);
  expect((await stat(join(d, "executions", `${e.id}.json`))).size).toBeLessThanOrEqual(RUN_MAX_BYTES);
  const loaded = (await readRun(d, e.id))!;
  expect(Buffer.byteLength(loaded.erreur!)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(loaded.blocs[0]!.erreur!)).toBeLessThanOrEqual(2048);
  expect(loaded.blocs.every((b) => b.journal.length >= 1 && b.journal.length <= 201)).toBe(true);
  expect(loaded.blocs[0]!.journal.some((l) => l.includes("lignes coupées"))).toBe(true);
});

test("listerExecutions does not re-read an unchanged file (same date, same size), re-reads a rewritten file", async () => {
  const d = await tempFolder();
  const e = execution(timestamp(1), [block("a")]);
  await writeRun(d, e);
  const path = join(d, "executions", `${e.id}.json`);
  // A round date, which utimes can restore identically.
  const date = new Date("2026-10-29T08:00:00.000Z");
  await utimes(path, date, date);
  expect((await listRuns(d)).map((x) => x.statut)).toEqual(["reussie"]);
  // Same size, same date: the file is not re-read (the kept summary stays).
  await writeFile(path, (await readFile(path, "utf8")).replace('"reussie"', '"echouee"'));
  await utimes(path, date, date);
  expect((await listRuns(d)).map((x) => x.statut)).toEqual(["reussie"]);
  // Date changed: re-read.
  await utimes(path, date, new Date(date.getTime() + 5000));
  expect((await listRuns(d)).map((x) => x.statut)).toEqual(["echouee"]);
  // Erased: no longer listed.
  await rm(path);
  expect(await listRuns(d)).toEqual([]);
});

const attempt = (start: string): Execution => ({
  ...execution(start), id: attemptId(start), declencheur: "rejeu", essai: { depart: "b", origine: idExecution(timestamp(0)) },
});

test("idEssai adds -essai to the run's identifier", () => {
  expect(attemptId("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z-essai");
});

test("25 trials and 25 real runs: 10 trials and 20 real ones kept", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 25; i++) {
    await writeRun(d, attempt(timestamp(i)));
    await writeRun(d, execution(timestamp(i)));
  }
  const names = (await readdir(join(d, "executions"))).sort();
  expect(names.filter((n) => n.endsWith("-essai.json"))).toHaveLength(KEPT_ATTEMPTS);
  expect(names.filter((n) => !n.endsWith("-essai.json"))).toHaveLength(20);
  expect(names).toContain(`${attemptId(timestamp(24))}.json`);
  expect(names).not.toContain(`${attemptId(timestamp(14))}.json`);
  expect(names).toContain(`${idExecution(timestamp(5))}.json`);
});

test("a series of trials drives out no real run", async () => {
  const d = await tempFolder();
  for (let i = 0; i < 20; i++) await writeRun(d, execution(timestamp(i)));
  for (let i = 20; i < 60; i++) await writeRun(d, attempt(timestamp(i)));
  const names = await readdir(join(d, "executions"));
  expect(names.filter((n) => !n.endsWith("-essai.json"))).toHaveLength(20);
  expect(names).toContain(`${idExecution(timestamp(0))}.json`);
});

test("listerExecutions marks the trials", async () => {
  const d = await tempFolder();
  await writeRun(d, execution(timestamp(1)));
  await writeRun(d, attempt(timestamp(2)));
  const list = await listRuns(d);
  expect(list.find((r) => r.id === attemptId(timestamp(2)))!.essai).toEqual({ depart: "b", origine: idExecution(timestamp(0)) });
  expect(list.find((r) => r.id === idExecution(timestamp(1)))!.essai).toBeUndefined();
});

test("lireExecution accepts <timestamp>-essai and refuses ../x-essai", async () => {
  const d = await tempFolder();
  await writeRun(d, attempt(timestamp(3)));
  expect((await readRun(d, attemptId(timestamp(3))))!.declencheur).toBe("rejeu");
  // Regression guard (R21): already true before the widening of ID_EXECUTION.
  await writeFile(join(d, "x-essai.json"), "{}");
  expect(await readRun(d, "../x-essai")).toBeNull();
  expect(await readRun(d, "x-essai")).toBeNull();
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai")).toBe(true);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai/../x")).toBe(false);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai-essai")).toBe(false);
});

test("effacerExecutionsEtMemoire also erases the trials", async () => {
  const d = await tempFolder();
  await writeRun(d, attempt(timestamp(3)));
  await clearRunsAndMemory(d);
  expect(await readRun(d, attemptId(timestamp(3)))).toBeNull();
  expect(await listRuns(d)).toEqual([]);
});

test("an action run (owner action, saisie « clio lyon ») is written and re-read", async () => {
  const d = await tempFolder();
  const e: Execution = { ...execution(timestamp(0), [block("a", { x: 1 })]), proprietaire: { type: "action", id: "recherche" }, saisie: "clio lyon" };
  await writeRun(d, e);
  expect(await readRun(d, e.id)).toEqual(e);
  expect(ACTION_STOPPED).toBe("Arrêtée à ta demande");
});

test("a widget run written before this plan re-reads unchanged", async () => {
  const d = await tempFolder();
  const e = execution(timestamp(1), [block("a")]);
  await writeRun(d, e);
  const loaded = (await readRun(d, e.id))!;
  expect(loaded).toEqual(e);
  expect(loaded).not.toHaveProperty("saisie");
});
