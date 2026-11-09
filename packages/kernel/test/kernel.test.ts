import { afterEach, expect, test, vi } from "vitest";
import { Workshop } from "../src/container/workshop.js";
import type { Runner } from "../src/container/runner.js";
import { spacePaths } from "../src/paths.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createKernel, WorkshopError, type Kernel } from "../src/kernel.js";
import type { LocalAi } from "../src/ai/ia-locale.js";
import { WidgetsScheduler } from "../src/widgets/scheduler.js";
import { giveGrant as accorderAccord, readGrants } from "../src/widgets/accords.js";
import { writeRun, idExecution, type Execution } from "../src/workflows/executions.js";
import { writeResult } from "../src/actions/data.js";
import { writeData, readData, readWidgetState } from "../src/home/data.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { declarationWidget, writeWidget } from "./helpers/home.js";
import { FakeBridge } from "../src/mcp/pont-factice.js";
import { tempFolder } from "./helpers/temp.js";
import { fakeRunner } from "./helpers/fake-runner.js";

let kernel: Kernel | undefined;
afterEach(async () => {
  await kernel?.arreter();
  kernel = undefined;
});

async function createWithoutDocker() {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  return kernel;
}

const readMcp = async (n: Kernel) => JSON.parse(await readFile(n.chemins.configMcp, "utf8")).mcpServers.webaios;

/** Workshop whose « docker » is a fake script (it only sleeps for an `exec -it`, one session; any other call fails fast): a session pty never touches the real Docker. */
async function workshopWithoutDocker(root: string, run: Runner): Promise<Workshop> {
  const fake = join(`${root}-bin`, "docker");
  await mkdir(dirname(fake), { recursive: true });
  await writeFile(fake, '#!/bin/sh\ncase " $* " in *" -it "*) exec sleep 60;; *) exit 1;; esac\n', { mode: 0o755 });
  return new Workshop({ chemins: spacePaths(root), executer: run, docker: fake });
}

test("createKernel initializes the space and writes mcp.json with host.docker.internal", async () => {
  const n = await createWithoutDocker();
  expect(existsSync(join(n.chemins.racine, "AGENTS.md"))).toBe(true);
  const mcp = await readMcp(n);
  expect(mcp.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  expect(mcp.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test("Docker absent: createKernel succeeds, workshopState → docker-absent, ouvrirSessionAgent throws WorkshopError", async () => {
  const n = await createWithoutDocker();
  expect(await n.etatAtelier()).toBe("docker-absent");
  const error = await n.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.etat).toBe("docker-absent");
});

test("the MCP server answers with the token, then arreter closes it", async () => {
  const n = await createWithoutDocker();
  const mcp = await readMcp(n);
  const local = mcp.url.replace("host.docker.internal", "127.0.0.1");
  expect((await fetch(local, { method: "POST" })).status).toBe(401);
  await n.arreter();
  kernel = undefined;
  await expect(fetch(local, { method: "POST" })).rejects.toThrow();
});

test("profil inconnu → erreur claire", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  await expect(
    createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run, profilId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("createKernel does not wait for a slow image build", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // never ends
  ]);
  const start = Date.now();
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  expect(Date.now() - start).toBeLessThan(2000);
});

test("container start failure: createKernel succeeds, the session throws WorkshopError with the message", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  const error = await kernel.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.message).toContain("port is already allocated");
});

test("build failed at launch: the first session returns that failure without rebuilding right away", async () => {
  const root = await tempFolder();
  const { executer: run, appels: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 1 }],
    [/ inspect -f/, { code: 1 }],
    [/ build /, { code: 1, stderr: "réseau coupé" }],
  ]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  const error = await kernel.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error.message).toContain("réseau coupé");
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(1);
  // Retry: a new attempt.
  await kernel.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch(() => {});
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(2);
});

test("at launch, once the container is ready, the agents of a previous app are stopped before any session", async () => {
  const root = await tempFolder();
  const { executer: run, appels: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  // Up-to-date container: the mount probe returns the expected root and hash.
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = (c, args, o) =>
    args.includes("{{.State.Running}}") ? run(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : run(c, args, o);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: runUpToDate, atelier: workshop });
  await kernel.ouvrirSessionAgent({ cols: 80, rows: 24 }).then((s) => s.arreter(), () => {});
  const execs = calls.filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
  // The cleanup (all marked sessions) runs before the open session is stopped here.
  expect(execs[0]).toContain("/tmp/webaios-session-*.pid");
  expect(execs[1]).toMatch(/webaios-session-[0-9a-f]+\.pid/);
});

