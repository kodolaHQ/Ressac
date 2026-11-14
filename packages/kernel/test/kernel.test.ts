import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { SessionAgent } from "../src/pty/session.js";
import { Workshop } from "../src/container/workshop.js";
import type { Runner } from "../src/container/runner.js";
import { spacePaths } from "../src/paths.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createKernel, WorkshopError, type Kernel } from "../src/kernel.js";
import type { LocalAi } from "../src/ai/local-ai.js";
import { WidgetsScheduler } from "../src/widgets/scheduler.js";
import { giveGrant, readGrants } from "../src/widgets/grants.js";
import { writeRun, idExecution, type Execution } from "../src/workflows/executions.js";
import { writeResult } from "../src/actions/data.js";
import { writeData, readData, readWidgetState } from "../src/home/data.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { declarationWidget, writeWidget } from "./helpers/home.js";
import { FakeBridge } from "../src/mcp/fake-bridge.js";
import { tempFolder } from "./helpers/temp.js";
import { fakeRunner } from "./helpers/fake-runner.js";

let kernel: Kernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

async function createWithoutDocker() {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  return kernel;
}

const readMcp = async (n: Kernel) => JSON.parse(await readFile(n.paths.mcpConfig, "utf8")).mcpServers.ressac;

/** Workshop whose « docker » is a fake script (it only sleeps for an `exec -it`, one session; any other call fails fast): a session pty never touches the real Docker. */
async function workshopWithoutDocker(root: string, run: Runner): Promise<Workshop> {
  const fake = join(`${root}-bin`, "docker");
  await mkdir(dirname(fake), { recursive: true });
  await writeFile(fake, '#!/bin/sh\ncase " $* " in *" -it "*) exec sleep 60;; *) exit 1;; esac\n', { mode: 0o755 });
  return new Workshop({ paths: spacePaths(root), run: run, docker: fake });
}

test("createKernel initializes the space and writes mcp.json with host.docker.internal", async () => {
  const n = await createWithoutDocker();
  expect(existsSync(join(n.paths.root, "AGENTS.md"))).toBe(true);
  const mcp = await readMcp(n);
  expect(mcp.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  expect(mcp.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test("Docker absent: createKernel succeeds, workshopState → docker-absent, openAgentSession throws WorkshopError", async () => {
  const n = await createWithoutDocker();
  expect(await n.workshopState()).toBe("docker-absent");
  const error = await n.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.state).toBe("docker-absent");
});

test("the MCP server answers with the token, then arreter closes it", async () => {
  const n = await createWithoutDocker();
  const mcp = await readMcp(n);
  const local = mcp.url.replace("host.docker.internal", "127.0.0.1");
  expect((await fetch(local, { method: "POST" })).status).toBe(401);
  await n.stop();
  kernel = undefined;
  await expect(fetch(local, { method: "POST" })).rejects.toThrow();
});

test("profil inconnu → erreur claire", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  await expect(
    createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, profileId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("createKernel does not wait for a slow image build", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // never ends
  ]);
  const start = Date.now();
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  expect(Date.now() - start).toBeLessThan(2000);
});

test("container start failure: createKernel succeeds, the session throws WorkshopError with the message", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const error = await kernel.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.message).toContain("port is already allocated");
});

test("build failed at launch: the first session returns that failure without rebuilding right away", async () => {
  const root = await tempFolder();
  const { run: run, calls: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 1 }],
    [/ inspect -f/, { code: 1 }],
    [/ build /, { code: 1, stderr: "réseau coupé" }],
  ]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const error = await kernel.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error.message).toContain("réseau coupé");
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(1);
  // Retry: a new attempt.
  await kernel.openAgentSession({ cols: 80, rows: 24 }).catch(() => {});
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(2);
});

test("at launch, once the container is ready, the agents of a previous app are stopped before any session", async () => {
  const root = await tempFolder();
  const { run: run, calls: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  // Up-to-date container: the mount probe returns the expected root and hash.
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = (c, args, o) =>
    args.includes("{{.State.Running}}") ? run(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : run(c, args, o);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: runUpToDate, workshop: workshop });
  await kernel.openAgentSession({ cols: 80, rows: 24 }).then((s) => s.stop(), () => {});
  const execs = calls.filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
  // The cleanup (all marked sessions) runs before the open session is stopped here.
  expect(execs[0]).toContain("/tmp/ressac-session-*.pid");
  expect(execs[1]).toMatch(/ressac-session-[0-9a-f]+\.pid/);
});

