import { describe, expect, test, vi } from "vitest";
import { spacePaths } from "../../src/paths.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workshop, BUILD_DELAY_MS, parseBuildStep, IMAGE, dockerfileHash, harvestName, containerPortRange, sessionStopScript, findDocker } from "../../src/container/workshop.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOOLS_FOLDERS } from "../../src/container/runner.js";
import { fakeRunner } from "../helpers/fake-runner.js";

const paths = spacePaths("/Users/t/Ressac");

test("docker not found → docker-absent, without an exception", async () => {
  expect(await new Workshop({ paths: paths, docker: null }).state()).toBe("docker-absent");
  expect(await new Workshop({ paths: paths, docker: null }).ensureStarted()).toBe("docker-absent");
});

test("docker installed after the start is found without a restart", async () => {
  const { run: runCall, calls } = fakeRunner([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
  let installed = false;
  const workshop = new Workshop({ paths: paths, findDocker: () => (installed ? "docker" : null), run: runCall });
  expect(await workshop.state()).toBe("docker-absent");
  installed = true;
  await workshop.state();
  expect(calls.map((c) => [c.command, ...c.args].join(" "))).toEqual(["docker info"]);
});

test("docker info failing → docker-absent", async () => {
  const { run: runCall } = fakeRunner([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
  expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).state()).toBe("docker-absent");
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
  for (const [{ run: runCall }, expected] of cas) {
    expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).state()).toBe(expected);
  }
});

test("ensureStarted on absent: build if the image is missing then run with the right arguments", async () => {
  let launched = false;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted()).toBe("demarre");
  const build = calls.find((a) => a.args[0] === "build")!;
  expect(build.args.slice(0, 4)).toEqual(["build", "-t", "ressac-workshop:1", "--label"]);
  expect(build.args).toContain("-f");
  const run = calls.find((a) => a.args[0] === "run")!;
  expect(run.args).toEqual(expect.arrayContaining([
    "--name", "ressac-workshop",
    "127.0.0.1:5280-5299:5280-5299",
    "webaios-home:/home/node",
    "/Users/t/Ressac:/workspace",
    "host.docker.internal:host-gateway",
    "ressac-workshop:1",
  ]));
  expect(run.args.slice(-2)).toEqual(["sleep", "infinity"]);
  // .ressac (launch profiles…) read-only, so it cannot be renamed away; only the logs, which the container writes, on top.
  const w = run.args.indexOf("-v");
  expect(run.args.slice(w, w + 8)).toEqual([
    "-v", "/Users/t/Ressac:/workspace",
    "-v", "/Users/t/Ressac/.ressac:/workspace/.ressac:ro",
    "-v", "/Users/t/Ressac/.ressac/logs:/workspace/.ressac/logs",
    "-v", "webaios-home:/home/node",
  ]);
});

test("ensureStarted on arrete → docker start", async () => {
  let started = false;
  const { run: runCall, calls } = fakeRunner([
    [/ inspect -f .*Mounts/, { code: 0, stdout: `${paths.root}|${dockerfileHash()}\n` }],
    [/ inspect -f/, () => ({ code: 0, stdout: started ? "true\n" : "false\n" })],
    [/ start /, () => ((started = true), { code: 0 })],
  ]);
  expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted()).toBe("demarre");
  expect(calls.some((a) => a.args.join(" ") === "start ressac-workshop")).toBe(true);
  expect(calls.some((a) => a.args[0] === "run")).toBe(false);
});

test("execCommand interactive and non-interactive", () => {
  const a = new Workshop({ paths: paths, docker: "/opt/homebrew/bin/docker" });
  expect(a.execCommand(["claude"], { interactive: true })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-w", "/workspace", "ressac-workshop", "claude",
  ]);
  expect(a.execCommand(["claude", "-p", "x"], { interactive: false })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-w", "/workspace", "ressac-workshop", "claude", "-p", "x",
  ]);
});

test("the docker probes have a timeout (Docker Desktop stuck at startup)", async () => {
  const { run: runCall, calls } = fakeRunner([[/ inspect /, { code: 0, stdout: "true\n" }]]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).state();
  for (const a of calls) expect(a.opts?.delayMs, a.args.join(" ")).toBeGreaterThan(0);
});

