import { afterEach, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { spacePaths, type SpacePaths } from "../../src/chemins.js";
import { Atelier } from "../../src/conteneur/atelier.js";
import { createServer as serveurHttp } from "node:http";
import { createServer as serveurTcp, type AddressInfo, type Server } from "node:net";
import { ApplicationManager, probeByDefault, type AppState, type Launcher } from "../../src/applications/gestionnaire.js";
import { fakeRunner, type Response } from "../aide/executeur-factice.js";
import { tempFolder } from "../aide/temporaire.js";

const managers: ApplicationManager[] = [];
afterEach(async () => {
  for (const g of managers.splice(0)) await g.arreterSurveillance();
});

/** Fake launcher: keeps the argv, and each process ends when the test calls `finir`. */
function fakeLauncher() {
  const process: { argv: string[]; tue: boolean; finir: (code: number | null) => void }[] = [];
  const launcher: Launcher = (argv) => {
    const rappels: ((code: number | null) => void)[] = [];
    const p = { argv, tue: false, finir: (code: number | null) => rappels.forEach((r) => r(code)) };
    process.push(p);
    return {
      surFin: (r) => rappels.push(r),
      tuer: () => {
        p.tue = true;
      },
    };
  };
  return { lanceur: launcher, processus: process };
}

/** Scripted probe: each port returns its answers in order, then repeats the last one (default « libre »). */
function scriptedProbe(script: Record<number, ("http" | "occupe" | "libre")[]>) {
  return async (port: number) => {
    const r = script[port] ?? ["libre"];
    return r.length > 1 ? r.shift()! : r[0]!;
  };
}

async function space(projects: Record<string, string | null> = { todo: '{"nom":"Todo","type":"application","lancement":"npx vite --port {port}"}' }) {
  const c = spacePaths(await tempFolder());
  for (const [dossier, manifest] of Object.entries(projects)) {
    await mkdir(join(c.projets, dossier), { recursive: true });
    if (manifest !== null) await writeFile(join(c.projets, dossier, "webaios.json"), manifest);
  }
  return c;
}

function preparer(o: {
  chemins: SpacePaths;
  sonder?: (port: number) => Promise<"http" | "occupe" | "libre">;
  ports?: [number, number];
  inspect?: Response;
  info?: Response;
}) {
  const { executer, appels: calls } = fakeRunner([
    [/ info$/, o.info ?? { code: 0 }],
    [/ inspect /, o.inspect ?? { code: 0, stdout: "true\n" }],
  ]);
  const atelier = new Atelier({ chemins: o.chemins, docker: "docker", executer });
  const { lanceur: launcher, processus: process } = fakeLauncher();
  const states: AppState[] = [];
  const g: ApplicationManager = new ApplicationManager({
    chemins: o.chemins,
    atelier,
    lanceur: launcher,
    ports: o.ports ?? [5280, 5284],
    delaiPretMs: 200,
    intervalleSondeMs: 20,
    sonder: o.sonder ?? scriptedProbe({ 5280: ["libre", "http"] }),
    surChange: () => states.push(g.etatDe("todo")),
  });
  managers.push(g);
  const stops = () => calls.filter((a) => a.args[0] === "exec" && a.args[4]?.includes("WEBAIOS_APP=")).map((a) => a.args[4]!);
  return { g, atelier, processus: process, etats: states, appels: calls, arrets: stops };
}

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await attendre(5);
  expect(condition()).toBe(true);
}

test("lancer: free port, en-marche when the port answers", async () => {
  const c = await space();
  const { g, processus: process, etats: states } = preparer({ chemins: c });
  expect(await g.lancer("todo")).toMatchObject({ dossier: "todo", nom: "Todo", type: "application", etat: "en-marche", port: 5280 });
  expect(states).toEqual(["lancement", "en-marche"]);
  expect(process).toHaveLength(1);
  expect(process[0]!.argv).toContain("-e");
  expect(process[0]!.argv).toContain("WEBAIOS_APP=todo");
  expect(process[0]!.argv.at(-1)).toBe("npx vite --port 5280");
  expect(await g.liste()).toMatchObject([{ dossier: "todo", etat: "en-marche", port: 5280 }]);
});

