import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { writeData, writeWidgetState, readData, readWidgetState, deleteData } from "../../src/home/data.js";
import type { WidgetState } from "../../src/home/schemas.js";
import type { WorkshopState } from "../../src/container/workshop.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { kernelError, runHarvest, type ProcessLauncher, type HarvestOptions, type AttemptResult } from "../../src/widgets/harvest.js";
import { writeRun, attemptId, listRuns, type Execution } from "../../src/workflows/executions.js";
import { writeMemory } from "../../src/workflows/memory.js";
import { giveGrant, readGrants } from "../../src/widgets/grants.js";
import {
  WORKSHOP_STOPPED_ERROR,
  INTERNAL_HARVEST_ERROR,
  WidgetsScheduler,
  LONG_ROUTE_MINUTES,
  routeOf,
  widgetOf,
  type DirectState,
  type SchedulerOptions,
} from "../../src/widgets/scheduler.js";
import { Pacing } from "../../src/workflows/pacing.js";
import { currentSlot } from "../../src/widgets/hours.js";
import { AI_ABANDONED } from "../../src/ai/dispatcher.js";
import type { NotificationWidget } from "../../src/widgets/novelties.js";
import { readHome } from "../../src/home/read.js";
import type { SpacePaths } from "../../src/paths.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";
import { tempFolder } from "../helpers/temp.js";

/** Home reads in progress: a test waits until there are none left to know what a request has already read. */
const reads = vi.hoisted(() => ({ inFlight: 0 }));
vi.mock("../../src/home/read.js", async (original) => {
  const m = await original<typeof import("../../src/home/read.js")>();
  return {
    ...m,
    readHome: async (...a: Parameters<typeof m.readHome>) => {
      reads.inFlight++;
      try {
        return await m.readHome(...a);
      } finally {
        reads.inFlight--;
      }
    },
  };
});

const MIN = 60_000;
const START = new Date("2026-10-28T10:00:00.000Z");

let p: WidgetsScheduler | undefined;
afterEach(async () => {
  await p?.stop();
  p = undefined;
});

/** A widget « actus » that harvests every 60 min; the fake harvest succeeds (or returns `statut`). */
async function prepare(o: { workshop?: WorkshopState; status?: WidgetState["status"]; options?: Partial<SchedulerOptions> } = {}) {
  const root = await tempFolder();
  const c = spacePaths(root);
  const widgetsFolder = join(await tempFolder(), "widgets");
  await writeWidget(c, "actus", declarationWidget(undefined, { harvest: { minutes: 60 } }), { "harvest.mjs": "export default () => 1" });
  // A widget without a harvest is never launched.
  await writeWidget(c, "fixe", declarationWidget(), {});
  let now = START;
  const clock = () => now;
  const harvests: string[] = [];
  let workshopState: WorkshopState = o.workshop ?? "demarre";
  const changes = vi.fn();
  const harvest = vi.fn(async (r: HarvestOptions) => {
    harvests.push(r.id);
    const status = o.status ?? "ok";
    const before = await readWidgetState(r.widgetsFolder, r.id);
    const state: WidgetState = {
      status: status,
      lastUpdate: status === "ok" ? clock().toISOString() : before.lastUpdate,
      lastAttempt: clock().toISOString(),
      ...(status === "error" ? { error: "boum" } : {}),
    };
    if (status === "ok") await writeData(r.widgetsFolder, r.id, { n: harvests.length });
    await writeWidgetState(r.widgetsFolder, r.id, state);
    return { state: state };
  });
  const attempts: string[] = [];
  const harvestAttempt = vi.fn(async (r: HarvestOptions & { origin: string; start: string }): Promise<AttemptResult> => {
    attempts.push(r.id);
    return { ok: true, run: attemptId(clock().toISOString()), status: "succeeded" };
  });
  const directs: DirectState[] = [];
  const workshop = { state: async () => workshopState, harvestCommand: () => ["docker"], deleteHarvest: async (_id: string) => {} };
  const options = (): SchedulerOptions => ({
    paths: c,
    locale: () => "fr",
    widgetsFolder: widgetsFolder,
    engine: "/engine",
    workshop: workshop,
    bridge: new FakeBridge([], { active: null, allow: false }),
    ai: null,
    clock: clock,
    intervalMs: 60 * MIN, // the timer does not interfere: the tests call verifier themselves
    harvest: harvest,
    harvestAttempt: harvestAttempt,
    onChange: changes,
    onLive: (e) => directs.push(structuredClone(e)),
    ...o.options,
  });
  p = new WidgetsScheduler(options());
  return {
    attempts: attempts,
    harvestAttempt: harvestAttempt,
    directs,
    p,
    c,
    widgetsFolder: widgetsFolder,
    harvests: harvests,
    harvest: harvest,
    changes: changes,
    workshop: workshop,
    forward: (ms: number) => (now = new Date(now.getTime() + ms)),
    setWorkshop: (e: WorkshopState) => (workshopState = e),
    set: (d: Date) => (now = d),
    clock: clock,
    /** A new scheduler on the same folders (Ressac relaunched); the caller stopped the previous one. */
    relaunch: () => (p = new WidgetsScheduler(options())),
  };
}

