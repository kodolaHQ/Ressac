import { expect, test, vi } from "vitest";
import { spacePaths } from "../../src/paths.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workshop, BUILD_DELAY_MS, IMAGE, dockerfileHash, harvestName, containerPortRange, sessionStopScript, findDocker } from "../../src/container/workshop.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOOLS_FOLDERS } from "../../src/container/runner.js";
import { fakeRunner } from "../helpers/fake-runner.js";

const paths = spacePaths("/Users/t/WebAiOs");

test("docker not found → docker-absent, without an exception", async () => {
  expect(await new Workshop({ chemins: paths, docker: null }).etat()).toBe("docker-absent");
  expect(await new Workshop({ chemins: paths, docker: null }).assurerDemarre()).toBe("docker-absent");
});

test("docker info failing → docker-absent", async () => {
  const { executer: runCall } = fakeRunner([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
  expect(await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).etat()).toBe("docker-absent");
});

test("findDocker finds OrbStack outside the PATH", () => {
  expect(findDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.orbstack/bin/docker")).toBe(
    "/Users/t/.orbstack/bin/docker",
  );
});

test("findDocker prefers the PATH, and returns null if nothing", () => {
  expect(findDocker({ PATH: "/a:/b", HOME: "/h" }, (p) => p === "/b/docker" || p === "/usr/local/bin/docker")).toBe(
    "/b/docker",
  );
  expect(findDocker({ PATH: "/a", HOME: "/h" }, () => false)).toBeNull();
});

test("etat selon docker inspect", async () => {
  const cas: [ReturnType<typeof fakeRunner>, string][] = [
    [fakeRunner([[/ inspect /, { code: 0, stdout: "true\n" }]]), "demarre"],
    [fakeRunner([[/ inspect /, { code: 0, stdout: "false\n" }]]), "arrete"],
    [fakeRunner([[/ inspect /, { code: 1, stderr: "No such object" }]]), "absent"],
  ];
  for (const [{ executer: runCall }, expected] of cas) {
    expect(await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).etat()).toBe(expected);
  }
});

test("assurerDemarre on absent: build if the image is missing then run with the right arguments", async () => {
  let launched = false;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  expect(await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre()).toBe("demarre");
  const build = calls.find((a) => a.args[0] === "build")!;
  expect(build.args.slice(0, 3)).toEqual(["build", "-t", "webaios-atelier:1"]);
  expect(build.args).toContain("-f");
  const run = calls.find((a) => a.args[0] === "run")!;
  expect(run.args).toEqual(expect.arrayContaining([
    "--name", "webaios-atelier",
    "127.0.0.1:5280-5299:5280-5299",
    "webaios-home:/home/node",
    "/Users/t/WebAiOs:/workspace",
    "host.docker.internal:host-gateway",
    "webaios-atelier:1",
  ]));
  expect(run.args.slice(-2)).toEqual(["sleep", "infinity"]);
});

test("assurerDemarre on arrete → docker start", async () => {
  let started = false;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ inspect -f .*Mounts/, { code: 0, stdout: `${paths.racine}|${dockerfileHash()}\n` }],
    [/ inspect -f/, () => ({ code: 0, stdout: started ? "true\n" : "false\n" })],
    [/ start /, () => ((started = true), { code: 0 })],
  ]);
  expect(await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre()).toBe("demarre");
  expect(calls.some((a) => a.args.join(" ") === "start webaios-atelier")).toBe(true);
  expect(calls.some((a) => a.args[0] === "run")).toBe(false);
});

test("commandeExec interactive and non-interactive", () => {
  const a = new Workshop({ chemins: paths, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeExec(["claude"], { interactif: true })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-w", "/workspace", "webaios-atelier", "claude",
  ]);
  expect(a.commandeExec(["claude", "-p", "x"], { interactif: false })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-w", "/workspace", "webaios-atelier", "claude", "-p", "x",
  ]);
});

test("the docker probes have a timeout (Docker Desktop stuck at startup)", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([[/ inspect /, { code: 0, stdout: "true\n" }]]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).etat();
  for (const a of calls) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
});

test("the published ports avoid Vite's (5173…): 5280-5299", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
  ]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre();
  expect(calls.find((a) => a.args[0] === "run")!.args).toContain("127.0.0.1:5280-5299:5280-5299");
});

test("findDocker finds Docker Desktop installed per user (~/.docker/bin)", () => {
  expect(findDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.docker/bin/docker")).toBe(
    "/Users/t/.docker/bin/docker",
  );
});