test("createKernel reads models and Dockerfile from resources", async () => {
  const root = await tempFolder();
  const copy = await tempFolder();
  await cp(join(import.meta.dirname, "..", "templates"), join(copy, "templates"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "docker"), join(copy, "docker"), { recursive: true });
  await writeFile(join(copy, "templates", "fr", "AGENTS.md"), "# copie");
  const { run: run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, resources: copy, run: run });
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("relocalize swaps the untouched templates to the new language", async () => {
  const root = await tempFolder();
  let locale = "fr";
  const { run: run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  kernel = await createKernel({ locale: () => locale, widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const templates = join(import.meta.dirname, "..", "templates");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(await readFile(join(templates, "fr", "AGENTS.md"), "utf8"));
  locale = "en";
  await kernel.relocalize();
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(await readFile(join(templates, "en", "AGENTS.md"), "utf8"));
  expect(await readFile(join(root, "home", "widgets", "meteo", "widget.json"), "utf8")).toBe(await readFile(join(templates, "en", "widgets", "meteo", "widget.json"), "utf8"));
});

test("createKernel reuses the provided workshop", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  const workshop = new Workshop({ paths: spacePaths(root), run: run });
  const state = vi.spyOn(workshop, "state").mockResolvedValue("docker-absent");
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, workshop: workshop });
  await kernel.workshopState();
  expect(state).toHaveBeenCalled();
});

test("arreter: new conversation for the policy (pending cards drop) and dev tools released", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const released: number[] = [];
  let n = 0;
  const bridge = new FakeBridge([], { active: null, allow: false, devTools: true });
  const tools = bridge.devTools!;
  (tools as { owner?: () => unknown }).owner = () => {
    const num = ++n;
    return Object.assign(Object.create(tools), { release: () => released.push(num) });
  };
  const first = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: bridge, root: root, run: run });
  const conversation = first.policy.conversation;
  await first.stop();
  expect(first.policy.conversation).toBe(conversation + 1);
  expect(released).toEqual([1]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: bridge, root: root, run: run });
  expect(n).toBe(2);
});

test("kernel: arreter() stops the scheduler and the local AI", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const order: string[] = [];
  const original = WidgetsScheduler.prototype.stop;
  const schedule = vi.spyOn(WidgetsScheduler.prototype, "stop").mockImplementation(async function (this: WidgetsScheduler) {
    await original.call(this);
    order.push("planificateur");
  });
  // The kernel closes its own access to the AI (a late harvest does not restart Kev), not the shared AI.
  const access = { kev: vi.fn(), gemma: vi.fn(), close: vi.fn(async () => void order.push("ia")) };
  const ai = { access: () => access, stop: vi.fn() } as unknown as LocalAi;
  const n = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, ai: ai });
  expect(n.ai).toBe(ai);
  await n.stop();
  expect(order).toEqual(["planificateur", "ia"]);
  expect(ai.stop).not.toHaveBeenCalled();
  schedule.mockRestore();
});

test("kernel: readHome reads the widgets; ia is null without local AI", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  await writeWidget(kernel.paths, "meteo", declarationWidget());
  const state = await kernel.readHome();
  expect(state.widgets.map((w) => w.id)).toContain("meteo");
  expect(kernel.ai).toBeNull();
});

test("kernel: accorder records the grant (domains sorted), notifies and starts a harvest; refuserAccord removes it", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const onChange = vi.fn();
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, onChange: onChange });
  await writeWidget(
    kernel.paths,
    "daily",
    declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { account: ["b.dev", "a.dev"], public: ["z.com", "y.com"] } }),
    { "harvest.mjs": "export default () => 1" },
  );
  await kernel.grant({ id: "daily", profile: "perso", account: ["a.dev", "b.dev"], public: ["z.com", "y.com"] });
  expect((await readGrants(widgetsFolder)).daily).toEqual({ domains: ["a.dev", "b.dev"], public: ["y.com", "z.com"], profile: "perso" });
  expect(onChange).toHaveBeenCalled();
  // Docker absent: the started harvest ends with « atelier arrêté ».
  await vi.waitFor(async () => expect((await readWidgetState(widgetsFolder, "daily")).status).toBe("workshop-stopped"));
  // Messages written by the kernel: marked as such (they can go out to the agent without a grant).
  expect((await readWidgetState(widgetsFolder, "daily")).kernelError).toBe(true);

  onChange.mockClear();
  await kernel.denyGrant("daily");
  expect((await readGrants(widgetsFolder)).daily).toBeUndefined();
  expect(await readWidgetState(widgetsFolder, "daily")).toMatchObject({ status: "grant-required", kernelError: true });
  expect(onChange).toHaveBeenCalled();
});