test("a due widget is harvested at startup then according to its frequency (fake clock)", async () => {
  const { p, harvests: harvests, harvest: harvest, forward: advance } = await prepare();
  await p.start();
  await vi.waitFor(() => expect(harvests).toEqual(["actus"]));
  // The launch check finishes (otherwise the next one would be skipped without checking anything).
  await vi.waitFor(() => expect(harvest.mock.settledResults).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  advance(59 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual([]);
  advance(2 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual(["actus"]);
  expect(harvests).toEqual(["actus", "actus"]);
});

test("the harvest receives the widget, the data folder, the engine and the AI", async () => {
  const { p, harvest: harvest, widgetsFolder: widgetsFolder, c } = await prepare();
  await p.check({ onLaunch: true });
  const o = harvest.mock.calls[0]![0];
  expect(o).toMatchObject({ id: "actus", widgetsFolder: widgetsFolder, engine: "/engine", ai: null });
  expect(o.widget).toMatchObject({ id: "actus", folder: join(c.widgets, "actus") });
  // surChange follows every write made by the harvest.
  expect(o.onChange).toBeTypeOf("function");
});

test("with a given dispatcher, the harvests use it", async () => {
  const keys: string[] = [];
  const access = { kev: vi.fn(), gemma: vi.fn(), forget: vi.fn() };
  const dispatcher = { for: (key: string) => (keys.push(key), access) };
  const { p, harvest: harvest } = await prepare({ options: { dispatcher: dispatcher } });
  await p.check({ onLaunch: true });
  expect(harvest.mock.calls[0]![0].ai).toBe(access);
  expect(keys).toEqual([`actus:${START.toISOString()}`]);
  expect(access.forget).toHaveBeenCalledTimes(1);
});

test("the throttle and the search base are passed to each harvest and each trial; absent, nothing is passed", async () => {
  const pacing = new Pacing();
  const { p, harvest: harvest, harvestAttempt: harvestAttempt } = await prepare({ options: { pacing: pacing, searchUrl: "http://127.0.0.1:9/html/" } });
  await p.check({ onLaunch: true });
  await p.harvestNow("actus");
  await p.replay("actus", "x", "recolte");
  for (const o of [harvest.mock.calls[0]![0], harvest.mock.calls[1]![0], harvestAttempt.mock.calls[0]![0]]) {
    expect(o.pacing).toBe(pacing);
    expect(o.searchUrl).toBe("http://127.0.0.1:9/html/");
  }
  await p.stop();
  const without = await prepare();
  await without.p.check({ onLaunch: true });
  expect(without.harvest.mock.calls[0]![0]).not.toHaveProperty("menagement");
  expect(without.harvest.mock.calls[0]![0]).not.toHaveProperty("urlRecherche");
});

test("accord-requis is never retried on its own", async () => {
  const { p, harvests: harvests, widgetsFolder: widgetsFolder, forward: advance } = await prepare();
  await writeWidgetState(widgetsFolder, "actus", { status: "grant-required", lastUpdate: null, lastAttempt: null, error: "Accord requis" });
  expect(await p.check({ onLaunch: true })).toEqual([]);
  advance(24 * 60 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual([]);
  expect(harvests).toEqual([]);
  // An explicit request, however, goes through (the harvest checks the grant itself).
  await p.harvestNow("actus");
  expect(harvests).toEqual(["actus"]);
});

test("workshop stopped: status atelier-arrete, data kept", async () => {
  const { p, harvests: harvests, widgetsFolder: widgetsFolder, changes: changes, setWorkshop: setWorkshop } = await prepare({ workshop: "arrete" });
  await writeData(widgetsFolder, "actus", { old: true });
  await writeWidgetState(widgetsFolder, "actus", { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" });
  expect(await p.check({ onLaunch: true })).toEqual([]);
  expect(harvests).toEqual([]);
  expect(await readWidgetState(widgetsFolder, "actus")).toMatchObject({
    status: "workshop-stopped",
    lastUpdate: "2026-10-27T08:00:00.000Z",
    error: "Mise à jour impossible : atelier arrêté",
  });
  expect(await readData(widgetsFolder, "actus")).toEqual({ old: true });
  expect(changes).toHaveBeenCalledTimes(1);
  // Not rewritten every minute.
  await p.check({ onLaunch: false });
  expect(changes).toHaveBeenCalledTimes(1);
  // recolterMaintenant launches nothing either.
  expect((await p.harvestNow("actus")).status).toBe("workshop-stopped");
  expect(harvests).toEqual([]);
  // The workshop comes back: the harvest resumes at the next check.
  setWorkshop("demarre");
  expect(await p.check({ onLaunch: false })).toEqual(["actus"]);
});

test("an error is retried after 15 min, not before", async () => {
  const { p, harvests: harvests, forward: advance } = await prepare({ status: "error" });
  expect(await p.check({ onLaunch: true })).toEqual(["actus"]);
  advance(14 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual([]);
  advance(2 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual(["actus"]);
  expect(harvests).toEqual(["actus", "actus"]);
});

test("in-progress is relaunched at launch only", () => {
  const w = {
    id: "a",
    folder: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { account: [], public: [], web: false }, harvest: { minutes: 60 } },
    state: { status: "running" as const, lastUpdate: null, lastAttempt: START.toISOString() },
    data: null,
    example: null,
    hasHarvest: true,
    hasWorkflow: false,
    hasDisplay: true,
  };
  expect(widgetOf(w, START, { onLaunch: true })).toBe(true);
  expect(widgetOf(w, START, { onLaunch: false })).toBe(false);
  expect(widgetOf({ ...w, hasHarvest: false, state: { ...w.state, status: "ok" } }, START, { onLaunch: true })).toBe(false);
});

test("harvestNow waits for the harvest in progress: only one at a time", async () => {
  const { p, harvest: harvest } = await prepare();
  let inFlight = 0;
  let max = 0;
  const base = harvest.getMockImplementation()!;
  harvest.mockImplementation(async (o) => {
    max = Math.max(max, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    try {
      return await base(o);
    } finally {
      inFlight--;
    }
  });
  const check = p.check({ onLaunch: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalledTimes(1));
  const state = await p.harvestNow("actus");
  await check;
  expect(max).toBe(1);
  expect(state.status).toBe("ok");
  expect(harvest).toHaveBeenCalledTimes(2);
});

test("harvestNow on an unknown widget throws an error", async () => {
  const { p } = await prepare();
  await expect(p.harvestNow("absent")).rejects.toThrow(/inconnu/);
});

test("arreter: the harvest in progress is removed and its previous state restored", async () => {
  const { p, harvest: harvest, widgetsFolder: widgetsFolder, workshop: workshop } = await prepare();
  const before: WidgetState = { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.widgetsFolder, o.id, { ...before, status: "running" });
    await new Promise<void>((r) => (kill = r));
    const state: WidgetState = { ...before, status: "error", error: "La récolte s'est arrêtée sans résultat" };
    await writeWidgetState(o.widgetsFolder, o.id, state);
    return { state: state };
  });
  const deleted: string[] = [];
  workshop.deleteHarvest = async (id) => {
    deleted.push(id);
    kill();
  };
  const check = p.check({ onLaunch: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalled());
  await p.stop();
  await check;
  expect(deleted).toEqual(["actus"]);
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
});

test("arreter while the harvest checks the workshop: it does not start", async () => {
  const { p, harvest: harvest, workshop: workshop } = await prepare();
  let release!: () => void;
  const checked = vi.fn();
  workshop.state = async () => {
    checked();
    await new Promise<void>((r) => (release = r));
    return "demarre";
  };
  const check = p.check({ onLaunch: true });
  await vi.waitFor(() => expect(checked).toHaveBeenCalled());
  const stop = p.stop();
  release();
  await stop;
  await check;
  expect(harvest).not.toHaveBeenCalled();
});

test("arreter: a harvest that exceeds the wait sees its container removed once more", async () => {
  const { widgetsFolder: widgetsFolder, harvest: harvest, workshop: workshop, c } = await prepare();
  await p!.stop();
  let launched = false;
  let start!: () => void;
  const firstDeletion = new Promise<void>((r) => (start = r));
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.widgetsFolder, o.id, { status: "running", lastUpdate: null, lastAttempt: null });
    // The container starts after the first removal, and the harvest does not finish.
    await firstDeletion;
    launched = true;
    await new Promise(() => {});
    return { state: { status: "ok", lastUpdate: null, lastAttempt: null } };
  });
  const deleted: { id: string; launched: boolean }[] = [];
  workshop.deleteHarvest = async (id) => {
    deleted.push({ id, launched: launched });
    start();
  };
  p = new WidgetsScheduler({
    paths: c,
    widgetsFolder: widgetsFolder,
    engine: "/engine",
    workshop: workshop,
    bridge: new FakeBridge([], { active: null, allow: false }),
    ai: null,
    intervalMs: 60 * MIN,
    harvest: harvest,
    stopWaitMs: 100,
  });
  void p.check({ onLaunch: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalled());
  await p.stop();
  expect(deleted).toEqual([
    { id: "actus", launched: false },
    { id: "actus", launched: true },
  ]);
});

test("the first check waits for the workshop to be ready: no « atelier arrêté » at launch", async () => {
  const { widgetsFolder: widgetsFolder, harvest: harvest, workshop: workshop, c, harvests: harvests } = await prepare();
  await p!.stop();
  let state: WorkshopState = "arrete";
  workshop.state = async () => state;
  let ready!: () => void;
  const changes = vi.fn();
  p = new WidgetsScheduler({
    paths: c,
    widgetsFolder: widgetsFolder,
    engine: "/engine",
    workshop: workshop,
    bridge: new FakeBridge([], { active: null, allow: false }),
    ai: null,
    intervalMs: 60 * MIN,
    harvest: harvest,
    onChange: changes,
    ready: new Promise<void>((r) => (ready = r)),
  });
  await p.start();
  await new Promise((r) => setTimeout(r, 50));
  expect((await readWidgetState(widgetsFolder, "actus")).status).not.toBe("workshop-stopped");
  expect(changes).not.toHaveBeenCalled();
  state = "demarre";
  ready();
  await vi.waitFor(() => expect(harvests).toEqual(["actus"]));
});

test("a harvest that throws an error after writing in-progress leaves a kernel error state", async () => {
  const { p, harvest: harvest, widgetsFolder: widgetsFolder, changes: changes } = await prepare();
  await writeWidgetState(widgetsFolder, "actus", { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" });
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.widgetsFolder, o.id, { status: "running", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: START.toISOString() });
    throw new Error("disque plein SECRET");
  });
  await expect(p.harvestNow("actus")).resolves.toMatchObject({ status: "error" });
  const state = await readWidgetState(widgetsFolder, "actus");
  expect(state).toEqual({
    status: "error",
    lastUpdate: "2026-10-27T08:00:00.000Z",
    lastAttempt: START.toISOString(),
    error: INTERNAL_HARVEST_ERROR("fr"),
    kernelError: true,
  });
  expect(kernelError(INTERNAL_HARVEST_ERROR("fr"))).toBe(true);
  expect(changes).toHaveBeenCalled();
  // Same through the background check.
  await writeWidgetState(widgetsFolder, "actus", { status: "running", lastUpdate: null, lastAttempt: null });
  expect(await p.check({ onLaunch: true })).toEqual(["actus"]);
  expect((await readWidgetState(widgetsFolder, "actus")).status).toBe("error");
});

test("at each check, grants and data of a widget whose folder disappeared are erased", async () => {
  const { p, widgetsFolder: widgetsFolder, c } = await prepare();
  for (const id of ["actus", "parti"]) {
    await writeData(widgetsFolder, id, { secret: id });
    await giveGrant(widgetsFolder, id, { domains: ["x.fr"], public: [], profile: "defaut" });
  }
  // An unreadable widget keeps its data: its folder exists.
  await writeWidget(c, "casse", "{", {});
  await writeData(widgetsFolder, "casse", { secret: "casse" });
  await p.check({ onLaunch: false });
  expect(Object.keys(await readGrants(widgetsFolder)).sort()).toEqual(["actus"]);
  expect(existsSync(join(widgetsFolder, "parti"))).toBe(false);
  expect(await readData(widgetsFolder, "casse")).toEqual({ secret: "casse" });
  expect(existsSync(join(widgetsFolder, "actus"))).toBe(true);
  // Without a widgets folder at all (unreadable space), nothing is erased.
  await rm(c.widgets, { recursive: true, force: true });
  await p.check({ onLaunch: false });
  expect(Object.keys(await readGrants(widgetsFolder))).toEqual(["actus"]);
});

test("a widget with workflow.json without harvest.mjs is harvested when it is due", async () => {
  const { p, c, harvests: harvests } = await prepare();
  await writeWidget(c, "flux", declarationWidget(undefined, { harvest: { minutes: 60 } }), {
    "workflow.json": JSON.stringify({ version: 1, blocks: [{ id: "sortie", type: "output", params: { to: "widget" } }] }),
  });
  expect((await p.check({ onLaunch: true })).sort()).toEqual(["actus", "flux"]);
  expect(harvests.sort()).toEqual(["actus", "flux"]);
});

test("trigger: planifiee for the check, manuelle by default for harvestNow, otherwise the requested one", async () => {
  const { p, harvest: harvest } = await prepare();
  await p.check({ onLaunch: true });
  await p.harvestNow("actus");
  await p.harvestNow("actus", "agent");
  expect(harvest.mock.calls.map(([o]) => o.trigger)).toEqual(["scheduled", "manual", "agent"]);
  expect(harvest.mock.calls[0]![0].interrupted).toBeTypeOf("function");
});

test("stop during the run: run interrupted, previous state restored", async () => {
  const { p, harvest: harvest, widgetsFolder: widgetsFolder, workshop: workshop } = await prepare();
  const before: WidgetState = { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  const launched = vi.fn();
  // A container that never answers: only the stop ends it.
  const launch: ProcessLauncher = () => {
    launched();
    const end = new Promise<number | null>((r) => (kill = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => kill(), end: end };
  };
  harvest.mockImplementation((o) => runHarvest({ ...o, launch: launch }));
  workshop.deleteHarvest = async () => kill();
  const check = p.check({ onLaunch: true });
  await vi.waitFor(() => expect(launched).toHaveBeenCalled());
  await p.stop();
  await check;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
  expect((await listRuns(join(widgetsFolder, "actus"))).map((e) => e.status)).toEqual(["interrupted"]);
});

test("the vanished folder also erases runs and memory", async () => {
  const { p, widgetsFolder: widgetsFolder } = await prepare();
  const folder = join(widgetsFolder, "parti");
  await writeData(widgetsFolder, "parti", { secret: 1 });
  await writeRun(folder, {
    version: 1, id: "2026-10-27T08-00-00-000Z", owner: { type: "widget", id: "parti" }, trigger: "scheduled",
    start: "2026-10-27T08:00:00.000Z", end: null, status: "succeeded", blocks: [],
  });
  await writeMemory(folder, { a: { type: "list.new", value: [] } });
  await p.check({ onLaunch: false });
  expect(existsSync(folder)).toBe(false);
});

/** A promise to resolve from the outside. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise: promise, resolve: resolve };
}

test("a scheduled run due during a trial waits for its end", async () => {
  const { p, harvest: harvest, harvestAttempt: harvestAttempt } = await prepare();
  const log: string[] = [];
  const end = deferred<AttemptResult>();
  harvestAttempt.mockImplementation(async (o) => {
    log.push(`essai ${o.id} ${o.origin} ${o.start}`);
    const r = await end.promise;
    log.push("fin de l'essai");
    return r;
  });
  harvest.mockImplementation(async (o) => {
    log.push(`récolte ${o.id} ${o.trigger}`);
    return { state: { status: "ok", lastUpdate: START.toISOString(), lastAttempt: START.toISOString() } };
  });
  const attempt = p.replay("actus", "2026-10-28T09-00-00-000Z", "liste");
  await vi.waitFor(() => expect(log).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste"]));
  const verification = p.check({ onLaunch: true });
  await new Promise((r) => setTimeout(r, 30));
  expect(log).toHaveLength(1);
  end.resolve({ ok: true, run: "x-attempt", status: "succeeded" });
  expect(await attempt).toEqual({ ok: true, run: "x-attempt", status: "succeeded" });
  expect(await verification).toEqual(["actus"]);
  expect(log).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste", "fin de l'essai", "récolte actus scheduled"]);
});

test("two rejouer requested back to back run one after the other", async () => {
  const { p, harvestAttempt: harvestAttempt } = await prepare();
  const log: string[] = [];
  const ends = [deferred<void>(), deferred<void>()];
  let n = 0;
  harvestAttempt.mockImplementation(async (o) => {
    const i = n++;
    log.push(`début ${i} ${o.start}`);
    await ends[i]!.promise;
    log.push(`fin ${i}`);
    return { ok: true, run: `e${i}-attempt`, status: "succeeded" };
  });
  const a = p.replay("actus", "o", "a");
  const b = p.replay("actus", "o", "b");
  await vi.waitFor(() => expect(log).toEqual(["début 0 a"]));
  await new Promise((r) => setTimeout(r, 20));
  expect(log).toEqual(["début 0 a"]);
  ends[0]!.resolve();
  await vi.waitFor(() => expect(log).toEqual(["début 0 a", "fin 0", "début 1 b"]));
  ends[1]!.resolve();
  expect(await a).toMatchObject({ run: "e0-attempt" });
  expect(await b).toMatchObject({ run: "e1-attempt" });
});

test("an avancement or lecture trace does not change a widget's live tracking", async () => {
  const { p, harvestAttempt: harvestAttempt, directs } = await prepare();
  const seen: { before: DirectState; after: DirectState; reported: number }[] = [];
  harvestAttempt.mockImplementation(async (o) => {
    o.onTrace!({ block: "liste", step: "start" });
    const before = structuredClone(p.direct());
    const reported = directs.length;
    o.onTrace!({ block: "liste", step: "progress", done: 2, total: 5 });
    o.onTrace!({ block: "liste", step: "read", host: "gitlab.com" });
    o.onTrace!({ block: "autre", step: "read", host: "gitlab.com" });
    seen.push({ before: before, after: structuredClone(p.direct()), reported: directs.length - reported });
    return { ok: true, run: attemptId(START.toISOString()), status: "succeeded" };
  });
  await p.replay("actus", "o", "liste");
  expect(seen[0]!.after).toEqual(seen[0]!.before);
  expect(seen[0]!.after.running[0]!.blocks).toEqual({ liste: { status: "running", items: null } });
  expect(seen[0]!.reported).toBe(0);
});

test("direct() shows the running widget, its kind and its blocks as traces come, then nothing", async () => {
  const { p, harvestAttempt: harvestAttempt, directs, widgetsFolder: widgetsFolder } = await prepare();
  expect(p.direct()).toEqual({ running: [], waiting: [] });
  const seen: DirectState[] = [];
  harvestAttempt.mockImplementation(async (o) => {
    o.onTrace!({ block: "liste", step: "start" });
    seen.push(structuredClone(p.direct()));
    o.onTrace!({ block: "liste", step: "end", status: "succeeded", items: 3 });
    // Started, without an end: only the final run says it failed.
    o.onTrace!({ block: "sortie", step: "start" });
    seen.push(structuredClone(p.direct()));
    const e: Execution = {
      version: 1, id: attemptId(START.toISOString()), owner: { type: "widget", id: o.id }, trigger: "replay",
      attempt: { start: o.start, origin: o.origin }, start: START.toISOString(), end: START.toISOString(), status: "failed",
      blocks: [
        { id: "liste", type: "code", status: "succeeded", start: "x", end: "x", items: 3, log: [] },
        { id: "sortie", type: "output", status: "failed", start: "x", end: null, items: null, log: [] },
      ],
    };
    await writeRun(join(widgetsFolder, o.id), e);
    return { ok: true, run: e.id, status: e.status };
  });
  await p.replay("actus", "o", "liste");
  const start = START.toISOString();
  expect(seen[0]).toEqual({
    running: [{ widget: "actus", kind: "attempt", start: start, blocks: { liste: { status: "running", items: null } } }],
    waiting: [],
  });
  expect(seen[1]!.running[0]!.blocks).toEqual({ liste: { status: "succeeded", items: 3 }, sortie: { status: "running", items: null } });
  // End: resynchronized on the written run, then nothing in progress.
  expect(directs.at(-2)!.running[0]!.blocks).toEqual({ liste: { status: "succeeded", items: 3 }, sortie: { status: "failed", items: null } });
  expect(directs.at(-1)).toEqual({ running: [], waiting: [] });
  expect(p.direct()).toEqual({ running: [], waiting: [] });
  // A real run is tracked the same way, kind « execution ».
  await p.harvestNow("actus");
  expect(directs.some((d) => d.running.some((x) => x.kind === "execution" && x.widget === "actus"))).toBe(true);
  expect(p.direct().running).toEqual([]);
});

test("waiting lists a widget requested while another runs", async () => {
  const { p, harvestAttempt: harvestAttempt, harvests: harvests } = await prepare();
  const end = deferred<void>();
  harvestAttempt.mockImplementation(async () => {
    await end.promise;
    return { ok: true, run: "e-attempt", status: "succeeded" };
  });
  const attempt = p.replay("actus", "o", "liste");
  await vi.waitFor(() => expect(p.direct().running[0]?.widget).toBe("actus"));
  const other = p.harvestNow("fixe");
  await vi.waitFor(() => expect(p.direct().waiting).toEqual(["fixe"]));
  expect(harvests).toEqual([]);
  end.resolve();
  await attempt;
  await other;
  expect(harvests).toEqual(["fixe"]);
  expect(p.direct()).toEqual({ running: [], waiting: [] });
});

test("workshop stopped: rejouer refuses without changing the state", async () => {
  const { p, harvestAttempt: harvestAttempt, widgetsFolder: widgetsFolder, changes: changes } = await prepare({ workshop: "arrete" });
  const state: WidgetState = { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", state);
  expect(await p.replay("actus", "o", "liste")).toEqual({ ok: false, error: WORKSHOP_STOPPED_ERROR("fr") });
  expect(harvestAttempt).not.toHaveBeenCalled();
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(state);
  expect(changes).not.toHaveBeenCalled();
});

test("widgetDu: a widget with hours without minutes is never due by frequency", () => {
  const w = {
    id: "a",
    folder: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { account: [], public: [], web: false }, harvest: { hours: ["07:00"] } },
    // The time of day is already done: only the frequency could make it due.
    state: { status: "ok" as const, lastUpdate: null, lastAttempt: null, hours: { done: currentSlot(["07:00"], START), failures: null } },
    data: null,
    example: null,
    hasHarvest: true,
    hasWorkflow: false,
    hasDisplay: true,
  };
  expect(widgetOf(w, START, { onLaunch: true })).toBe(false);
  expect(widgetOf({ ...w, state: { ...w.state, status: "error" as const } }, START, { onLaunch: false })).toBe(false);
});

// --- Two lanes: watches (dureeMaxMinutes > 3) run apart ---

/** A widget that harvests every 60 min, with the given maximum duration. */
async function writeWatch(c: SpacePaths, id: string, maxDurationMinutes: number) {
  await writeWidget(c, id, declarationWidget(undefined, { harvest: { minutes: 60, maxDurationMinutes: maxDurationMinutes } }), { "harvest.mjs": "export default () => 1" });
}

/** The harvests of the `retenus` widgets wait for `liberer(id)`; all then go through the base fake harvest. */
function keep(harvest: Awaited<ReturnType<typeof prepare>>["harvest"], kept: string[]) {
  const base = harvest.getMockImplementation()!;
  const log: string[] = [];
  const ends = new Map<string, (() => void)[]>();
  harvest.mockImplementation(async (o) => {
    log.push(`début ${o.id}`);
    if (kept.includes(o.id)) {
      const d = deferred<void>();
      ends.set(o.id, [...(ends.get(o.id) ?? []), d.resolve]);
      await d.promise;
    }
    try {
      return await base(o);
    } finally {
      log.push(`fin ${o.id}`);
    }
  });
  return {
    log: log,
    release: (id: string) => {
      const f = ends.get(id)?.shift();
      if (!f) throw new Error(`rien à libérer pour ${id}`);
      f();
    },
  };
}

test("routeOf: long beyond LONG_ROUTE_MINUTES (3), short otherwise", async () => {
  expect(LONG_ROUTE_MINUTES).toBe(3);
  const { c, widgetsFolder: widgetsFolder } = await prepare();
  await writeWatch(c, "trois", 3);
  await writeWatch(c, "quatre", 4);
  const widgets = (await readHome(c, widgetsFolder)).widgets;
  const route = (id: string) => routeOf(widgets.find((w) => w.id === id)!);
  expect([route("actus"), route("trois"), route("quatre"), route("fixe")]).toEqual(["short", "short", "long", "short"]);
});

test("a long run (maxDurationMinutes 30) does not prevent a short widget from running", async () => {
  const { p, c, harvest: harvest } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  // The check launches the watch without waiting for it, and harvests « actus » while it runs.
  expect(await p.check({ onLaunch: true })).toEqual(["actus"]);
  expect(r.log).toContain("fin actus");
  await vi.waitFor(() => expect(r.log).toContain("début veille"));
  expect(r.log).not.toContain("fin veille");
  // A manual request for a short widget goes through too.
  expect((await p.harvestNow("actus")).status).toBe("ok");
  r.release("veille");
  await vi.waitFor(() => expect(r.log).toContain("fin veille"));
});

test("two long widgets: one after the other", async () => {
  const { p, c, harvest: harvest } = await prepare();
  await writeWatch(c, "veille-a", 30);
  await writeWatch(c, "veille-b", 20);
  const r = keep(harvest, ["veille-a", "veille-b"]);
  await p.check({ onLaunch: true });
  await vi.waitFor(() => expect(r.log.filter((l) => l.startsWith("début veille"))).toHaveLength(1));
  await new Promise((ok) => setImmediate(ok));
  const first = r.log.find((l) => l.startsWith("début veille"))!.slice("début ".length);
  const second = first === "veille-a" ? "veille-b" : "veille-a";
  expect(r.log).not.toContain(`début ${second}`);
  r.release(first);
  await vi.waitFor(() => expect(r.log).toContain(`début ${second}`));
  expect(r.log.indexOf(`fin ${first}`)).toBeLessThan(r.log.indexOf(`début ${second}`));
  r.release(second);
  await vi.waitFor(() => expect(r.log).toContain(`fin ${second}`));
});

test("a long widget and its trial: never at the same time", async () => {
  const { p, c, harvest: harvest, harvestAttempt: harvestAttempt } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  harvestAttempt.mockImplementation(async (o) => {
    r.log.push(`essai ${o.id}`);
    return { ok: true, run: "e-attempt", status: "succeeded" };
  });
  const execution = p.harvestNow("veille");
  await vi.waitFor(() => expect(r.log).toEqual(["début veille"]));
  const attempt = p.replay("veille", "o", "liste");
  await vi.waitFor(() => expect(p.direct().waiting).toEqual(["veille"]));
  // A short widget runs in the meantime: the waiting trial does not block its lane.
  await p.harvestNow("actus");
  expect(r.log).not.toContain("essai veille");
  r.release("veille");
  await execution;
  expect(await attempt).toMatchObject({ ok: true });
  expect(r.log.indexOf("fin veille")).toBeLessThan(r.log.indexOf("essai veille"));
});

test("maxDurationMinutes changed from 30 to 2 during the run: the new request waits for the first to end", async () => {
  const { p, c, harvest: harvest, harvests: harvests } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  const first = p.harvestNow("veille");
  await vi.waitFor(() => expect(r.log).toEqual(["début veille"]));
  await writeWatch(c, "veille", 2);
  const second = p.harvestNow("veille");
  // The short lane stays free for the other widgets, and a check does not wait for this busy widget.
  await p.harvestNow("actus");
  expect(await p.check({ onLaunch: false })).toEqual([]);
  expect(r.log.filter((l) => l === "début veille")).toHaveLength(1);
  r.release("veille");
  await first;
  await vi.waitFor(() => expect(r.log.filter((l) => l === "début veille")).toHaveLength(2));
  expect(r.log.indexOf("fin veille")).toBeLessThan(r.log.lastIndexOf("début veille"));
  expect(harvests).toEqual(["actus", "veille"]);
  r.release("veille");
  expect((await second).status).toBe("ok");
});

test("a check is not stuck by a long run: a short widget due later is harvested", async () => {
  const { p, c, harvest: harvest, forward: advance } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  expect(await p.check({ onLaunch: true })).toEqual(["actus"]);
  advance(61 * MIN);
  // « actus » is due again; the watch too according to its data, but it is still running: not relaunched.
  expect(await p.check({ onLaunch: false })).toEqual(["actus"]);
  advance(61 * MIN);
  expect(await p.check({ onLaunch: false })).toEqual(["actus"]);
  expect(r.log.filter((l) => l === "début veille")).toHaveLength(1);
  r.release("veille");
  await vi.waitFor(() => expect(r.log).toContain("fin veille"));
});

test("direct().courants lists both runs", async () => {
  const { p, c, harvest: harvest } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille", "actus"]);
  void p.check({ onLaunch: true });
  await vi.waitFor(() => expect(r.log).toEqual(expect.arrayContaining(["début veille", "début actus"])));
  await vi.waitFor(() =>
    expect(
      p
        .direct()
        .running.map((x) => x.widget)
        .sort(),
    ).toEqual(["actus", "veille"]),
  );
  expect(p.direct().running.every((x) => x.kind === "execution")).toBe(true);
  r.release("actus");
  await vi.waitFor(() => expect(p.direct().running.map((x) => x.widget)).toEqual(["veille"]));
  r.release("veille");
  await vi.waitFor(() => expect(p.direct()).toEqual({ running: [], waiting: [] }));
});

test("arreter removes both containers and waits for both lanes", async () => {
  const { p, c, harvest: harvest, workshop: workshop } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille", "actus"]);
  const deleted: string[] = [];
  const turn = () => new Promise((ok) => setImmediate(ok));
  workshop.deleteHarvest = async (id) => {
    deleted.push(id);
    if (id === "actus") return void setImmediate(() => r.release(id));
    // The killed watch ends well after the short one (it still writes its memory and its « interrompue » run).
    void (async () => {
      while (!r.log.includes("fin actus")) await turn();
      for (let i = 0; i < 5; i++) await turn();
      r.release(id);
    })();
  };
  void p.check({ onLaunch: true });
  await vi.waitFor(() => expect(p.direct().running).toHaveLength(2));
  await p.stop();
  expect(deleted.sort()).toEqual(["actus", "veille"]);
  expect(r.log).toEqual(expect.arrayContaining(["fin actus", "fin veille"]));
});

test("arreter: a long run that does not finish is awaited in a bounded way, its container removed twice", async () => {
  const { p, c, harvest: harvest, workshop: workshop } = await prepare({
    options: { stopWaitMs: 1 },
  });
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  const deleted: string[] = [];
  workshop.deleteHarvest = async (id) => void deleted.push(id);
  await p.check({ onLaunch: true });
  await vi.waitFor(() => expect(r.log).toContain("début veille"));
  await p.stop();
  expect(deleted).toEqual(["veille", "veille"]);
  r.release("veille");
});

test("the AI goes through the dispatcher: each run has its view, calls reach the given AI, refused after its end", async () => {
  const calls: string[] = [];
  const ai = { kev: async () => "k", gemma: async (o: { prompt: string }) => (calls.push(o.prompt), "g") };
  const { p, c, harvest: harvest, harvestAttempt: harvestAttempt } = await prepare({ options: { ai: ai } });
  await writeWatch(c, "veille", 30);
  const responses: unknown[] = [];
  const base = harvest.getMockImplementation()!;
  harvest.mockImplementation(async (o) => {
    responses.push(await o.ai!.gemma({ prompt: o.id }));
    return base(o);
  });
  harvestAttempt.mockImplementation(async (o) => {
    responses.push(await o.ai!.gemma({ prompt: `essai ${o.id}` }));
    return { ok: true, run: "e-attempt", status: "succeeded" };
  });
  await p.harvestNow("actus");
  await p.harvestNow("veille");
  await p.replay("actus", "o", "liste");
  const views = [harvest.mock.calls[0]![0].ai, harvest.mock.calls[1]![0].ai, harvestAttempt.mock.calls[0]![0].ai];
  expect(new Set(views).size).toBe(3);
  for (const v of views) expect(v).not.toBe(ai);
  expect(responses).toEqual(["g", "g", "g"]);
  expect(calls).toEqual(["actus", "veille", "essai actus"]);
  // The run finished, its view refuses: a late call no longer goes to the AI.
  await expect(views[0]!.gemma({ prompt: "tard" })).rejects.toThrow(AI_ABANDONED);
  expect(calls).toHaveLength(3);
});

test("maxDurationMinutes changed from 2 to 30 while a request waits: it goes into the long lane", async () => {
  const { p, c, harvest: harvest } = await prepare();
  await writeWatch(c, "veille", 2);
  const r = keep(harvest, ["veille"]);
  const first = p.harvestNow("veille");
  await vi.waitFor(() => expect(r.log).toEqual(["début veille"]));
  const second = p.harvestNow("veille");
  // Every read the request would do right away (lane choice on request) is finished before the change.
  await new Promise((ok) => setImmediate(ok));
  await vi.waitFor(() => expect(reads.inFlight).toBe(0));
  await writeWatch(c, "veille", 30);
  r.release("veille");
  await first;
  await vi.waitFor(() => expect(r.log.filter((l) => l === "début veille")).toHaveLength(2));
  // The second runs in the long lane: the short lane and the check stay free.
  expect((await p.harvestNow("actus")).status).toBe("ok");
  expect(await p.check({ onLaunch: false })).toEqual([]);
  r.release("veille");
  expect((await second).status).toBe("ok");
});

test("widget changed from 30 to 2 just before a trial: the trial goes through during another widget's watch", async () => {
  const { p, c, harvest: harvest, harvestAttempt: harvestAttempt } = await prepare();
  await writeWatch(c, "veille-a", 30);
  await writeWatch(c, "veille-b", 30);
  const r = keep(harvest, ["veille-a"]);
  // Watch A runs in the long lane; the scheduler read B at 30 in the meantime.
  const a = p.harvestNow("veille-a");
  await vi.waitFor(() => expect(r.log).toEqual(["début veille-a"]));
  await writeWatch(c, "veille-b", 2);
  expect(await p.replay("veille-b", "o", "liste")).toMatchObject({ ok: true });
  expect(harvestAttempt.mock.calls.map((x) => x[0].id)).toEqual(["veille-b"]);
  expect(r.log).not.toContain("fin veille-a");
  r.release("veille-a");
  await a;
});

// --- Heures fixes ---

/** Local time of October 29, 2026 (or of the given day). */
const at = (h: number, m: number, day = 29) => new Date(2026, 9, day, h, m);

/** A widget « matin » at fixed hours (and at a frequency if `minutes`). */
async function writeMorning(c: SpacePaths, harvest: { hours: string[]; minutes?: number }, extra: Record<string, unknown> = {}) {
  await writeWidget(c, "matin", declarationWidget(undefined, { harvest: harvest, ...extra }), { "harvest.mjs": "export default () => 1" });
}

const morning = (harvests: string[]) => harvests.filter((x) => x === "matin").length;

test("hours and minutes: both apply", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { minutes: 120, hours: ["07:00"] });
  fixer(at(6, 0));
  await p.check({ onLaunch: true });
  expect(morning(harvests)).toBe(1); // by frequency (never harvested)
  // Before the first hour of the day: no effect on the tracking.
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toBeUndefined();
  fixer(at(6, 30));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
  fixer(at(7, 0));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(2); // by the hour, the data is only an hour old
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: "2026-10-29T07:00", failures: null });
  for (const [h, m] of [[7, 1], [8, 59]] as const) {
    fixer(at(h, m));
    await p.check({ onLaunch: false });
  }
  expect(morning(harvests)).toBe(2);
  fixer(at(9, 0));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(3); // by frequency, 2 h after 07:00
});

test("interrupted: caught up at the next launch the same day", async () => {
  const { p, c, harvests: harvests, harvest: harvest, set: fixer, widgetsFolder: widgetsFolder, workshop: workshop, relaunch: relaunch } = await prepare();
  await writeMorning(c, { hours: ["07:00"] });
  const base = harvest.getMockImplementation()!;
  let kill: (() => void) | undefined;
  harvest.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    harvests.push(o.id);
    await writeWidgetState(o.widgetsFolder, o.id, { status: "running", lastUpdate: null, lastAttempt: at(7, 0).toISOString() });
    await new Promise<void>((r) => (kill = r));
    return { state: { status: "error", lastUpdate: null, lastAttempt: at(7, 0).toISOString(), error: "Interrompue" } };
  });
  workshop.deleteHarvest = async () => kill?.();
  fixer(at(7, 0));
  const check = p.check({ onLaunch: true });
  await vi.waitFor(() => expect(morning(harvests)).toBe(1));
  // `tuer` is only set after the in-progress state is written: without it, arreter() would wait 15 s (F5).
  await vi.waitFor(() => expect(kill).toBeDefined());
  await p.stop();
  await check;
  // Interrupted: no effect on the tracking, the earlier state is restored.
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({ status: "ok", lastUpdate: null, lastAttempt: null });
  harvest.mockImplementation(base);
  fixer(at(7, 30));
  const p2 = relaunch();
  await p2.check({ onLaunch: true });
  expect(morning(harvests)).toBe(2);
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: "2026-10-29T07:00", failures: null });
  fixer(at(7, 31));
  await p2.check({ onLaunch: false });
  expect(morning(harvests)).toBe(2);
});

