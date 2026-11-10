import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATA_MAX_SIZE, giveGrant, spacePaths, lastResult, writeRun, writeMemory, writeResult, attemptId, idExecution,
  readGrants, readRun, readResult, forgetGoneActions, deleteDataAction, type Execution, type ActionResult,
} from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

const timestamp = (i: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, i)).toISOString();
const execution = (start: string, attempt = false): Execution => ({
  version: 1, id: attempt ? attemptId(start) : idExecution(start), owner: { type: "action", id: "a" },
  trigger: "manual", start: start, end: start, status: "succeeded", blocks: [],
});
const result = (id: string, results: unknown = { n: 1 }): ActionResult => ({
  version: 1, run: id, input: null, results: results, plan: null, fallback: false, empty: false,
});
const add = async (d: string, start: string, attempt = false, results?: unknown) => {
  const e = execution(start, attempt);
  await writeRun(join(d, "a"), e);
  await writeResult(d, "a", result(e.id, results));
  return e.id;
};

test("result written then re-read; lastResult ignores trials", async () => {
  const d = await tempFolder();
  const real = await add(d, timestamp(0), false, { v: "vrai" });
  const attempt = await add(d, timestamp(5), true, { v: "essai" });
  expect(await readResult(d, "a", real)).toEqual(result(real, { v: "vrai" }));
  expect((await readResult(d, "a", attempt))?.results).toEqual({ v: "essai" });
  expect((await lastResult(d, "a"))?.run).toBe(real);
  expect(await readResult(d, "a", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await readResult(d, "a", "../../x")).toBeNull();
});

test("lastResult: the most recent real run that has a result", async () => {
  const d = await tempFolder();
  const a = await add(d, timestamp(0));
  const b = await add(d, timestamp(2), false, { v: "recent" });
  expect((await lastResult(d, "a"))?.run).toBe(b);
  await writeRun(join(d, "a"), execution(timestamp(1))); // run without a result (failure)
  expect((await lastResult(d, "a"))?.run).toBe(b);
  expect(a).not.toBe(b);
  expect(await lastResult(await tempFolder(), "a")).toBeNull();
});

test("21 runs: the oldest's result goes with it", async () => {
  const d = await tempFolder();
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push(await add(d, timestamp(i)));
  expect(await readRun(join(d, "a"), ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[1]!)).not.toBeNull();
  expect(await readResult(d, "a", ids[20]!)).not.toBeNull();
});

test("11 trials: the oldest's result goes with it", async () => {
  const d = await tempFolder();
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(await add(d, timestamp(i), true));
  expect(await readResult(d, "a", ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[10]!)).not.toBeNull();
});

test("a huge result is refused, a damaged file is ignored", async () => {
  const d = await tempFolder();
  const e = execution(timestamp(0));
  await writeRun(join(d, "a"), e);
  await expect(writeResult(d, "a", result(e.id, "x".repeat(DATA_MAX_SIZE + 300 * 1024)))).rejects.toThrow();
  expect(await readResult(d, "a", e.id)).toBeNull();
  await mkdir(join(d, "a", "results"), { recursive: true });
  await writeFile(join(d, "a", "results", `${e.id}.json`), "{x");
  expect(await readResult(d, "a", e.id)).toBeNull();
});

test("deleteDataAction erases runs, results and memory", async () => {
  const d = await tempFolder();
  const id = await add(d, timestamp(0));
  await writeMemory(join(d, "a"), { b: { type: "t", value: 1 } });
  for (const f of ["runs", "results", "memory.json"]) expect(existsSync(join(d, "a", f)), f).toBe(true);
  await deleteDataAction(d, "a");
  for (const f of ["runs", "results", "memory.json"]) expect(existsSync(join(d, "a", f)), f).toBe(false);
  expect(await readResult(d, "a", id)).toBeNull();
});

test("forgetGoneActions erases the data and grant of an action whose folder disappeared, not the others", async () => {
  const c = spacePaths(await tempFolder());
  const actionsFolder = await tempFolder();
  await mkdir(join(c.actions, "vivante"), { recursive: true });
  for (const id of ["vivante", "disparue"]) {
    const d = join(actionsFolder, id);
    const e = execution(timestamp(0));
    await writeRun(d, e);
    await writeResult(actionsFolder, id, result(e.id));
    await giveGrant(actionsFolder, id, { domains: ["gitlab.com"], public: [], profile: "p" });
  }
  await forgetGoneActions(c, actionsFolder);
  expect(existsSync(join(actionsFolder, "disparue"))).toBe(false);
  expect(existsSync(join(actionsFolder, "vivante", "results"))).toBe(true);
  expect(Object.keys(await readGrants(actionsFolder))).toEqual(["vivante"]);
});

test("forgetGoneActions: without an actions folder (space moved), data and grants stay", async () => {
  const c = spacePaths(await tempFolder()); // c.actions does not exist
  const actionsFolder = await tempFolder();
  const e = execution(timestamp(0));
  await writeRun(join(actionsFolder, "x"), e);
  await writeResult(actionsFolder, "x", result(e.id));
  await giveGrant(actionsFolder, "x", { domains: ["gitlab.com"], public: [], profile: "p" });
  await forgetGoneActions(c, actionsFolder);
  expect(existsSync(join(actionsFolder, "x", "results"))).toBe(true);
  expect(Object.keys(await readGrants(actionsFolder))).toEqual(["x"]);
});

test("forgetGoneActions: a symbolic link named like the action is not the action", async () => {
  const c = spacePaths(await tempFolder());
  const actionsFolder = await tempFolder();
  await mkdir(c.actions, { recursive: true });
  await symlink(await tempFolder(), join(c.actions, "x"));
  await writeRun(join(actionsFolder, "x"), execution(timestamp(0)));
  await forgetGoneActions(c, actionsFolder);
  expect(existsSync(join(actionsFolder, "x"))).toBe(false);
});

test("a well-formed plan is re-read; a malformed plan makes the result be rejected", async () => {
  const d = await tempFolder();
  const id = idExecution(timestamp(0));
  const plan = { blocks: [{ component: "title", props: { text: "x" } }] };
  await writeRun(join(d, "a"), execution(timestamp(0)));
  await writeResult(d, "a", { ...result(id), plan });
  expect((await readResult(d, "a", id))?.plan).toEqual(plan);
  await writeResult(d, "a", { ...result(id), plan: { blocks: [{ component: "Pas Bon", props: {} }] } as never });
  expect(await readResult(d, "a", id)).toBeNull();
});
