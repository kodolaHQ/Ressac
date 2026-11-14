import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths } from "../../src/paths.js";
import { FakeBridge } from "../../src/mcp/fake-bridge.js";
import { createAiDispatcher } from "../../src/ai/dispatcher.js";
import { readRun } from "../../src/workflows/executions.js";
import { WidgetsScheduler } from "../../src/widgets/scheduler.js";
import type { HarvestOptions } from "../../src/widgets/harvest.js";
import type { OptionsAction, LaunchResult } from "../../src/actions/run.js";
import { CONCURRENT_ACTIONS, FileActions, type ActionsState, type OptionsFileActions } from "../../src/actions/file.js";
import { tempFolder } from "../helpers/temp.js";
import { declarationWidget, writeWidget } from "../helpers/home.js";

const ENGINE = join(import.meta.dirname, "..", "..", "docker", "engine");
const SCRIPT = join(ENGINE, "harvester.mjs");
const clock = (() => {
  let t = Date.parse("2026-10-31T10:00:00.000Z");
  return () => new Date((t += 1000));
})();

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise: promise, resolve: resolve };
}

const files: FileActions[] = [];
afterEach(async () => {
  await Promise.all(files.splice(0).map((f) => f.stopAll()));
});

async function prepare(o: Partial<OptionsFileActions> = {}) {
  const c = spacePaths(await tempFolder());
  const actionsFolder = await tempFolder();
  const directs: ActionsState[] = [];
  const deleted: unknown[] = [];
  const f = new FileActions({
    paths: c,
    actionsFolder: actionsFolder,
    engine: ENGINE,
    workshop: { state: async () => "demarre", harvestCommand: (p) => ["docker", JSON.stringify(p)], deleteHarvest: async (p) => void deleted.push(p) },
    bridge: new FakeBridge([], { active: null, allow: false }),
    dispatcher: null,
    clock: clock,
    locale: () => "fr",
    onLive: (e) => directs.push(e),
    ...o,
  });
  files.push(f);
  return { f, c, actionsFolder: actionsFolder, directs, deleted: deleted };
}

/** A fake run per action, which waits for `liberer(id)`. */
function kept() {
  const ends = new Map<string, (r: LaunchResult) => void>();
  const launched: OptionsAction[] = [];
  const run = (o: OptionsAction) => {
    launched.push(o);
    const d = deferred<LaunchResult>();
    ends.set(o.id, d.resolve);
    return d.promise;
  };
  const release = (id: string) => ends.get(id)!({ status: "succeeded", run: `ex-${id}` });
  return { run: run, launchedList: launched, release: release };
}

const waitUntil = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("attente dépassée");
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