test("an occupied port is skipped", async () => {
  const c = await space();
  const { g } = preparer({ chemins: c, sonder: scriptedProbe({ 5280: ["occupe"], 5281: ["libre", "http"] }) });
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5281 });
});

test("a port that answers in HTTP (server launched by hand by the agent) is skipped", async () => {
  const c = await space();
  const { g } = preparer({ chemins: c, sonder: scriptedProbe({ 5280: ["http"], 5281: ["libre", "http"] }) });
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5281 });
});

test("no more free ports", async () => {
  const c = await space({
    todo: '{"type":"application","lancement":"x"}',
    autre: '{"type":"application","lancement":"y"}',
  });
  const { g } = preparer({ chemins: c, ports: [5280, 5280], sonder: scriptedProbe({ 5280: ["libre", "http"] }) });
  expect(await g.lancer("autre")).toMatchObject({ etat: "en-marche", port: 5280 });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur", erreur: "Plus de port libre : arrête une application." });
});

test("the process exits right away: error without waiting for the delay", async () => {
  const c = await space();
  const { g, processus: process } = preparer({ chemins: c, sonder: scriptedProbe({}) });
  const result = g.lancer("todo");
  await until(() => process.length === 1);
  await mkdir(c.journaux, { recursive: true });
  await writeFile(join(c.journaux, "todo.log"), "démarrage\nboum\n");
  const debut = Date.now();
  process[0]!.finir(3);
  const app = await result;
  expect(Date.now() - debut).toBeLessThan(50);
  expect(app.etat).toBe("erreur");
  expect(app.erreur).toContain("Arrêtée avec le code 3");
  expect(app.erreur).toContain("boum");
});

test("the port never answers: error after delaiPretMs, process stopped", async () => {
  const c = await space();
  const { g, processus: process, arrets: stops } = preparer({ chemins: c, sonder: scriptedProbe({}) });
  const debut = Date.now();
  const app = await g.lancer("todo");
  expect(Date.now() - debut).toBeGreaterThanOrEqual(190);
  expect(app.etat).toBe("erreur");
  expect(app.erreur).toContain("5280");
  expect(process[0]!.tue).toBe(true);
  expect(stops()).toHaveLength(1);
  expect(stops()[0]).toContain("WEBAIOS_APP=todo");
  // The killed process's end does not replace the error.
  process[0]!.finir(null);
  expect((await g.liste())[0]).toMatchObject({ etat: "erreur", erreur: app.erreur });
});

test("arreter during the launch: arretee, not an error", async () => {
  const c = await space();
  const { g, processus: process, arrets: stops } = preparer({ chemins: c, sonder: scriptedProbe({}) });
  const result = g.lancer("todo");
  await until(() => process.length === 1);
  await g.arreter("todo");
  process[0]!.finir(143);
  expect(await result).toMatchObject({ etat: "arretee" });
  expect(process[0]!.tue).toBe(true);
  expect(stops()).toHaveLength(1);
  expect((await g.liste())[0]).toMatchObject({ etat: "arretee" });
  expect((await g.liste())[0]!.erreur).toBeUndefined();
});

test("arreter while a second launch waits in the queue: it is cancelled too", async () => {
  const c = await space();
  const { g, processus: process } = preparer({ chemins: c, sonder: scriptedProbe({}) });
  const premier = g.lancer("todo");
  await until(() => process.length === 1);
  const second = g.lancer("todo");
  await g.arreter("todo");
  expect(await premier).toMatchObject({ etat: "arretee" });
  expect(await second).toMatchObject({ etat: "arretee" });
  expect(process).toHaveLength(1);
  expect(g.etatDe("todo")).toBe("arretee");
});

test("arreter before the launch has started (project read): arretee, nothing launched", async () => {
  const c = await space();
  const { g, processus: process } = preparer({ chemins: c });
  const result = g.lancer("todo");
  await g.arreter("todo");
  expect(await result).toMatchObject({ etat: "arretee" });
  expect(process).toHaveLength(0);
});

