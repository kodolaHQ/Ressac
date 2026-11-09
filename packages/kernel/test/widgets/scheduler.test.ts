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
import type { NotificationWidget } from "../../src/widgets/nouveautes.js";
import { readHome } from "../../src/home/read.js";
import type { SpacePaths } from "../../src/paths.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";
import { tempFolder } from "../helpers/temp.js";

/** Home reads in progress: a test waits until there are none left to know what a request has already read. */
const reads = vi.hoisted(() => ({ enVol: 0 }));
vi.mock("../../src/home/read.js", async (original) => {
  const m = await original<typeof import("../../src/home/read.js")>();
  return {
    ...m,
    readHome: async (...a: Parameters<typeof m.readHome>) => {
      reads.enVol++;
      try {
        return await m.readHome(...a);
      } finally {
        reads.enVol--;
      }
    },
  };
});

const MIN = 60_000;
const START = new Date("2026-10-28T10:00:00.000Z");

let p: WidgetsScheduler | undefined;
afterEach(async () => {
  await p?.arreter();
  p = undefined;
});

/** A widget « actus » that harvests every 60 min; the fake harvest succeeds (or returns `statut`). */
async function prepare(o: { atelier?: WorkshopState; statut?: WidgetState["statut"]; options?: Partial<SchedulerOptions> } = {}) {
  const root = await tempFolder();
  const c = spacePaths(root);
  const widgetsFolder = join(await tempFolder(), "widgets");
  await writeWidget(c, "actus", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
  // A widget without a harvest is never launched.
  await writeWidget(c, "fixe", declarationWidget(), {});
  let now = START;
  const clock = () => now;
  const harvests: string[] = [];
  let workshopState: WorkshopState = o.atelier ?? "demarre";
  const changes = vi.fn();
  const harvest = vi.fn(async (r: HarvestOptions) => {
    harvests.push(r.id);
    const status = o.statut ?? "ok";
    const before = await readWidgetState(r.dossierWidgets, r.id);
    const state: WidgetState = {
      statut: status,
      derniereMaj: status === "ok" ? clock().toISOString() : before.derniereMaj,
      derniereTentative: clock().toISOString(),
      ...(status === "erreur" ? { erreur: "boum" } : {}),
    };
    if (status === "ok") await writeData(r.dossierWidgets, r.id, { n: harvests.length });
    await writeWidgetState(r.dossierWidgets, r.id, state);
    return { etat: state };
  });
  const attempts: string[] = [];
  const harvestAttempt = vi.fn(async (r: HarvestOptions & { origine: string; depart: string }): Promise<AttemptResult> => {
    attempts.push(r.id);
    return { ok: true, execution: attemptId(clock().toISOString()), statut: "reussie" };
  });
  const directs: DirectState[] = [];
  const workshop = { etat: async () => workshopState, commandeRecolte: () => ["docker"], supprimerRecolte: async (_id: string) => {} };
  const options = (): SchedulerOptions => ({
    chemins: c,
    dossierWidgets: widgetsFolder,
    moteur: "/moteur",
    atelier: workshop,
    pont: new FakeBridge([], { actif: null, autoriser: false }),
    ia: null,
    horloge: clock,
    intervalleMs: 60 * MIN, // the timer does not interfere: the tests call verifier themselves
    recolter: harvest,
    recolterEssai: harvestAttempt,
    surChange: changes,
    surDirect: (e) => directs.push(structuredClone(e)),
    ...o.options,
  });
  p = new WidgetsScheduler(options());
  return {
    essais: attempts,
    recolterEssai: harvestAttempt,
    directs,
    p,
    c,
    dossierWidgets: widgetsFolder,
    recoltes: harvests,
    recolter: harvest,
    changements: changes,
    atelier: workshop,
    avancer: (ms: number) => (now = new Date(now.getTime() + ms)),
    fixerAtelier: (e: WorkshopState) => (workshopState = e),
    fixer: (d: Date) => (now = d),
    horloge: clock,
    /** A new scheduler on the same folders (WebAiOs relaunched); the caller stopped the previous one. */
    relancer: () => (p = new WidgetsScheduler(options())),
  };
}

test("a due widget is harvested at startup then according to its frequency (fake clock)", async () => {
  const { p, recoltes: harvests, recolter: harvest, avancer: advance } = await prepare();
  await p.demarrer();
  await vi.waitFor(() => expect(harvests).toEqual(["actus"]));
  // The launch check finishes (otherwise the next one would be skipped without checking anything).
  await vi.waitFor(() => expect(harvest.mock.settledResults).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  advance(59 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  advance(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(harvests).toEqual(["actus", "actus"]);
});

test("the harvest receives the widget, the data folder, the engine and the AI", async () => {
  const { p, recolter: harvest, dossierWidgets: widgetsFolder, c } = await prepare();
  await p.verifier({ auLancement: true });
  const o = harvest.mock.calls[0]![0];
  expect(o).toMatchObject({ id: "actus", dossierWidgets: widgetsFolder, moteur: "/moteur", ia: null });
  expect(o.widget).toMatchObject({ id: "actus", dossier: join(c.widgets, "actus") });
  // surChange follows every write made by the harvest.
  expect(o.surChange).toBeTypeOf("function");
});

test("with a given dispatcher, the harvests use it", async () => {
  const keys: string[] = [];
  const access = { kev: vi.fn(), gemma: vi.fn(), oublier: vi.fn() };
  const dispatcher = { pour: (key: string) => (keys.push(key), access) };
  const { p, recolter: harvest } = await prepare({ options: { repartiteur: dispatcher } });
  await p.verifier({ auLancement: true });
  expect(harvest.mock.calls[0]![0].ia).toBe(access);
  expect(keys).toEqual([`actus:${START.toISOString()}`]);
  expect(access.oublier).toHaveBeenCalledTimes(1);
});

test("the throttle and the search base are passed to each harvest and each trial; absent, nothing is passed", async () => {
  const pacing = new Pacing();
  const { p, recolter: harvest, recolterEssai: harvestAttempt } = await prepare({ options: { menagement: pacing, urlRecherche: "http://127.0.0.1:9/html/" } });
  await p.verifier({ auLancement: true });
  await p.recolterMaintenant("actus");
  await p.rejouer("actus", "x", "recolte");
  for (const o of [harvest.mock.calls[0]![0], harvest.mock.calls[1]![0], harvestAttempt.mock.calls[0]![0]]) {
    expect(o.menagement).toBe(pacing);
    expect(o.urlRecherche).toBe("http://127.0.0.1:9/html/");
  }
  await p.arreter();
  const without = await prepare();
  await without.p.verifier({ auLancement: true });
  expect(without.recolter.mock.calls[0]![0]).not.toHaveProperty("menagement");
  expect(without.recolter.mock.calls[0]![0]).not.toHaveProperty("urlRecherche");
});

test("accord-requis is never retried on its own", async () => {
  const { p, recoltes: harvests, dossierWidgets: widgetsFolder, avancer: advance } = await prepare();
  await writeWidgetState(widgetsFolder, "actus", { statut: "accord-requis", derniereMaj: null, derniereTentative: null, erreur: "Accord requis" });
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  advance(24 * 60 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  expect(harvests).toEqual([]);
  // An explicit request, however, goes through (the harvest checks the grant itself).
  await p.recolterMaintenant("actus");
  expect(harvests).toEqual(["actus"]);
});

test("workshop stopped: status atelier-arrete, data kept", async () => {
  const { p, recoltes: harvests, dossierWidgets: widgetsFolder, changements: changes, fixerAtelier: setWorkshop } = await prepare({ atelier: "arrete" });
  await writeData(widgetsFolder, "actus", { vieux: true });
  await writeWidgetState(widgetsFolder, "actus", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  expect(harvests).toEqual([]);
  expect(await readWidgetState(widgetsFolder, "actus")).toMatchObject({
    statut: "atelier-arrete",
    derniereMaj: "2026-10-27T08:00:00.000Z",
    erreur: "Mise à jour impossible : atelier arrêté",
  });
  expect(await readData(widgetsFolder, "actus")).toEqual({ vieux: true });
  expect(changes).toHaveBeenCalledTimes(1);
  // Not rewritten every minute.
  await p.verifier({ auLancement: false });
  expect(changes).toHaveBeenCalledTimes(1);
  // recolterMaintenant launches nothing either.
  expect((await p.recolterMaintenant("actus")).statut).toBe("atelier-arrete");
  expect(harvests).toEqual([]);
  // The workshop comes back: the harvest resumes at the next check.
  setWorkshop("demarre");
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
});

test("an error is retried after 15 min, not before", async () => {
  const { p, recoltes: harvests, avancer: advance } = await prepare({ statut: "erreur" });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  advance(14 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  advance(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(harvests).toEqual(["actus", "actus"]);
});

test("in-progress is relaunched at launch only", () => {
  const w = {
    id: "a",
    dossier: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [], web: false }, recolte: { minutes: 60 } },
    etat: { statut: "en-cours" as const, derniereMaj: null, derniereTentative: START.toISOString() },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aWorkflow: false,
    aAffichage: true,
  };
  expect(widgetOf(w, START, { auLancement: true })).toBe(true);
  expect(widgetOf(w, START, { auLancement: false })).toBe(false);
  expect(widgetOf({ ...w, aRecolte: false, etat: { ...w.etat, statut: "ok" } }, START, { auLancement: true })).toBe(false);
});

test("recolterMaintenant waits for the harvest in progress: only one at a time", async () => {
  const { p, recolter: harvest } = await prepare();
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
  const check = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalledTimes(1));
  const state = await p.recolterMaintenant("actus");
  await check;
  expect(max).toBe(1);
  expect(state.statut).toBe("ok");
  expect(harvest).toHaveBeenCalledTimes(2);
});

test("recolterMaintenant on an unknown widget throws an error", async () => {
  const { p } = await prepare();
  await expect(p.recolterMaintenant("absent")).rejects.toThrow(/inconnu/);
});

test("arreter: the harvest in progress is removed and its previous state restored", async () => {
  const { p, recolter: harvest, dossierWidgets: widgetsFolder, atelier: workshop } = await prepare();
  const before: WidgetState = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.dossierWidgets, o.id, { ...before, statut: "en-cours" });
    await new Promise<void>((r) => (kill = r));
    const state: WidgetState = { ...before, statut: "erreur", erreur: "La récolte s'est arrêtée sans résultat" };
    await writeWidgetState(o.dossierWidgets, o.id, state);
    return { etat: state };
  });
  const deleted: string[] = [];
  workshop.supprimerRecolte = async (id) => {
    deleted.push(id);
    kill();
  };
  const check = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalled());
  await p.arreter();
  await check;
  expect(deleted).toEqual(["actus"]);
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
});

test("arreter while the harvest checks the workshop: it does not start", async () => {
  const { p, recolter: harvest, atelier: workshop } = await prepare();
  let release!: () => void;
  const checked = vi.fn();
  workshop.etat = async () => {
    checked();
    await new Promise<void>((r) => (release = r));
    return "demarre";
  };
  const check = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(checked).toHaveBeenCalled());
  const stop = p.arreter();
  release();
  await stop;
  await check;
  expect(harvest).not.toHaveBeenCalled();
});