test("abrupt stop (in-progress at launch): the missed hour is caught up once", async () => {
  const { p, c, harvests: harvests, harvest: harvest, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00", "12:00"] });
  await writeWidgetState(widgetsFolder, "matin", {
    status: "running", lastUpdate: null, lastAttempt: at(12, 0).toISOString(), progress: { done: 7, total: 12 },
    hours: { done: "2026-10-29T07:00", failures: null },
  });
  fixer(at(14, 0));
  await p.start();
  await vi.waitFor(() => expect(harvest.mock.settledResults.filter((r) => r.type === "fulfilled")).toHaveLength(2));
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: "2026-10-29T12:00", failures: null });
  fixer(at(14, 1));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
});

test("in-progress at launch of an hours widget already done today: not relaunched, its state restored", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00"] });
  const hours = { done: "2026-10-29T07:00", failures: null };
  await writeWidgetState(widgetsFolder, "matin", {
    status: "running", lastUpdate: at(7, 5).toISOString(), lastAttempt: at(8, 0).toISOString(), progress: { done: 7, total: 12 }, hours: hours,
  });
  fixer(at(9, 0));
  await p.check({ onLaunch: true });
  expect(morning(harvests)).toBe(0);
  // No frozen « 7 / 12 ».
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({ status: "ok", lastUpdate: at(7, 5).toISOString(), lastAttempt: at(8, 0).toISOString(), hours: hours });
});

