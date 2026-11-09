import { afterEach, expect, test, vi } from "vitest";
import { Atelier } from "../src/container/workshop.js";
import type { Runner } from "../src/container/runner.js";
import { spacePaths } from "../src/paths.js";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createKernel, WorkshopError, type Noyau } from "../src/kernel.js";
import type { IaLocale } from "../src/ai/ia-locale.js";
import { WidgetsScheduler } from "../src/widgets/scheduler.js";
import { accorder as accorderAccord, lireAccords } from "../src/widgets/accords.js";
import { writeRun, idExecution, type Execution } from "../src/workflows/executions.js";
import { writeResult } from "../src/actions/data.js";
import { writeData, readData, readWidgetState } from "../src/home/data.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { declarationWidget, writeWidget } from "./helpers/home.js";
import { PontFactice } from "../src/mcp/pont-factice.js";
import { tempFolder } from "./helpers/temp.js";
import { fakeRunner } from "./helpers/fake-runner.js";

let noyau: Noyau | undefined;
afterEach(async () => {
  await noyau?.arreter();
  noyau = undefined;
});

async function createWithoutDocker() {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  return noyau;
}

const lireMcp = async (n: Noyau) => JSON.parse(await readFile(n.chemins.configMcp, "utf8")).mcpServers.webaios;

/** Workshop whose « docker » is a fake script (it only sleeps for an `exec -it`, one session; any other call fails fast): a session pty never touches the real Docker. */
async function atelierSansDocker(root: string, executer: Runner): Promise<Atelier> {
  const fake = join(`${root}-bin`, "docker");
  await mkdir(dirname(fake), { recursive: true });
  await writeFile(fake, '#!/bin/sh\ncase " $* " in *" -it "*) exec sleep 60;; *) exit 1;; esac\n', { mode: 0o755 });
  return new Atelier({ chemins: spacePaths(root), executer, docker: fake });
}

test("creerNoyau initializes the space and writes mcp.json with host.docker.internal", async () => {
  const n = await createWithoutDocker();
  expect(existsSync(join(n.chemins.racine, "AGENTS.md"))).toBe(true);
  const mcp = await lireMcp(n);
  expect(mcp.url).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
  expect(mcp.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
});

test("Docker absent: creerNoyau succeeds, etatAtelier → docker-absent, ouvrirSessionAgent throws ErreurAtelier", async () => {
  const n = await createWithoutDocker();
  expect(await n.etatAtelier()).toBe("docker-absent");
  const error = await n.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.etat).toBe("docker-absent");
});

test("the MCP server answers with the token, then arreter closes it", async () => {
  const n = await createWithoutDocker();
  const mcp = await lireMcp(n);
  const local = mcp.url.replace("host.docker.internal", "127.0.0.1");
  expect((await fetch(local, { method: "POST" })).status).toBe(401);
  await n.arreter();
  noyau = undefined;
  await expect(fetch(local, { method: "POST" })).rejects.toThrow();
});

test("profil inconnu → erreur claire", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  await expect(
    createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer, profilId: "inconnu" }),
  ).rejects.toThrow(/inconnu/);
});

test("creerNoyau does not wait for a slow image build", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 1 }],
    [/ build /, () => new Promise(() => {})], // never ends
  ]);
  const debut = Date.now();
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  expect(Date.now() - debut).toBeLessThan(2000);
});

test("container start failure: creerNoyau succeeds, the session throws ErreurAtelier with the message", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ image inspect /, { code: 0 }],
    [/ run /, { code: 125, stderr: "Bind for 127.0.0.1:5280 failed: port is already allocated" }],
  ]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  const error = await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error).toBeInstanceOf(WorkshopError);
  expect(error.message).toContain("port is already allocated");
});

test("build failed at launch: the first session returns that failure without rebuilding right away", async () => {
  const root = await tempFolder();
  const { executer, appels: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 1 }],
    [/ inspect -f/, { code: 1 }],
    [/ build /, { code: 1, stderr: "réseau coupé" }],
  ]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  const error = await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch((e) => e);
  expect(error.message).toContain("réseau coupé");
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(1);
  // Retry: a new attempt.
  await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).catch(() => {});
  expect(calls.filter((a) => a.args[0] === "build")).toHaveLength(2);
});

test("at launch, once the container is ready, the agents of a previous app are stopped before any session", async () => {
  const root = await tempFolder();
  const { executer, appels: calls } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  // Up-to-date container: the mount probe returns the expected root and hash.
  const { dockerfileHash: dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof executer = (c, args, o) =>
    args.includes("{{.State.Running}}") ? executer(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : executer(c, args, o);
  const atelier = await atelierSansDocker(root, runUpToDate);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer: runUpToDate, atelier });
  await noyau.ouvrirSessionAgent({ cols: 80, rows: 24 }).then((s) => s.arreter(), () => {});
  const execs = calls.filter((a) => a.args[0] === "exec").map((a) => a.args.join(" "));
  // The cleanup (all marked sessions) runs before the open session is stopped here.
  expect(execs[0]).toContain("/tmp/webaios-session-*.pid");
  expect(execs[1]).toMatch(/webaios-session-[0-9a-f]+\.pid/);
});

