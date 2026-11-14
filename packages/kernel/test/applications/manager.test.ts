import { afterEach, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spacePaths, type SpacePaths } from "../../src/paths.js";
import { Workshop } from "../../src/container/workshop.js";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer, type AddressInfo, type Server } from "node:net";
import { ApplicationManager, probeByDefault, type AppState, type Launcher } from "../../src/applications/manager.js";
import { fakeRunner, type Response } from "../helpers/fake-runner.js";
import { tempFolder } from "../helpers/temp.js";

const managers: ApplicationManager[] = [];
afterEach(async () => {
  for (const g of managers.splice(0)) await g.stopWatching();
});

/** Fake launcher: keeps the argv, and each process ends when the test calls `finir`. */
function fakeLauncher() {
  const process: { argv: string[]; killed: boolean; finish: (code: number | null) => void }[] = [];
  const launcher: Launcher = (argv) => {
    const callbacks: ((code: number | null) => void)[] = [];
    const p = { argv, killed: false, finish: (code: number | null) => callbacks.forEach((r) => r(code)) };
    process.push(p);
    return {
      onEnd: (r) => callbacks.push(r),
      kill: () => {
        p.killed = true;
      },
    };
  };
  return { launcher: launcher, process: process };
}

/** Scripted probe: each port returns its answers in order, then repeats the last one (default « libre »). */
function scriptedProbe(script: Record<number, ("http" | "occupe" | "libre")[]>) {
  return async (port: number) => {
    const r = script[port] ?? ["libre"];
    return r.length > 1 ? r.shift()! : r[0]!;
  };
}

async function space(projects: Record<string, string | null> = { todo: '{"name":"Todo","type":"app","launch":"npx vite --port {port}"}' }) {
  const c = spacePaths(await tempFolder());
  for (const [folder, manifest] of Object.entries(projects)) {
    await mkdir(join(c.projects, folder), { recursive: true });
    if (manifest !== null) await writeFile(join(c.projects, folder, "ressac.json"), manifest);
  }
  return c;
}

function prepare(o: {
  paths: SpacePaths;
  probe?: (port: number) => Promise<"http" | "occupe" | "libre">;
  ports?: [number, number];
  inspect?: Response;
  info?: Response;
}) {
  const { run: run, calls: calls } = fakeRunner([
    [/ info$/, o.info ?? { code: 0 }],
    [/ inspect /, o.inspect ?? { code: 0, stdout: "true\n" }],
  ]);
  const workshop = new Workshop({ paths: o.paths, docker: "docker", run: run });
  const { launcher: launcher, process: process } = fakeLauncher();
  const states: AppState[] = [];
  const g: ApplicationManager = new ApplicationManager({
    paths: o.paths,
    locale: () => "fr",
    workshop: workshop,
    launcher: launcher,
    ports: o.ports ?? [5280, 5284],
    readyDelayMs: 200,
    probeIntervalMs: 20,
    probe: o.probe ?? scriptedProbe({ 5280: ["libre", "http"] }),
    onChange: () => states.push(g.stateOf("todo")),
  });
  managers.push(g);
  const stops = () => calls.filter((a) => a.args[0] === "exec" && a.args[4]?.includes("RESSAC_APP=")).map((a) => a.args[4]!);
  return { g, workshop: workshop, process: process, states: states, calls: calls, stops: stops };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await sleep(5);
  expect(condition()).toBe(true);
}

test("lancer: free port, en-marche when the port answers", async () => {
  const c = await space();
  const { g, process: process, states: states } = prepare({ paths: c });
  expect(await g.launch("todo")).toMatchObject({ folder: "todo", name: "Todo", type: "app", state: "running", port: 5280 });
  expect(states).toEqual(["launching", "running"]);
  expect(process).toHaveLength(1);
  expect(process[0]!.argv).toContain("-e");
  expect(process[0]!.argv).toContain("RESSAC_APP=todo");
  expect(process[0]!.argv.at(-1)).toBe("npx vite --port 5280");
  expect(await g.list()).toMatchObject([{ folder: "todo", state: "running", port: 5280 }]);
});