test("in-progress at launch while a trial waits: the state is restored before any run, the widget relaunched afterwards", async () => {
  const { p, harvests: harvests, harvestAttempt: harvestAttempt, widgetsFolder: widgetsFolder } = await prepare();
  // Fresh data: only the abrupt stop makes it due at launch.
  await writeWidgetState(widgetsFolder, "actus", { status: "running", lastUpdate: START.toISOString(), lastAttempt: START.toISOString(), progress: { done: 7, total: 12 } });
  const end = deferred<AttemptResult>();
  const started = deferred<void>();
  harvestAttempt.mockImplementation(async () => {
    started.resolve();
    return end.promise;
  });
  const attempt = p.replay("actus", "o", "liste");
  await started.promise;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual({ status: "ok", lastUpdate: START.toISOString(), lastAttempt: START.toISOString() });
  const verification = p.check({ onLaunch: true });
  end.resolve({ ok: true, run: "x-attempt", status: "succeeded" });
  await attempt;
  expect(await verification).toEqual(["actus"]);
  expect(harvests).toEqual(["actus"]);
});

test("a trial does not count for the hour", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00"] });
  fixer(at(7, 0));
  expect(await p.replay("matin", "o", "liste")).toMatchObject({ ok: true });
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toBeUndefined();
  fixer(at(7, 1));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
});