test("creerNoyau reads models and Dockerfile from resources", async () => {
  const root = await tempFolder();
  const copy = await tempFolder();
  await cp(join(import.meta.dirname, "..", "modeles"), join(copy, "modeles"), { recursive: true });
  await cp(join(import.meta.dirname, "..", "docker"), join(copy, "docker"), { recursive: true });
  await writeFile(join(copy, "modeles", "AGENTS.md"), "# copie");
  const { executer } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, ressources: copy, executer });
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# copie");
});

test("creerNoyau reuses the provided workshop", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1, stderr: "absent" }]]);
  const atelier = new Atelier({ chemins: spacePaths(root), executer });
  const state = vi.spyOn(atelier, "etat").mockResolvedValue("docker-absent");
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer, atelier });
  await noyau.etatAtelier();
  expect(state).toHaveBeenCalled();
});

test("arreter: new conversation for the policy (pending cards drop) and dev tools released", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  const released: number[] = [];
  let n = 0;
  const pont = new PontFactice([], { actif: null, autoriser: false, outilsDev: true });
  const tools = pont.outilsDev!;
  (tools as { proprietaire?: () => unknown }).proprietaire = () => {
    const numero = ++n;
    return Object.assign(Object.create(tools), { liberer: () => released.push(numero) });
  };
  const premier = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont, racine: root, executer });
  const conversation = premier.politique.conversation;
  await premier.arreter();
  expect(premier.politique.conversation).toBe(conversation + 1);
  expect(released).toEqual([1]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont, racine: root, executer });
  expect(n).toBe(2);
});

test("kernel: arreter() stops the scheduler and the local AI", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  const order: string[] = [];
  const original = WidgetsScheduler.prototype.arreter;
  const schedule = vi.spyOn(WidgetsScheduler.prototype, "arreter").mockImplementation(async function (this: WidgetsScheduler) {
    await original.call(this);
    order.push("planificateur");
  });
  // The kernel closes its own access to the AI (a late harvest does not restart Kev), not the shared AI.
  const access = { kev: vi.fn(), gemma: vi.fn(), fermer: vi.fn(async () => void order.push("ia")) };
  const ia = { acces: () => access, arreter: vi.fn() } as unknown as IaLocale;
  const n = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer, ia });
  expect(n.ia).toBe(ia);
  await n.arreter();
  expect(order).toEqual(["planificateur", "ia"]);
  expect(ia.arreter).not.toHaveBeenCalled();
  schedule.mockRestore();
});

test("kernel: lireAccueil reads the widgets; ia is null without local AI", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  await writeWidget(noyau.chemins, "meteo", declarationWidget());
  const state = await noyau.lireAccueil();
  expect(state.widgets.map((w) => w.id)).toContain("meteo");
  expect(noyau.ia).toBeNull();
});

test("kernel: accorder records the grant (domains sorted), notifies and starts a harvest; refuserAccord removes it", async () => {
  const root = await tempFolder();
  const dossierWidgets = `${root}-widgets`;
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  const surChange = vi.fn();
  noyau = await createKernel({ dossierWidgets, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer, surChange });
  await writeWidget(
    noyau.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["b.dev", "a.dev"], publiques: ["z.com", "y.com"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["a.dev", "b.dev"], publiques: ["z.com", "y.com"] });
  expect((await lireAccords(dossierWidgets)).daily).toEqual({ domaines: ["a.dev", "b.dev"], publiques: ["y.com", "z.com"], profil: "perso" });
  expect(surChange).toHaveBeenCalled();
  // Docker absent: the started harvest ends with « atelier arrêté ».
  await vi.waitFor(async () => expect((await readWidgetState(dossierWidgets, "daily")).statut).toBe("atelier-arrete"));
  // Messages written by the kernel: marked as such (they can go out to the agent without a grant).
  expect((await readWidgetState(dossierWidgets, "daily")).erreurNoyau).toBe(true);

  surChange.mockClear();
  await noyau.refuserAccord("daily");
  expect((await lireAccords(dossierWidgets)).daily).toBeUndefined();
  expect(await readWidgetState(dossierWidgets, "daily")).toMatchObject({ statut: "accord-requis", erreurNoyau: true });
  expect(surChange).toHaveBeenCalled();
});