test("arreter: a harvest that exceeds the wait sees its container removed once more", async () => {
  const { dossierWidgets: widgetsFolder, recolter: harvest, atelier: workshop, c } = await prepare();
  await p!.arreter();
  let launched = false;
  let start!: () => void;
  const firstDeletion = new Promise<void>((r) => (start = r));
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: null });
    // The container starts after the first removal, and the harvest does not finish.
    await firstDeletion;
    launched = true;
    await new Promise(() => {});
    return { etat: { statut: "ok", derniereMaj: null, derniereTentative: null } };
  });
  const deleted: { id: string; lancee: boolean }[] = [];
  workshop.supprimerRecolte = async (id) => {
    deleted.push({ id, lancee: launched });
    start();
  };
  p = new WidgetsScheduler({
    chemins: c,
    dossierWidgets: widgetsFolder,
    moteur: "/moteur",
    atelier: workshop,
    pont: new FakeBridge([], { actif: null, autoriser: false }),
    ia: null,
    intervalleMs: 60 * MIN,
    recolter: harvest,
    attenteArretMs: 100,
  });
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(harvest).toHaveBeenCalled());
  await p.arreter();
  expect(deleted).toEqual([
    { id: "actus", lancee: false },
    { id: "actus", lancee: true },
  ]);
});

test("the first check waits for the workshop to be ready: no « atelier arrêté » at launch", async () => {
  const { dossierWidgets: widgetsFolder, recolter: harvest, atelier: workshop, c, recoltes: harvests } = await prepare();
  await p!.arreter();
  let state: WorkshopState = "arrete";
  workshop.etat = async () => state;
  let ready!: () => void;
  const changes = vi.fn();
  p = new WidgetsScheduler({
    chemins: c,
    dossierWidgets: widgetsFolder,
    moteur: "/moteur",
    atelier: workshop,
    pont: new FakeBridge([], { actif: null, autoriser: false }),
    ia: null,
    intervalleMs: 60 * MIN,
    recolter: harvest,
    surChange: changes,
    pret: new Promise<void>((r) => (ready = r)),
  });
  await p.demarrer();
  await new Promise((r) => setTimeout(r, 50));
  expect((await readWidgetState(widgetsFolder, "actus")).statut).not.toBe("atelier-arrete");
  expect(changes).not.toHaveBeenCalled();
  state = "demarre";
  ready();
  await vi.waitFor(() => expect(harvests).toEqual(["actus"]));
});