test("the published ports avoid Vite's (5173…): 5280-5299", async () => {
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
  ]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted();
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
function fakeDocker(o: { source: string; containerHash: string; imageHash: string; running?: string }) {
  let recreated = false;
  const f = fakeRunner([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 0, stdout: `${o.imageHash}\n` }],
    [/ inspect -f \{\{\.State\.Running\}\}/, () => ({ code: 0, stdout: recreated ? "true\n" : (o.running ?? "true\n") })],
    [/ inspect -f .*Mounts/, () => ({ code: 0, stdout: recreated ? "" : `${o.source}|${o.containerHash}\n` })],
    [/ rm -f ressac-workshop/, () => ((recreated = true), { code: 0 })],
  ]);
  return f;
}

test("existing container on the right folder and the right image → kept", async () => {
  const e = dockerfileHash();
  const { run: runCall, calls } = fakeDocker({ source: paths.root, containerHash: e, imageHash: e });
  expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted()).toBe("demarre");
  expect(calls.some((a) => a.args[0] === "rm")).toBe(false);
});

test("existing container mounted on another folder → removed then recreated", async () => {
  const e = dockerfileHash();
  const { run: runCall, calls } = fakeDocker({ source: "/tmp/ailleurs", containerHash: e, imageHash: e });
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted();
  expect(calls.some((a) => a.args.join(" ") === "rm -f ressac-workshop")).toBe(true);
  expect(calls.some((a) => a.args[0] === "run")).toBe(true);
});

test("modified Dockerfile → image rebuilt and container recreated", async () => {
  const { run: runCall, calls } = fakeDocker({ source: paths.root, containerHash: "ancienne", imageHash: "ancienne" });
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted();
  const build = calls.find((a) => a.args[0] === "build")!;
  expect(build.args).toContain(`ressac.dockerfile=${dockerfileHash()}`);
  expect(calls.some((a) => a.args.join(" ") === "rm -f ressac-workshop")).toBe(true);
});

test("interactive session: its PID is noted in the container, and stopping it kills it there (killing the docker client is not enough)", async () => {
  const { run: runCall, calls } = fakeRunner([]);
  const a = new Workshop({ paths: paths, docker: "/opt/homebrew/bin/docker", run: runCall });
  const pid = "/tmp/ressac-session-ab12.pid";
  expect(a.sessionCommand("ab12", ["claude", "--x"])).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-e", "RESSAC_SESSION=ab12", "-w", "/workspace", "ressac-workshop",
    "sh", "-c", `echo $$ > ${pid}; exec "$@"`, "ressac-session", "claude", "--x",
  ]);
  await a.stopSession("ab12");
  const call = calls.find((x) => x.args[0] === "exec")!;
  expect(call.args.slice(0, 4)).toEqual(["exec", "ressac-workshop", "sh", "-c"]);
  expect(call.args[4]).toContain(`cat ${pid}`);
  expect(call.args[4]).toBe(sessionStopScript(pid, "ab12"));
  expect(() => a.sessionCommand("../x", ["claude"])).toThrow();
});

test("two starts at the same time: a single image build and a single container", async () => {
  let finishBuild!: () => void;
  let launched = false;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ build /, () => new Promise((ok) => (finishBuild = () => ok({ code: 0 })))],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  const workshop = new Workshop({ paths: paths, docker: "docker", run: runCall });
  const a = workshop.ensureStarted();
  const b = workshop.ensureStarted();
  await new Promise((r) => setTimeout(r, 10));
  finishBuild();
  expect(await Promise.all([a, b])).toEqual(["demarre", "demarre"]);
  expect(calls.filter((x) => x.args[0] === "build")).toHaveLength(1);
  expect(calls.filter((x) => x.args[0] === "run")).toHaveLength(1);
});

test("after a failure, a new start retries", async () => {
  let failures = 0;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, { code: 1 }],
    [/ build /, () => (failures++, { code: 1, stderr: "réseau" })],
  ]);
  const workshop = new Workshop({ paths: paths, docker: "docker", run: runCall });
  await expect(workshop.ensureStarted()).rejects.toThrow("réseau");
  await expect(workshop.ensureStarted()).rejects.toThrow("réseau");
  expect(calls.filter((x) => x.args[0] === "build")).toHaveLength(2);
});

test("a failed build keeps only the tail of its output in the error", async () => {
  const stderr = ["#1 [internal] load build definition", ...Array.from({ length: 200 }, (_, i) => `#${i} step ${"x".repeat(40)}`), "ERROR: failed to solve: npm install exited with 1"].join("\n");
  const { run: runCall } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, { code: 1 }],
    [/ build /, { code: 1, stderr }],
  ]);
  const error: Error = await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted().then(() => { throw new Error("no failure"); }, (e) => e);
  expect(error.message).toContain("ERROR: failed to solve: npm install exited with 1");
  expect(error.message).not.toContain("load build definition");
  expect(error.message.length).toBeLessThan(400);
});