test("kernel: accorder refuses a widget without an account", async () => {
  const root = await tempFolder();
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  await writeWidget(noyau.chemins, "meteo", declarationWidget());
  await expect(noyau.accorder({ id: "meteo", profil: "perso", compte: [], publiques: [] })).rejects.toThrow(/compte/);
});

test("kernel: accorder refuses if the declaration is no longer the one shown to the user (account or public ones)", async () => {
  const root = await tempFolder();
  const dossierWidgets = `${root}-widgets`;
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  noyau = await createKernel({ dossierWidgets, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  await writeWidget(
    noyau.chemins,
    "daily",
    declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: ["app.daily.dev"], publiques: ["espion.example"] } }),
    { "recolte.mjs": "export default () => 1" },
  );
  // Shown without the public domain (old declaration): refused.
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] })).rejects.toThrow(/a changé/);
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["autre.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  await expect(noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev", "app.daily.dev"], publiques: ["espion.example"] })).rejects.toThrow(/a changé/);
  expect(await lireAccords(dossierWidgets)).toEqual({});
  // Exactly what is declared: granted.
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: ["espion.example"] });
  expect((await lireAccords(dossierWidgets)).daily).toEqual({ domaines: ["app.daily.dev"], publiques: ["espion.example"], profil: "perso" });
});

test("kernel: refuserAccord erases the data; account removed afterwards → donnees_widget returns nothing of the account", async () => {
  const root = await tempFolder();
  const dossierWidgets = `${root}-widgets`;
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  noyau = await createKernel({ dossierWidgets, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  const decl = (account: string[]) => declarationWidget(undefined, { recolte: { minutes: 60 }, sources: { compte: account, publiques: [] } });
  await writeWidget(noyau.chemins, "daily", decl(["app.daily.dev"]), { "recolte.mjs": "export default () => 1" });
  await noyau.accorder({ id: "daily", profil: "perso", compte: ["app.daily.dev"], publiques: [] });
  await writeData(dossierWidgets, "daily", { secret: "du compte" });
  await noyau.refuserAccord("daily");
  expect(await readData(dossierWidgets, "daily")).toBeNull();
  // The agent removes the account: the widget becomes public again, with nothing from the account.
  await writeWidget(noyau.chemins, "daily", decl([]), { "recolte.mjs": "export default () => 1" });
  const mcp = await lireMcp(noyau);
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
  const vus: unknown[] = [];
  const unsubscribe = n.surDirect((e) => vus.push(e));
  expect(await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte")).toEqual({ ok: false, erreur: "Mise à jour impossible : atelier arrêté" });
  expect(vus).toContainEqual({ courants: [], enAttente: ["meteo"] });
  expect(vus.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(n.direct()).toEqual({ courants: [], enAttente: [] });
  unsubscribe();
  const before = vus.length;
  await n.rejouer("meteo", "2026-10-28T09-00-00-000Z", "recolte");
  expect(vus).toHaveLength(before);
});

// Docker « ready » (fake executor); the session pty launches a fake binary that sleeps, never the real Docker.
async function createReady() {
  const root = await tempFolder();
  const { executer } = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ inspect -f/, { code: 0, stdout: "true\n" }],
  ]);
  const { dockerfileHash: dockerfileHash } = await import("../src/container/workshop.js");
  const runUpToDate: typeof executer = (c, args, o) =>
    args.includes("{{.State.Running}}") ? executer(c, args, o) : args[0] === "inspect" ? Promise.resolve({ code: 0, stdout: `${root}|${dockerfileHash()}\n`, stderr: "" }) : executer(c, args, o);
  const atelier = await atelierSansDocker(root, runUpToDate);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer: runUpToDate, atelier });
  return noyau;
}