test("a harvest that throws an error after writing in-progress leaves a kernel error state", async () => {
  const { p, recolter: harvest, dossierWidgets: widgetsFolder, changements: changes } = await prepare();
  await writeWidgetState(widgetsFolder, "actus", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
  harvest.mockImplementation(async (o) => {
    await writeWidgetState(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: START.toISOString() });
    throw new Error("disque plein SECRET");
  });
  await expect(p.recolterMaintenant("actus")).resolves.toMatchObject({ statut: "erreur" });
  const state = await readWidgetState(widgetsFolder, "actus");
  expect(state).toEqual({
    statut: "erreur",
    derniereMaj: "2026-10-27T08:00:00.000Z",
    derniereTentative: START.toISOString(),
    erreur: INTERNAL_HARVEST_ERROR,
    erreurNoyau: true,
  });
  expect(kernelError(INTERNAL_HARVEST_ERROR)).toBe(true);
  expect(changes).toHaveBeenCalled();
  // Same through the background check.
  await writeWidgetState(widgetsFolder, "actus", { statut: "en-cours", derniereMaj: null, derniereTentative: null });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect((await readWidgetState(widgetsFolder, "actus")).statut).toBe("erreur");
});

test("at each check, grants and data of a widget whose folder disappeared are erased", async () => {
  const { p, dossierWidgets: widgetsFolder, c } = await prepare();
  for (const id of ["actus", "parti"]) {
    await writeData(widgetsFolder, id, { secret: id });
    await giveGrant(widgetsFolder, id, { domaines: ["x.fr"], publiques: [], profil: "defaut" });
  }
  // An unreadable widget keeps its data: its folder exists.
  await writeWidget(c, "casse", "{", {});
  await writeData(widgetsFolder, "casse", { secret: "casse" });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await readGrants(widgetsFolder)).sort()).toEqual(["actus"]);
  expect(existsSync(join(widgetsFolder, "parti"))).toBe(false);
  expect(await readData(widgetsFolder, "casse")).toEqual({ secret: "casse" });
  expect(existsSync(join(widgetsFolder, "actus"))).toBe(true);
  // Without a widgets folder at all (unreadable space), nothing is erased.
  await rm(c.widgets, { recursive: true, force: true });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await readGrants(widgetsFolder))).toEqual(["actus"]);
});

test("a widget with workflow.json without recolte.mjs is harvested when it is due", async () => {
  const { p, c, recoltes: harvests } = await prepare();
  await writeWidget(c, "flux", declarationWidget(undefined, { recolte: { minutes: 60 } }), {
    "workflow.json": JSON.stringify({ version: 1, blocs: [{ id: "sortie", type: "sortie", parametres: { vers: "widget" } }] }),
  });
  expect((await p.verifier({ auLancement: true })).sort()).toEqual(["actus", "flux"]);
  expect(harvests.sort()).toEqual(["actus", "flux"]);
});

test("trigger: planifiee for the check, manuelle by default for recolterMaintenant, otherwise the requested one", async () => {
  const { p, recolter: harvest } = await prepare();
  await p.verifier({ auLancement: true });
  await p.recolterMaintenant("actus");
  await p.recolterMaintenant("actus", "agent");
  expect(harvest.mock.calls.map(([o]) => o.declencheur)).toEqual(["planifiee", "manuelle", "agent"]);
  expect(harvest.mock.calls[0]![0].interrompue).toBeTypeOf("function");
});

test("stop during the run: run interrupted, previous state restored", async () => {
  const { p, recolter: harvest, dossierWidgets: widgetsFolder, atelier: workshop } = await prepare();
  const before: WidgetState = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  const launched = vi.fn();
  // A container that never answers: only the stop ends it.
  const launch: ProcessLauncher = () => {
    launched();
    const end = new Promise<number | null>((r) => (kill = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), tuer: () => kill(), fin: end };
  };
  harvest.mockImplementation((o) => runHarvest({ ...o, lancer: launch }));
  workshop.supprimerRecolte = async () => kill();
  const check = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(launched).toHaveBeenCalled());
  await p.arreter();
  await check;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
  expect((await listRuns(join(widgetsFolder, "actus"))).map((e) => e.statut)).toEqual(["interrompue"]);
});

test("the vanished folder also erases runs and memory", async () => {
  const { p, dossierWidgets: widgetsFolder } = await prepare();
  const folder = join(widgetsFolder, "parti");
  await writeData(widgetsFolder, "parti", { secret: 1 });
  await writeRun(folder, {
    version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "parti" }, declencheur: "planifiee",
    debut: "2026-10-27T08:00:00.000Z", fin: null, statut: "reussie", blocs: [],
  });
  await writeMemory(folder, { a: { type: "liste.nouveaux", valeur: [] } });
  await p.verifier({ auLancement: false });
  expect(existsSync(folder)).toBe(false);
});

