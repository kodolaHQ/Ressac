import { afterEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { SessionAgent } from "../src/pty/session.js";
import { Workshop } from "../src/container/workshop.js";
import type { Runner } from "../src/container/runner.js";
import { spacePaths } from "../src/paths.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createKernel, WorkshopError, type Kernel } from "../src/kernel.js";
import type { LocalAi } from "../src/ai/local-ai.js";
import { WidgetsScheduler } from "../src/widgets/scheduler.js";
import { FileActions } from "../src/actions/file.js";
import { giveGrant, readGrants } from "../src/widgets/grants.js";
import { codeHash, readReads, readsCovered } from "../src/widgets/reads.js";
import { writeRun, idExecution, type Execution } from "../src/workflows/executions.js";
import { writeResult } from "../src/actions/data.js";
import { writeData, readData, readWidgetState } from "../src/home/data.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { declarationWidget, writeWidget } from "./helpers/home.js";
import { FakeBridge } from "../src/mcp/fake-bridge.js";
import { tempFolder } from "./helpers/temp.js";
import { fakeRunner } from "./helpers/fake-runner.js";
import type { InstructionChange } from "../src/workspace/instructions.js";
import type { Masker } from "../src/mask/masker.js";

/** The window's banner says « non couverte ». */
const uncovered = (m: Pick<Masker, "uncoveredCause">, win: string) => {
  const c = m.uncoveredCause(win);
  return c.resumed || c.passport.length > 0;
};

let kernel: Kernel | undefined;
afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
});

async function createWithoutDocker() {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
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

test("a stopped machine: openAgentSession throws a WorkshopError that says so, not a container state", async () => {
  const root = await tempFolder();
  const machine = { kind: "machine" as const, binary: () => "/no/podman", args: () => [], hostAddress: () => "192.168.5.2", up: async () => false, wake: async () => {} };
  const workshop = new Workshop({ paths: spacePaths(root), engine: () => machine });
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root, workshop });
  const error = await kernel.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.state).toBe("machine-stopped");
  expect(error.message).toBe("La machine de l'atelier n'est pas démarrée : réessayez, ou voyez pourquoi dans Réglages › Atelier.");
});

test("a stopped machine is not booted at launch: the first session wakes it", async () => {
  const root = await tempFolder();
  const wakes: string[] = [];
  const machine = { kind: "machine" as const, binary: () => "/no/podman", args: () => [], hostAddress: () => "192.168.5.2", up: async () => false, wake: async (r: string) => void wakes.push(r) };
  const workshop = new Workshop({ paths: spacePaths(root), engine: () => machine });
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root, workshop });
  await new Promise((r) => setTimeout(r, 50));
  const user = () => wakes.filter((r) => r === "user");
  expect(user()).toEqual([]);
  await kernel.openAgentSession({ cols: 80, rows: 24 }).catch(() => {});
  expect(user()).toEqual(["user"]);
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
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  await expect(
    createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, profileId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("createKernel does not wait for a slow image build", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // never ends
  ]);
  const start = Date.now();
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  expect(Date.now() - start).toBeLessThan(2000);
});

test("container start failure: createKernel succeeds, the session throws WorkshopError with the message", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, workshop: await workshopWithoutDocker(root, run) });
  const error = await kernel.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.message).toContain("port is already allocated");
});

test("build failed at launch: the first session returns that failure without rebuilding right away", async () => {
  const root = await tempFolder();
  const { run, calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 1 }],
    [/ inspect -f/, { code: 1 }],
    [/ build /, { code: 1, stderr: "réseau coupé" }],
  ]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, workshop: await workshopWithoutDocker(root, run) });
  const error = await kernel.openAgentSession({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error.message).toContain("réseau coupé");
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(1);
  // Retry: a new attempt.
  await kernel.openAgentSession({ cols: 80, rows: 24 }).catch(() => {});
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(2);
});