test("Mac asleep over several hours: a single catch-up on wake", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00", "09:00", "12:00"] });
  fixer(at(6, 0));
  await p.check({ onLaunch: true });
  expect(morning(harvests)).toBe(0);
  // Wake at 3 pm: 07:00, 09:00 and 12:00 missed, a single run.
  for (let t = at(15, 0).getTime(); t <= at(23, 59).getTime(); t += 30 * MIN) {
    fixer(new Date(t));
    await p.check({ onLaunch: false });
  }
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: "2026-10-29T12:00", failures: null });
});

test("midnight: the hour missed the day before is not caught up, the next day's is", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00", "22:00"] });
  // 22:00 missed on the 29th (Ressac closed); reopened after midnight.
  await writeWidgetState(widgetsFolder, "matin", { status: "ok", lastUpdate: null, lastAttempt: null, hours: { done: "2026-10-29T07:00", failures: null } });
  for (const [h, m] of [[0, 0], [0, 1], [3, 0], [6, 59]] as const) {
    fixer(at(h, m, 30));
    await p.check({ onLaunch: h === 0 && m === 0 });
  }
  expect(morning(harvests)).toBe(0);
  fixer(at(7, 0, 30));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: "2026-10-30T07:00", failures: null });
});

test("failures: retried 15 min later, 3 times at most, then nothing until the next hour", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare({ status: "error" });
  await writeMorning(c, { hours: ["07:00", "12:00"] });
  const attempts: string[] = [];
  for (let t = at(7, 0).getTime(); t <= at(12, 0).getTime(); t += MIN) {
    fixer(new Date(t));
    const before = morning(harvests);
    await p.check({ onLaunch: false });
    if (morning(harvests) > before) attempts.push(`${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")}`);
  }
  expect(attempts).toEqual(["7:00", "7:15", "7:30", "7:45", "12:00"]);
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual({ done: null, failures: { hour: "2026-10-29T12:00", count: 1, end: at(12, 0).toISOString() } });
});