test("an occupied port is skipped", async () => {
  const c = await space();
  const { g } = prepare({ paths: c, probe: scriptedProbe({ 5280: ["occupe"], 5281: ["libre", "http"] }) });
  expect(await g.launch("todo")).toMatchObject({ state: "running", port: 5281 });
});

test("a port that answers in HTTP (server launched by hand by the agent) is skipped", async () => {
  const c = await space();
  const { g } = prepare({ paths: c, probe: scriptedProbe({ 5280: ["http"], 5281: ["libre", "http"] }) });
  expect(await g.launch("todo")).toMatchObject({ state: "running", port: 5281 });
});

test("no more free ports", async () => {
  const c = await space({
    todo: '{"type":"app","launch":"x"}',
    autre: '{"type":"app","launch":"y"}',
  });
  const { g } = prepare({ paths: c, ports: [5280, 5280], probe: scriptedProbe({ 5280: ["libre", "http"] }) });
  expect(await g.launch("autre")).toMatchObject({ state: "running", port: 5280 });
  expect(await g.launch("todo")).toMatchObject({ state: "error", error: "Plus de port libre : arrête une application." });
});

test("the process exits right away: error without waiting for the delay", async () => {
  const c = await space();
  const { g, process: process } = prepare({ paths: c, probe: scriptedProbe({}) });
  const result = g.launch("todo");
  await until(() => process.length === 1);
  await mkdir(c.logs, { recursive: true });
  await writeFile(join(c.logs, "todo.log"), "démarrage\nboum\n");
  const start = Date.now();
  process[0]!.finish(3);
  const app = await result;
  expect(Date.now() - start).toBeLessThan(50);
  expect(app.state).toBe("error");
  expect(app.error).toContain("Arrêtée avec le code 3");
  expect(app.error).toContain("boum");
});

test("the port never answers: error after readyDelayMs, process stopped", async () => {
  const c = await space();
  const { g, process: process, stops: stops } = prepare({ paths: c, probe: scriptedProbe({}) });
  const start = Date.now();
  const app = await g.launch("todo");
  expect(Date.now() - start).toBeGreaterThanOrEqual(190);
  expect(app.state).toBe("error");
  expect(app.error).toContain("5280");
  expect(process[0]!.killed).toBe(true);
  expect(stops()).toHaveLength(1);
  expect(stops()[0]).toContain("RESSAC_APP=todo");
  // The killed process's end does not replace the error.
  process[0]!.finish(null);
  expect((await g.list())[0]).toMatchObject({ state: "error", error: app.error });
});

test("arreter during the launch: arretee, not an error", async () => {
  const c = await space();
  const { g, process: process, stops: stops } = prepare({ paths: c, probe: scriptedProbe({}) });
  const result = g.launch("todo");
  await until(() => process.length === 1);
  await g.stop("todo");
  process[0]!.finish(143);
  expect(await result).toMatchObject({ state: "stopped" });
  expect(process[0]!.killed).toBe(true);
  expect(stops()).toHaveLength(1);
  expect((await g.list())[0]).toMatchObject({ state: "stopped" });
  expect((await g.list())[0]!.error).toBeUndefined();
});

test("arreter while a second launch waits in the queue: it is cancelled too", async () => {
  const c = await space();
  const { g, process: process } = prepare({ paths: c, probe: scriptedProbe({}) });
  const first = g.launch("todo");
  await until(() => process.length === 1);
  const second = g.launch("todo");
  await g.stop("todo");
  expect(await first).toMatchObject({ state: "stopped" });
  expect(await second).toMatchObject({ state: "stopped" });
  expect(process).toHaveLength(1);
  expect(g.stateOf("todo")).toBe("stopped");
});