test("at launch, once the container is ready, the agents of a previous app are stopped before any session", async () => {
  const root = await tempFolder();
  const { run, calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  // Up-to-date container: the mount probe returns the expected root and hash.
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = (c, args, o) =>
    args.includes("{{.State.Running}}") ? run(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}|2684354560|2-browser\n`, stderr: "" }) : run(c, args, o);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: runUpToDate, workshop: workshop });
  await kernel.openAgentSession({ cols: 80, rows: 24, mode: "workshop" }).then((s) => s.stop(), () => {});
  const execs = calls.filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
  // The cleanup (all marked sessions), then the sweep before the first session, then this session's own stop.
  expect(execs[0]).toContain("/tmp/ressac-session-*.pid");
  expect(execs[1]).toContain("kill -KILL -1");
  expect(execs[2]).toMatch(/ressac-session-[0-9a-f]+\.pid/);
});

test("createKernel reads models and Dockerfile from resources", async () => {
  const root = await tempFolder();
  const copy = await tempFolder();
  await cp(join(import.meta.dirname, "..", "templates"), join(copy, "templates"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "docker"), join(copy, "docker"), { recursive: true });
  await writeFile(join(copy, "templates", "fr", "AGENTS.md"), "# copie");
  const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, resources: copy, run: run });
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("relocalize swaps the untouched templates to the new language", async () => {
  const root = await tempFolder();
  let locale = "fr";
  let order: string[] = [];
  const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => order.shift() ?? locale, widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  const templates = join(import.meta.dirname, "..", "templates");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(await readFile(join(templates, "fr", "AGENTS.md"), "utf8"));
  locale = "en";
  await kernel.relocalize();
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(await readFile(join(templates, "en", "AGENTS.md"), "utf8"));
  expect(await readFile(join(root, "home", "widgets", "meteo", "widget.json"), "utf8")).toBe(await readFile(join(templates, "en", "widgets", "meteo", "widget.json"), "utf8"));
  // Two quick changes: the runs do not overlap, the end state is entirely the last language.
  // Each run reads the language once when it starts: fr for the first, then en.
  order = ["fr", "en"];
  await Promise.all([kernel.relocalize(), kernel.relocalize()]);
  expect(order).toEqual([]);
  for (const f of ["AGENTS.md", "CLAUDE.md"]) expect(await readFile(join(root, f), "utf8"), f).toBe(await readFile(join(templates, "en", f), "utf8"));
  for (const id of ["meteo", "actus-tech", "daily-dev"]) {
    for (const f of await readdir(join(templates, "en", "widgets", id))) {
      expect(await readFile(join(root, "home", "widgets", id, f), "utf8"), `${id}/${f}`).toBe(await readFile(join(templates, "en", "widgets", id, f), "utf8"));
    }
  }
});

test("createKernel reuses the provided workshop", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  const workshop = new Workshop({ paths: spacePaths(root), run: run });
  const state = vi.spyOn(workshop, "state").mockResolvedValue("docker-absent");
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, workshop: workshop });
  await kernel.workshopState();
  expect(state).toHaveBeenCalled();
});

test("arreter: new conversation for the policy (pending cards drop) and dev tools released", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const released: number[] = [];
  let n = 0;
  const bridge = new FakeBridge([], { active: null, allow: false, devTools: true });
  const tools = bridge.devTools!;
  (tools as { owner?: () => unknown }).owner = () => {
    const num = ++n;
    return Object.assign(Object.create(tools), { release: () => released.push(num) });
  };
  const first = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: bridge, root: root, run: run });
  const conversation = first.policy.conversation;
  await first.stop();
  expect(first.policy.conversation).toBe(conversation + 1);
  expect(released).toEqual([1]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: bridge, root: root, run: run });
  expect(n).toBe(2);
});

test("kernel: arreter() stops the scheduler and the local AI", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const order: string[] = [];
  const original = WidgetsScheduler.prototype.stop;
  const schedule = vi.spyOn(WidgetsScheduler.prototype, "stop").mockImplementation(async function (this: WidgetsScheduler) {
    await original.call(this);
    order.push("planificateur");
  });
  // The kernel closes its own access to the AI (a late harvest does not restart the AI), not the shared AI.
  const access = { gemma: vi.fn(), close: vi.fn(async () => void order.push("ia")) };
  const ai = { access: () => access, stopServers: vi.fn() } as unknown as LocalAi;
  const n = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, ai: ai });
  expect(n.ai).toBe(ai);
  await n.stop();
  expect(order).toEqual(["planificateur", "ia"]);
  expect(ai.stopServers).not.toHaveBeenCalled();
  schedule.mockRestore();
});

test("kernel: readHome reads the widgets; ia is null without local AI", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  await writeWidget(kernel.paths, "meteo", declarationWidget());
  const state = await kernel.readHome();
  expect(state.widgets.map((w) => w.id)).toContain("meteo");
  expect(kernel.ai).toBeNull();
});

test("kernel: accorder records the grant (domains sorted), notifies and starts a harvest; refuserAccord removes it", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const onChange = vi.fn();
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, onChange: onChange });
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
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  await writeWidget(kernel.paths, "meteo", declarationWidget());
  await expect(kernel.grant({ id: "meteo", profile: "perso", account: [], public: [] })).rejects.toThrow(/compte/);
});

test("kernel: accorder refuses if the declaration is no longer the one shown to the user (account or public ones)", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
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
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
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
/** The instruction script run on the host: /workspace is the space folder, /home/node a sibling folder (trees are not walked). */
async function instructionScript(root: string, args: string[], input: string) {
  const host = (p: string) => (p.startsWith("/workspace/") ? join(root, p.slice("/workspace/".length)) : join(`${root}-home`, p.slice("/home/node/".length)));
  if (args.some((a) => a.includes("readInstructionFiles"))) {
    const { files } = (JSON.parse(input) as { input: { files: string[] } }).input;
    const out: Record<string, string> = {};
    for (const f of files) if (existsSync(host(f))) out[f] = await readFile(host(f), "utf8");
    return JSON.stringify(out);
  }
  for (const [p, c] of Object.entries((JSON.parse(input) as { input: Record<string, string | null> }).input)) c === null ? await rm(host(p), { force: true }) : await writeFile(host(p), c);
  return '"done"';
}

/** The commands the last createReady's workshop ran. */
let runs: { args: string[] }[] = [];
async function createReady(locale: () => string = () => "fr", o: { lab?: () => boolean; instructionsFail?: boolean; writeFail?: boolean; bridge?: FakeBridge; onLock?: () => Promise<void>; shape?: string } = {}) {
  const root = await tempFolder();
  const { run, calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  runs = calls;
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = async (c, args, opts) =>
    args.at(-1) === "ressac-instructions"
      ? o.instructionsFail || (o.writeFail && !args.some((a) => a.includes("readInstructionFiles")))
        ? { code: 1, stdout: "", stderr: "boom" }
        : { code: 0, stdout: await instructionScript(root, args, opts!.input!), stderr: "" }
      : args.includes("{{.State.Running}}")
        ? run(c, args, opts)
        : args.includes('{{index .Config.Labels "ressac.shape"}}')
          ? { code: 0, stdout: `${o.shape ?? "2-browser"}\n`, stderr: "" }
          : args[0] === "inspect"
          ? { code: 0, stdout: `${root}|${dockerfileHash()}|2684354560|${o.shape ?? "2-browser"}\n`, stderr: "" }
          : run(c, args, opts);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ lab: o.lab ?? (() => true), maskingFolder: `${root}-masking`, locale: locale, widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: o.bridge ?? new FakeBridge([], { active: null, allow: false }), root: root, run: runUpToDate, workshop: workshop, ...(o.onLock ? { onLock: o.onLock } : {}) });
  return kernel;
}

test("a network that cannot be secured refuses the session: WorkshopError, no session config", async () => {
  const n = await createReady();
  const { Workshop } = await import("../src/container/workshop.js");
  const spy = vi.spyOn(Workshop.prototype, "secureNetwork").mockRejectedValue(new Error("net down"));
  try {
    const error = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" }).catch((e) => e);
    expect(error).toBeInstanceOf(WorkshopError);
    expect(error.message).toBe("net down");
    expect(await readdir(join(n.paths.internal, "sessions")).catch(() => [])).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

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

test("a reveal is refused while a second session is open, granted once it ended", async () => {
  const code = "381" + "624";
  const bridge = new FakeBridge([{ id: "mail", title: "Boîte", url: "https://mail.example.test/inbox", space: "perso", agentReached: false }], { active: "mail", allow: true, reveal: true });
  bridge.pages.set("mail", { text: `Ton code : ${code}` });
  const n = await createReady(() => "fr", { bridge });
  const folder = join(n.paths.internal, "sessions");
  const a = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" });
  const auth = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]!), "utf8")).mcpServers.ressac.headers.Authorization;
  const c = new Client({ name: "test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${n.mcpPort}/mcp`), { requestInit: { headers: { Authorization: auth } } }));
  const call = async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
  try {
    const label = (await call("read_tab", { id: "mail" })).match(/⟨code-[a-z0-9]{8}⟩/)![0];
    const b = await n.openAgentSession({ cols: 80, rows: 24, window: "F2" });
    expect(await call("reveal_value", { label, reason: "payer" })).toMatch(/^Une autre conversation utilise l'atelier/);
    await b.stop();
    await vi.waitFor(async () => expect(await readdir(folder)).toHaveLength(1));
    expect(n.workspaceLock.locked()).toBe(false);
    // A site app's tweak, recorded with the widgets' and actions' code.
    await mkdir(join(n.paths.sites, "vidola", "tweaks"), { recursive: true });
    await writeFile(join(n.paths.sites, "vidola", "site.json"), JSON.stringify({ name: "Vidola", url: "https://a.example/", domains: ["a.example"], tweaks: [{ matches: ["/*"], js: ["a.js"] }] }));
    await writeFile(join(n.paths.sites, "vidola", "tweaks", "a.js"), "A");
    expect(await call("reveal_value", { label, reason: "payer" })).toContain(code);
    const { tweaksHash } = await import("../src/sites/read.js");
    expect(n.workspaceLock.info()?.codes["site:vidola"]).toBe(tweaksHash({ js: { "a.js": "A" }, css: {} }));
    // Locked before the value left: the file, the reveal stamp in the container.
    expect(n.workspaceLock.info()?.names).toEqual(["votre code"]);
    expect(runs.some((x) => x.args.join(" ").includes("-u root") && x.args.join(" ").includes("touch /run/ressac-reveal-stamp"))).toBe(true);
  } finally {
    await c.close();
    await a.stop();
  }
});

