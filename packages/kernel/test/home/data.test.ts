import { expect, test } from "vitest";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeData, writeWidgetState, readData, readWidgetState, changeWidgetState, deleteData } from "../../src/home/data.js";
import { writeRun, writeMemory, listRuns, readMemory } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

test("atomic write of the data and the state; default state when etat.json is missing or damaged", async () => {
  const d = await tempFolder();
  expect(await readData(d, "w")).toBeNull();
  expect(await readWidgetState(d, "w")).toEqual({ status: "ok", lastUpdate: null, lastAttempt: null });

  await writeData(d, "w", { list: [1, 2] });
  expect(await readData(d, "w")).toEqual({ list: [1, 2] });
  const state = { status: "accord-requis" as const, lastUpdate: "2026-10-28T07:00:00.000Z", lastAttempt: null, log: "x" };
  await writeWidgetState(d, "w", state);
  expect(await readWidgetState(d, "w")).toEqual(state);
  expect((await readdir(join(d, "w"))).sort()).toEqual(["donnees.json", "etat.json"]); // no .tmp left lying around

  await writeFile(join(d, "w", "etat.json"), "{ abîmé");
  expect((await readWidgetState(d, "w")).status).toBe("ok");
  await writeFile(join(d, "w", "etat.json"), JSON.stringify({ status: "inconnu" }));
  expect((await readWidgetState(d, "w")).lastUpdate).toBeNull();
});

test("donnees.json is limited to 2 MB", async () => {
  const d = await tempFolder();
  const big = { t: "x".repeat(2 * 1024 * 1024) };
  await expect(writeData(d, "w", big)).rejects.toThrow("2 Mo");
  await mkdir(join(d, "w"), { recursive: true });
  await writeFile(join(d, "w", "donnees.json"), JSON.stringify(big));
  expect(await readData(d, "w")).toBeNull();
});

test("deleteData also erases the runs and the memory, and keeps etat.json", async () => {
  const d = await tempFolder();
  await writeData(d, "w", { a: 1 });
  await writeWidgetState(d, "w", { status: "ok", lastUpdate: null, lastAttempt: null });
  await writeMemory(join(d, "w"), { b: { type: "liste.nouveaux", value: ["x"] } });
  await writeRun(join(d, "w"), {
    version: 1, id: "2026-10-29T08-00-00-000Z", owner: { type: "widget", id: "w" }, trigger: "manuelle",
    start: "2026-10-29T08:00:00.000Z", end: null, status: "reussie", blocks: [],
  });
  await deleteData(d, "w");
  expect((await readdir(join(d, "w"))).sort()).toEqual(["etat.json"]);
  expect(await readData(d, "w")).toBeNull();
  expect(await readMemory(join(d, "w"))).toEqual({});
  expect(await listRuns(join(d, "w"))).toEqual([]);
});

test("writeWidgetState keeps the hours tracking when the written state has none, and replaces it when it has one", async () => {
  const d = await tempFolder();
  const hours = { done: "2026-10-29T07:00", failures: null };
  await writeWidgetState(d, "w", { status: "ok", lastUpdate: null, lastAttempt: null, hours: hours });
  await writeWidgetState(d, "w", { status: "en-cours", lastUpdate: null, lastAttempt: "2026-10-29T08:00:00.000Z" });
  expect((await readWidgetState(d, "w")).hours).toEqual(hours);
  await writeWidgetState(d, "w", { status: "erreur", lastUpdate: null, lastAttempt: null, error: "x" });
  expect((await readWidgetState(d, "w")).hours).toEqual(hours);
  const others = { done: "2026-10-29T07:00", failures: { hour: "2026-10-29T12:00", count: 2 } };
  await writeWidgetState(d, "w", { status: "ok", lastUpdate: null, lastAttempt: null, hours: others });
  expect((await readWidgetState(d, "w")).hours).toEqual(others);
  // Without a state file or tracking: nothing is invented.
  await writeWidgetState(d, "neuf", { status: "ok", lastUpdate: null, lastAttempt: null });
  expect("hours" in (await readWidgetState(d, "neuf"))).toBe(false);
});

test("writes of a widget's state one after the other: a write without tracking does not lose the tracking modified at the same time", async () => {
  const d = await tempFolder();
  await writeWidgetState(d, "w", { status: "ok", lastUpdate: null, lastAttempt: null });
  for (let i = 0; i < 20; i++) {
    const hours = { done: `2026-10-29T07:${String(i).padStart(2, "0")}`, failures: null };
    await Promise.all([
      writeWidgetState(d, "w", { status: "en-cours", lastUpdate: null, lastAttempt: null }),
      changeWidgetState(d, "w", (e) => ({ ...e, hours: hours })),
      writeWidgetState(d, "w", { status: "ok", lastUpdate: null, lastAttempt: null }),
    ]);
    expect(await readWidgetState(d, "w")).toEqual({ status: "ok", lastUpdate: null, lastAttempt: null, hours: hours });
  }
  // null: nothing is written.
  await expect(changeWidgetState(d, "w", () => null)).resolves.toBeNull();
  expect((await readWidgetState(d, "w")).status).toBe("ok");
});