test("a manual run before the first hour does not erase the previous day's tracking; one at 07:10 counts for 07:00", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  await writeMorning(c, { hours: ["07:00"] });
  const watch = { done: "2026-10-28T07:00", failures: null };
  await writeWidgetState(widgetsFolder, "matin", { status: "ok", lastUpdate: null, lastAttempt: null, hours: watch });
  fixer(at(6, 50));
  expect(await p.harvestNow("matin")).toMatchObject({ status: "ok" });
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual(watch);
  fixer(at(7, 10));
  expect(await p.harvestNow("matin", "agent")).toMatchObject({ status: "ok", hours: { done: "2026-10-29T07:00", failures: null } });
  fixer(at(7, 11));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(2);
});

test("the hours tracking survives a grant removed then granted again", async () => {
  const { p, c, harvests: harvests, set: fixer, widgetsFolder: widgetsFolder } = await prepare();
  const sources = { account: ["mail.example.com"], public: [] };
  await writeMorning(c, { hours: ["07:00"] }, { sources });
  await giveGrant(widgetsFolder, "matin", { domains: ["mail.example.com"], public: [], profile: "defaut" });
  fixer(at(7, 0));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
  const done = { done: "2026-10-29T07:00", failures: null };
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual(done);
  // Like refuserAccord: data erased, state waiting for a grant.
  await deleteData(widgetsFolder, "matin");
  const before = await readWidgetState(widgetsFolder, "matin");
  await writeWidgetState(widgetsFolder, "matin", { status: "grant-required", lastUpdate: before.lastUpdate, lastAttempt: before.lastAttempt, error: "accord", kernelError: true });
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual(done);
  fixer(at(7, 5));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(1);
  // Granted again: the harvest that follows the grant counts, and the hour is not redone.
  await giveGrant(widgetsFolder, "matin", { domains: ["mail.example.com"], public: [], profile: "defaut" });
  await p.harvestNow("matin");
  expect((await readWidgetState(widgetsFolder, "matin")).hours).toEqual(done);
  fixer(at(7, 30));
  await p.check({ onLaunch: false });
  expect(morning(harvests)).toBe(2);
});