test("the lift is refused while a conversation is open; once it ended, the lock goes and a new session is born unlocked", async () => {
  const n = await createReady();
  await mkdir(join(n.paths.internal, "sessions"), { recursive: true });
  await n.workspaceLock.lock({ names: ["votre code"] });
  const a = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" });
  await expect(n.masking.lift({ choice: "quarantine" })).rejects.toThrow("Arrêtez la conversation pour lever le verrou");
  expect(n.workspaceLock.locked()).toBe(true);
  await a.stop();
  await vi.waitFor(async () => expect(await readdir(join(n.paths.internal, "sessions"))).toEqual([]));
  expect(await n.masking.changedFiles()).toEqual([]);
  await n.masking.lift({ choice: "quarantine" });
  expect(n.workspaceLock.locked()).toBe(false);
  expect(runs.some((x) => x.args.join(" ").includes("rm -f /run/ressac-reveal-stamp"))).toBe(true);
  expect(await n.masking.quarantine.list()).toEqual([]);
  (await n.openAgentSession({ cols: 80, rows: 24, window: "F2" })).stop();
  expect(n.masker.locks().some((l) => l.locked())).toBe(false);
});

test("under the lock a shape change refuses the session", async () => {
  const n = await createReady(() => "fr", { shape: "2-workshop" });
  await n.workspaceLock.lock({ names: ["votre code"] });
  await expect(n.openAgentSession({ cols: 80, rows: 24, window: "F1" })).rejects.toThrow("L'atelier doit être recréé : levez d'abord le verrou pour ouvrir une conversation.");
});

test("while a lift runs, the same lift shares it and another choice is refused", async () => {
  const n = await createReady();
  await n.workspaceLock.lock({ names: ["votre code"] });
  const { Workshop } = await import("../src/container/workshop.js");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const sweep = vi.spyOn(Workshop.prototype, "stopAgentProcesses").mockImplementation(() => held);
  try {
    const first = n.masking.lift({ choice: "quarantine" });
    await vi.waitFor(() => expect(sweep).toHaveBeenCalled());
    expect(n.masking.lift({ choice: "quarantine" })).toBe(first);
    await expect(n.masking.lift({ choice: "delete" })).rejects.toThrow("Le verrou est déjà en train d'être levé.");
    release();
    await first;
    expect(n.workspaceLock.locked()).toBe(false);
  } finally {
    sweep.mockRestore();
  }
});

test("a session opened while none runs first kills what the agent left in the container; one opened beside it does not", async () => {
  const n = await createReady();
  const { Workshop } = await import("../src/container/workshop.js");
  const sweep = vi.spyOn(Workshop.prototype, "stopAgentProcesses").mockResolvedValue();
  try {
    await mkdir(join(n.paths.internal, "sessions"), { recursive: true });
    const [a, b] = await Promise.all([n.openAgentSession({ cols: 80, rows: 24, window: "F1" }), n.openAgentSession({ cols: 80, rows: 24, window: "F2" })]);
    expect(sweep).toHaveBeenCalledTimes(1);
    await a.stop();
    const c = await n.openAgentSession({ cols: 80, rows: 24, window: "F1" });
    expect(sweep).toHaveBeenCalledTimes(1);
    await Promise.all([b.stop(), c.stop()]);
    await vi.waitFor(async () => expect(await readdir(join(n.paths.internal, "sessions"))).toEqual([]));
    (await n.openAgentSession({ cols: 80, rows: 24, window: "F3" })).stop();
    expect(sweep).toHaveBeenCalledTimes(2);
  } finally {
    sweep.mockRestore();
  }
});

test("an out-of-date container (a 0.1.7 one could hold a process moving .ressac) is removed before the kernel writes the space", async () => {
  const root = await tempFolder();
  let spaceAtRemoval: boolean | undefined;
  const { run } = fakeRunner([
    [/ info$/, { code: 1 }],
    [/ inspect -f \{\{\.State\.Running\}\}/, { code: 0, stdout: "true\n" }],
    [/ inspect -f /, { code: 0, stdout: `${root}|old-hash\n` }],
    [/ rm -f ressac-workshop$/, () => ((spaceAtRemoval = existsSync(join(root, ".ressac"))), { code: 0 })],
  ]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run, workshop: await workshopWithoutDocker(root, run) });
  expect(spaceAtRemoval).toBe(false);
});