test("kernel: accorder refuses a widget without an account", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  await writeWidget(kernel.paths, "meteo", declarationWidget());
  await expect(kernel.grant({ id: "meteo", profile: "perso", account: [], public: [] })).rejects.toThrow(/compte/);
});

test("kernel: accorder refuses if the declaration is no longer the one shown to the user (account or public ones)", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  await writeWidget(
    kernel.paths,
    "daily",
    declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { account: ["app.daily.dev"], public: ["espion.example"] } }),
    { "harvest.mjs": "export default () => 1" },
  );
  // Shown without the public domain (old declaration): refused.
  await expect(kernel.grant({ id: "daily", profile: "perso", account: ["app.daily.dev"], public: [] })).rejects.toThrow(/a changé/);
  await expect(kernel.grant({ id: "daily", profile: "perso", account: ["autre.dev"], public: ["espion.example"] })).rejects.toThrow(/a changé/);
  await expect(kernel.grant({ id: "daily", profile: "perso", account: ["app.daily.dev", "app.daily.dev"], public: ["espion.example"] })).rejects.toThrow(/a changé/);
  expect(await readGrants(widgetsFolder)).toEqual({});
  // Exactly what is declared: granted.
  await kernel.grant({ id: "daily", profile: "perso", account: ["app.daily.dev"], public: ["espion.example"] });
  expect((await readGrants(widgetsFolder)).daily).toEqual({ domains: ["app.daily.dev"], public: ["espion.example"], profile: "perso" });
});

test("kernel: refuserAccord erases the data; account removed afterwards → widget_data returns nothing of the account", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const decl = (account: string[]) => declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { account: account, public: [] } });
  await writeWidget(kernel.paths, "daily", decl(["app.daily.dev"]), { "harvest.mjs": "export default () => 1" });
  await kernel.grant({ id: "daily", profile: "perso", account: ["app.daily.dev"], public: [] });
  await writeData(widgetsFolder, "daily", { secret: "du compte" });
  await kernel.denyGrant("daily");
  expect(await readData(widgetsFolder, "daily")).toBeNull();
  // The agent removes the account: the widget becomes public again, with nothing from the account.
  await writeWidget(kernel.paths, "daily", decl([]), { "harvest.mjs": "export default () => 1" });
  const mcp = await readMcp(kernel);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url.replace("host.docker.internal", "127.0.0.1")), {
      requestInit: { headers: { Authorization: mcp.headers.Authorization } },
    }),
  );
  const r = await client.callTool({ name: "widget_data", arguments: { id: "daily" } });
  await client.close();
  const t = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
  expect(t).not.toContain("du compte");
  expect(t).toContain("Aucune donnée");
});

test("kernel: rejouer goes through the scheduler queue; surDirect follows the queue and unsubscribes", async () => {
  const n = await createWithoutDocker();
  await writeWidget(n.paths, "meteo", declarationWidget(undefined, { harvest: { minutes: 60 } }), { "harvest.mjs": "export default () => 1" });
  const seen: unknown[] = [];
  const unsubscribe = n.onLive((e) => seen.push(e));
  expect(await n.replay("meteo", "2026-10-28T09-00-00-000Z", "recolte")).toEqual({ ok: false, error: "Mise à jour impossible : atelier arrêté" });
  expect(seen).toContainEqual({ running: [], waiting: ["meteo"] });
  expect(seen.at(-1)).toEqual({ running: [], waiting: [] });
  expect(n.direct()).toEqual({ running: [], waiting: [] });
  unsubscribe();
  const before = seen.length;
  await n.replay("meteo", "2026-10-28T09-00-00-000Z", "recolte");
  expect(seen).toHaveLength(before);
});

// Docker « ready » (fake executor); the session pty launches a fake binary that sleeps, never the real Docker.
async function createReady() {
  const root = await tempFolder();
  const { run: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = (c, args, o) =>
    args.includes("{{.State.Running}}") ? run(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : run(c, args, o);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: runUpToDate, workshop: workshop });
  return kernel;
}