/** A promise to resolve from the outside. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promesse: promise, resoudre: resolve };
}

test("a scheduled run due during a trial waits for its end", async () => {
  const { p, recolter: harvest, recolterEssai: harvestAttempt } = await prepare();
  const log: string[] = [];
  const end = deferred<AttemptResult>();
  harvestAttempt.mockImplementation(async (o) => {
    log.push(`essai ${o.id} ${o.origine} ${o.depart}`);
    const r = await end.promesse;
    log.push("fin de l'essai");
    return r;
  });
  harvest.mockImplementation(async (o) => {
    log.push(`récolte ${o.id} ${o.declencheur}`);
    return { etat: { statut: "ok", derniereMaj: START.toISOString(), derniereTentative: START.toISOString() } };
  });
  const attempt = p.rejouer("actus", "2026-10-28T09-00-00-000Z", "liste");
  await vi.waitFor(() => expect(log).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste"]));
  const verification = p.verifier({ auLancement: true });
  await new Promise((r) => setTimeout(r, 30));
  expect(log).toHaveLength(1);
  end.resoudre({ ok: true, execution: "x-essai", statut: "reussie" });
  expect(await attempt).toEqual({ ok: true, execution: "x-essai", statut: "reussie" });
  expect(await verification).toEqual(["actus"]);
  expect(log).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste", "fin de l'essai", "récolte actus planifiee"]);
});

test("two rejouer requested back to back run one after the other", async () => {
  const { p, recolterEssai: harvestAttempt } = await prepare();
  const log: string[] = [];
  const ends = [deferred<void>(), deferred<void>()];
  let n = 0;
  harvestAttempt.mockImplementation(async (o) => {
    const i = n++;
    log.push(`début ${i} ${o.depart}`);
    await ends[i]!.promesse;
    log.push(`fin ${i}`);
    return { ok: true, execution: `e${i}-essai`, statut: "reussie" };
  });
  const a = p.rejouer("actus", "o", "a");
  const b = p.rejouer("actus", "o", "b");
  await vi.waitFor(() => expect(log).toEqual(["début 0 a"]));
  await new Promise((r) => setTimeout(r, 20));
  expect(log).toEqual(["début 0 a"]);
  ends[0]!.resoudre();
  await vi.waitFor(() => expect(log).toEqual(["début 0 a", "fin 0", "début 1 b"]));
  ends[1]!.resoudre();
  expect(await a).toMatchObject({ execution: "e0-essai" });
  expect(await b).toMatchObject({ execution: "e1-essai" });
});

test("an avancement or lecture trace does not change a widget's live tracking", async () => {
  const { p, recolterEssai: harvestAttempt, directs } = await prepare();
  const seen: { avant: DirectState; apres: DirectState; signales: number }[] = [];
  harvestAttempt.mockImplementation(async (o) => {
    o.surTrace!({ bloc: "liste", etape: "debut" });
    const before = structuredClone(p.direct());
    const reported = directs.length;
    o.surTrace!({ bloc: "liste", etape: "avancement", faits: 2, total: 5 });
    o.surTrace!({ bloc: "liste", etape: "lecture", hote: "gitlab.com" });
    o.surTrace!({ bloc: "autre", etape: "lecture", hote: "gitlab.com" });
    seen.push({ avant: before, apres: structuredClone(p.direct()), signales: directs.length - reported });
    return { ok: true, execution: attemptId(START.toISOString()), statut: "reussie" };
  });
  await p.rejouer("actus", "o", "liste");
  expect(seen[0]!.apres).toEqual(seen[0]!.avant);
  expect(seen[0]!.apres.courants[0]!.blocs).toEqual({ liste: { statut: "en-cours", elements: null } });
  expect(seen[0]!.signales).toBe(0);
});

test("direct() shows the running widget, its kind and its blocks as traces come, then nothing", async () => {
  const { p, recolterEssai: harvestAttempt, directs, dossierWidgets: widgetsFolder } = await prepare();
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  const seen: DirectState[] = [];
  harvestAttempt.mockImplementation(async (o) => {
    o.surTrace!({ bloc: "liste", etape: "debut" });
    seen.push(structuredClone(p.direct()));
    o.surTrace!({ bloc: "liste", etape: "fin", statut: "reussi", elements: 3 });
    // Started, without an end: only the final run says it failed.
    o.surTrace!({ bloc: "sortie", etape: "debut" });
    seen.push(structuredClone(p.direct()));
    const e: Execution = {
      version: 1, id: attemptId(START.toISOString()), proprietaire: { type: "widget", id: o.id }, declencheur: "rejeu",
      essai: { depart: o.depart, origine: o.origine }, debut: START.toISOString(), fin: START.toISOString(), statut: "echouee",
      blocs: [
        { id: "liste", type: "code", statut: "reussi", debut: "x", fin: "x", elements: 3, journal: [] },
        { id: "sortie", type: "sortie", statut: "echoue", debut: "x", fin: null, elements: null, journal: [] },
      ],
    };
    await writeRun(join(widgetsFolder, o.id), e);
    return { ok: true, execution: e.id, statut: e.statut };
  });
  await p.rejouer("actus", "o", "liste");
  const start = START.toISOString();
  expect(seen[0]).toEqual({
    courants: [{ widget: "actus", genre: "essai", debut: start, blocs: { liste: { statut: "en-cours", elements: null } } }],
    enAttente: [],
  });
  expect(seen[1]!.courants[0]!.blocs).toEqual({ liste: { statut: "reussi", elements: 3 }, sortie: { statut: "en-cours", elements: null } });
  // End: resynchronized on the written run, then nothing in progress.
  expect(directs.at(-2)!.courants[0]!.blocs).toEqual({ liste: { statut: "reussi", elements: 3 }, sortie: { statut: "echoue", elements: null } });
  expect(directs.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  // A real run is tracked the same way, kind « execution ».
  await p.recolterMaintenant("actus");
  expect(directs.some((d) => d.courants.some((x) => x.genre === "execution" && x.widget === "actus"))).toBe(true);
  expect(p.direct().courants).toEqual([]);
});

test("enAttente lists a widget requested while another runs", async () => {
  const { p, recolterEssai: harvestAttempt, recoltes: harvests } = await prepare();
  const end = deferred<void>();
  harvestAttempt.mockImplementation(async () => {
    await end.promesse;
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  const attempt = p.rejouer("actus", "o", "liste");
  await vi.waitFor(() => expect(p.direct().courants[0]?.widget).toBe("actus"));
  const other = p.recolterMaintenant("fixe");
  await vi.waitFor(() => expect(p.direct().enAttente).toEqual(["fixe"]));
  expect(harvests).toEqual([]);
  end.resoudre();
  await attempt;
  await other;
  expect(harvests).toEqual(["fixe"]);
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
});

test("workshop stopped: rejouer refuses without changing the state", async () => {
  const { p, recolterEssai: harvestAttempt, dossierWidgets: widgetsFolder, changements: changes } = await prepare({ atelier: "arrete" });
  const state: WidgetState = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", state);
  expect(await p.rejouer("actus", "o", "liste")).toEqual({ ok: false, erreur: WORKSHOP_STOPPED_ERROR });
  expect(harvestAttempt).not.toHaveBeenCalled();
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(state);
  expect(changes).not.toHaveBeenCalled();
});

test("widgetDu: a widget with hours without minutes is never due by frequency", () => {
  const w = {
    id: "a",
    dossier: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [], web: false }, recolte: { heures: ["07:00"] } },
    // The time of day is already done: only the frequency could make it due.
    etat: { statut: "ok" as const, derniereMaj: null, derniereTentative: null, heures: { faite: currentSlot(["07:00"], START), echecs: null } },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aWorkflow: false,
    aAffichage: true,
  };
  expect(widgetOf(w, START, { auLancement: true })).toBe(false);
  expect(widgetOf({ ...w, etat: { ...w.etat, statut: "erreur" as const } }, START, { auLancement: false })).toBe(false);
});

// --- Two lanes: watches (dureeMaxMinutes > 3) run apart ---

/** A widget that harvests every 60 min, with the given maximum duration. */
async function writeWatch(c: SpacePaths, id: string, maxDurationMinutes: number) {
  await writeWidget(c, id, declarationWidget(undefined, { recolte: { minutes: 60, dureeMaxMinutes: maxDurationMinutes } }), { "recolte.mjs": "export default () => 1" });
}

/** The harvests of the `retenus` widgets wait for `liberer(id)`; all then go through the base fake harvest. */
function keep(harvest: Awaited<ReturnType<typeof prepare>>["recolter"], kept: string[]) {
  const base = harvest.getMockImplementation()!;
  const log: string[] = [];
  const ends = new Map<string, (() => void)[]>();
  harvest.mockImplementation(async (o) => {
    log.push(`début ${o.id}`);
    if (kept.includes(o.id)) {
      const d = deferred<void>();
      ends.set(o.id, [...(ends.get(o.id) ?? []), d.resoudre]);
      await d.promesse;
    }
    try {
      return await base(o);
    } finally {
      log.push(`fin ${o.id}`);
    }
  });
  return {
    journal: log,
    liberer: (id: string) => {
      const f = ends.get(id)?.shift();
      if (!f) throw new Error(`rien à libérer pour ${id}`);
      f();
    },
  };
}