test("defaultRunner adds ~/.docker/bin to the PATH (credential helpers)", () => {
  expect(TOOLS_FOLDERS).toContain(join(homedir(), ".docker", "bin"));
});

// Existing container created on another folder or with an old Dockerfile → recreated.
function fakeDocker(o: { source: string; empreinteConteneur: string; empreinteImage: string; running?: string }) {
  let recreated = false;
  const f = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 0, stdout: `${o.empreinteImage}\n` }],
    [/ inspect -f \{\{\.State\.Running\}\}/, () => ({ code: 0, stdout: recreated ? "true\n" : (o.running ?? "true\n") })],
    [/ inspect -f .*Mounts/, () => ({ code: 0, stdout: recreated ? "" : `${o.source}|${o.empreinteConteneur}\n` })],
    [/ rm -f webaios-atelier/, () => ((recreated = true), { code: 0 })],
  ]);
  return f;
}

test("existing container on the right folder and the right image → kept", async () => {
  const e = dockerfileHash();
  const { executer: runCall, appels: calls } = fakeDocker({ source: paths.racine, empreinteConteneur: e, empreinteImage: e });
  expect(await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre()).toBe("demarre");
  expect(calls.some((a) => a.args[0] === "rm")).toBe(false);
});

test("existing container mounted on another folder → removed then recreated", async () => {
  const e = dockerfileHash();
  const { executer: runCall, appels: calls } = fakeDocker({ source: "/tmp/ailleurs", empreinteConteneur: e, empreinteImage: e });
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre();
  expect(calls.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
  expect(calls.some((a) => a.args[0] === "run")).toBe(true);
});

test("modified Dockerfile → image rebuilt and container recreated", async () => {
  const { executer: runCall, appels: calls } = fakeDocker({ source: paths.racine, empreinteConteneur: "ancienne", empreinteImage: "ancienne" });
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre();
  const build = calls.find((a) => a.args[0] === "build")!;
  expect(build.args).toContain(`webaios.dockerfile=${dockerfileHash()}`);
  expect(calls.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
});

test("interactive session: its PID is noted in the container, and stopping it kills it there (killing the docker client is not enough)", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([]);
  const a = new Workshop({ chemins: paths, docker: "/opt/homebrew/bin/docker", executer: runCall });
  const pid = "/tmp/webaios-session-ab12.pid";
  expect(a.commandeSession("ab12", ["claude", "--x"])).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-e", "WEBAIOS_SESSION=ab12", "-w", "/workspace", "webaios-atelier",
    "sh", "-c", `echo $$ > ${pid}; exec "$@"`, "webaios-session", "claude", "--x",
  ]);
  await a.arreterSession("ab12");
  const call = calls.find((x) => x.args[0] === "exec")!;
  expect(call.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(call.args[4]).toContain(`cat ${pid}`);
  expect(call.args[4]).toBe(sessionStopScript(pid, "ab12"));
  expect(() => a.commandeSession("../x", ["claude"])).toThrow();
});

test("two starts at the same time: a single image build and a single container", async () => {
  let finishBuild!: () => void;
  let launched = false;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ build /, () => new Promise((ok) => (finishBuild = () => ok({ code: 0 })))],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  const workshop = new Workshop({ chemins: paths, docker: "docker", executer: runCall });
  const a = workshop.assurerDemarre();
  const b = workshop.assurerDemarre();
  await new Promise((r) => setTimeout(r, 10));
  finishBuild();
  expect(await Promise.all([a, b])).toEqual(["demarre", "demarre"]);
  expect(calls.filter((x) => x.args[0] === "build")).toHaveLength(1);
  expect(calls.filter((x) => x.args[0] === "run")).toHaveLength(1);
});

test("after a failure, a new start retries", async () => {
  let failures = 0;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, { code: 1 }],
    [/ build /, () => (failures++, { code: 1, stderr: "réseau" })],
  ]);
  const workshop = new Workshop({ chemins: paths, docker: "docker", executer: runCall });
  await expect(workshop.assurerDemarre()).rejects.toThrow("réseau");
  await expect(workshop.assurerDemarre()).rejects.toThrow("réseau");
  expect(calls.filter((x) => x.args[0] === "build")).toHaveLength(2);
});