test("a session opened for a window writes its own MCP config, deleted when the session ends", async () => {
  const n = await createReady();
  const folder = join(n.paths.internal, "sessions");
  const session = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" });
  const files = await readdir(folder);
  expect(files).toHaveLength(1);
  const clean = JSON.parse(await readFile(join(folder, files[0]!), "utf8")).mcpServers.ressac;
  const principal = await readMcp(n);
  expect(clean.url).toBe(principal.url);
  expect(clean.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  expect(clean.headers.Authorization).not.toBe(principal.headers.Authorization);
  expect((await (await import("node:fs/promises")).stat(join(folder, files[0]!))).mode & 0o777).toBe(0o600);
  await session.stop();
  await vi.waitFor(async () => expect(await readdir(folder)).toEqual([]));
});

test("at kernel startup, session configs left behind by a crash are purged", async () => {
  const root = await tempFolder();
  const folder = join(spacePaths(root).internal, "sessions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "reste.json"), "{}");
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  expect(existsSync(join(folder, "reste.json"))).toBe(false);
});

test("arreter deletes the config of a still-open session", async () => {
  const n = await createReady();
  const folder = join(n.paths.internal, "sessions");
  const session = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" });
  const [file] = await readdir(folder);
  expect(existsSync(join(folder, file!))).toBe(true);
  const stop = n.stop();
  kernel = undefined;
  await stop;
  expect(existsSync(join(folder, file!))).toBe(false);
  await session.stop();
});

test("a session whose folder is a symbolic link is refused, nothing is written elsewhere", async () => {
  const n = await createReady();
  const target = await tempFolder();
  const folder = join(n.paths.internal, "sessions");
  await mkdir(n.paths.internal, { recursive: true });
  await symlink(target, folder);
  await expect(n.openAgentSession({ cols: 80, rows: 24, window: "F1" })).rejects.toThrow(/Dossier des sessions invalide/);
  expect(await readdir(target)).toEqual([]);
  expect((await stat(target)).isDirectory()).toBe(true);
});

async function createWithActions(prepareSpace?: (root: string, actionsFolder: string) => Promise<void>) {
  const root = await tempFolder();
  const actionsFolder = await tempFolder();
  await prepareSpace?.(root, actionsFolder);
  const { run: run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: actionsFolder, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  return { n: kernel, actionsFolder: actionsFolder };
}

const executionAction = (id: string, start: string): Execution => ({
  version: 1, id: idExecution(start), owner: { type: "action", id }, trigger: "manual", start: start, end: start, status: "succeeded", blocks: [],
});

test("kernel.actions: page(id, null) returns the last resolved result; page of an unknown run: null", async () => {
  const { n, actionsFolder: actionsFolder } = await createWithActions(async (root) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ name: "GitLab", sources: { account: ["gitlab.com"] } }));
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(actionsFolder, "gitlab"), { ...e, input: "x" });
  const plan = { blocks: [{ component: "list", props: { items: "tickets", title: "title" } }] };
  await writeResult(actionsFolder, "gitlab", { version: 1, run: e.id, input: "x", results: { tickets: [{ title: "A" }] }, plan, fallback: false, empty: false });
  const p = await n.actions.page("gitlab", null);
  expect(p).toMatchObject({ run: e.id, start: e.start, end: e.end, input: "x", status: "succeeded", account: true });
  expect(p!.page).toMatchObject({ fallback: false, empty: false });
  expect(p!.page!.blocks[0]).toMatchObject({ component: "list" });
  expect(await n.actions.page("gitlab", e.id)).toEqual(p);
  expect(await n.actions.page("gitlab", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await n.actions.page("absente", null)).toBeNull();
  expect(await n.actions.page("gitlab", "../x")).toBeNull();
  expect(await n.actions.run("gitlab", "../x")).toBeNull();
  expect((await n.actions.list()).map((a) => a.id)).toEqual(["gitlab"]);
  expect((await n.actions.runs("gitlab")).map((x) => x.id)).toEqual([e.id]);
  expect(await n.actions.run("gitlab", e.id)).toMatchObject({ id: e.id });
  expect(n.actions.direct()).toEqual({ running: [], waiting: [] });
});

test("kernel.actions: page() of an action rewritten without an account but still granted counts as reading with the account", async () => {
  const { n, actionsFolder: actionsFolder } = await createWithActions(async (root, actionsFolder) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ name: "GitLab", sources: { web: true } }));
    await giveGrant(actionsFolder, "gitlab", { domains: ["gitlab.com"], public: [], profile: "perso" });
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(actionsFolder, "gitlab"), e);
  const plan = { blocks: [{ component: "list", props: { items: "tickets", title: "title", image: "image" } }] };
  await writeResult(actionsFolder, "gitlab", { version: 1, run: e.id, input: null, results: { tickets: [{ title: "A", image: "https://img.test/a.png" }] }, plan, fallback: false, empty: false });
  expect(await n.actions.page("gitlab", null)).toMatchObject({ run: e.id, account: true });
});