test("building and launching the container have a maximum timeout", async () => {
  let launched = false;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted();
  for (const a of calls) expect(a.opts?.delayMs, a.args.join(" ")).toBeGreaterThan(0);
  expect(calls.find((a) => a.args[0] === "build")!.opts?.delayMs).toBe(BUILD_DELAY_MS);
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
  const f = join(mkdtempSync(join(tmpdir(), "ressac-arret-")), "session.pid");
  // Like commandeSession: the shell notes its PID then becomes the agent; here an agent deaf to HUP and TERM, with a child.
  const agent = spawn("sh", ["-c", `echo $$ > ${f}; exec "$@"`, "ressac-session", "sh", "-c", "trap '' HUP TERM; sleep 60 & wait"], {
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

test("appCommand", () => {
  const a = new Workshop({ paths: paths, docker: "/opt/homebrew/bin/docker" });
  expect(a.appCommand("todo", "npx vite --port {port}", 5281)).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-e", "RESSAC_APP=todo", "-e", "PORT=5281", "-w", "/workspace/projects/todo", "ressac-workshop",
    "sh", "-c", `mkdir -p /workspace/.ressac/logs; exec >"/workspace/.ressac/logs/$1.log" 2>&1; eval "$2"`,
    "ressac-app", "todo", "npx vite --port 5281",
  ]);
});

test("stopApp only targets its own mark", async () => {
  const { run: runCall, calls } = fakeRunner([]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).stopApp("todo");
  const call = calls.find((x) => x.args[0] === "exec")!;
  expect(call.args.slice(0, 4)).toEqual(["exec", "ressac-workshop", "sh", "-c"]);
  expect(call.args[4]).toContain("RESSAC_APP=todo");
  expect(call.args[4]).not.toContain("RESSAC_SESSION");
  expect(call.args[4]).toContain("signaler KILL");
  await expect(new Workshop({ paths: paths, docker: "docker", run: runCall }).stopApp("x'y")).rejects.toThrow();
});

test("stopOrphanApps vise RESSAC_APP=.*", async () => {
  const { run: runCall, calls } = fakeRunner([]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).stopOrphanApps();
  const script = calls.find((x) => x.args[0] === "exec")!.args[4]!;
  expect(script).toContain("RESSAC_APP=.*");
  expect(script).not.toContain("RESSAC_SESSION");
});

test("stopApp: the dot in a folder name is not a grep wildcard", async () => {
  const { run: runCall, calls } = fakeRunner([]);
  await new Workshop({ paths: paths, docker: "docker", run: runCall }).stopApp("my.app");
  const script = calls.find((x) => x.args[0] === "exec")!.args[4]!;
  const pattern = /grep -qzx '([^']*)'/.exec(script)![1]!;
  expect(pattern).toBe("RESSAC_APP=my\\.app");
  // The pattern as grep reads it: « my.app » is targeted, « myxapp » is not.
  const targets = (value: string) =>
    new Promise<boolean>((ok) => execFile("sh", ["-c", `printf '%s' "$1" | grep -qx "$2"`, "sh", value, pattern], (e) => ok(!e)));
  expect(await targets("RESSAC_APP=my.app")).toBe(true);
  expect(await targets("RESSAC_APP=myxapp")).toBe(false);
});

test("harvestCommand mounts the engine read-only and launches /opt/ressac/engine/harvester.mjs", () => {
  const workshop = new Workshop({ paths: paths, docker: "/usr/local/bin/docker" });
  const c = workshop.harvestCommand("meteo", "/Users/t/Ressac/home/widgets/meteo", "/app/docker/engine");
  expect(c).toEqual([
    "/usr/local/bin/docker", "run", "-i", "--rm",
    "--name", "ressac-harvest-meteo",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp",
    "-v", "/Users/t/Ressac/home/widgets/meteo:/widget:ro",
    "-v", "/app/docker/engine:/opt/ressac/engine:ro",
    "--memory", "512m",
    "--pids-limit", "128",
    "--cpus", "1",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    IMAGE,
    "timeout", "-k", "5", "180",
    "node", "/opt/ressac/engine/harvester.mjs", "/widget",
  ]);
  // The engine folder is mounted as is, not its parent: nothing else of the package enters the container.
  expect(() => workshop.harvestCommand("meteo", "/d", "/app/x:y")).toThrow();
});