test("a launch requested after a stop is not cancelled by it", async () => {
  const c = await space();
  const { g } = preparer({ chemins: c });
  await g.arreter("todo");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche" });
});

/** Promise resolved by the test. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promesse: promise, resoudre: resolve };
}

test("a launch right after a stop waits for the stop script to end (which would kill it)", async () => {
  const c = await space();
  const { g, atelier, processus: process } = preparer({ chemins: c, sonder: scriptedProbe({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.lancer("todo");
  const script = deferred();
  vi.spyOn(atelier, "arreterApplication").mockReturnValue(script.promesse);
  const stop = g.arreter("todo");
  const relaunch = g.lancer("todo");
  await attendre(50);
  expect(process).toHaveLength(1);
  script.resoudre();
  await stop;
  expect(await relaunch).toMatchObject({ etat: "en-marche" });
  expect(process).toHaveLength(2);
});

test("a launch during the orphan cleanup waits for its end", async () => {
  const c = await space();
  const { g, atelier, processus: process } = preparer({ chemins: c });
  const menage = deferred();
  vi.spyOn(atelier, "arreterApplicationsOrphelines").mockReturnValue(menage.promesse);
  const startup = g.demarrer();
  const launch = g.lancer("todo");
  await attendre(50);
  expect(process).toHaveLength(0);
  menage.resoudre();
  await startup;
  expect(await launch).toMatchObject({ etat: "en-marche" });
  expect(process).toHaveLength(1);
});

test("the project watching does not wait for the orphan cleanup (Docker starting up)", async () => {
  const c = await space();
  const { g, atelier, etats: states } = preparer({ chemins: c });
  const menage = deferred();
  vi.spyOn(atelier, "arreterApplicationsOrphelines").mockReturnValue(menage.promesse);
  const startup = g.demarrer();
  await attendre(400);
  await mkdir(join(c.projets, "nouveau"), { recursive: true });
  await writeFile(join(c.projets, "nouveau", "webaios.json"), '{"type":"poc","lancement":"x"}');
  await until(() => states.length > 0);
  menage.resoudre();
  await startup;
});

test("toutArreter also cancels a queued launch: nothing is launched after", async () => {
  const c = await space();
  const { g, processus: process } = preparer({ chemins: c, sonder: scriptedProbe({}) });
  const premier = g.lancer("todo");
  await until(() => process.length === 1);
  const second = g.lancer("todo");
  await g.toutArreter();
  expect(await premier).toMatchObject({ etat: "arretee" });
  expect(await second).toMatchObject({ etat: "arretee" });
  await attendre(50);
  expect(process).toHaveLength(1);
  expect(process[0]!.tue).toBe(true);
});

test("stop of the running app by its process ending: error", async () => {
  const c = await space();
  const { g, processus: process, etats: states } = preparer({ chemins: c });
  await g.lancer("todo");
  process[0]!.finir(1);
  await until(() => states.at(-1) === "erreur");
  const app = (await g.liste())[0]!;
  expect(app).toMatchObject({ etat: "erreur" });
  expect(app.erreur).toContain("Arrêtée avec le code 1");
  expect(app.port).toBeUndefined();
});

test("relaunching a running app stops it first", async () => {
  const c = await space();
  const { g, processus: process, arrets: stops } = preparer({ chemins: c, sonder: scriptedProbe({ 5280: ["libre", "http", "libre", "http"] }) });
  await g.lancer("todo");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche", port: 5280 });
  expect(process[0]!.tue).toBe(true);
  expect(stops()).toHaveLength(1);
  expect(process).toHaveLength(2);
});

test("without a fiche or unknown folder: lancer refuses", async () => {
  const c = await space({ brut: null });
  const { g, processus: process } = preparer({ chemins: c });
  await expect(g.lancer("brut")).rejects.toThrow(/sans fiche/);
  await expect(g.lancer("absent")).rejects.toThrow(/inconnu/);
  expect(process).toHaveLength(0);
  expect(await g.liste()).toMatchObject([{ dossier: "brut", type: "sans-fiche", sansFiche: "pas de webaios.json", etat: "arretee" }]);
});

test("oublier: a project recreated under the same name no longer shows the old error", async () => {
  const c = await space();
  const { g } = preparer({ chemins: c, info: { code: 1 } });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur" });
  g.oublier("todo");
  expect(g.etatDe("todo")).toBe("arretee");
  const [todo] = await g.liste();
  expect(todo).toMatchObject({ etat: "arretee" });
  expect(todo!.erreur).toBeUndefined();
});

test("docker absent: error Docker n'est pas lancé", async () => {
  const c = await space();
  const { g, processus: process } = preparer({ chemins: c, info: { code: 1 } });
  expect(await g.lancer("todo")).toMatchObject({ etat: "erreur", erreur: "Docker n'est pas lancé." });
  expect(process).toHaveLength(0);
});

test("container stopped: preparation then launch", async () => {
  const c = await space();
  const { g, atelier, etats: states } = preparer({ chemins: c, inspect: { code: 0, stdout: "false\n" } });
  const assurer = vi.spyOn(atelier, "assurerDemarre").mockResolvedValue("demarre");
  expect(await g.lancer("todo")).toMatchObject({ etat: "en-marche" });
  expect(assurer).toHaveBeenCalledOnce();
  expect(states).toEqual(["preparation", "lancement", "en-marche"]);
});

test("demarrer stops the WEBAIOS_APP orphans", async () => {
  const c = await space();
  const { g, arrets: stops } = preparer({ chemins: c });
  await g.demarrer();
  expect(stops()).toHaveLength(1);
  expect(stops()[0]).toContain("WEBAIOS_APP=.*");
});

test("demarrer on a stopped container: nothing to stop", async () => {
  const c = await space();
  const { g, arrets: stops } = preparer({ chemins: c, inspect: { code: 0, stdout: "false\n" } });
  await g.demarrer();
  expect(stops()).toHaveLength(0);
});

test("toutArreter stops each running app", async () => {
  const c = await space({
    todo: '{"type":"application","lancement":"x"}',
    autre: '{"type":"poc","lancement":"y"}',
  });
  const { g, processus: process, arrets: stops } = preparer({ chemins: c, sonder: scriptedProbe({ 5280: ["libre", "http"], 5281: ["libre", "http"] }) });
  await g.lancer("todo");
  await g.lancer("autre");
  await g.toutArreter();
  expect(process.every((p) => p.tue)).toBe(true);
  expect(stops().sort()).toHaveLength(2);
  expect((await g.liste()).map((a) => a.etat)).toEqual(["arretee", "arretee"]);
});

test("log: the last lines, empty if absent", async () => {
  const c = await space();
  const { g } = preparer({ chemins: c });
  expect(await g.journal("todo")).toBe("");
  await mkdir(c.journaux, { recursive: true });
  await writeFile(join(c.journaux, "todo.log"), "a\nb\nc\n");
  expect(await g.journal("todo", 2)).toBe("b\nc");
  await expect(g.journal("../x")).rejects.toThrow();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

test("default probe: closed port → libre", async () => {
  const server = serveurTcp();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  expect(await probeByDefault(port)).toBe("libre");
});

test("default probe: connection accepted then cut (Docker proxy without a server) → libre", async () => {
  const server = serveurTcp((s) => s.resetAndDestroy());
  try {
    expect(await probeByDefault(await listen(server))).toBe("libre");
  } finally {
    server.close();
  }
});

test("default probe: HTTP server → http", async () => {
  const server = serveurHttp((_, res) => res.writeHead(404).end());
  try {
    expect(await probeByDefault(await listen(server))).toBe("http");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("default probe: connection accepted without an answer in 1 s → occupe", async () => {
  const sockets: import("node:net").Socket[] = [];
  const server = serveurTcp((s) => sockets.push(s));
  try {
    expect(await probeByDefault(await listen(server))).toBe("occupe");
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});