test("arreter before the launch has started (project read): arretee, nothing launched", async () => {
  const c = await space();
  const { g, process: process } = prepare({ paths: c });
  const result = g.launch("todo");
  await g.stop("todo");
  expect(await result).toMatchObject({ state: "stopped" });
  expect(process).toHaveLength(0);
});

test("a launch requested after a stop is not cancelled by it", async () => {
  const c = await space();
  const { g } = prepare({ paths: c });
  await g.stop("todo");
  expect(await g.launch("todo")).toMatchObject({ state: "running" });
});

/** Promise resolved by the test. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise: promise, resolve: resolve };
}

test("a launch right after a stop waits for the stop script to end (which would kill it)", async () => {
  const c = await space();
  const { g, workshop: workshop, process: process } = prepare({ paths: c, probe: scriptedProbe({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.launch("todo");
  const script = deferred();
  vi.spyOn(workshop, "stopApp").mockReturnValue(script.promise);
  const stop = g.stop("todo");
  const relaunch = g.launch("todo");
  await sleep(50);
  expect(process).toHaveLength(1);
  script.resolve();
  await stop;
  expect(await relaunch).toMatchObject({ state: "running" });
  expect(process).toHaveLength(2);
});

test("a launch during the orphan cleanup waits for its end", async () => {
  const c = await space();
  const { g, workshop: workshop, process: process } = prepare({ paths: c });
  const cleanup = deferred();
  vi.spyOn(workshop, "stopOrphanApps").mockReturnValue(cleanup.promise);
  const startup = g.start();
  const launch = g.launch("todo");
  await sleep(50);
  expect(process).toHaveLength(0);
  cleanup.resolve();
  await startup;
  expect(await launch).toMatchObject({ state: "running" });
  expect(process).toHaveLength(1);
});

test("the project watching does not wait for the orphan cleanup (Docker starting up)", async () => {
  const c = await space();
  const { g, workshop: workshop, states: states } = prepare({ paths: c });
  const cleanup = deferred();
  vi.spyOn(workshop, "stopOrphanApps").mockReturnValue(cleanup.promise);
  const startup = g.start();
  await sleep(400);
  await mkdir(join(c.projects, "nouveau"), { recursive: true });
  await writeFile(join(c.projects, "nouveau", "ressac.json"), '{"type":"poc","launch":"x"}');
  await until(() => states.length > 0);
  cleanup.resolve();
  await startup;
});

test("stopAll also cancels a queued launch: nothing is launched after", async () => {
  const c = await space();
  const { g, process: process } = prepare({ paths: c, probe: scriptedProbe({}) });
  const first = g.launch("todo");
  await until(() => process.length === 1);
  const second = g.launch("todo");
  await g.stopAll();
  expect(await first).toMatchObject({ state: "stopped" });
  expect(await second).toMatchObject({ state: "stopped" });
  await sleep(50);
  expect(process).toHaveLength(1);
  expect(process[0]!.killed).toBe(true);
});

test("stop of the running app by its process ending: error", async () => {
  const c = await space();
  const { g, process: process, states: states } = prepare({ paths: c });
  await g.launch("todo");
  process[0]!.finish(1);
  await until(() => states.at(-1) === "error");
  const app = (await g.list())[0]!;
  expect(app).toMatchObject({ state: "error" });
  expect(app.error).toContain("Arrêtée avec le code 1");
  expect(app.port).toBeUndefined();
});

test("relaunching a running app stops it first", async () => {
  const c = await space();
  const { g, process: process, stops: stops } = prepare({ paths: c, probe: scriptedProbe({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.launch("todo");
  expect(await g.launch("todo")).toMatchObject({ state: "running", port: 5280 });
  expect(process[0]!.killed).toBe(true);
  expect(stops()).toHaveLength(1);
  expect(process).toHaveLength(2);
});

test("without a fiche or unknown folder: lancer refuses", async () => {
  const c = await space({ brut: null });
  const { g, process: process } = prepare({ paths: c });
  await expect(g.launch("brut")).rejects.toThrow(/sans fiche/);
  await expect(g.launch("absent")).rejects.toThrow(/inconnu/);
  expect(process).toHaveLength(0);
  expect(await g.list()).toMatchObject([{ folder: "brut", type: "no-manifest", noManifest: "pas de ressac.json", state: "stopped" }]);
});

test("oublier: a project recreated under the same name no longer shows the old error", async () => {
  const c = await space();
  const { g } = prepare({ paths: c, info: { code: 1 } });
  expect(await g.launch("todo")).toMatchObject({ state: "error" });
  g.forget("todo");
  expect(g.stateOf("todo")).toBe("stopped");
  const [todo] = await g.list();
  expect(todo).toMatchObject({ state: "stopped" });
  expect(todo!.error).toBeUndefined();
});

test("docker absent: error Docker n'est pas lancé", async () => {
  const c = await space();
  const { g, process: process } = prepare({ paths: c, info: { code: 1 } });
  expect(await g.launch("todo")).toMatchObject({ state: "error", error: "Docker n'est pas lancé." });
  expect(process).toHaveLength(0);
});

test("container stopped: preparation then launch", async () => {
  const c = await space();
  const { g, workshop: workshop, states: states } = prepare({ paths: c, inspect: { code: 0, stdout: "false\n" } });
  const ensure = vi.spyOn(workshop, "ensureStarted").mockResolvedValue("demarre");
  expect(await g.launch("todo")).toMatchObject({ state: "running" });
  expect(ensure).toHaveBeenCalledOnce();
  expect(states).toEqual(["preparing", "launching", "running"]);
});

test("demarrer stops the RESSAC_APP orphans", async () => {
  const c = await space();
  const { g, stops: stops } = prepare({ paths: c });
  await g.start();
  expect(stops()).toHaveLength(1);
  expect(stops()[0]).toContain("RESSAC_APP=.*");
});

test("demarrer on a stopped container: nothing to stop", async () => {
  const c = await space();
  const { g, stops: stops } = prepare({ paths: c, inspect: { code: 0, stdout: "false\n" } });
  await g.start();
  expect(stops()).toHaveLength(0);
});

test("stopAll stops each running app", async () => {
  const c = await space({
    todo: '{"type":"app","launch":"x"}',
    autre: '{"type":"poc","launch":"y"}',
  });
  const { g, process: process, stops: stops } = prepare({ paths: c, probe: scriptedProbe({ 5280: ["libre", "http"], 5281: ["libre", "http"] }) });
  await g.launch("todo");
  await g.launch("autre");
  await g.stopAll();
  expect(process.every((p) => p.killed)).toBe(true);
  expect(stops().sort()).toHaveLength(2);
  expect((await g.list()).map((a) => a.state)).toEqual(["stopped", "stopped"]);
});

test("log: the last lines, empty if absent", async () => {
  const c = await space();
  const { g } = prepare({ paths: c });
  expect(await g.log("todo")).toBe("");
  await mkdir(c.logs, { recursive: true });
  await writeFile(join(c.logs, "todo.log"), "a\nb\nc\n");
  expect(await g.log("todo", 2)).toBe("b\nc");
  await expect(g.log("../x")).rejects.toThrow();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

test("default probe: closed port → libre", async () => {
  const server = tcpServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  expect(await probeByDefault(port)).toBe("libre");
});

test("default probe: connection accepted then cut (Docker proxy without a server) → libre", async () => {
  const server = tcpServer((s) => s.resetAndDestroy());
  try {
    expect(await probeByDefault(await listen(server))).toBe("libre");
  } finally {
    server.close();
  }
});

test("default probe: HTTP server → http", async () => {
  const server = httpServer((_, res) => res.writeHead(404).end());
  try {
    expect(await probeByDefault(await listen(server))).toBe("http");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("default probe: connection accepted without an answer in 1 s → occupe", async () => {
  const sockets: import("node:net").Socket[] = [];
  const server = tcpServer((s) => sockets.push(s));
  try {
    expect(await probeByDefault(await listen(server))).toBe("occupe");
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});