test("harvestCommand of an action names the container ressac-action-<id>; of a widget, ressac-harvest-<id>", async () => {
  const workshop = new Workshop({ paths: paths, docker: "/usr/local/bin/docker" });
  const name = (c: string[]) => c[c.indexOf("--name") + 1];
  expect(name(workshop.harvestCommand({ type: "action", id: "gitlab" }, "/d", "/app/docker/engine"))).toBe("ressac-action-gitlab");
  expect(name(workshop.harvestCommand({ type: "widget", id: "meteo" }, "/d", "/app/docker/engine"))).toBe("ressac-harvest-meteo");
  expect(name(workshop.harvestCommand("meteo", "/d", "/app/docker/engine"))).toBe("ressac-harvest-meteo");
  expect(harvestName({ type: "action", id: "gitlab" })).toBe("ressac-action-gitlab");
  expect(harvestName("meteo")).toBe("ressac-harvest-meteo");
  expect(() => harvestName({ type: "action", id: "../x" })).toThrow();
  // The removal targets the same name.
  const calls: string[][] = [];
  const deleter = new Workshop({ paths: paths, docker: "/usr/local/bin/docker", run: async (_c, args) => (calls.push(args), { code: 0, stdout: "", stderr: "" }) });
  await deleter.deleteHarvest({ type: "action", id: "gitlab" });
  await deleter.deleteHarvest("meteo");
  expect(calls).toEqual([["rm", "-f", "ressac-action-gitlab"], ["rm", "-f", "ressac-harvest-meteo"]]);
});

test("harvestCommand with delaiS 1830: timeout -k 5 1830", () => {
  const workshop = new Workshop({ paths: paths, docker: "/usr/local/bin/docker" });
  const c = workshop.harvestCommand("veille", "/d", "/app/docker/engine", 1830);
  const i = c.indexOf("timeout");
  expect(c.slice(i, i + 4)).toEqual(["timeout", "-k", "5", "1830"]);
  // Without a given delay: 180 s as before.
  const d = workshop.harvestCommand("veille", "/d", "/app/docker/engine");
  expect(d.slice(d.indexOf("timeout"), d.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "180"]);
});

async function quotedNames(): Promise<string[]> {
  let launched = false;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((launched = true), { code: 0 })],
  ]);
  const workshop = new Workshop({ paths: paths, docker: "docker", run: runCall });
  await workshop.ensureStarted();
  await workshop.stopOrphanSessions();
  // the image is also called ressac-workshop:1, so only container-name positions count
  return calls.flatMap((a) => a.args.filter((x, i) => /^ressac-workshop(-test)?$/.test(x) && a.args[i - 1] !== "-t"));
}