test("routeOf: long beyond LONG_ROUTE_MINUTES (3), short otherwise", async () => {
  expect(LONG_ROUTE_MINUTES).toBe(3);
  const { c, dossierWidgets: widgetsFolder } = await prepare();
  await writeWatch(c, "trois", 3);
  await writeWatch(c, "quatre", 4);
  const widgets = (await readHome(c, widgetsFolder)).widgets;
  const route = (id: string) => routeOf(widgets.find((w) => w.id === id)!);
  expect([route("actus"), route("trois"), route("quatre"), route("fixe")]).toEqual(["courte", "courte", "longue", "courte"]);
});

test("a long run (dureeMaxMinutes 30) does not prevent a short widget from running", async () => {
  const { p, c, recolter: harvest } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  // The check launches the watch without waiting for it, and harvests « actus » while it runs.
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect(r.journal).toContain("fin actus");
  await vi.waitFor(() => expect(r.journal).toContain("début veille"));
  expect(r.journal).not.toContain("fin veille");
  // A manual request for a short widget goes through too.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("two long widgets: one after the other", async () => {
  const { p, c, recolter: harvest } = await prepare();
  await writeWatch(c, "veille-a", 30);
  await writeWatch(c, "veille-b", 20);
  const r = keep(harvest, ["veille-a", "veille-b"]);
  await p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal.filter((l) => l.startsWith("début veille"))).toHaveLength(1));
  await new Promise((ok) => setImmediate(ok));
  const first = r.journal.find((l) => l.startsWith("début veille"))!.slice("début ".length);
  const second = first === "veille-a" ? "veille-b" : "veille-a";
  expect(r.journal).not.toContain(`début ${second}`);
  r.liberer(first);
  await vi.waitFor(() => expect(r.journal).toContain(`début ${second}`));
  expect(r.journal.indexOf(`fin ${first}`)).toBeLessThan(r.journal.indexOf(`début ${second}`));
  r.liberer(second);
  await vi.waitFor(() => expect(r.journal).toContain(`fin ${second}`));
});

test("a long widget and its trial: never at the same time", async () => {
  const { p, c, recolter: harvest, recolterEssai: harvestAttempt } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  harvestAttempt.mockImplementation(async (o) => {
    r.journal.push(`essai ${o.id}`);
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  const execution = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  const attempt = p.rejouer("veille", "o", "liste");
  await vi.waitFor(() => expect(p.direct().enAttente).toEqual(["veille"]));
  // A short widget runs in the meantime: the waiting trial does not block its lane.
  await p.recolterMaintenant("actus");
  expect(r.journal).not.toContain("essai veille");
  r.liberer("veille");
  await execution;
  expect(await attempt).toMatchObject({ ok: true });
  expect(r.journal.indexOf("fin veille")).toBeLessThan(r.journal.indexOf("essai veille"));
});

test("dureeMaxMinutes changed from 30 to 2 during the run: the new request waits for the first to end", async () => {
  const { p, c, recolter: harvest, recoltes: harvests } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  const first = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  await writeWatch(c, "veille", 2);
  const second = p.recolterMaintenant("veille");
  // The short lane stays free for the other widgets, and a check does not wait for this busy widget.
  await p.recolterMaintenant("actus");
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  expect(r.journal.filter((l) => l === "début veille")).toHaveLength(1);
  r.liberer("veille");
  await first;
  await vi.waitFor(() => expect(r.journal.filter((l) => l === "début veille")).toHaveLength(2));
  expect(r.journal.indexOf("fin veille")).toBeLessThan(r.journal.lastIndexOf("début veille"));
  expect(harvests).toEqual(["actus", "veille"]);
  r.liberer("veille");
  expect((await second).statut).toBe("ok");
});

test("a check is not stuck by a long run: a short widget due later is harvested", async () => {
  const { p, c, recolter: harvest, avancer: advance } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  advance(61 * MIN);
  // « actus » is due again; the watch too according to its data, but it is still running: not relaunched.
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  advance(61 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(r.journal.filter((l) => l === "début veille")).toHaveLength(1);
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("direct().courants lists both runs", async () => {
  const { p, c, recolter: harvest } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille", "actus"]);
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal).toEqual(expect.arrayContaining(["début veille", "début actus"])));
  await vi.waitFor(() =>
    expect(
      p
        .direct()
        .courants.map((x) => x.widget)
        .sort(),
    ).toEqual(["actus", "veille"]),
  );
  expect(p.direct().courants.every((x) => x.genre === "execution")).toBe(true);
  r.liberer("actus");
  await vi.waitFor(() => expect(p.direct().courants.map((x) => x.widget)).toEqual(["veille"]));
  r.liberer("veille");
  await vi.waitFor(() => expect(p.direct()).toEqual({ courants: [], enAttente: [] }));
});

test("arreter removes both containers and waits for both lanes", async () => {
  const { p, c, recolter: harvest, atelier: workshop } = await prepare();
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille", "actus"]);
  const deleted: string[] = [];
  const turn = () => new Promise((ok) => setImmediate(ok));
  workshop.supprimerRecolte = async (id) => {
    deleted.push(id);
    if (id === "actus") return void setImmediate(() => r.liberer(id));
    // The killed watch ends well after the short one (it still writes its memory and its « interrompue » run).
    void (async () => {
      while (!r.journal.includes("fin actus")) await turn();
      for (let i = 0; i < 5; i++) await turn();
      r.liberer(id);
    })();
  };
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(p.direct().courants).toHaveLength(2));
  await p.arreter();
  expect(deleted.sort()).toEqual(["actus", "veille"]);
  expect(r.journal).toEqual(expect.arrayContaining(["fin actus", "fin veille"]));
});

test("arreter: a long run that does not finish is awaited in a bounded way, its container removed twice", async () => {
  const { p, c, recolter: harvest, atelier: workshop } = await prepare({
    options: { attenteArretMs: 1 },
  });
  await writeWatch(c, "veille", 30);
  const r = keep(harvest, ["veille"]);
  const deleted: string[] = [];
  workshop.supprimerRecolte = async (id) => void deleted.push(id);
  await p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal).toContain("début veille"));
  await p.arreter();
  expect(deleted).toEqual(["veille", "veille"]);
  r.liberer("veille");
});