test("createKernel reads models and Dockerfile from resources", async () => {
  const root = await tempFolder();
  const copy = await tempFolder();
  await cp(join(import.meta.dirname, "..", "modeles"), join(copy, "modeles"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "docker"), join(copy, "docker"), { recursive: true });
  await writeFile(join(copy, "modeles", "AGENTS.md"), "# copie");
  const { executer: run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, ressources: copy, executer: run });
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("createKernel reuses the provided workshop", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  const workshop = new Workshop({ chemins: spacePaths(root), executer: run });
  const state = vi.spyOn(workshop, "etat").mockResolvedValue("docker-absent");
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run, atelier: workshop });
  await kernel.etatAtelier();
  expect(state).toHaveBeenCalled();
});

test("arreter: new conversation for the policy (pending cards drop) and dev tools released", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const released: number[] = [];
  let n = 0;
  const bridge = new FakeBridge([], { actif: null, autoriser: false, outilsDev: true });
  const tools = bridge.outilsDev!;
  (tools as { proprietaire?: () => unknown }).proprietaire = () => {
    const num = ++n;
    return Object.assign(Object.create(tools), { liberer: () => released.push(num) });
  };
  const first = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: bridge, racine: root, executer: run });
  const conversation = first.politique.conversation;
  await first.arreter();
  expect(first.politique.conversation).toBe(conversation + 1);
  expect(released).toEqual([1]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: bridge, racine: root, executer: run });
  expect(n).toBe(2);
});

test("kernel: arreter() stops the scheduler and the local AI", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const order: string[] = [];
  const original = WidgetsScheduler.prototype.arreter;
  const schedule = vi.spyOn(WidgetsScheduler.prototype, "arreter").mockImplementation(async function (this: WidgetsScheduler) {
    await original.call(this);
    order.push("planificateur");
  });
  // The kernel closes its own access to the AI (a late harvest does not restart Kev), not the shared AI.
  const access = { kev: vi.fn(), gemma: vi.fn(), fermer: vi.fn(async () => void order.push("ia")) };
  const ai = { acces: () => access, arreter: vi.fn() } as unknown as LocalAi;
  const n = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run, ia: ai });
  expect(n.ia).toBe(ai);
  await n.arreter();
  expect(order).toEqual(["planificateur", "ia"]);
  expect(ai.arreter).not.toHaveBeenCalled();
  schedule.mockRestore();
});

test("kernel: lireAccueil reads the widgets; ia is null without local AI", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  await writeWidget(kernel.chemins, "meteo", declarationWidget());
  const state = await kernel.lireAccueil();
  expect(state.widgets.map((w) => w.id)).toContain("meteo");
  expect(kernel.ia).toBeNull();
});

test("kernel: accorder records the grant (domains sorted), notifies and starts a harvest; refuserAccord removes it", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  const onChange = vi.fn();
  kernel = await createKernel({ dossierWidgets: widgetsFolder, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run, surChange: onChange });
  await writeWidget(
    kernel.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["b.dev", "a.dev"], publiques: ["z.com", "y.com"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  await kernel.accorder({ id: "daily", profil: "perso", compte: ["a.dev", "b.dev"], publiques: ["z.com", "y.com"] });
  expect((await readGrants(widgetsFolder)).daily).toEqual({ domaines: ["a.dev", "b.dev"], publiques: ["y.com", "z.com"], profil: "perso" });
  expect(onChange).toHaveBeenCalled();
  // Docker absent: the started harvest ends with « atelier arrêté ».
  await vi.waitFor(async () => expect((await readWidgetState(widgetsFolder, "daily")).statut).toBe("atelier-arrete"));
  // Messages written by the kernel: marked as such (they can go out to the agent without a grant).
  expect((await readWidgetState(widgetsFolder, "daily")).erreurNoyau).toBe(true);

  onChange.mockClear();
  await kernel.refuserAccord("daily");
  expect((await readGrants(widgetsFolder)).daily).toBeUndefined();
  expect(await readWidgetState(widgetsFolder, "daily")).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
  expect(onChange).toHaveBeenCalled();
});

test("kernel: accorder refuses a widget without an account", async () => {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  await writeWidget(kernel.chemins, "meteo", declarationWidget());
  await expect(kernel.accorder({ id: "meteo", profil: "perso", compte: [], publiques: [] })).rejects.toThrow(/compte/);
});

test("kernel: accorder refuses if the declaration is no longer the one shown to the user (account or public ones)", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ dossierWidgets: widgetsFolder, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  await writeWidget(
    kernel.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["app.daily.dev"], publiques: ["espion.example"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  // Shown without the public domain (old declaration): refused.
  await expect(kernel.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] })).rejects.toThrow(/a changé/);
  await expect(kernel.accorder({ id: "daily", profil: "perso", compte: ["autre.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  await expect(kernel.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev", "app.daily.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  expect(await readGrants(widgetsFolder)).toEqual({});
  // Exactly what is declared: granted.
  await kernel.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: ["espion.example"] });
  expect((await readGrants(widgetsFolder)).daily).toEqual({ domaines: ["app.daily.dev"], publiques: ["espion.example"], profil: "perso" });
});

test("kernel: refuserAccord erases the data; account removed afterwards → donnees_widget returns nothing of the account", async () => {
  const root = await tempFolder();
  const widgetsFolder = `${root}-widgets`;
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ dossierWidgets: widgetsFolder, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  const decl = (account: string[]) => declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: account, publiques: [] } });
  await writeWidget(kernel.chemins, "daily", decl(["app.daily.dev"]), { "recolte.mjs": "export default () => 1" });
  await kernel.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] });
  await writeData(widgetsFolder, "daily", { secret: "du compte" });
  await kernel.refuserAccord("daily");
  expect(await readData(widgetsFolder, "daily")).toBeNull();
  // The agent removes the account: the widget becomes public again, with nothing from the account.
  await writeWidget(kernel.chemins, "daily", decl([]), { "recolte.mjs": "export default () => 1" });
  const mcp = await readMcp(kernel);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url.replace("host.docker.internal", "127.0.0.1")), {
      requestInit: { headers: { Authorization: mcp.headers.Authorization } },
    }),
  );
  const r = await client.callTool({ name: "donnees_widget", arguments: { id: "daily" } });
  await client.close();
  const t = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
  expect(t).not.toContain("du compte");
  expect(t).toContain("Aucune donnée");
});