test("uses RESSAC_CONTAINER for every docker command", async () => {
  vi.stubEnv("RESSAC_CONTAINER", "ressac-workshop-test");
  try {
    const names = await quotedNames();
    expect(names.length).toBeGreaterThan(2);
    expect(new Set(names)).toEqual(new Set(["ressac-workshop-test"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("defaults to ressac-workshop", async () => {
  vi.stubEnv("RESSAC_CONTAINER", "");
  try {
    expect(new Set(await quotedNames())).toEqual(new Set(["ressac-workshop"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("RESSAC_CONTAINER_PORTS gives the published range and tells it to the container; invalid falls back to 5280-5299", async () => {
  const runArgs = async () => {
    const { run: runCall, calls } = fakeRunner([
      [/ image inspect /, { code: 0 }],
      [/ inspect -f/, { code: 1 }],
    ]);
    await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted();
    return calls.find((a) => a.args[0] === "run")!.args;
  };
  try {
    vi.stubEnv("RESSAC_CONTAINER_PORTS", "5300-5319");
    expect(containerPortRange()).toEqual([5300, 5319]);
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5300-5319:5300-5319", "RESSAC_PORTS=5300-5319"]));
    for (const invalid of ["", "abc", "5319-5300", "80-90"]) {
      vi.stubEnv("RESSAC_CONTAINER_PORTS", invalid);
      expect(containerPortRange()).toEqual([5280, 5299]);
    }
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5280-5299:5280-5299", "RESSAC_PORTS=5280-5299"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a failed docker run removes the half-created container, so the next start retries instead of reusing it", async () => {
  let runs = 0;
  const { run: runCall, calls } = fakeRunner([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ run /, () => (++runs === 1 ? { code: 125, stderr: "port is already allocated" } : { code: 0 })],
  ]);
  const workshop = new Workshop({ paths: paths, docker: "docker", run: runCall });
  await expect(workshop.ensureStarted()).rejects.toThrow("port is already allocated");
  const iRun = calls.findIndex((a) => a.args[0] === "run");
  expect(calls.slice(iRun + 1).some((a) => a.args.join(" ") === "rm -f ressac-workshop")).toBe(true);
  await workshop.ensureStarted();
  expect(runs).toBe(2);
});

describe("restart, rebuild, exec", () => {
  const upToDate = `${paths.root}|${dockerfileHash()}\n`;

  test("restart stops then starts", async () => {
    let started = false;
    const { run: runCall, calls } = fakeRunner([
      [/ inspect -f .*Mounts/, { code: 0, stdout: upToDate }],
      [/ inspect -f/, () => ({ code: 0, stdout: started ? "true\n" : "false\n" })],
      [/ start /, () => ((started = true), { code: 0 })],
    ]);
    expect(await new Workshop({ paths, docker: "docker", run: runCall }).restart()).toBe("demarre");
    const lines = calls.map((c) => c.args.join(" "));
    expect(lines.indexOf("stop -t 2 ressac-workshop")).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => l.startsWith("inspect"))).toBeGreaterThan(lines.indexOf("stop -t 2 ressac-workshop"));
    expect(lines).toContain("start ressac-workshop");
  });

  const rebuildRules = () => {
    let launched = false;
    return fakeRunner([
      [/ image inspect /, { code: 0, stdout: dockerfileHash() + "\n" }],
      [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
      [/ run /, () => ((launched = true), { code: 0 })],
    ]);
  };

  test("rebuild keeps the volumes", async () => {
    const { run: runCall, calls } = rebuildRules();
    expect(await new Workshop({ paths, docker: "docker", run: runCall }).rebuild()).toBe("demarre");
    const names = calls.map((c) => c.args[0]);
    expect(names.indexOf("rm")).toBeLessThan(names.indexOf("build"));
    expect(names.indexOf("build")).toBeLessThan(names.indexOf("run"));
    expect(calls.find((c) => c.args[0] === "rm")!.args).toEqual(["rm", "-f", "ressac-workshop"]);
    const build = calls.find((c) => c.args[0] === "build")!;
    expect(build.args).toEqual(expect.arrayContaining(["--no-cache", "--pull"]));
    expect(calls.find((c) => c.args[0] === "run")!.args).toEqual(
      expect.arrayContaining(["webaios-home:/home/node", `${paths.root}:/workspace`]),
    );
  });

  test("rebuild twice at once builds once", async () => {
    const { run: runCall, calls } = rebuildRules();
    const w = new Workshop({ paths, docker: "docker", run: runCall });
    await Promise.all([w.rebuild(), w.rebuild()]);
    expect(calls.filter((c) => c.args[0] === "build")).toHaveLength(1);
  });

  test("a rebuild never rides on a plain startup in progress", async () => {
    const { run: runCall, calls } = rebuildRules();
    const w = new Workshop({ paths, docker: "docker", run: runCall });
    await Promise.all([w.ensureStarted(), w.rebuild()]);
    expect(calls.map((c) => c.args.join(" "))).toContain("rm -f ressac-workshop");
    expect(calls.some((c) => c.args[0] === "build" && c.args.includes("--no-cache"))).toBe(true);
  });

  test("docker absent", async () => {
    const { run: runCall, calls } = fakeRunner([[/ info/, { code: 1 }]]);
    const w = new Workshop({ paths, docker: "docker", run: runCall });
    expect(await w.restart()).toBe("docker-absent");
    expect(await w.rebuild()).toBe("docker-absent");
    expect(calls.every((c) => c.args[0] === "info")).toBe(true);
    expect(await new Workshop({ paths, docker: null }).exec(["ls"])).toEqual({ code: 1, stdout: "", stderr: "Docker introuvable" });
  });

  test("exec", async () => {
    const { run: runCall, calls } = fakeRunner([]);
    await new Workshop({ paths, docker: "docker", run: runCall }).exec(["claude", "auth", "status", "--json"]);
    expect(calls[0]!.args).toEqual(["exec", "ressac-workshop", "claude", "auth", "status", "--json"]);
  });
});

test("sessionCommand passes env variables by name only", () => {
  const w = new Workshop({ paths: spacePaths("/x"), docker: "/d", run: fakeRunner([]).run });
  const argv = w.sessionCommand("s1", ["codex"], ["RESSAC_MCP_TOKEN"]);
  const at = argv.indexOf("RESSAC_MCP_TOKEN");
  expect(argv[at - 1]).toBe("-e");
  expect(argv.some((a) => a.startsWith("RESSAC_MCP_TOKEN="))).toBe(false);
});

describe("first build progress", () => {
  const sample = readFileSync(new URL("../fixtures/buildkit-plain-progress.txt", import.meta.url), "utf8");

  test("the parser reads the steps of a recorded BuildKit plain output", () => {
    const steps = sample.split("\n").map((l) => parseBuildStep(l, "fr")).filter(Boolean);
    expect(steps).toEqual([
      { step: 1, of: 3, label: "Téléchargement de l'image de base" },
      { step: 2, of: 3, label: "Outils système" },
      { step: 3, of: 3, label: "Installation de Claude Code et Codex" },
    ]);
  });

  test("the parser ignores non-BuildKit output and labels other RUNs", () => {
    expect(parseBuildStep("Step 2/3 : RUN apt-get update", "fr")).toBeNull();
    expect(parseBuildStep("#5 DONE 38.2s", "fr")).toBeNull();
    expect(parseBuildStep("", "fr")).toBeNull();
    expect(parseBuildStep("#8 [stage-1 2/4] RUN make", "fr")).toEqual({ step: 2, of: 4, label: "Préparation" });
    expect(parseBuildStep("#8 [stage-1 2/4] RUN make", "en")).toEqual({ step: 2, of: 4, label: "Preparing" });
    expect(parseBuildStep("#5 [1/3] FROM node", "en")?.label).toBe("Downloading the base image");
  });

  test("every subscriber hears the steps, even a late one, across split chunks", async () => {
    let launched = false;
    const run = (async (_c: string, args: string[], opts?: { onStderr?: (s: string) => void }) => {
      if (args[0] === "build") {
        opts!.onStderr!("#4 [1/3] FROM docker.io/lib");
        opts!.onStderr!("rary/node:22\n#5 [2/3] RUN apt-get update\n");
        await lateJoin();
        opts!.onStderr!("#6 [3/3] RUN npm install -g @anthropic-ai/claude-code\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "run") launched = true;
      if (args[0] === "image") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "inspect") return { code: launched ? 0 : 1, stdout: "true\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }) as never;
    const w = new Workshop({ paths: paths, docker: "docker", run });
    const early: number[] = [];
    const late: number[] = [];
    w.onBuildProgress((p) => early.push(p.step));
    const lateJoin = async () => void w.onBuildProgress((p) => late.push(p.step));
    expect(await w.ensureStarted()).toBe("demarre");
    expect(early).toEqual([1, 2, 3]);
    expect(late).toEqual([2, 3]);
  });
});

describe("the container from before the rename to Ressac", () => {
  /** A first start (no container, image up to date): the docker commands, in order. */
  async function firstStart(env: string) {
    vi.stubEnv("RESSAC_CONTAINER", env);
    try {
      let launched = false;
      const { run: runCall, calls } = fakeRunner([
        [/ image inspect /, { code: 0, stdout: `${dockerfileHash()}\n` }],
        [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
        [/ run /, () => ((launched = true), { code: 0 })],
        [/ rm -f webaios-/, { code: 1, stderr: "Error: No such container" }],
      ]);
      expect(await new Workshop({ paths: paths, docker: "docker", run: runCall }).ensureStarted()).toBe("demarre");
      return calls.map((c) => c.args.join(" "));
    } finally {
      vi.unstubAllEnvs();
    }
  }

  test("is removed before the new one is created: it holds the same ports (absent: no error)", async () => {
    const lines = await firstStart("ressac-workshop-firefox");
    const rm = lines.indexOf("rm -f webaios-workshop-firefox");
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(lines.findIndex((l) => l.startsWith("run ")));
    expect(await firstStart("")).toContain("rm -f webaios-workshop");
  });

  test("never with Docker not running, nor when the container already exists", async () => {
    const { run: off, calls: offCalls } = fakeRunner([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
    expect(await new Workshop({ paths: paths, docker: "docker", run: off }).ensureStarted()).toBe("docker-absent");
    expect(offCalls.some((c) => c.args[0] === "rm")).toBe(false);
    const { run: on, calls } = fakeRunner([[/ inspect -f \{\{\.State/, { code: 0, stdout: "true\n" }], [/ inspect /, { code: 0, stdout: `${paths.root}|${dockerfileHash()}\n` }]]);
    expect(await new Workshop({ paths: paths, docker: "docker", run: on }).ensureStarted()).toBe("demarre");
    expect(calls.some((c) => c.args[0] === "rm")).toBe(false);
  });
});

describe("agent network", () => {
  const network = () => ({ ports: [5281, 5282], domains: ["ok.example.com", "evil.com/x", "1.2.3.4", "*.com", "-a.com", "Up.com", "*.good.dev"] });
  const make = (rules: Parameters<typeof fakeRunner>[0], withNetwork = true) => {
    const { run, calls } = fakeRunner(rules);
    return { calls, workshop: new Workshop({ paths: paths, docker: "docker", run, ...(withNetwork ? { network } : {}) }) };
  };

  test("docker run carries the network, memory and proxy flags once each", async () => {
    let launched = false;
    const { run, calls } = fakeRunner([
      [/ image inspect /, { code: 1 }],
      [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
      [/ run /, () => ((launched = true), { code: 0 })],
    ]);
    await new Workshop({ paths: paths, docker: "docker", run }).ensureStarted();
    const args = calls.find((a) => a.args[0] === "run")!.args;
    const count = (x: string) => args.filter((a) => a === x).length;
    for (const f of ["--cap-add", "--memory", "--pids-limit", "--sysctl"]) expect(count(f)).toBe(1);
    expect(args.join(" ")).toContain("--cap-add NET_ADMIN --security-opt no-new-privileges --memory 4g --pids-limit 1024 --sysctl net.ipv6.conf.all.disable_ipv6=1");
    for (const e of [
      "HTTPS_PROXY=http://127.0.0.1:3128", "https_proxy=http://127.0.0.1:3128", "HTTP_PROXY=http://127.0.0.1:3128", "http_proxy=http://127.0.0.1:3128",
      "NO_PROXY=localhost,127.0.0.1,host.docker.internal", "no_proxy=localhost,127.0.0.1,host.docker.internal",
      "NODE_USE_ENV_PROXY=1", "DISABLE_AUTOUPDATER=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    ]) expect(args.filter((a) => a === e), e).toHaveLength(1);
  });

  test("the image hash covers the network module and the run flags version", async () => {
    const { RUN_FLAGS, RUN_FLAGS_VERSION } = await import("../../src/container/workshop.js");
    // Changing a flag must bump RUN_FLAGS_VERSION (and the fake docker's copy of it).
    expect(RUN_FLAGS_VERSION).toBe("3");
    expect(RUN_FLAGS.join(" ")).toMatchInlineSnapshot(`"--cap-add NET_ADMIN --security-opt no-new-privileges --memory 4g --pids-limit 1024 --sysctl net.ipv6.conf.all.disable_ipv6=1 -e HTTPS_PROXY=http://127.0.0.1:3128 -e https_proxy=http://127.0.0.1:3128 -e HTTP_PROXY=http://127.0.0.1:3128 -e http_proxy=http://127.0.0.1:3128 -e NO_PROXY=localhost,127.0.0.1,host.docker.internal -e no_proxy=localhost,127.0.0.1,host.docker.internal -e NODE_USE_ENV_PROXY=1 -e DISABLE_AUTOUPDATER=1 -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"`);
  });

  test("secureNetwork applies the rules with valid domains only, then probes", async () => {
    const { workshop, calls } = make([[/curl/, { code: 7 }]]);
    await workshop.secureNetwork();
    expect(calls[0]!.args).toEqual(["exec", "-u", "root", "-w", "/", "-i", "ressac-workshop", "node", "/opt/ressac/ressac-network.mjs", "apply"]);
    expect(JSON.parse(calls[0]!.opts!.input!)).toEqual({ ports: [5281, 5282], domains: ["ok.example.com", "*.good.dev"] });
    expect(calls[1]!.args).toEqual(["exec", "ressac-workshop", "curl", "-s", "--noproxy", "*", "--max-time", "3", "https://1.1.1.1"]);
  });

  test("secureNetwork fails closed: apply error, or a reachable probe", async () => {
    await expect(make([[/apply/, { code: 1, stderr: "boom\n" }]]).workshop.secureNetwork()).rejects.toThrow(/boom/);
    for (const code of [0, 35, 60, 124, 126]) await expect(make([[/curl/, { code }]]).workshop.secureNetwork(), String(code)).rejects.toThrow(/could not be secured/);
    await expect(make([[/curl/, { code: 28 }]]).workshop.secureNetwork()).rejects.toThrow(/could not be secured/);
  });

  test("concurrent secureNetwork calls share one apply", async () => {
    const { workshop, calls } = make([[/curl/, { code: 7 }]]);
    await Promise.all([workshop.secureNetwork(), workshop.secureNetwork()]);
    expect(calls.filter((c) => c.args.includes("apply"))).toHaveLength(1);
  });

  test("a call during an apply queues one follow-up that reads the new domains", async () => {
    let domains = ["old.example.com"];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { run, calls } = fakeRunner([[/ apply$/, async () => (first && ((first = false), await gate), { code: 0 })], [/curl/, { code: 7 }]]);
    const workshop = new Workshop({ paths: paths, docker: "docker", run, network: () => ({ ports: [1], domains }) });
    const a = workshop.secureNetwork();
    await new Promise((r) => setTimeout(r, 10));
    domains = ["new.example.com"];
    const b = workshop.secureNetwork();
    const c = workshop.secureNetwork();
    release();
    await Promise.all([a, b, c]);
    const sent = calls.filter((x) => x.args.includes("apply")).map((x) => JSON.parse(x.opts!.input!).domains);
    expect(sent).toEqual([["old.example.com"], ["new.example.com"]]);
  });

  test("start applies the network when it ends running: from absent and from stopped", async () => {
    let launched = false;
    const absent = fakeRunner([
      [/ image inspect /, { code: 0, stdout: `${dockerfileHash()}\n` }],
      [/ inspect /, () => ({ code: launched ? 0 : 1, stdout: "true\n" })],
      [/ run /, () => ((launched = true), { code: 0 })],
      [/curl/, { code: 7 }],
    ]);
    await new Workshop({ paths: paths, docker: "docker", run: absent.run, network }).ensureStarted();
    expect(absent.calls.some((c) => c.args.includes("apply"))).toBe(true);
    let started = false;
    const stopped = fakeRunner([
      [/ inspect -f \{\{\.State/, () => ({ code: 0, stdout: started ? "true\n" : "false\n" })],
      [/ inspect /, { code: 0, stdout: `${paths.root}|${dockerfileHash()}\n` }],
      [/ start /, () => ((started = true), { code: 0 })],
      [/curl/, { code: 7 }],
    ]);
    await new Workshop({ paths: paths, docker: "docker", run: stopped.run, network }).ensureStarted();
    expect(stopped.calls.some((c) => c.args.includes("apply"))).toBe(true);
  });

  test("exec secures the network first; a failed apply refuses the command", async () => {
    const ok = make([[/curl/, { code: 7 }]]);
    await ok.workshop.exec(["claude", "auth", "status"]);
    const names = ok.calls.map((c) => c.args.join(" "));
    expect(names.findIndex((n) => n.includes("apply"))).toBeLessThan(names.findIndex((n) => n.endsWith("claude auth status")));
    await ok.workshop.exec(["claude", "auth", "status"]);
    expect(ok.calls.filter((c) => c.args.includes("apply"))).toHaveLength(1);
    const bad = make([[/apply/, { code: 1, stderr: "boom" }]]);
    await expect(bad.workshop.exec(["claude", "auth", "status"])).rejects.toThrow(/boom/);
    expect(bad.calls.some((c) => c.args.includes("claude"))).toBe(false);
  });

  test("secureNetwork does nothing without a network option", async () => {
    const { workshop, calls } = make([], false);
    await workshop.secureNetwork();
    expect(calls).toEqual([]);
  });

  test("the kernel's domain validator agrees with the image's", async () => {
    // @ts-expect-error plain .mjs without declarations
    const image = (await import("../../docker/ressac-network.mjs")) as { validDomain: (d: string) => boolean };
    const { validDomain } = await import("../../src/container/workshop.js");
    for (const d of ["a.com", "*.a.com", "a.b-c.io", "evil.com/x", "1.2.3.4", "*.com", "com", "-a.com", "a-.com", "Up.com", "a b.com", "a.com:80", "", "*.", "x".repeat(254) + ".com", "a..com"])
      expect(validDomain(d), d).toBe(image.validDomain(d));
  });
});

describe("Codex requirements", () => {
  test("only managed hooks, and only the ressac MCP server at the session's URL", async () => {
    const { codexRequirements } = await import("../../src/container/workshop.js");
    expect(codexRequirements("http://host.docker.internal:4567/mcp")).toBe(
      'allow_managed_hooks_only = true\n\n[mcp_servers.ressac.identity]\nurl = "http://host.docker.internal:4567/mcp"\n',
    );
  });

  test("restrictCodex writes them as root, by rename, and throws when it fails", async () => {
    const { run, calls } = fakeRunner([]);
    const workshop = new Workshop({ paths: paths, docker: "docker", run });
    await workshop.restrictCodex("http://host.docker.internal:4567/mcp");
    expect(calls[0]!.args.slice(0, 7)).toEqual(["exec", "-u", "root", "-w", "/", "-i", "ressac-workshop"]);
    expect(calls[0]!.args.at(-1)).toMatch(/^umask 022 && .* && mv /);
    expect(calls[0]!.opts!.input).toContain('url = "http://host.docker.internal:4567/mcp"');
    const failing = new Workshop({ paths: paths, docker: "docker", run: fakeRunner([[/ exec /, { code: 1, stderr: "nope" }]]).run });
    await expect(failing.restrictCodex("http://x/mcp")).rejects.toThrow("nope");
  });
});