test("kernel startup deletes nothing under .ressac/sessions (it could be followed through a .ressac linked again)", async () => {
  const root = await tempFolder();
  const folder = join(spacePaths(root).internal, "sessions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "reste.json"), "{}");
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  expect(existsSync(join(folder, "reste.json"))).toBe(true);
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

async function createWithActions(prepareSpace?: (root: string, actionsFolder: string) => Promise<void>, lab: () => boolean = () => true) {
  const root = await tempFolder();
  const actionsFolder = await tempFolder();
  await prepareSpace?.(root, actionsFolder);
  const { run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ lab, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: actionsFolder, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
  return { n: kernel, actionsFolder: actionsFolder };
}

const executionAction = (id: string, start: string): Execution => ({
  version: 1, id: idExecution(start), owner: { type: "action", id }, trigger: "manual", start: start, end: start, status: "succeeded", blocks: [],
});

test("kernel.actions: page(id, null) returns the last resolved result; page of an unknown run: null", async () => {
  const { n, actionsFolder } = await createWithActions(async (root) => {
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
  const { n, actionsFolder } = await createWithActions(async (root, actionsFolder) => {
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
  const { actionsFolder } = await createWithActions(async (root, actionsFolder) => {
    await mkdir(spacePaths(root).actions, { recursive: true });
    await writeRun(join(actionsFolder, "partie"), executionAction("partie", "2026-10-31T08:00:00.000Z"));
    await giveGrant(actionsFolder, "partie", { domains: ["gitlab.com"], public: [], profile: "perso" });
  });
  expect(existsSync(join(actionsFolder, "partie"))).toBe(false);
  expect((await readGrants(actionsFolder)).partie).toBeUndefined();
});

test("kernel.actions: accorder records the grant without running anything; refuserAccord removes it and erases", async () => {
  const { n, actionsFolder } = await createWithActions(async (root) => {
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

test("kernel: owners on disk at start get no reads approved; approveReads checks what was shown and ties the code", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const decl = (publics: string[], web = false) => declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { account: [], public: publics, web } });
  await writeWidget(spacePaths(root), "old", decl(["a.fr"]), { "harvest.mjs": "export default () => 1" });
  const { n, actionsFolder } = await (async () => {
    const actionsFolder = await tempFolder();
    const folder = join(spacePaths(root).actions, "pub");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ name: "P", sources: { public: ["x.fr"], web: true } }));
    const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
    kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder, actionsFolder, bridge: new FakeBridge([], { active: null, allow: false }), root, run });
    return { n: kernel, actionsFolder };
  })();
  expect((await readReads(widgetsFolder)).old).toBeUndefined();
  expect((await readReads(actionsFolder)).pub).toBeUndefined();

  await writeWidget(n.paths, "fresh", decl(["b.fr"], true), { "harvest.mjs": "export default () => 1" });
  expect((await readReads(widgetsFolder)).fresh).toBeUndefined();
  await expect(n.approveReads({ id: "fresh", public: ["b.fr"], web: false })).rejects.toThrow(/a changé/);
  await expect(n.approveReads({ id: "fresh", public: [], web: true })).rejects.toThrow(/a changé/);
  await n.approveReads({ id: "fresh", public: ["b.fr"], web: true });
  expect((await readReads(widgetsFolder)).fresh).toEqual({ public: ["b.fr"], web: true, code: await codeHash(join(n.paths.widgets, "fresh")) });
  // Docker absent: the started harvest ends with « atelier arrêté », past the gate.
  await vi.waitFor(async () => expect((await readWidgetState(widgetsFolder, "fresh")).status).toBe("workshop-stopped"));

  await n.denyGrant("fresh");
  expect((await readReads(widgetsFolder)).fresh).toBeUndefined();
  expect(await readWidgetState(widgetsFolder, "fresh")).toMatchObject({ status: "grant-required", error: "Accord requis pour lire : b.fr et le web" });

  // An account owner is not approved this way.
  await writeWidget(n.paths, "acc", declarationWidget(undefined, { harvest: { minutes: 60 }, sources: { account: ["a.dev"], public: [] } }));
  await expect(n.approveReads({ id: "acc", public: [], web: false })).rejects.toThrow(/a changé/);

  await expect(n.actions.approveReads({ id: "pub", public: ["x.fr"], web: false })).rejects.toThrow(/changé/);
  await n.actions.denyGrant("pub");
  expect((await readReads(actionsFolder)).pub).toBeUndefined();
  await n.actions.approveReads({ id: "pub", public: ["x.fr"], web: true });
  expect((await readReads(actionsFolder)).pub).toEqual({ public: ["x.fr"], web: true, code: await codeHash(join(n.paths.actions, "pub")) });
});

test("kernel: a fresh space grants its starters nothing: each one that reads waits for the user's approval", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder, actionsFolder: `${root}-actions`, bridge: new FakeBridge([], { active: null, allow: false }), root, run });
  expect(await readReads(widgetsFolder)).toEqual({});
  const widgets = (await kernel.readHome()).widgets.flatMap((w) => ("error" in w || w.declaration.sources.account.length ? [] : [w]));
  expect(widgets.map((w) => w.id)).toContain("actus-tech");
  for (const w of widgets) expect(readsCovered(w.declaration, undefined), w.id).toBe(w.declaration.sources.public.length === 0 && !w.declaration.sources.web);
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
      expect(command.find((a) => a.startsWith("mcp_servers."))).toMatch(/^mcp_servers\.ressac=\{url="http:\/\/host\.docker\.internal:\d+\/mcp",bearer_token_env_var="RESSAC_MCP_TOKEN"\}$/);
      expect(command[command.findIndex((a) => a.startsWith("mcp_servers.")) - 1]).toBe("-c");
      expect(command.some((a) => a.startsWith("RESSAC_MCP_TOKEN="))).toBe(false);
      expect(o.env!.RESSAC_MCP_TOKEN).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(n.paths.internal, "sessions"))).toBe(false);
      await s.stop();
    });
  });

  test("codex: the requirements pin the session's MCP server before the session starts, claude leaves them", async () => {
    const { Workshop } = await import("../src/container/workshop.js");
    const restrict = vi.spyOn(Workshop.prototype, "restrictCodex");
    await started(async (n, start) => {
      const c = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude" });
      expect(restrict).not.toHaveBeenCalled();
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f2", profile: "codex" });
      expect(restrict).toHaveBeenCalledTimes(1);
      const url = /url="([^"]+)"/.exec(start.mock.calls[1]![0].find((a) => a.startsWith("mcp_servers."))!)![1];
      expect(restrict).toHaveBeenCalledWith(url);
      expect(restrict.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[1]!);
      await c.stop();
      await s.stop();
    });
    restrict.mockRestore();
  });

  test("outflow: a session's start keeps its window's reads, resumed or not (a switched-back profile resumes it); a new conversation forgets what was typed", async () => {
    await started(async (n) => {
      // Rule 2 only (an e-mail is no secret by itself): a hit means the window still remembers reading it.
      const email = "jeanne.martin@exemple.fr";
      const typed = "paul.durand@exemple.fr";
      n.outflow.read("f1", `${email} ${typed}`, "un onglet");
      n.outflow.typed("f1", `écris à ${typed}\r`);
      const resumed = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", resume: true });
      expect(n.outflow.check("f1", email)?.kind).toBe("email");
      expect(n.outflow.check("f1", typed)).toBeUndefined();
      const fresh = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude" });
      expect(n.outflow.check("f1", email)?.kind).toBe("email");
      expect(n.outflow.check("f1", typed)?.kind).toBe("email");
      await resumed.stop();
      await fresh.stop();
    });
  });

  test("covered: a new Claude conversation is recorded and covered when resumed; an unknown id or a Codex resume is not", async () => {
    await started(async (n) => {
      const id = "11111111-2222-3333-4444-555555555555";
      const open = (o: { profile: string; conversation?: string; resume?: boolean }) => n.openAgentSession({ cols: 80, rows: 24, window: "f1", ...o });
      const sessions = [await open({ profile: "claude", conversation: id })];
      expect(uncovered(n.masker, "f1")).toBe(false);
      sessions.push(await open({ profile: "claude", conversation: id, resume: true }));
      expect(uncovered(n.masker, "f1")).toBe(false);
      sessions.push(await open({ profile: "claude", conversation: "99999999-2222-3333-4444-555555555555", resume: true }));
      expect(uncovered(n.masker, "f1")).toBe(true);
      sessions.push(await open({ profile: "codex", resume: true }));
      expect(uncovered(n.masker, "f1")).toBe(true);
      sessions.push(await open({ profile: "codex" }));
      expect(uncovered(n.masker, "f1")).toBe(false);
      for (const s of sessions) await s.stop();
    });
  });

  test("passport: an added form marks only the conversations that read something « non couverte », and takes them out of covered.json", async () => {
    await started(async (n) => {
      const [read, idle] = ["11111111-2222-3333-4444-555555555555", "22222222-2222-3333-4444-555555555555"];
      const a = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", conversation: read });
      const b = await n.openAgentSession({ cols: 80, rows: 24, window: "f2", profile: "claude", conversation: idle });
      n.masker.maskTyped("f1", "bonjour");
      const covered = async () => JSON.parse(await readFile(join(`${n.paths.root}-masking`, "covered.json"), "utf8"));
      const entry = { id: "0000000000000001", field: "nom" as const, value: { given: "Camille", family: "Exemplaire" }, variants: [], origins: [], how: "typed" as const, created: "2026-11-23T10:00:00.000Z", updated: "2026-11-23T10:00:00.000Z" };
      expect(await n.replacePassport("default", [])).toEqual({ uncovered: 0 });
      expect(await n.replacePassport("default", [entry])).toEqual({ uncovered: 1 });
      expect([uncovered(n.masker, "f1"), uncovered(n.masker, "f2")]).toEqual([true, false]);
      expect(n.masker.uncoveredCause("f1")).toEqual({ resumed: false, passport: [{ profile: "default", id: entry.id }] });
      expect(await covered()).toEqual([idle]);
      // Only origins change: nothing new to mask, nobody marked.
      n.masker.maskTyped("f2", "bonjour");
      expect(await n.replacePassport("default", [{ ...entry, origins: ["ameli.fr"] }])).toEqual({ uncovered: 0 });
      expect(uncovered(n.masker, "f2")).toBe(false);
      expect(n.passport.entries("default")[0]!.origins).toEqual(["ameli.fr"]);
      await a.stop();
      await b.stop();
    });
  });

  test("codex resume by a chat's thread id replaces --last, a bad id is refused", async () => {
    await started(async (n, start) => {
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", resume: true, conversation: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });
      const [command] = start.mock.calls[0]!;
      const at = command.indexOf("codex");
      expect(command.slice(at + 3, at + 5)).toEqual(["resume", "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"]);
      expect(command).not.toContain("--last");
      await s.stop();
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", resume: true, conversation: "--last; rm" })).rejects.toThrow();
    });
  });

  test("codex resume with extra args and env", async () => {
    await started(async (n, start) => {
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", resume: true, extra: { args: ["-m", "x"], env: { RESSAC_ENGINE_TOKEN: "t" } } });
      const [command, o] = start.mock.calls[0]!;
      const at = command.indexOf("codex");
      expect(command.slice(at + 3, at + 5)).toEqual(["resume", "--last"]); // after `-c developer_instructions=…`
      expect(command.slice(-2)).toEqual(["-m", "x"]);
      expect(o.env!.RESSAC_ENGINE_TOKEN).toBe("t");
      expect(command[command.indexOf("RESSAC_ENGINE_TOKEN") - 1]).toBe("-e");
      await s.stop();
    });
  });

  test("mode: browser (the default) takes the shell away, workshop keeps it", async () => {
    await started(async (n, start) => {
      const opened = [
        await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", mode: "browser" }),
        await n.openAgentSession({ cols: 80, rows: 24, window: "f2", profile: "claude", mode: "workshop" }),
        await n.openAgentSession({ cols: 80, rows: 24, window: "f3", profile: "claude" }),
        await n.openAgentSession({ cols: 80, rows: 24, window: "f4", profile: "codex", extra: { args: ["-m", "x"], env: {} } }),
        await n.openAgentSession({ cols: 80, rows: 24, window: "f5", profile: "codex", mode: "workshop" }),
      ];
      const [browser, workshop, none, codex, codexWorkshop] = start.mock.calls.map((x) => x[0].join(" "));
      // Claude's auto-memory is off in Navigateur only (the default mode): the instruction gate does not watch it.
      expect(start.mock.calls.map((x) => x[1].env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY)).toEqual(["1", undefined, "1", undefined, undefined]);
      expect(browser).toContain("-e CLAUDE_CODE_DISABLE_AUTO_MEMORY");
      const claudeArgs = start.mock.calls[0]![0];
      const sources = claudeArgs.indexOf("--setting-sources");
      expect(claudeArgs.slice(sources, sources + 3)).toEqual(["--setting-sources", "", "--settings"]);
      expect(claudeArgs.slice(sources + 4, sources + 6)).toEqual(["--append-system-prompt-file", "/workspace/.ressac/instructions/AGENTS.md"]);
      // Claude's Navigateur settings deny both subscription credentials (all of ~/.codex) and the lesson notebook.
      const settings = JSON.parse(claudeArgs[claudeArgs.indexOf("--settings") + 1]!);
      expect(settings).toEqual({
        skipDangerousModePermissionPrompt: true,
        permissions: {
          deny: [
            "Read(//home/node/.claude/.credentials.json)", "Read(//home/node/.codex/auth.json)", "Edit(//home/node/.claude/.credentials.json)", "Edit(//home/node/.codex/auth.json)",
            "Read(//home/node/.codex/**)", "Edit(//home/node/.codex/**)",
            "Read(//workspace/.ressac/browsing-notes.md)",
          ],
        },
      });
      // An allowlist of built-in tools, files only: nothing that runs a command, spawns an agent or schedules a turn.
      const tools = claudeArgs[claudeArgs.indexOf("--tools") + 1]!.split(",");
      expect(tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
      expect(browser).toContain("--tools Read,Glob,Grep,Write,Edit --disallowedTools Bash,mcp__ressac__launch_app --strict-mcp-config --setting-sources");
      expect(browser).toContain("/workspace/.ressac/instructions/AGENTS.md --disallowedTools WebSearch,WebFetch");
      expect(claudeArgs.at(-2)).toBe("--mcp-config");
      expect(workshop).not.toMatch(/--tools|Bash|launch_app|strict-mcp-config|setting-sources|AGENTS/);
      expect(none).toContain("--tools Read,Glob,Grep,Write,Edit --disallowedTools Bash,mcp__ressac__launch_app");
      expect(codex).toContain(`--disable shell_tool -c mcp_servers.ressac.disabled_tools=["launch_app"] -c notify=[] -c model_provider="openai" -m x`);
      // Codex's interactive TUI (0.169) refuses --ignore-user-config: only `codex exec` takes it.
      expect(codex).not.toContain("--ignore-user-config");
      expect(codexWorkshop).not.toMatch(/shell_tool|launch_app|notify|model_provider/);
      for (const s of opened) await s.stop();
    });
  });

  test("reply language: claude and codex get it at session open, an open session keeps its own, a custom command is untouched", async () => {
    let lang = "en";
    const n = await createReady(() => lang);
    const start = vi.spyOn(SessionAgent, "start");
    try {
      const a = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude" });
      lang = "fr";
      const b = await n.openAgentSession({ cols: 80, rows: 24, window: "f2", profile: "claude" });
      const c = await n.openAgentSession({ cols: 80, rows: 24, window: "f3", profile: "codex" });
      const line = (l: string) => `Always reply to the user in ${l}, whatever language the instructions are written in.`;
      const [first, second, third] = start.mock.calls.map((x) => x[0]);
      expect(first![first!.indexOf("--append-system-prompt") + 1]).toBe(line("English"));
      expect(second![second!.indexOf("--append-system-prompt") + 1]).toBe(line("French"));
      expect(third).toContain(`developer_instructions=${JSON.stringify(line("French"))}`);
      await mkdir(n.paths.profiles, { recursive: true });
      await writeFile(join(n.paths.profiles, "custom.json"), JSON.stringify({ id: "custom", name: "Custom", interactive: ["mytool", "{mcpConfig}"], nonInteractive: ["mytool", "{prompt}"], mcpConfig: "claude-json" }));
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f4", profile: "custom" })).rejects.toThrow("« Custom » ne tourne qu'en mode Atelier");
      const d = await n.openAgentSession({ cols: 80, rows: 24, window: "f4", profile: "custom", mode: "workshop" });
      const fourth = start.mock.calls[3]![0];
      expect(fourth.join(" ")).not.toMatch(/reply to the user|developer_instructions|append-system-prompt/);
      for (const s of [a, b, c, d]) await s.stop();
    } finally {
      start.mockRestore();
    }
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

describe("the instruction review before a Navigateur session", () => {
  const agents = (n: Kernel) => join(n.paths.root, "AGENTS.md");
  async function gate(attempt: (n: Kernel, start: MockInstance<typeof SessionAgent.start>) => Promise<void>, o: { instructionsFail?: boolean; writeFail?: boolean } = {}) {
    const n = await createReady(undefined, o);
    const start = vi.spyOn(SessionAgent, "start");
    try {
      await attempt(n, start);
    } finally {
      start.mockRestore();
    }
  }

  test("a changed AGENTS.md is reviewed before the CLI starts", async () => {
    await gate(async (n, start) => {
      await writeFile(agents(n), "mine");
      let answer!: (a: "keep") => void;
      const review = vi.fn((_changes: InstructionChange[]) => new Promise<"keep" | "revert">((r) => (answer = r)));
      const opening = n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review });
      await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
      expect(review.mock.calls[0]![0]).toMatchObject([{ path: "/workspace/AGENTS.md", status: "changed" }]);
      expect(start).not.toHaveBeenCalled();
      answer("keep");
      const s = await opening;
      expect(start).toHaveBeenCalledTimes(1);
      expect(await readFile(join(n.paths.internal, "instructions", "AGENTS.md"), "utf8")).toBe("mine");
      await s.stop();
    });
  });

  test("keep accepts only the shown snapshot: a later change shows a new card", async () => {
    await gate(async (n) => {
      await writeFile(agents(n), "mine");
      const review = vi.fn(async () => {
        if (review.mock.calls.length === 1) await writeFile(agents(n), "mine again");
        return "keep" as const;
      });
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review });
      expect(review).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(review.mock.calls[1])).toContain("mine again");
      await s.stop();
    });
  });

  test("revert writes the reference back, then the session starts", async () => {
    await gate(async (n, start) => {
      const before = await readFile(agents(n), "utf8");
      await writeFile(agents(n), "evil");
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "codex", review: async () => "revert" });
      expect(await readFile(agents(n), "utf8")).toBe(before);
      expect(start).toHaveBeenCalledTimes(1);
      await s.stop();
    });
  });

  test("a rejected review starts no session and leaves no session config", async () => {
    await gate(async (n, start) => {
      await writeFile(agents(n), "mine");
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review: () => Promise.reject(new Error("closed")) })).rejects.toThrow("closed");
      expect(start).not.toHaveBeenCalled();
      expect(await readdir(join(n.paths.internal, "sessions")).catch(() => [])).toEqual([]);
    });
  });

  test("no review callback and a change: the open fails", async () => {
    await gate(async (n, start) => {
      await writeFile(agents(n), "mine");
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude" })).rejects.toThrow(
        "Les consignes de l'agent ont changé depuis la dernière session : rouvrez le panneau pour les relire.",
      );
      expect(start).not.toHaveBeenCalled();
    });
  });

  test("a change on every round fails after three cards", async () => {
    await gate(async (n, start) => {
      await writeFile(agents(n), "mine");
      const review = vi.fn(async () => (await writeFile(agents(n), `v${review.mock.calls.length}`), "keep" as const));
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review })).rejects.toThrow("Les consignes de l'agent ont changé");
      expect(review).toHaveBeenCalledTimes(3);
      expect(start).not.toHaveBeenCalled();
    });
  });

  test("workshop mode never reviews", async () => {
    await gate(async (n, start) => {
      await writeFile(agents(n), "mine");
      const review = vi.fn(async () => "keep" as const);
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", mode: "workshop", review });
      expect(review).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      await s.stop();
    });
  });

  test("the conversation resets after the card: a grant made meanwhile is gone, a refused card leaves the grants", async () => {
    await gate(async (n) => {
      await writeFile(agents(n), "mine");
      n.policy.grantWidgetData("before");
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review: () => Promise.reject(new Error("closed")) })).rejects.toThrow("closed");
      expect(n.policy.widgetDataGranted("before")).toBe(true);
      const s = await n.openAgentSession({
        cols: 80,
        rows: 24,
        window: "f1",
        profile: "claude",
        review: async () => {
          expect(n.policy.widgetDataGranted("before")).toBe(true);
          n.policy.grantWidgetData("meanwhile");
          return "keep";
        },
      });
      expect(n.policy.widgetDataGranted("before")).toBe(false);
      expect(n.policy.widgetDataGranted("meanwhile")).toBe(false);
      await s.stop();
    });
  });

  test("a revert whose write fails fails the open, no session", async () => {
    await gate(
      async (n, start) => {
        await writeFile(agents(n), "evil");
        await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review: async () => "revert" })).rejects.toThrow(
          "Impossible de lire ou de remettre les consignes de l'agent : restoring the instruction files failed: boom",
        );
        expect(start).not.toHaveBeenCalled();
      },
      { writeFail: true },
    );
  });

  test("a failed read fails the open closed: no card, no session", async () => {
    await gate(
      async (n, start) => {
        const review = vi.fn(async () => "keep" as const);
        await expect(n.openAgentSession({ cols: 80, rows: 24, window: "f1", profile: "claude", review })).rejects.toThrow(
          "Impossible de lire ou de remettre les consignes de l'agent : reading the instruction files failed: boom",
        );
        expect(review).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
      },
      { instructionsFail: true },
    );
  });
});