test("kernel.actions: at startup, the data of a vanished action is erased", async () => {
  const { actionsFolder: actionsFolder } = await createWithActions(async (root, actionsFolder) => {
    await mkdir(spacePaths(root).actions, { recursive: true });
    await writeRun(join(actionsFolder, "partie"), executionAction("partie", "2026-10-31T08:00:00.000Z"));
    await giveGrant(actionsFolder, "partie", { domains: ["gitlab.com"], public: [], profile: "perso" });
  });
  expect(existsSync(join(actionsFolder, "partie"))).toBe(false);
  expect((await readGrants(actionsFolder)).partie).toBeUndefined();
});

test("kernel.actions: accorder records the grant without running anything; refuserAccord removes it and erases", async () => {
  const { n, actionsFolder: actionsFolder } = await createWithActions(async (root) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ name: "GitLab", sources: { account: ["gitlab.com"] } }));
  });
  await expect(n.actions.grant({ id: "gitlab", profile: "perso", account: ["github.com"], public: [] })).rejects.toThrow(/changé/);
  await n.actions.grant({ id: "gitlab", profile: "perso", account: ["gitlab.com"], public: [] });
  expect((await readGrants(actionsFolder)).gitlab).toEqual({ domains: ["gitlab.com"], public: [], profile: "perso" });
  expect(n.actions.direct().running).toEqual([]);
  await writeRun(join(actionsFolder, "gitlab"), executionAction("gitlab", "2026-10-31T08:00:00.000Z"));
  await n.actions.denyGrant("gitlab");
  expect((await readGrants(actionsFolder)).gitlab).toBeUndefined();
  expect(await n.actions.runs("gitlab")).toEqual([]);
});

describe("openAgentSession with a profile", () => {
  async function started(attempt: (n: Kernel, start: MockInstance<typeof SessionAgent.start>) => Promise<void>) {
    const n = await createReady();
    const start = vi.spyOn(SessionAgent, "start");
    try {
      await attempt(n, start);
    } finally {
      start.mockRestore();
    }
  }

  test("codex: -c argument, no session file, token by environment", async () => {
    await started(async (n, start) => {
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex" });
      const [command, o] = start.mock.calls[0]!;
      expect(command.at(-1)).toMatch(/^mcp_servers\.ressac=\{url="http:\/\/host\.docker\.internal:\d+\/mcp",bearer_token_env_var="RESSAC_MCP_TOKEN"\}$/);
      expect(command.at(-2)).toBe("-c");
      expect(command.some((a) => a.startsWith("RESSAC_MCP_TOKEN="))).toBe(false);
      expect(o.env!.RESSAC_MCP_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(n.paths.internal, "sessions"))).toBe(false);
      await s.stop();
    });
  });

  test("codex resume with extra args and env", async () => {
    await started(async (n, start) => {
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", resume: true, extra: { args: ["-m", "x"], env: { RESSAC_ENGINE_TOKEN: "t" } } });
      const [command, o] = start.mock.calls[0]!;
      expect(command.slice(command.indexOf("codex"), command.indexOf("codex") + 3)).toEqual(["codex", "resume", "--last"]);
      expect(command.slice(-2)).toEqual(["-m", "x"]);
      expect(o.env!.RESSAC_ENGINE_TOKEN).toBe("t");
      expect(command[command.indexOf("RESSAC_ENGINE_TOKEN") - 1]).toBe("-e");
      await s.stop();
    });
  });

  test("an unknown profile is rejected; claude still writes its 0600 session file", async () => {
    await started(async (n) => {
      await expect(n.openAgentSession({ cols: 80, rows: 24, profile: "inconnu" })).rejects.toThrow("Profil d'agent inconnu : inconnu");
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude" });
      const folder = join(n.paths.internal, "sessions");
      const [file] = await readdir(folder);
      expect((await stat(join(folder, file!))).mode & 0o777).toBe(0o600);
      await s.stop();
    });
  });
});

test("kernel: onRecapChange is called once per successful recap publication", async () => {
  const root = await tempFolder();
  const { run: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const onRecapChange = vi.fn();
  kernel = await createKernel({ locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, recapsFolder: `${root}-recaps`, onRecapChange, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const mcp = await readMcp(kernel);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url.replace("host.docker.internal", "127.0.0.1")), {
      requestInit: { headers: { Authorization: mcp.headers.Authorization } },
    }),
  );
  const call = (plan: unknown) => client.callTool({ name: "show_recap", arguments: { title: "Vélos", results: { items: [{ name: "A" }] }, plan } });
  await call({ blocks: [{ component: "cards", props: { items: "items", title: "name" } }] });
  await call({ blocks: [] });
  await client.close();
  expect(onRecapChange).toHaveBeenCalledTimes(1);
  expect((await readdir(`${root}-recaps`)).filter((f) => f !== "used-days.json")).toEqual([`${onRecapChange.mock.calls[0]![0]}.json`]);
});