test("the AI goes through the dispatcher: each run has its view, calls reach the given AI, refused after its end", async () => {
  const calls: string[] = [];
  const ai = { kev: async () => "k", gemma: async (o: { prompt: string }) => (calls.push(o.prompt), "g") };
  const { p, c, recolter: harvest, recolterEssai: harvestAttempt } = await prepare({ options: { ia: ai } });
  await writeWatch(c, "veille", 30);
  const responses: unknown[] = [];
  const base = harvest.getMockImplementation()!;
  harvest.mockImplementation(async (o) => {
    responses.push(await o.ia!.gemma({ prompt: o.id }));
    return base(o);
  });
  harvestAttempt.mockImplementation(async (o) => {
    responses.push(await o.ia!.gemma({ prompt: `essai ${o.id}` }));
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  await p.recolterMaintenant("actus");
  await p.recolterMaintenant("veille");
  await p.rejouer("actus", "o", "liste");
  const views = [harvest.mock.calls[0]![0].ia, harvest.mock.calls[1]![0].ia, harvestAttempt.mock.calls[0]![0].ia];
  expect(new Set(views).size).toBe(3);
  for (const v of views) expect(v).not.toBe(ai);
  expect(responses).toEqual(["g", "g", "g"]);
  expect(calls).toEqual(["actus", "veille", "essai actus"]);
  // The run finished, its view refuses: a late call no longer goes to the AI.
  await expect(views[0]!.gemma({ prompt: "tard" })).rejects.toThrow(AI_ABANDONED);
  expect(calls).toHaveLength(3);
});

test("dureeMaxMinutes changed from 2 to 30 while a request waits: it goes into the long lane", async () => {
  const { p, c, recolter: harvest } = await prepare();
  await writeWatch(c, "veille", 2);
  const r = keep(harvest, ["veille"]);
  const first = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  const second = p.recolterMaintenant("veille");
  // Every read the request would do right away (lane choice on request) is finished before the change.
  await new Promise((ok) => setImmediate(ok));
  await vi.waitFor(() => expect(reads.enVol).toBe(0));
  await writeWatch(c, "veille", 30);
  r.liberer("veille");
  await first;
  await vi.waitFor(() => expect(r.journal.filter((l) => l === "début veille")).toHaveLength(2));
  // The second runs in the long lane: the short lane and the check stay free.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  r.liberer("veille");
  expect((await second).statut).toBe("ok");
});

test("widget changed from 30 to 2 just before a trial: the trial goes through during another widget's watch", async () => {
  const { p, c, recolter: harvest, recolterEssai: harvestAttempt } = await prepare();
  await writeWatch(c, "veille-a", 30);
  await writeWatch(c, "veille-b", 30);
  const r = keep(harvest, ["veille-a"]);
  // Watch A runs in the long lane; the scheduler read B at 30 in the meantime.
  const a = p.recolterMaintenant("veille-a");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille-a"]));
  await writeWatch(c, "veille-b", 2);
  expect(await p.rejouer("veille-b", "o", "liste")).toMatchObject({ ok: true });
  expect(harvestAttempt.mock.calls.map((x) => x[0].id)).toEqual(["veille-b"]);
  expect(r.journal).not.toContain("fin veille-a");
  r.liberer("veille-a");
  await a;
});

// --- Heures fixes ---

/** Local time of October 29, 2026 (or of the given day). */
const at = (h: number, m: number, day = 29) => new Date(2026, 9, day, h, m);

/** A widget « matin » at fixed hours (and at a frequency if `minutes`). */
async function writeMorning(c: SpacePaths, harvest: { heures: string[]; minutes?: number }, extra: Record<string, unknown> = {}) {
  await writeWidget(c, "matin", declarationWidget(undefined, { recolte: harvest, ...extra }), { "recolte.mjs": "export default () => 1" });
}

const morning = (harvests: string[]) => harvests.filter((x) => x === "matin").length;

test("hours and minutes: both apply", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { minutes: 120, heures: ["07:00"] });
  fixer(at(6, 0));
  await p.verifier({ auLancement: true });
  expect(morning(harvests)).toBe(1); // by frequency (never harvested)
  // Before the first hour of the day: no effect on the tracking.
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toBeUndefined();
  fixer(at(6, 30));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
  fixer(at(7, 0));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(2); // by the hour, the data is only an hour old
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  for (const [h, m] of [[7, 1], [8, 59]] as const) {
    fixer(at(h, m));
    await p.verifier({ auLancement: false });
  }
  expect(morning(harvests)).toBe(2);
  fixer(at(9, 0));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(3); // by frequency, 2 h after 07:00
});

test("interrupted: caught up at the next launch the same day", async () => {
  const { p, c, recoltes: harvests, recolter: harvest, fixer, dossierWidgets: widgetsFolder, atelier: workshop, relancer: relaunch } = await prepare();
  await writeMorning(c, { heures: ["07:00"] });
  const base = harvest.getMockImplementation()!;
  let kill: (() => void) | undefined;
  harvest.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    harvests.push(o.id);
    await writeWidgetState(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: at(7, 0).toISOString() });
    await new Promise<void>((r) => (kill = r));
    return { etat: { statut: "erreur", derniereMaj: null, derniereTentative: at(7, 0).toISOString(), erreur: "Interrompue" } };
  });
  workshop.supprimerRecolte = async () => kill?.();
  fixer(at(7, 0));
  const check = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(morning(harvests)).toBe(1));
  // `tuer` is only set after the in-progress state is written: without it, arreter() would wait 15 s (F5).
  await vi.waitFor(() => expect(kill).toBeDefined());
  await p.arreter();
  await check;
  // Interrupted: no effect on the tracking, the earlier state is restored.
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null });
  harvest.mockImplementation(base);
  fixer(at(7, 30));
  const p2 = relaunch();
  await p2.verifier({ auLancement: true });
  expect(morning(harvests)).toBe(2);
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  fixer(at(7, 31));
  await p2.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(2);
});

test("abrupt stop (in-progress at launch): the missed hour is caught up once", async () => {
  const { p, c, recoltes: harvests, recolter: harvest, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00", "12:00"] });
  await writeWidgetState(widgetsFolder, "matin", {
    statut: "en-cours", derniereMaj: null, derniereTentative: at(12, 0).toISOString(), progression: { faits: 7, total: 12 },
    heures: { faite: "2026-10-29T07:00", echecs: null },
  });
  fixer(at(14, 0));
  await p.demarrer();
  await vi.waitFor(() => expect(harvest.mock.settledResults.filter((r) => r.type === "fulfilled")).toHaveLength(2));
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: "2026-10-29T12:00", echecs: null });
  fixer(at(14, 1));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
});

test("in-progress at launch of an hours widget already done today: not relaunched, its state restored", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00"] });
  const hours = { faite: "2026-10-29T07:00", echecs: null };
  await writeWidgetState(widgetsFolder, "matin", {
    statut: "en-cours", derniereMaj: at(7, 5).toISOString(), derniereTentative: at(8, 0).toISOString(), progression: { faits: 7, total: 12 }, heures: hours,
  });
  fixer(at(9, 0));
  await p.verifier({ auLancement: true });
  expect(morning(harvests)).toBe(0);
  // No frozen « 7 / 12 ».
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({ statut: "ok", derniereMaj: at(7, 5).toISOString(), derniereTentative: at(8, 0).toISOString(), heures: hours });
});

test("in-progress at launch while a trial waits: the state is restored before any run, the widget relaunched afterwards", async () => {
  const { p, recoltes: harvests, recolterEssai: harvestAttempt, dossierWidgets: widgetsFolder } = await prepare();
  // Fresh data: only the abrupt stop makes it due at launch.
  await writeWidgetState(widgetsFolder, "actus", { statut: "en-cours", derniereMaj: START.toISOString(), derniereTentative: START.toISOString(), progression: { faits: 7, total: 12 } });
  const end = deferred<AttemptResult>();
  const started = deferred<void>();
  harvestAttempt.mockImplementation(async () => {
    started.resoudre();
    return end.promesse;
  });
  const attempt = p.rejouer("actus", "o", "liste");
  await started.promesse;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual({ statut: "ok", derniereMaj: START.toISOString(), derniereTentative: START.toISOString() });
  const verification = p.verifier({ auLancement: true });
  end.resoudre({ ok: true, execution: "x-essai", statut: "reussie" });
  await attempt;
  expect(await verification).toEqual(["actus"]);
  expect(harvests).toEqual(["actus"]);
});