test("watch failing after 30 min: the retry starts at the earliest 15 min after the failure ends", async () => {
  const { p, c, harvest: harvest, set: fixer, clock: clock, forward: advance, widgetsFolder: widgetsFolder } = await prepare({ status: "error" });
  await writeMorning(c, { hours: ["07:00", "12:00"] });
  const base = harvest.getMockImplementation()!;
  const starts: string[] = [];
  harvest.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    const start = clock();
    starts.push(`${start.getHours()}:${String(start.getMinutes()).padStart(2, "0")}`);
    // derniereTentative = the start, like the real harvest; the failure comes 30 min later.
    await writeWidgetState(o.widgetsFolder, o.id, { status: "running", lastUpdate: null, lastAttempt: start.toISOString() });
    advance(30 * MIN);
    await writeWidgetState(o.widgetsFolder, o.id, { status: "error", lastUpdate: null, lastAttempt: start.toISOString(), error: "délai" });
    return { state: { status: "error", lastUpdate: null, lastAttempt: start.toISOString(), error: "délai" } };
  });
  fixer(at(7, 0));
  while (clock() < at(11, 59)) {
    await p.check({ onLaunch: false });
    advance(MIN);
  }
  expect(starts).toEqual(["7:00", "7:45", "8:30", "9:15"]);
  const { hours: hours } = await readWidgetState(widgetsFolder, "matin");
  expect(hours?.failures).toMatchObject({ hour: "2026-10-29T07:00", count: 4 });
});