test("kernel: rejouer goes through the scheduler queue; surDirect follows the queue and unsubscribes", async () => {
  const n = await createWithoutDocker();
  await writeWidget(n.chemins, "meteo", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
  const seen: unknown[] = [];
  const unsubscribe = n.surDirect((e) => seen.push(e));
  expect(await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte")).toEqual({ ok: false, erreur: "Mise à jour impossible : atelier arrêté" });
  expect(seen).toContainEqual({ courants: [], enAttente: ["meteo"] });
  expect(seen.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(n.direct()).toEqual({ courants: [], enAttente: [] });
  unsubscribe();
  const before = seen.length;
  await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte");
  expect(seen).toHaveLength(before);
});

// Docker « ready » (fake executor); the session pty launches a fake binary that sleeps, never the real Docker.
async function createReady() {
  const root = await tempFolder();
  const { executer: run } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  const { dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof run = (c, args, o) =>
    args.includes("{{.State.Running}}") ? run(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : run(c, args, o);
  const workshop = await workshopWithoutDocker(root, runUpToDate);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: runUpToDate, atelier: workshop });
  return kernel;
}

test("a session opened for a window writes its own MCP config, deleted when the session ends", async () => {
  const n = await createReady();
  const folder = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const files = await readdir(folder);
  expect(files).toHaveLength(1);
  const clean = JSON.parse(await readFile(join(folder, files[0]!), "utf8")).mcpServers.webaios;
  const principal = await readMcp(n);
  expect(clean.url).toBe(principal.url);
  expect(clean.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  expect(clean.headers.Authorization).not.toBe(principal.headers.Authorization);
  expect((await (await import("node:fs/promises")).stat(join(folder, files[0]!))).mode & 0o777).toBe(0o600);
  await session.arreter();
  await vi.waitFor(async () => expect(await readdir(folder)).toEqual([]));
});

test("at kernel startup, session configs left behind by a crash are purged", async () => {
  const root = await tempFolder();
  const folder = join(spacePaths(root).interne, "sessions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "reste.json"), "{}");
  const { executer: run } = fakeRunner([[/ info$/, { code: 1 }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  expect(existsSync(join(folder, "reste.json"))).toBe(false);
});

test("arreter deletes the config of a still-open session", async () => {
  const n = await createReady();
  const folder = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const [file] = await readdir(folder);
  expect(existsSync(join(folder, file!))).toBe(true);
  const stop = n.arreter();
  kernel = undefined;
  await stop;
  expect(existsSync(join(folder, file!))).toBe(false);
  await session.arreter();
});

test("a session whose folder is a symbolic link is refused, nothing is written elsewhere", async () => {
  const n = await createReady();
  const target = await tempFolder();
  const folder = join(n.chemins.interne, "sessions");
  await mkdir(n.chemins.interne, { recursive: true });
  await symlink(target, folder);
  await expect(n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" })).rejects.toThrow(/Dossier des sessions invalide/);
  expect(await readdir(target)).toEqual([]);
  expect((await stat(target)).isDirectory()).toBe(true);
});

async function createWithActions(prepareSpace?: (root: string, actionsFolder: string) => Promise<void>) {
  const root = await tempFolder();
  const actionsFolder = await tempFolder();
  await prepareSpace?.(root, actionsFolder);
  const { executer: run } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  kernel = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: actionsFolder, pont: new FakeBridge([], { actif: null, autoriser: false }), racine: root, executer: run });
  return { n: kernel, dossierActions: actionsFolder };
}

const executionAction = (id: string, start: string): Execution => ({
  version: 1, id: idExecution(start), proprietaire: { type: "action", id }, declencheur: "manuelle", debut: start, fin: start, statut: "reussie", blocs: [],
});

test("noyau.actions: page(id, null) returns the last resolved result; page of an unknown run: null", async () => {
  const { n, dossierActions: actionsFolder } = await createWithActions(async (root) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(actionsFolder, "gitlab"), { ...e, saisie: "x" });
  const plan = { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "titre" } }] };
  await writeResult(actionsFolder, "gitlab", { version: 1, execution: e.id, saisie: "x", resultats: { tickets: [{ titre: "A" }] }, plan, secours: false, vide: false });
  const p = await n.actions.page("gitlab", null);
  expect(p).toMatchObject({ execution: e.id, debut: e.debut, fin: e.fin, saisie: "x", statut: "reussie", compte: true });
  expect(p!.page).toMatchObject({ secours: false, vide: false });
  expect(p!.page!.blocs[0]).toMatchObject({ composant: "liste" });
  expect(await n.actions.page("gitlab", e.id)).toEqual(p);
  expect(await n.actions.page("gitlab", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await n.actions.page("absente", null)).toBeNull();
  expect(await n.actions.page("gitlab", "../x")).toBeNull();
  expect(await n.actions.execution("gitlab", "../x")).toBeNull();
  expect((await n.actions.lister()).map((a) => a.id)).toEqual(["gitlab"]);
  expect((await n.actions.executions("gitlab")).map((x) => x.id)).toEqual([e.id]);
  expect(await n.actions.execution("gitlab", e.id)).toMatchObject({ id: e.id });
  expect(n.actions.direct()).toEqual({ courantes: [], enAttente: [] });
});

test("noyau.actions: page() of an action rewritten without an account but still granted counts as reading with the account", async () => {
  const { n, dossierActions: actionsFolder } = await createWithActions(async (root, actionsFolder) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ nom: "GitLab", sources: { web: true } }));
    await accorderAccord(actionsFolder, "gitlab", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(actionsFolder, "gitlab"), e);
  const plan = { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "titre", image: "image" } }] };
  await writeResult(actionsFolder, "gitlab", { version: 1, execution: e.id, saisie: null, resultats: { tickets: [{ titre: "A", image: "https://img.test/a.png" }] }, plan, secours: false, vide: false });
  expect(await n.actions.page("gitlab", null)).toMatchObject({ execution: e.id, compte: true });
});