test("a trial does not count for the hour", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00"] });
  fixer(at(7, 0));
  expect(await p.rejouer("matin", "o", "liste")).toMatchObject({ ok: true });
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toBeUndefined();
  fixer(at(7, 1));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
});

test("Mac asleep over several hours: a single catch-up on wake", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00", "09:00", "12:00"] });
  fixer(at(6, 0));
  await p.verifier({ auLancement: true });
  expect(morning(harvests)).toBe(0);
  // Wake at 3 pm: 07:00, 09:00 and 12:00 missed, a single run.
  for (let t = at(15, 0).getTime(); t <= at(23, 59).getTime(); t += 30 * MIN) {
    fixer(new Date(t));
    await p.verifier({ auLancement: false });
  }
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: "2026-10-29T12:00", echecs: null });
});

test("midnight: the hour missed the day before is not caught up, the next day's is", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00", "22:00"] });
  // 22:00 missed on the 29th (WebAiOs closed); reopened after midnight.
  await writeWidgetState(widgetsFolder, "matin", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: { faite: "2026-10-29T07:00", echecs: null } });
  for (const [h, m] of [[0, 0], [0, 1], [3, 0], [6, 59]] as const) {
    fixer(at(h, m, 30));
    await p.verifier({ auLancement: h === 0 && m === 0 });
  }
  expect(morning(harvests)).toBe(0);
  fixer(at(7, 0, 30));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: "2026-10-30T07:00", echecs: null });
});

test("failures: retried 15 min later, 3 times at most, then nothing until the next hour", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare({ statut: "erreur" });
  await writeMorning(c, { heures: ["07:00", "12:00"] });
  const attempts: string[] = [];
  for (let t = at(7, 0).getTime(); t <= at(12, 0).getTime(); t += MIN) {
    fixer(new Date(t));
    const before = morning(harvests);
    await p.verifier({ auLancement: false });
    if (morning(harvests) > before) attempts.push(`${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")}`);
  }
  expect(attempts).toEqual(["7:00", "7:15", "7:30", "7:45", "12:00"]);
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual({ faite: null, echecs: { heure: "2026-10-29T12:00", nombre: 1, fin: at(12, 0).toISOString() } });
});

test("a manual run before the first hour does not erase the previous day's tracking; one at 07:10 counts for 07:00", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  await writeMorning(c, { heures: ["07:00"] });
  const watch = { faite: "2026-10-28T07:00", echecs: null };
  await writeWidgetState(widgetsFolder, "matin", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: watch });
  fixer(at(6, 50));
  expect(await p.recolterMaintenant("matin")).toMatchObject({ statut: "ok" });
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual(watch);
  fixer(at(7, 10));
  expect(await p.recolterMaintenant("matin", "agent")).toMatchObject({ statut: "ok", heures: { faite: "2026-10-29T07:00", echecs: null } });
  fixer(at(7, 11));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(2);
});

test("the hours tracking survives a grant removed then granted again", async () => {
  const { p, c, recoltes: harvests, fixer, dossierWidgets: widgetsFolder } = await prepare();
  const sources = { compte: ["mail.example.com"], publiques: [] };
  await writeMorning(c, { heures: ["07:00"] }, { sources });
  await giveGrant(widgetsFolder, "matin", { domaines: ["mail.example.com"], publiques: [], profil: "defaut" });
  fixer(at(7, 0));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
  const done = { faite: "2026-10-29T07:00", echecs: null };
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual(done);
  // Like refuserAccord: data erased, state waiting for a grant.
  await deleteData(widgetsFolder, "matin");
  const before = await readWidgetState(widgetsFolder, "matin");
  await writeWidgetState(widgetsFolder, "matin", { statut: "accord-requis", derniereMaj: before.derniereMaj, derniereTentative: before.derniereTentative, erreur: "accord", erreurNoyau: true });
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual(done);
  fixer(at(7, 5));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(1);
  // Granted again: the harvest that follows the grant counts, and the hour is not redone.
  await giveGrant(widgetsFolder, "matin", { domaines: ["mail.example.com"], publiques: [], profil: "defaut" });
  await p.recolterMaintenant("matin");
  expect((await readWidgetState(widgetsFolder, "matin")).heures).toEqual(done);
  fixer(at(7, 30));
  await p.verifier({ auLancement: false });
  expect(morning(harvests)).toBe(2);
});

test("watch failing after 30 min: the retry starts at the earliest 15 min after the failure ends", async () => {
  const { p, c, recolter: harvest, fixer, horloge: clock, avancer: advance, dossierWidgets: widgetsFolder } = await prepare({ statut: "erreur" });
  await writeMorning(c, { heures: ["07:00", "12:00"] });
  const base = harvest.getMockImplementation()!;
  const starts: string[] = [];
  harvest.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    const start = clock();
    starts.push(`${start.getHours()}:${String(start.getMinutes()).padStart(2, "0")}`);
    // derniereTentative = the start, like the real harvest; the failure comes 30 min later.
    await writeWidgetState(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: start.toISOString() });
    advance(30 * MIN);
    await writeWidgetState(o.dossierWidgets, o.id, { statut: "erreur", derniereMaj: null, derniereTentative: start.toISOString(), erreur: "délai" });
    return { etat: { statut: "erreur", derniereMaj: null, derniereTentative: start.toISOString(), erreur: "délai" } };
  });
  fixer(at(7, 0));
  while (clock() < at(11, 59)) {
    await p.verifier({ auLancement: false });
    advance(MIN);
  }
  expect(starts).toEqual(["7:00", "7:45", "8:30", "9:15"]);
  const { heures: hours } = await readWidgetState(widgetsFolder, "matin");
  expect(hours?.echecs).toMatchObject({ heure: "2026-10-29T07:00", nombre: 4 });
});