test("abrupt stop: the state from before the run (error) is restored; clean stop: nothing of the run remains", async () => {
  const { p, c, harvest: harvest, set: fixer, widgetsFolder: widgetsFolder, workshop: workshop, harvests: harvests } = await prepare();
  await writeMorning(c, { hours: ["07:00"] });
  const hours = { done: "2026-10-29T07:00", failures: null };
  await writeWidgetState(widgetsFolder, "matin", {
    status: "running", lastUpdate: null, lastAttempt: at(8, 0).toISOString(), progress: { done: 7, total: 12 }, hours: hours,
    before: { status: "error", error: "Sélecteur introuvable", kernelError: true },
  });
  fixer(at(9, 0));
  await p.check({ onLaunch: true });
  expect(morning(harvests)).toBe(0);
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({
    status: "error", lastUpdate: null, lastAttempt: at(8, 0).toISOString(), error: "Sélecteur introuvable", kernelError: true, hours: hours,
  });
  // Clean stop during a real harvest: the earlier state comes back without the avant field.
  const before: WidgetState = { status: "ok", lastUpdate: "2026-10-27T08:00:00.000Z", lastAttempt: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  const launched = vi.fn();
  const launch: ProcessLauncher = () => {
    launched();
    const end = new Promise<number | null>((r) => (kill = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => kill(), end: end };
  };
  harvest.mockImplementation((o) => runHarvest({ ...o, launch: launch }));
  workshop.deleteHarvest = async () => kill?.();
  const now = p.harvestNow("actus");
  await vi.waitFor(() => expect(launched).toHaveBeenCalled());
  expect((await readWidgetState(widgetsFolder, "actus")).before).toEqual({ status: "ok" });
  await p.stop();
  await now;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
});

test("a onChange callback that throws during the startup restore does not block the runs", async () => {
  const { widgetsFolder: widgetsFolder, harvests: harvests, relaunch: relaunch, p: first } = await prepare({ options: { onChange: () => { throw new Error("rappel"); } } });
  await first.stop();
  await writeWidgetState(widgetsFolder, "actus", { status: "running", lastUpdate: null, lastAttempt: null });
  const p2 = relaunch();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await p2.harvestNow("actus").catch(() => {});
    await expect(p2.check({ onLaunch: true })).resolves.toEqual(expect.any(Array));
  } finally {
    errors.mockRestore();
  }
  expect(harvests.length).toBeGreaterThan(0);
});

describe("end-of-watch notification", () => {
  /** A « veille » widget that notifies, and a spy notifier; the fake harvest returns `nouveaux` (and `statut`). */
  async function prepareWatch(o: { notify?: boolean; newItems?: number; status?: WidgetState["status"]; noCallback?: boolean } = {}) {
    const notifications: NotificationWidget[] = [];
    const notify = vi.fn((n: NotificationWidget) => void notifications.push(n));
    const t = await prepare({ options: o.noCallback ? {} : { notify: notify } });
    await writeWidget(
      t.c,
      "veille",
      declarationWidget(undefined, { name: "Vélos d'occasion", harvest: { minutes: 60, ...(o.notify === false ? {} : { notify: true }) } }),
      { "harvest.mjs": "export default () => 1" },
    );
    t.harvest.mockImplementation(async (r) => {
      const status = o.status ?? "ok";
      const state: WidgetState = { status: status, lastUpdate: START.toISOString(), lastAttempt: START.toISOString(), ...(status === "error" ? { error: "boum" } : {}) };
      if (status === "ok") await writeData(r.widgetsFolder, r.id, [{ title: "PIÈGE annonce", url: "https://x.test/1" }]);
      await writeWidgetState(r.widgetsFolder, r.id, state);
      return { state: state, ...(o.newItems !== undefined ? { newItems: o.newItems } : {}) };
    });
    return { ...t, notify: notify, notifications };
  }

  test("3 new items: one notification, title = widget name, text « 3 nouveaux éléments »", async () => {
    const { p, notifications } = await prepareWatch({ newItems: 3 });
    await p.harvestNow("veille");
    expect(notifications).toEqual([{ widget: "veille", title: "Vélos d'occasion", text: "3 nouveaux éléments" }]);
  });

  test("1 new item: singular text", async () => {
    const { p, notifications } = await prepareWatch({ newItems: 1 });
    await p.harvestNow("veille");
    expect(notifications).toEqual([{ widget: "veille", title: "Vélos d'occasion", text: "1 nouvel élément" }]);
  });

  test("zero new, failure, trial, widget without notifier: none", async () => {
    const zero = await prepareWatch({ newItems: 0 });
    await zero.p.harvestNow("veille");
    await zero.p.harvestNow("veille", "scheduled");
    expect(zero.notify).not.toHaveBeenCalled();
    await zero.p.stop();

    const failure = await prepareWatch({ newItems: 2, status: "error" });
    await failure.p.harvestNow("veille");
    expect(failure.notify).not.toHaveBeenCalled();
    await failure.p.stop();

    const attempt = await prepareWatch({ newItems: 2 });
    expect(await attempt.p.replay("veille", "2026-10-28T09-00-00-000Z", "liste")).toMatchObject({ ok: true });
    expect(attempt.harvestAttempt).toHaveBeenCalledTimes(1);
    expect(attempt.notify).not.toHaveBeenCalled();
    await attempt.p.stop();

    // The widget does not declare `notifier`: even if the harvest returned a count, nothing.
    const without = await prepareWatch({ newItems: 2, notify: false });
    await without.p.harvestNow("veille");
    expect(without.notify).not.toHaveBeenCalled();
    await without.p.stop();

    // No callback given to the scheduler: the harvest ends as before.
    const withoutCallback = await prepareWatch({ newItems: 2, noCallback: true });
    expect((await withoutCallback.p.harvestNow("veille")).status).toBe("ok");
  });

  test("the text contains nothing from the data (trapped listing title)", async () => {
    const { p, notifications, widgetsFolder: widgetsFolder } = await prepareWatch({ newItems: 1 });
    await p.harvestNow("veille");
    expect(await readData(widgetsFolder, "veille")).toEqual([{ title: "PIÈGE annonce", url: "https://x.test/1" }]);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toMatch(/PIÈGE|x\.test/);
    expect(notifications[0]!.text).toBe("1 nouvel élément");
  });

  test("a notifier that throws does not prevent the run from finishing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { p, notify: notify, widgetsFolder: widgetsFolder } = await prepareWatch({ newItems: 3 });
      notify.mockImplementation(() => {
        throw new Error("Notification impossible");
      });
      const state = await p.harvestNow("veille");
      expect(notify).toHaveBeenCalledTimes(1);
      expect(state.status).toBe("ok");
      expect((await readWidgetState(widgetsFolder, "veille")).status).toBe("ok");
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("notification of widget veille"), expect.any(Error));
    } finally {
      errors.mockRestore();
    }
  });
});

test("notification: the widget name is cleaned (controls and invisible characters replaced, on one line)", async () => {
  const notifications: NotificationWidget[] = [];
  const { p, c, harvest: harvest } = await prepare({ options: { notify: (n) => void notifications.push(n) } });
  await writeWidget(c, "veille", declarationWidget(undefined, { name: "‮Vélos\n\nd'occasion​\t ", harvest: { minutes: 60, notify: true } }), {
    "harvest.mjs": "export default () => 1",
  });
  harvest.mockImplementation(async () => ({ state: { status: "ok", lastUpdate: START.toISOString(), lastAttempt: START.toISOString() }, newItems: 2 }));
  await p.harvestNow("veille");
  expect(notifications).toEqual([{ widget: "veille", title: "Vélos d'occasion", text: "2 nouveaux éléments" }]);
});