test("building and launching the container have a maximum timeout", async () => {
  let launched = false;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre();
  for (const a of calls) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
  expect(calls.find((a) => a.args[0] === "build")!.opts?.delaiMs).toBe(BUILD_DELAY_MS);
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the stop script kills an agent that ignores HUP and TERM (claude intercepts them), and its whole group", async () => {
  const f = join(mkdtempSync(join(tmpdir(), "webaios-arret-")), "session.pid");
  // Like commandeSession: the shell notes its PID then becomes the agent; here an agent deaf to HUP and TERM, with a child.
  const agent = spawn("sh", ["-c", `echo $$ > ${f}; exec "$@"`, "webaios-session", "sh", "-c", "trap '' HUP TERM; sleep 60 & wait"], {
    detached: true,
    stdio: "ignore",
  });
  const finished = new Promise((ok) => agent.on("exit", ok));
  await expect.poll(() => existsSync(f)).toBe(true);
  const start = Date.now();
  await new Promise<void>((ok, ko) => execFile("sh", ["-c", sessionStopScript(f, "local")], (e) => (e ? ko(e) : ok())));
  await finished;
  expect(Date.now() - start).toBeLessThan(8000);
  expect(alive(agent.pid!)).toBe(false);
  expect(existsSync(f)).toBe(false);
  // No process of the group left (the sleep launched by the agent).
  expect(() => process.kill(-agent.pid!, 0)).toThrow();
}, 15_000);

test("commandeApplication", () => {
  const a = new Workshop({ chemins: paths, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeApplication("todo", "npx vite --port {port}", 5281)).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-e", "WEBAIOS_APP=todo", "-e", "PORT=5281", "-w", "/workspace/projets/todo", "webaios-atelier",
    "sh", "-c", `mkdir -p /workspace/.webaios/journaux; exec >"/workspace/.webaios/journaux/$1.log" 2>&1; eval "$2"`,
    "webaios-app", "todo", "npx vite --port 5281",
  ]);
});

test("arreterApplication only targets its own mark", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).arreterApplication("todo");
  const call = calls.find((x) => x.args[0] === "exec")!;
  expect(call.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(call.args[4]).toContain("WEBAIOS_APP=todo");
  expect(call.args[4]).not.toContain("WEBAIOS_SESSION");
  expect(call.args[4]).toContain("signaler KILL");
  await expect(new Workshop({ chemins: paths, docker: "docker", executer: runCall }).arreterApplication("x'y")).rejects.toThrow();
});

test("arreterApplicationsOrphelines vise WEBAIOS_APP=.*", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).arreterApplicationsOrphelines();
  const script = calls.find((x) => x.args[0] === "exec")!.args[4]!;
  expect(script).toContain("WEBAIOS_APP=.*");
  expect(script).not.toContain("WEBAIOS_SESSION");
});

test("arreterApplication: the dot in a folder name is not a grep wildcard", async () => {
  const { executer: runCall, appels: calls } = fakeRunner([]);
  await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).arreterApplication("my.app");
  const script = calls.find((x) => x.args[0] === "exec")!.args[4]!;
  const pattern = /grep -qzx '([^']*)'/.exec(script)![1]!;
  expect(pattern).toBe("WEBAIOS_APP=my\\.app");
  // The pattern as grep reads it: « my.app » is targeted, « myxapp » is not.
  const targets = (value: string) =>
    new Promise<boolean>((ok) => execFile("sh", ["-c", `printf '%s' "$1" | grep -qx "$2"`, "sh", value, pattern], (e) => ok(!e)));
  expect(await targets("WEBAIOS_APP=my.app")).toBe(true);
  expect(await targets("WEBAIOS_APP=myxapp")).toBe(false);
});

test("commandeRecolte mounts the engine read-only and launches /opt/webaios/moteur/recolteur.mjs", () => {
  const workshop = new Workshop({ chemins: paths, docker: "/usr/local/bin/docker" });
  const c = workshop.commandeRecolte("meteo", "/Users/t/WebAiOs/accueil/widgets/meteo", "/app/docker/moteur");
  expect(c).toEqual([
    "/usr/local/bin/docker", "run", "-i", "--rm",
    "--name", "webaios-recolte-meteo",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp",
    "-v", "/Users/t/WebAiOs/accueil/widgets/meteo:/widget:ro",
    "-v", "/app/docker/moteur:/opt/webaios/moteur:ro",
    "--memory", "512m",
    "--pids-limit", "128",
    IMAGE,
    "timeout", "-k", "5", "180",
    "node", "/opt/webaios/moteur/recolteur.mjs", "/widget",
  ]);
  // The engine folder is mounted as is, not its parent: nothing else of the package enters the container.
  expect(() => workshop.commandeRecolte("meteo", "/d", "/app/x:y")).toThrow();
});