test("abrupt stop: the state from before the run (error) is restored; clean stop: nothing of the run remains", async () => {
  const { p, c, recolter: harvest, fixer, dossierWidgets: widgetsFolder, atelier: workshop, recoltes: harvests } = await prepare();
  await writeMorning(c, { heures: ["07:00"] });
  const hours = { faite: "2026-10-29T07:00", echecs: null };
  await writeWidgetState(widgetsFolder, "matin", {
    statut: "en-cours", derniereMaj: null, derniereTentative: at(8, 0).toISOString(), progression: { faits: 7, total: 12 }, heures: hours,
    avant: { statut: "erreur", erreur: "Sélecteur introuvable", erreurNoyau: true },
  });
  fixer(at(9, 0));
  await p.verifier({ auLancement: true });
  expect(morning(harvests)).toBe(0);
  expect(await readWidgetState(widgetsFolder, "matin")).toEqual({
    statut: "erreur", derniereMaj: null, derniereTentative: at(8, 0).toISOString(), erreur: "Sélecteur introuvable", erreurNoyau: true, heures: hours,
  });
  // Clean stop during a real harvest: the earlier state comes back without the avant field.
  const before: WidgetState = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await writeWidgetState(widgetsFolder, "actus", before);
  let kill!: () => void;
  const launched = vi.fn();
  const launch: ProcessLauncher = () => {
    launched();
    const end = new Promise<number | null>((r) => (kill = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), tuer: () => kill(), fin: end };
  };
  harvest.mockImplementation((o) => runHarvest({ ...o, lancer: launch }));
  workshop.supprimerRecolte = async () => kill?.();
  const now = p.recolterMaintenant("actus");
  await vi.waitFor(() => expect(launched).toHaveBeenCalled());
  expect((await readWidgetState(widgetsFolder, "actus")).avant).toEqual({ statut: "ok" });
  await p.arreter();
  await now;
  expect(await readWidgetState(widgetsFolder, "actus")).toEqual(before);
});

test("a surChange callback that throws during the startup restore does not block the runs", async () => {
  const { dossierWidgets: widgetsFolder, recoltes: harvests, relancer: relaunch, p: first } = await prepare({ options: { surChange: () => { throw new Error("rappel"); } } });
  await first.arreter();
  await writeWidgetState(widgetsFolder, "actus", { statut: "en-cours", derniereMaj: null, derniereTentative: null });
  const p2 = relaunch();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await p2.recolterMaintenant("actus").catch(() => {});
    await expect(p2.verifier({ auLancement: true })).resolves.toEqual(expect.any(Array));
  } finally {
    errors.mockRestore();
  }
  expect(harvests.length).toBeGreaterThan(0);
});

describe("notification de fin de veille", () => {
  /** A « veille » widget that notifies, and a spy notifier; the fake harvest returns `nouveaux` (and `statut`). */
  async function prepareWatch(o: { notifier?: boolean; nouveaux?: number; statut?: WidgetState["statut"]; sansRappel?: boolean } = {}) {
    const notifications: NotificationWidget[] = [];
    const notify = vi.fn((n: NotificationWidget) => void notifications.push(n));
    const t = await prepare({ options: o.sansRappel ? {} : { notifier: notify } });
    await writeWidget(
      t.c,
      "veille",
      declarationWidget(undefined, { nom: "Vélos d'occasion", recolte: { minutes: 60, ...(o.notifier === false ? {} : { notifier: true }) } }),
      { "recolte.mjs": "export default () => 1" },
    );
    t.recolter.mockImplementation(async (r) => {
      const status = o.statut ?? "ok";
      const state: WidgetState = { statut: status, derniereMaj: START.toISOString(), derniereTentative: START.toISOString(), ...(status === "erreur" ? { erreur: "boum" } : {}) };
      if (status === "ok") await writeData(r.dossierWidgets, r.id, [{ titre: "PIÈGE annonce", url: "https://x.test/1" }]);
      await writeWidgetState(r.dossierWidgets, r.id, state);
      return { etat: state, ...(o.nouveaux !== undefined ? { nouveaux: o.nouveaux } : {}) };
    });
    return { ...t, notifier: notify, notifications };
  }

  test("3 new items: one notification, title = widget name, text « 3 nouveaux éléments »", async () => {
    const { p, notifications } = await prepareWatch({ nouveaux: 3 });
    await p.recolterMaintenant("veille");
    expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "3 nouveaux éléments" }]);
  });

  test("1 new item: singular text", async () => {
    const { p, notifications } = await prepareWatch({ nouveaux: 1 });
    await p.recolterMaintenant("veille");
    expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "1 nouvel élément" }]);
  });

  test("zero new, failure, trial, widget without notifier: none", async () => {
    const zero = await prepareWatch({ nouveaux: 0 });
    await zero.p.recolterMaintenant("veille");
    await zero.p.recolterMaintenant("veille", "planifiee");
    expect(zero.notifier).not.toHaveBeenCalled();
    await zero.p.arreter();

    const failure = await prepareWatch({ nouveaux: 2, statut: "erreur" });
    await failure.p.recolterMaintenant("veille");
    expect(failure.notifier).not.toHaveBeenCalled();
    await failure.p.arreter();

    const attempt = await prepareWatch({ nouveaux: 2 });
    expect(await attempt.p.rejouer("veille", "2026-10-28T09-00-00-000Z", "liste")).toMatchObject({ ok: true });
    expect(attempt.recolterEssai).toHaveBeenCalledTimes(1);
    expect(attempt.notifier).not.toHaveBeenCalled();
    await attempt.p.arreter();

    // The widget does not declare `notifier`: even if the harvest returned a count, nothing.
    const without = await prepareWatch({ nouveaux: 2, notifier: false });
    await without.p.recolterMaintenant("veille");
    expect(without.notifier).not.toHaveBeenCalled();
    await without.p.arreter();

    // No callback given to the scheduler: the harvest ends as before.
    const withoutCallback = await prepareWatch({ nouveaux: 2, sansRappel: true });
    expect((await withoutCallback.p.recolterMaintenant("veille")).statut).toBe("ok");
  });

  test("the text contains nothing from the data (trapped listing title)", async () => {
    const { p, notifications, dossierWidgets: widgetsFolder } = await prepareWatch({ nouveaux: 1 });
    await p.recolterMaintenant("veille");
    expect(await readData(widgetsFolder, "veille")).toEqual([{ titre: "PIÈGE annonce", url: "https://x.test/1" }]);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toMatch(/PIÈGE|x\.test/);
    expect(notifications[0]!.texte).toBe("1 nouvel élément");
  });

  test("a notifier that throws does not prevent the run from finishing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { p, notifier: notify, dossierWidgets: widgetsFolder } = await prepareWatch({ nouveaux: 3 });
      notify.mockImplementation(() => {
        throw new Error("Notification impossible");
      });
      const state = await p.recolterMaintenant("veille");
      expect(notify).toHaveBeenCalledTimes(1);
      expect(state.statut).toBe("ok");
      expect((await readWidgetState(widgetsFolder, "veille")).statut).toBe("ok");
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("notification du widget veille"), expect.any(Error));
    } finally {
      errors.mockRestore();
    }
  });
});

test("notification: the widget name is cleaned (controls and invisible characters replaced, on one line)", async () => {
  const notifications: NotificationWidget[] = [];
  const { p, c, recolter: harvest } = await prepare({ options: { notifier: (n) => void notifications.push(n) } });
  await writeWidget(c, "veille", declarationWidget(undefined, { nom: "‮Vélos\n\nd'occasion​\t ", recolte: { minutes: 60, notifier: true } }), {
    "recolte.mjs": "export default () => 1",
  });
  harvest.mockImplementation(async () => ({ etat: { statut: "ok", derniereMaj: START.toISOString(), derniereTentative: START.toISOString() }, nouveaux: 2 }));
  await p.recolterMaintenant("veille");
  expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "2 nouveaux éléments" }]);
});