test("a session opened for a window writes its own MCP config, deleted when the session ends", async () => {
  const n = await createReady();
  const dossier = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const files = await readdir(dossier);
  expect(files).toHaveLength(1);
  const clean = JSON.parse(await readFile(join(dossier, files[0]!), "utf8")).mcpServers.webaios;
  const principal = await lireMcp(n);
  expect(clean.url).toBe(principal.url);
  expect(clean.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  expect(clean.headers.Authorization).not.toBe(principal.headers.Authorization);
  expect((await (await import("node:fs/promises")).stat(join(dossier, files[0]!))).mode & 0o777).toBe(0o600);
  await session.arreter();
  await vi.waitFor(async () => expect(await readdir(dossier)).toEqual([]));
});

test("at kernel startup, session configs left behind by a crash are purged", async () => {
  const root = await tempFolder();
  const dossier = join(spacePaths(root).interne, "sessions");
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "reste.json"), "{}");
  const { executer } = fakeRunner([[/ info$/, { code: 1 }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions: `${root}-actions`, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  expect(existsSync(join(dossier, "reste.json"))).toBe(false);
});

test("arreter deletes the config of a still-open session", async () => {
  const n = await createReady();
  const dossier = join(n.chemins.interne, "sessions");
  const session = await n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" });
  const [file] = await readdir(dossier);
  expect(existsSync(join(dossier, file!))).toBe(true);
  const stop = n.arreter();
  noyau = undefined;
  await stop;
  expect(existsSync(join(dossier, file!))).toBe(false);
  await session.arreter();
});

test("a session whose folder is a symbolic link is refused, nothing is written elsewhere", async () => {
  const n = await createReady();
  const target = await tempFolder();
  const dossier = join(n.chemins.interne, "sessions");
  await mkdir(n.chemins.interne, { recursive: true });
  await symlink(target, dossier);
  await expect(n.ouvrirSessionAgent({ cols: 80, rows: 24, fenetre: "F1" })).rejects.toThrow(/Dossier des sessions invalide/);
  expect(await readdir(target)).toEqual([]);
  expect((await stat(target)).isDirectory()).toBe(true);
});

async function createWithActions(prepareSpace?: (root: string, dossierActions: string) => Promise<void>) {
  const root = await tempFolder();
  const dossierActions = await tempFolder();
  await prepareSpace?.(root, dossierActions);
  const { executer } = fakeRunner([[/ info$/, { code: 1, stderr: "Cannot connect to the Docker daemon" }]]);
  noyau = await createKernel({ dossierWidgets: `${root}-widgets`, dossierActions, pont: new PontFactice([], { actif: null, autoriser: false }), racine: root, executer });
  return { n: noyau, dossierActions };
}

const executionAction = (id: string, debut: string): Execution => ({
  version: 1, id: idExecution(debut), proprietaire: { type: "action", id }, declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [],
});

test("noyau.actions: page(id, null) returns the last resolved result; page of an unknown run: null", async () => {
  const { n, dossierActions } = await createWithActions(async (root) => {
    const dossier = join(spacePaths(root).actions, "gitlab");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(dossierActions, "gitlab"), { ...e, saisie: "x" });
  const plan = { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "titre" } }] };
  await writeResult(dossierActions, "gitlab", { version: 1, execution: e.id, saisie: "x", resultats: { tickets: [{ titre: "A" }] }, plan, secours: false, vide: false });
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
  const { n, dossierActions } = await createWithActions(async (root, dossierActions) => {
    const dossier = join(spacePaths(root).actions, "gitlab");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "GitLab", sources: { web: true } }));
    await accorderAccord(dossierActions, "gitlab", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  });
  const e = executionAction("gitlab", "2026-10-31T08:00:00.000Z");
  await writeRun(join(dossierActions, "gitlab"), e);
  const plan = { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "titre", image: "image" } }] };
  await writeResult(dossierActions, "gitlab", { version: 1, execution: e.id, saisie: null, resultats: { tickets: [{ titre: "A", image: "https://img.test/a.png" }] }, plan, secours: false, vide: false });
  expect(await n.actions.page("gitlab", null)).toMatchObject({ execution: e.id, compte: true });
});

test("noyau.actions: at startup, the data of a vanished action is erased", async () => {
  const { dossierActions } = await createWithActions(async (root, dossierActions) => {
    await mkdir(spacePaths(root).actions, { recursive: true });
    await writeRun(join(dossierActions, "partie"), executionAction("partie", "2026-10-31T08:00:00.000Z"));
    await accorderAccord(dossierActions, "partie", { domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  });
  expect(existsSync(join(dossierActions, "partie"))).toBe(false);
  expect((await lireAccords(dossierActions)).partie).toBeUndefined();
});

test("noyau.actions: accorder records the grant without running anything; refuserAccord removes it and erases", async () => {
  const { n, dossierActions } = await createWithActions(async (root) => {
    const dossier = join(spacePaths(root).actions, "gitlab");
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, "action.json"), JSON.stringify({ nom: "GitLab", sources: { compte: ["gitlab.com"] } }));
  });
  await expect(n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["github.com"], publiques: [] })).rejects.toThrow(/changé/);
  await n.actions.accorder({ id: "gitlab", profil: "perso", compte: ["gitlab.com"], publiques: [] });
  expect((await lireAccords(dossierActions)).gitlab).toEqual({ domaines: ["gitlab.com"], publiques: [], profil: "perso" });
  expect(n.actions.direct().courantes).toEqual([]);
  await writeRun(join(dossierActions, "gitlab"), executionAction("gitlab", "2026-10-31T08:00:00.000Z"));
  await n.actions.refuserAccord("gitlab");
  expect((await lireAccords(dossierActions)).gitlab).toBeUndefined();
  expect(await n.actions.executions("gitlab")).toEqual([]);
});