test("noyau.actions: at startup, the data of a vanished action is erased", async () => {
  const { dossierActions: actionsFolder } = await createWithActions(async (root, actionsFolder) => {
    await mkdir(spacePaths(root).actions, { recursive: true });
    await writeRun(join(actionsFolder, "partie"), executionAction("partie", "2026-10-31T08:00:00.000Z"));
    await accorderAccord(actionsFolder, "partie", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  });
  expect(existsSync(join(actionsFolder, "partie"))).toBe(false);
  expect((await readGrants(actionsFolder)).partie).toBeUndefined();
});

test("noyau.actions: accorder records the grant without running anything; refuserAccord removes it and erases", async () => {
  const { n, dossierActions: actionsFolder } = await createWithActions(async (root) => {
    const folder = join(spacePaths(root).actions, "gitlab");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  await expect(n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["github.com"], publiques: [] })).rejects.toThrow(/changé/);
  await n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["gitlab.com"], publiques: [] });
  expect((await readGrants(actionsFolder)).gitlab).toEqual({ domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  expect(n.actions.direct().courantes).toEqual([]);
  await writeRun(join(actionsFolder, "gitlab"), executionAction("gitlab", "2026-10-31T08:00:00.000Z"));
  await n.actions.refuserAccord("gitlab");
  expect((await readGrants(actionsFolder)).gitlab).toBeUndefined();
  expect(await n.actions.executions("gitlab")).toEqual([]);
});