describe("FileActions", () => {
  it("three actions: two run, the third waits and appears in waiting", async () => {
    expect(CONCURRENT_ACTIONS).toBe(2);
    const r = kept();
    const { f } = await prepare({ run: r.run });
    const a = f.launch("a", { input: null, trigger: "manual" });
    const b = f.launch("b", { input: "clio lyon", trigger: "manual" });
    const c = f.launch("c", { input: null, trigger: "agent" });
    await waitUntil(() => r.launchedList.length === 2);
    expect(r.launchedList.map((o) => o.id)).toEqual(["a", "b"]);
    const d = f.direct();
    expect(d.running.map((x) => x.action)).toEqual(["a", "b"]);
    expect(d.running[1]).toMatchObject({ input: "clio lyon", attempt: false, step: "workflow", blocks: {} });
    expect(d.waiting.map((x) => x.action)).toEqual(["c"]);
    expect(a.already || b.already || c.already).toBe(false);
    r.release("a");
    expect(await a.end).toEqual({ status: "succeeded", run: "ex-a" });
    await waitUntil(() => r.launchedList.length === 3);
    expect(f.direct().waiting).toEqual([]);
    r.release("b");
    r.release("c");
    await Promise.all([b.end, c.end]);
    expect(f.direct()).toEqual({ running: [], waiting: [] });
  });

  it("relaunching a running action returns deja: true and the same end", async () => {
    const r = kept();
    const { f } = await prepare({ run: r.run });
    const first = f.launch("a", { input: null, trigger: "manual" });
    const second = f.launch("a", { input: "autre", trigger: "manual" });
    expect(second.already).toBe(true);
    expect(second.end).toBe(first.end);
    expect(f.try("a", "x", "y").already).toBe(true);
    await waitUntil(() => r.launchedList.length === 1);
    r.release("a");
    await first.end;
    // Finished: a new request goes through.
    const third = f.launch("a", { input: null, trigger: "manual" });
    expect(third.already).toBe(false);
    await waitUntil(() => r.launchedList.length === 2);
    r.release("a");
    await third.end;
  });

  it("a waiting action that is stopped leaves the queue without running", async () => {
    const r = kept();
    const { f } = await prepare({ run: r.run });
    f.launch("a", { input: null, trigger: "manual" });
    f.launch("b", { input: null, trigger: "manual" });
    const c = f.launch("c", { input: null, trigger: "manual" });
    await waitUntil(() => r.launchedList.length === 2);
    expect(f.stop("c")).toBe(true);
    expect((await c.end).status).toBe("interrupted");
    expect(f.direct().waiting).toEqual([]);
    expect(f.stop("inconnue")).toBe(false);
    // A running action receives the signal.
    expect(f.stop("a")).toBe(true);
    expect(r.launchedList[0]!.signal.aborted).toBe(true);
    r.release("a");
    r.release("b");
  });

  it("attend pret avant de lancer", async () => {
    const r = kept();
    const ready = deferred<void>();
    const { f } = await prepare({ run: r.run, ready: ready.promise });
    f.launch("a", { input: null, trigger: "manual" });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(r.launchedList).toEqual([]);
    ready.resolve();
    await waitUntil(() => r.launchedList.length === 1);
    r.release("a");
  });

  it("each action has its priority AI access, forgotten at the end", async () => {
    const r = kept();
    const dispatcher = createAiDispatcher({ kev: async () => ({}), gemma: async () => "ok" } as never);
    const keys: { key: string; priority?: boolean }[] = [];
    let forgotten = 0;
    const spy = {
      for: (key: string, o?: { priority?: boolean }) => {
        keys.push({ key: key, ...(o?.priority !== undefined ? { priority: o.priority } : {}) });
        const access = dispatcher.for(key, o);
        return { ...access, forget: () => (forgotten++, access.forget()) };
      },
    };
    const { f } = await prepare({ run: r.run, dispatcher: spy });
    const a = f.launch("a", { input: null, trigger: "manual" });
    await waitUntil(() => r.launchedList.length === 1);
    expect(r.launchedList[0]!.ai).not.toBeNull();
    expect(keys).toHaveLength(1);
    expect(keys[0]!.key).toMatch(/^action:a:2026-/);
    expect(keys[0]!.priority).toBe(true);
    r.release("a");
    await a.end;
    expect(forgotten).toBe(1);
  });

  it("an action starts while a widget harvest is running", async () => {
    const r = kept();
    const { f, c } = await prepare({ run: r.run });
    await writeWidget(c, "lent", declarationWidget(undefined, { harvest: { minutes: 60 } }), { "harvest.mjs": "export default () => 1" });
    const keptHarvest = deferred<void>();
    let harvestStarted = false;
    const p = new WidgetsScheduler({
      paths: c,
      widgetsFolder: await tempFolder(),
      engine: ENGINE,
      workshop: { state: async () => "demarre", harvestCommand: () => ["docker"], deleteHarvest: async () => {} },
      bridge: new FakeBridge([], { active: null, allow: false }),
      ai: null,
      harvest: async (_o: HarvestOptions) => {
        harvestStarted = true;
        await keptHarvest.promise;
        return { state: { status: "ok", lastUpdate: null, lastAttempt: null } };
      },
    });
    const harvest = p.harvestNow("lent");
    await waitUntil(() => harvestStarted);
    const a = f.launch("a", { input: null, trigger: "manual" });
    await waitUntil(() => r.launchedList.length === 1);
    r.release("a");
    expect((await a.end).status).toBe("succeeded");
    keptHarvest.resolve();
    await harvest;
    await p.stop();
  });

  it("lecture and avancement traces fill direct()", async () => {
    const r = kept();
    const { f, directs } = await prepare({ run: r.run });
    const a = f.launch("a", { input: null, trigger: "manual" });
    await waitUntil(() => r.launchedList.length === 1);
    const o = r.launchedList[0]!;
    o.onTrace({ block: "lire", step: "start" });
    o.onTrace({ block: "lire", step: "read", host: "gitlab.com" });
    o.onTrace({ block: "lire", step: "progress", done: 7, total: 12 });
    expect(f.direct().running[0]!.blocks).toEqual({ lire: { status: "running", items: null, host: "gitlab.com", done: 7, total: 12 } });
    o.onTrace({ block: "lire", step: "end", status: "succeeded", items: 12 });
    expect(f.direct().running[0]!.blocks.lire).toMatchObject({ status: "succeeded", items: 12 });
    o.onStep("layout");
    expect(f.direct().running[0]!.step).toBe("layout");
    // surDirect is called on each change.
    expect(directs.some((d) => d.running[0]?.blocks.lire?.host === "gitlab.com")).toBe(true);
    expect(directs.at(-1)!.running[0]!.step).toBe("layout");
    // direct() is a copy.
    f.direct().running[0]!.blocks.lire!.status = "failed";
    expect(f.direct().running[0]!.blocks.lire!.status).toBe("succeeded");
    r.release("a");
    await a.end;
    expect(directs.at(-1)).toEqual({ running: [], waiting: [] });
  });

  it("the block type relayed by the trace goes into direct()", async () => {
    const r = kept();
    const { f } = await prepare({ run: r.run });
    const a = f.launch("a", { input: null, trigger: "manual" });
    await waitUntil(() => r.launchedList.length === 1);
    const o = r.launchedList[0]!;
    o.onTrace({ block: "trier", step: "start", type: "ai.sort" });
    expect(f.direct().running[0]!.blocks.trier).toEqual({ status: "running", items: null, type: "ai.sort" });
    o.onTrace({ block: "trier", step: "end", status: "succeeded", items: 2, type: "ai.sort" });
    expect(f.direct().running[0]!.blocks.trier).toEqual({ status: "succeeded", items: 2, type: "ai.sort" });
    r.release("a");
    await a.end;
  });

  it("arreterTout: written run interrupted", async () => {
    const c0 = spacePaths(await tempFolder());
    const folder = join(c0.actions, "public");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ name: "P", sources: { public: ["gitlab.com"] } }));
    await writeFile(
      join(folder, "workflow.json"),
      JSON.stringify({
        version: 1,
        blocks: [{ id: "lire", type: "code", params: { source: "lire.mjs" } }, { id: "sortie", type: "output", params: { to: "page" } }],
        links: [{ from: "lire", to: "sortie" }],
      }),
    );
    await writeFile(join(folder, "lire.mjs"), `export default async (e, w) => ({ t: (await w.readPage("https://gitlab.com/x")).titre });`);
    const bridge = new FakeBridge([], { active: null, allow: false, read: { pages: [], suspended: ["https://gitlab.com/x"] } });
    const { f, actionsFolder: actionsFolder, deleted: deleted } = await prepare({
      paths: c0,
      bridge: bridge,
      localAddresses: true,
      launch: () => {
        const e = spawn(process.execPath, [SCRIPT, folder], { stdio: ["pipe", "pipe", "pipe"] });
        return { stdin: e.stdin, stdout: e.stdout, stderr: e.stderr, kill: () => void e.kill("SIGKILL"), end: new Promise((ok) => e.on("close", (x) => ok(x))) };
      },
    });
    const a = f.launch("public", { input: null, trigger: "manual" });
    await waitUntil(() => bridge.calls.some((x) => x.method === "readPageInvisible"));
    await f.stopAll();
    const r = await a.end;
    expect(r.status).toBe("interrupted");
    const e = await readRun(join(actionsFolder, "public"), r.run!);
    expect(e).toMatchObject({ status: "interrupted", error: "Interrompue : Ressac s'est arrêté", kernelError: true });
    expect(deleted).toContainEqual({ type: "action", id: "public" });
    // After the stop, nothing leaves anymore.
    expect((await f.launch("public", { input: null, trigger: "manual" }).end).status).toBe("interrupted");
  });
});