test("commandeRecolte of an action names the container webaios-action-<id>; of a widget, webaios-recolte-<id>", async () => {
  const workshop = new Workshop({ chemins: paths, docker: "/usr/local/bin/docker" });
  const name = (c: string[]) => c[c.indexOf("--name") + 1];
  expect(name(workshop.commandeRecolte({ type: "action", id: "gitlab" }, "/d", "/app/docker/moteur"))).toBe("webaios-action-gitlab");
  expect(name(workshop.commandeRecolte({ type: "widget", id: "meteo" }, "/d", "/app/docker/moteur"))).toBe("webaios-recolte-meteo");
  expect(name(workshop.commandeRecolte("meteo", "/d", "/app/docker/moteur"))).toBe("webaios-recolte-meteo");
  expect(harvestName({ type: "action", id: "gitlab" })).toBe("webaios-action-gitlab");
  expect(harvestName("meteo")).toBe("webaios-recolte-meteo");
  expect(() => harvestName({ type: "action", id: "../x" })).toThrow();
  // The removal targets the same name.
  const calls: string[][] = [];
  const deleter = new Workshop({ chemins: paths, docker: "/usr/local/bin/docker", executer: async (_c, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) });
  await deleter.supprimerRecolte({ type: "action", id: "gitlab" });
  await deleter.supprimerRecolte("meteo");
  expect(calls).toEqual([["rm", "-f", "webaios-action-gitlab"], ["rm", "-f", "webaios-recolte-meteo"]]);
});

test("commandeRecolte with delaiS 1830: timeout -k 5 1830", () => {
  const workshop = new Workshop({ chemins: paths, docker: "/usr/local/bin/docker" });
  const c = workshop.commandeRecolte("veille", "/d", "/app/docker/moteur", 1830);
  const i = c.indexOf("timeout");
  expect(c.slice(i, i + 4)).toEqual(["timeout", "-k", "5", "1830"]);
  // Without a given delay: 180 s as before.
  const d = workshop.commandeRecolte("veille", "/d", "/app/docker/moteur");
  expect(d.slice(d.indexOf("timeout"), d.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "180"]);
});

async function quotedNames(): Promise<string[]> {
  let launched = false;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  const workshop = new Workshop({ chemins: paths, docker: "docker", executer: runCall });
  await workshop.assurerDemarre();
  await workshop.arreterSessionsOrphelines();
  // the image is also called webaios-atelier:1, so only container-name positions count
  return calls.flatMap((a) => a.args.filter((x, i) => /^webaios-atelier(-test)?$/.test(x) && a.args[i - 1] !== "-t"));
}

test("uses WEBAIOS_CONTENEUR for every docker command", async () => {
  vi.stubEnv("WEBAIOS_CONTENEUR", "webaios-atelier-test");
  try {
    const names = await quotedNames();
    expect(names.length).toBeGreaterThan(2);
    expect(new Set(names)).toEqual(new Set(["webaios-atelier-test"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("defaults to webaios-atelier", async () => {
  vi.stubEnv("WEBAIOS_CONTENEUR", "");
  try {
    expect(new Set(await quotedNames())).toEqual(new Set(["webaios-atelier"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("WEBAIOS_PORTS_CONTENEUR gives the published range and tells it to the container; invalid falls back to 5280-5299", async () => {
  const runArgs = async () => {
    const { executer: runCall, appels: calls } = fakeRunner([
      [/ image inspect /, { code: 0 }],
      [/ inspect -f/, { code: 1 }],
    ]);
    await new Workshop({ chemins: paths, docker: "docker", executer: runCall }).assurerDemarre();
    return calls.find((a) => a.args[0] === "run")!.args;
  };
  try {
    vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", "5300-5319");
    expect(containerPortRange()).toEqual([5300, 5319]);
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5300-5319:5300-5319", "WEBAIOS_PORTS=5300-5319"]));
    for (const invalid of ["", "abc", "5319-5300", "80-90"]) {
      vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", invalid);
      expect(containerPortRange()).toEqual([5280, 5299]);
    }
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5280-5299:5280-5299", "WEBAIOS_PORTS=5280-5299"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a failed docker run removes the half-created container, so the next start retries instead of reusing it", async () => {
  let runs = 0;
  const { executer: runCall, appels: calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ run /, () => (++runs === 1 ? { code: 125, stderr: "port is already allocated" } : { code: 0 })],
  ]);
  const workshop = new Workshop({ chemins: paths, docker: "docker", executer: runCall });
  await expect(workshop.assurerDemarre()).rejects.toThrow("port is already allocated");
  const iRun = calls.findIndex((a) => a.args[0] === "run");
  expect(calls.slice(iRun + 1).some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
  await workshop.assurerDemarre();
  expect(runs).toBe(2);
});