test("kernel: onRecapChange is called once per successful recap publication", async () => {
  const root = await tempFolder();
  const { run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const onRecapChange = vi.fn();
  kernel = await createKernel({ lab: () => true, maskingFolder: `${root}-masking`, locale: () => "fr", widgetsFolder: `${root}-widgets`, actionsFolder: `${root}-actions`, recapsFolder: `${root}-recaps`, onRecapChange, bridge: new FakeBridge([], { active: null, allow: false }), root: root, run: run });
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

test("the reveal awaits the browser's lock hook before the value leaves; a hook that fails refuses it", async () => {
  const code = "381" + "624";
  for (const fails of [false, true]) {
    const bridge = new FakeBridge([{ id: "mail", title: "Boîte", url: "https://mail.example.test/inbox", space: "perso", agentReached: false }], { active: "mail", allow: true, reveal: true });
    bridge.pages.set("mail", { text: `Ton code : ${code}` });
    let hooked = 0;
    const n = await createReady(() => "fr", { bridge, onLock: async () => { hooked++; if (fails) throw new Error("apps did not stop"); } });
    const id = "11111111-2222-3333-4444-555555555555";
    let a = await n.openAgentSession({ cols: 80, rows: 24, window: "F1", profile: "claude", conversation: id });
    const folder = join(n.paths.internal, "sessions");
    const auth = JSON.parse(await readFile(join(folder, (await readdir(folder))[0]!), "utf8")).mcpServers.ressac.headers.Authorization;
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${n.mcpPort}/mcp`), { requestInit: { headers: { Authorization: auth } } }));
    const call = async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
    try {
      const label = (await call("read_tab", { id: "mail" })).match(/⟨code-[a-z0-9]{8}⟩/)![0];
      const r = await call("reveal_value", { label, reason: "payer" });
      expect(hooked).toBe(1);
      if (fails) expect(r).not.toContain(code);
      else {
        expect(r).toContain(code);
        // The revealing conversation, resumed later, holds the value in its context: no longer covered.
        await a.stop();
        a = await n.openAgentSession({ cols: 80, rows: 24, window: "F1", profile: "claude", conversation: id, resume: true });
        expect(uncovered(n.masker, "F1")).toBe(true);
      }
    } finally {
      await c.close();
      await a.stop();
    }
  }
});

describe("the lab", () => {
  test("an Atelier session is refused while the lab is off", async () => {
    const n = await createReady(() => "fr", { lab: () => false });
    const command = vi.spyOn(Workshop.prototype, "sessionCommand");
    try {
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "F1", mode: "workshop" })).rejects.toThrow("Cette fonction fait partie du labo, éteint : Réglages › Agent › Niveau d'usage.");
      expect(command).not.toHaveBeenCalled();
    } finally {
      command.mockRestore();
    }
  });

  test("setLab(false) stops running actions; the lab's stores read empty until it is back on", async () => {
    let on = true;
    const { n, actionsFolder } = await createWithActions(async (root) => {
      const folder = join(spacePaths(root).actions, "gitlab");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "action.json"), JSON.stringify({ name: "GitLab", sources: { web: true } }));
    }, () => on);
    const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
    await writeRun(join(actionsFolder, "gitlab"), e);
    await writeResult(actionsFolder, "gitlab", { version: 1, run: e.id, input: null, results: { tickets: [{ title: "A" }] }, plan: { blocks: [{ component: "list", props: { items: "tickets", title: "title" } }] }, fallback: false, empty: false });
    const stopRunning = vi.spyOn(FileActions.prototype, "stopRunning");
    try {
      expect((await n.actions.list()).map((a) => a.id)).toEqual(["gitlab"]);
      on = false;
      await n.setLab(false);
      expect(stopRunning).toHaveBeenCalledTimes(1);
      expect(await n.actions.list()).toEqual([]);
      expect(await n.actions.runs("gitlab")).toEqual([]);
      expect(await n.actions.run("gitlab", e.id)).toBeNull();
      expect(await n.actions.page("gitlab", null)).toBeNull();
      expect(await n.actions.launch("gitlab", {}).end).toMatchObject({ status: "interrupted", error: "Cette fonction fait partie du labo, éteint : Réglages › Agent › Niveau d'usage." });
      on = true;
      await n.setLab(true);
      expect((await n.actions.list()).map((a) => a.id)).toEqual(["gitlab"]);
      expect((await n.actions.runs("gitlab")).map((x) => x.id)).toEqual([e.id]);
      expect(await n.actions.run("gitlab", e.id)).toMatchObject({ id: e.id });
      expect(await n.actions.page("gitlab", null)).toMatchObject({ run: e.id });
    } finally {
      stopRunning.mockRestore();
    }
  });
});

describe("pipe transport", () => {
  const conversation = "11111111-2222-3333-4444-555555555555";

  test("pipe transport returns a LaunchSpec with the Navigateur lockdown once", async () => {
    const n = await createReady();
    const start = vi.spyOn(SessionAgent, "start");
    try {
      const spec = await n.openAgentSession({ transport: "pipe", window: "w", mode: "browser", profile: "claude", conversation });
      expect(start).not.toHaveBeenCalled();
      expect(spec.program).toBe("claude");
      const argv = spec.command(["--output-format", "stream-json"]);
      const exec = argv.indexOf("exec");
      expect(exec).toBeGreaterThan(-1);
      expect(argv[exec + 1]).toBe("-i");
      expect(argv).not.toContain("-it");
      expect(argv).not.toContain("-t");
      const once = (flag: string) => argv.filter((a) => a === flag).length;
      expect(argv.join(" ")).toContain("--tools Read,Glob,Grep,Write,Edit");
      expect([once("--tools"), once("--strict-mcp-config"), once("--settings"), once("--mcp-config")]).toEqual([1, 1, 1, 1]);
      expect(argv).not.toContain("--dangerously-skip-permissions");
      expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", conversation]);
      expect(argv.slice(-2)).toEqual(["--output-format", "stream-json"]);
      expect(spec.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
      expect(argv).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY"); // passed by name
      // The masker keys the discussion by the kernel session id.
      expect(n.masker.table(spec.sessionId)).not.toBe(n.masker.table(null));
      await spec.stop();
    } finally {
      start.mockRestore();
    }
  });

  test("codex pipe argv puts lockdown flags before app-server", async () => {
    const n = await createReady();
    const spec = await n.openAgentSession({ transport: "pipe", window: "w", profile: "codex", resume: true, extra: { args: ["-m", "x"], env: { RESSAC_ENGINE_TOKEN: "t" } } });
    const argv = spec.command([]);
    const server = argv.indexOf("app-server");
    expect(server).toBe(argv.length - 1);
    expect(argv.indexOf("codex")).toBeLessThan(server);
    // Resume is the adapter's (thread/resume): never `codex resume --last`.
    expect(argv).not.toContain("resume");
    const before = argv.slice(argv.indexOf("codex"), server).join(" ");
    expect(before).toContain("--disable shell_tool");
    expect(before).toContain("-c notify=[]");
    expect(before).toContain('-c mcp_servers.ressac.disabled_tools=["launch_app"]');
    expect(before).toMatch(/-c mcp_servers\.ressac=\{url=/);
    expect(before).toContain("-m x");
    expect(spec.env.RESSAC_MCP_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.env.RESSAC_ENGINE_TOKEN).toBe("t");
    expect(spec.codexConfig).toBeUndefined();
    expect(uncovered(n.masker, "w")).toBe(true); // a Codex resume is never covered
    await spec.stop();
  });

  test("stop() cleans once", async () => {
    const n = await createReady();
    const stopSession = vi.spyOn(Workshop.prototype, "stopSession");
    try {
      const spec = await n.openAgentSession({ transport: "pipe", window: "w", profile: "claude", conversation });
      // The clean step calls server.closeSession and masker.close together, guarded by the token: one close proves one of each.
      const close = vi.spyOn(n.masker, "close");
      const folder = join(n.paths.internal, "sessions");
      expect(await readdir(folder)).toHaveLength(1);
      await spec.stop();
      await spec.stop();
      spec.ended();
      expect(stopSession).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(spec.sessionId);
      expect(n.masker.table(spec.sessionId)).toBe(n.masker.table(null));
      expect(await readdir(folder)).toHaveLength(0);
    } finally {
      stopSession.mockRestore();
    }
  });

  test("ended() alone cleans without stopping the remote process", async () => {
    const n = await createReady();
    const stopSession = vi.spyOn(Workshop.prototype, "stopSession");
    try {
      const spec = await n.openAgentSession({ transport: "pipe", window: "w", profile: "claude" });
      const close = vi.spyOn(n.masker, "close");
      spec.ended();
      spec.ended();
      await spec.stop();
      expect(close).toHaveBeenCalledTimes(1);
      expect(stopSession).not.toHaveBeenCalled();
    } finally {
      stopSession.mockRestore();
    }
  });

  test("a PTY start that throws leaves no open session: the next first session sweeps again", async () => {
    const n = await createReady();
    const sweep = vi.spyOn(Workshop.prototype, "stopAgentProcesses");
    const start = vi.spyOn(SessionAgent, "start").mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    try {
      await expect(n.openAgentSession({ cols: 80, rows: 24, window: "w", profile: "claude" })).rejects.toThrow("spawn failed");
      const swept = sweep.mock.calls.length;
      const s = await n.openAgentSession({ cols: 80, rows: 24, window: "w", profile: "claude" });
      expect(sweep.mock.calls.length).toBe(swept + 1);
      await s.stop();
    } finally {
      start.mockRestore();
      sweep.mockRestore();
    }
  });

  test("login session: a terminal running the CLI's login, no MCP token, no masker session", async () => {
    const n = await createReady();
    const start = vi.spyOn(SessionAgent, "start");
    const open = vi.spyOn(n.masker, "open");
    try {
      const claude = await n.openLoginSession({ cols: 80, rows: 24, program: "claude" });
      const codex = await n.openLoginSession({ cols: 80, rows: 24, program: "codex" });
      const [a, ao] = start.mock.calls[0]!;
      const b = start.mock.calls[1]![0];
      expect(a).toContain("-it");
      expect(a.slice(-3)).toEqual(["claude", "auth", "login"]);
      expect(b.slice(-3)).toEqual(["codex", "login", "--device-auth"]);
      expect(a.join(" ")).not.toMatch(/RESSAC_MCP_TOKEN|mcp-config|mcp_servers/);
      expect(ao.env ?? {}).toEqual({});
      expect(open).not.toHaveBeenCalled();
      await claude.stop();
      await codex.stop();
    } finally {
      start.mockRestore();
    }
  });
});
