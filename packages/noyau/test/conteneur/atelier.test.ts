import { expect, test, vi } from "vitest";
import { spacePaths } from "../../src/chemins.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { Atelier, BUILD_DELAY_MS, IMAGE, dockerfileHash, harvestName, containerPortRange, sessionStopScript, findDocker } from "../../src/conteneur/atelier.js";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOOLS_FOLDERS } from "../../src/conteneur/executeur.js";
import { executeurFactice } from "../aide/executeur-factice.js";

const chemins = spacePaths("/Users/t/WebAiOs");

test("docker not found → docker-absent, without an exception", async () => {
  expect(await new Atelier({ chemins, docker: null }).etat()).toBe("docker-absent");
  expect(await new Atelier({ chemins, docker: null }).assurerDemarre()).toBe("docker-absent");
});

test("docker info failing → docker-absent", async () => {
  const { executer } = executeurFactice([[/ info/, { code: 1, stderr: "Cannot connect" }]]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).etat()).toBe("docker-absent");
});

test("trouverDocker finds OrbStack outside the PATH", () => {
  expect(findDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.orbstack/bin/docker")).toBe(
    "/Users/t/.orbstack/bin/docker",
  );
});

test("trouverDocker prefers the PATH, and returns null if nothing", () => {
  expect(findDocker({ PATH: "/a:/b", HOME: "/h" }, (p) => p === "/b/docker" || p === "/usr/local/bin/docker")).toBe(
    "/b/docker",
  );
  expect(findDocker({ PATH: "/a", HOME: "/h" }, () => false)).toBeNull();
});

test("etat selon docker inspect", async () => {
  const cas: [ReturnType<typeof executeurFactice>, string][] = [
    [executeurFactice([[/ inspect /, { code: 0, stdout: "true\n" }]]), "demarre"],
    [executeurFactice([[/ inspect /, { code: 0, stdout: "false\n" }]]), "arrete"],
    [executeurFactice([[/ inspect /, { code: 1, stderr: "No such object" }]]), "absent"],
  ];
  for (const [{ executer }, attendu] of cas) {
    expect(await new Atelier({ chemins, docker: "docker", executer }).etat()).toBe(attendu);
  }
});

test("assurerDemarre on absent: build if the image is missing then run with the right arguments", async () => {
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  const build = appels.find((a) => a.args[0] === "build")!;
  expect(build.args.slice(0, 3)).toEqual(["build", "-t", "webaios-atelier:1"]);
  expect(build.args).toContain("-f");
  const run = appels.find((a) => a.args[0] === "run")!;
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
  let demarre = false;
  const { executer, appels } = executeurFactice([
    [/ inspect -f .*Mounts/, { code: 0, stdout: `${chemins.racine}|${dockerfileHash()}\n` }],
    [/ inspect -f/, () => ({ code: 0, stdout: demarre ? "true\n" : "false\n" })],
    [/ start /, () => ((demarre = true), { code: 0 })],
  ]);
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  expect(appels.some((a) => a.args.join(" ") === "start webaios-atelier")).toBe(true);
  expect(appels.some((a) => a.args[0] === "run")).toBe(false);
});

test("commandeExec interactive and non-interactive", () => {
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeExec(["claude"], { interactif: true })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-w", "/workspace", "webaios-atelier", "claude",
  ]);
  expect(a.commandeExec(["claude", "-p", "x"], { interactif: false })).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-w", "/workspace", "webaios-atelier", "claude", "-p", "x",
  ]);
});

test("the docker probes have a timeout (Docker Desktop stuck at startup)", async () => {
  const { executer, appels } = executeurFactice([[/ inspect /, { code: 0, stdout: "true\n" }]]);
  await new Atelier({ chemins, docker: "docker", executer }).etat();
  for (const a of appels) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
});

test("the published ports avoid Vite's (5173…): 5280-5299", async () => {
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
  ]);
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  expect(appels.find((a) => a.args[0] === "run")!.args).toContain("127.0.0.1:5280-5299:5280-5299");
});

test("trouverDocker finds Docker Desktop installed per user (~/.docker/bin)", () => {
  expect(findDocker({ PATH: "/usr/bin", HOME: "/Users/t" }, (p) => p === "/Users/t/.docker/bin/docker")).toBe(
    "/Users/t/.docker/bin/docker",
  );
});

test("executeurParDefaut adds ~/.docker/bin to the PATH (credential helpers)", () => {
  expect(TOOLS_FOLDERS).toContain(join(homedir(), ".docker", "bin"));
});

// Existing container created on another folder or with an old Dockerfile → recreated.
function fauxDocker(o: { source: string; empreinteConteneur: string; empreinteImage: string; running?: string }) {
  let recree = false;
  const f = executeurFactice([
    [/ info$/, { code: 0 }],
    [/ image inspect /, { code: 0, stdout: `${o.empreinteImage}\n` }],
    [/ inspect -f \{\{\.State\.Running\}\}/, () => ({ code: 0, stdout: recree ? "true\n" : (o.running ?? "true\n") })],
    [/ inspect -f .*Mounts/, () => ({ code: 0, stdout: recree ? "" : `${o.source}|${o.empreinteConteneur}\n` })],
    [/ rm -f webaios-atelier/, () => ((recree = true), { code: 0 })],
  ]);
  return f;
}

test("existing container on the right folder and the right image → kept", async () => {
  const e = dockerfileHash();
  const { executer, appels } = fauxDocker({ source: chemins.racine, empreinteConteneur: e, empreinteImage: e });
  expect(await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre()).toBe("demarre");
  expect(appels.some((a) => a.args[0] === "rm")).toBe(false);
});

test("existing container mounted on another folder → removed then recreated", async () => {
  const e = dockerfileHash();
  const { executer, appels } = fauxDocker({ source: "/tmp/ailleurs", empreinteConteneur: e, empreinteImage: e });
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  expect(appels.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
  expect(appels.some((a) => a.args[0] === "run")).toBe(true);
});

test("modified Dockerfile → image rebuilt and container recreated", async () => {
  const { executer, appels } = fauxDocker({ source: chemins.racine, empreinteConteneur: "ancienne", empreinteImage: "ancienne" });
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  const build = appels.find((a) => a.args[0] === "build")!;
  expect(build.args).toContain(`webaios.dockerfile=${dockerfileHash()}`);
  expect(appels.some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
});

test("interactive session: its PID is noted in the container, and stopping it kills it there (killing the docker client is not enough)", async () => {
  const { executer, appels } = executeurFactice([]);
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker", executer });
  const pid = "/tmp/webaios-session-ab12.pid";
  expect(a.commandeSession("ab12", ["claude", "--x"])).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-it", "-e", "WEBAIOS_SESSION=ab12", "-w", "/workspace", "webaios-atelier",
    "sh", "-c", `echo $$ > ${pid}; exec "$@"`, "webaios-session", "claude", "--x",
  ]);
  await a.arreterSession("ab12");
  const appel = appels.find((x) => x.args[0] === "exec")!;
  expect(appel.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(appel.args[4]).toContain(`cat ${pid}`);
  expect(appel.args[4]).toBe(sessionStopScript(pid, "ab12"));
  expect(() => a.commandeSession("../x", ["claude"])).toThrow();
});

test("two starts at the same time: a single image build and a single container", async () => {
  let finirBuild!: () => void;
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ build /, () => new Promise((ok) => (finirBuild = () => ok({ code: 0 })))],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  const a = atelier.assurerDemarre();
  const b = atelier.assurerDemarre();
  await new Promise((r) => setTimeout(r, 10));
  finirBuild();
  expect(await Promise.all([a, b])).toEqual(["demarre", "demarre"]);
  expect(appels.filter((x) => x.args[0] === "build")).toHaveLength(1);
  expect(appels.filter((x) => x.args[0] === "run")).toHaveLength(1);
});

test("after a failure, a new start retries", async () => {
  let echecs = 0;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, { code: 1 }],
    [/ build /, () => (echecs++, { code: 1, stderr: "réseau" })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  await expect(atelier.assurerDemarre()).rejects.toThrow("réseau");
  await expect(atelier.assurerDemarre()).rejects.toThrow("réseau");
  expect(appels.filter((x) => x.args[0] === "build")).toHaveLength(2);
});

test("building and launching the container have a maximum timeout", async () => {
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 1 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
  for (const a of appels) expect(a.opts?.delaiMs, a.args.join(" ")).toBeGreaterThan(0);
  expect(appels.find((a) => a.args[0] === "build")!.opts?.delaiMs).toBe(BUILD_DELAY_MS);
});

const vivant = (pid: number) => {
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
  const fini = new Promise((ok) => agent.on("exit", ok));
  await expect.poll(() => existsSync(f)).toBe(true);
  const debut = Date.now();
  await new Promise<void>((ok, ko) => execFile("sh", ["-c", sessionStopScript(f, "local")], (e) => (e ? ko(e) : ok())));
  await fini;
  expect(Date.now() - debut).toBeLessThan(8000);
  expect(vivant(agent.pid!)).toBe(false);
  expect(existsSync(f)).toBe(false);
  // No process of the group left (the sleep launched by the agent).
  expect(() => process.kill(-agent.pid!, 0)).toThrow();
}, 15_000);

test("commandeApplication", () => {
  const a = new Atelier({ chemins, docker: "/opt/homebrew/bin/docker" });
  expect(a.commandeApplication("todo", "npx vite --port {port}", 5281)).toEqual([
    "/opt/homebrew/bin/docker", "exec", "-e", "WEBAIOS_APP=todo", "-e", "PORT=5281", "-w", "/workspace/projets/todo", "webaios-atelier",
    "sh", "-c", `mkdir -p /workspace/.webaios/journaux; exec >"/workspace/.webaios/journaux/$1.log" 2>&1; eval "$2"`,
    "webaios-app", "todo", "npx vite --port 5281",
  ]);
});

test("arreterApplication only targets its own mark", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplication("todo");
  const appel = appels.find((x) => x.args[0] === "exec")!;
  expect(appel.args.slice(0, 4)).toEqual(["exec", "webaios-atelier", "sh", "-c"]);
  expect(appel.args[4]).toContain("WEBAIOS_APP=todo");
  expect(appel.args[4]).not.toContain("WEBAIOS_SESSION");
  expect(appel.args[4]).toContain("signaler KILL");
  await expect(new Atelier({ chemins, docker: "docker", executer }).arreterApplication("x'y")).rejects.toThrow();
});

test("arreterApplicationsOrphelines vise WEBAIOS_APP=.*", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplicationsOrphelines();
  const script = appels.find((x) => x.args[0] === "exec")!.args[4]!;
  expect(script).toContain("WEBAIOS_APP=.*");
  expect(script).not.toContain("WEBAIOS_SESSION");
});

test("arreterApplication: the dot in a folder name is not a grep wildcard", async () => {
  const { executer, appels } = executeurFactice([]);
  await new Atelier({ chemins, docker: "docker", executer }).arreterApplication("my.app");
  const script = appels.find((x) => x.args[0] === "exec")!.args[4]!;
  const motif = /grep -qzx '([^']*)'/.exec(script)![1]!;
  expect(motif).toBe("WEBAIOS_APP=my\\.app");
  // The pattern as grep reads it: « my.app » is targeted, « myxapp » is not.
  const vise = (valeur: string) =>
    new Promise<boolean>((ok) => execFile("sh", ["-c", `printf '%s' "$1" | grep -qx "$2"`, "sh", valeur, motif], (e) => ok(!e)));
  expect(await vise("WEBAIOS_APP=my.app")).toBe(true);
  expect(await vise("WEBAIOS_APP=myxapp")).toBe(false);
});

test("commandeRecolte mounts the engine read-only and launches /opt/webaios/moteur/recolteur.mjs", () => {
  const atelier = new Atelier({ chemins, docker: "/usr/local/bin/docker" });
  const c = atelier.commandeRecolte("meteo", "/Users/t/WebAiOs/accueil/widgets/meteo", "/app/docker/moteur");
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
  expect(() => atelier.commandeRecolte("meteo", "/d", "/app/x:y")).toThrow();
});

test("commandeRecolte of an action names the container webaios-action-<id>; of a widget, webaios-recolte-<id>", async () => {
  const atelier = new Atelier({ chemins, docker: "/usr/local/bin/docker" });
  const nom = (c: string[]) => c[c.indexOf("--name") + 1];
  expect(nom(atelier.commandeRecolte({ type: "action", id: "gitlab" }, "/d", "/app/docker/moteur"))).toBe("webaios-action-gitlab");
  expect(nom(atelier.commandeRecolte({ type: "widget", id: "meteo" }, "/d", "/app/docker/moteur"))).toBe("webaios-recolte-meteo");
  expect(nom(atelier.commandeRecolte("meteo", "/d", "/app/docker/moteur"))).toBe("webaios-recolte-meteo");
  expect(harvestName({ type: "action", id: "gitlab" })).toBe("webaios-action-gitlab");
  expect(harvestName("meteo")).toBe("webaios-recolte-meteo");
  expect(() => harvestName({ type: "action", id: "../x" })).toThrow();
  // The removal targets the same name.
  const appels: string[][] = [];
  const supprimeur = new Atelier({ chemins, docker: "/usr/local/bin/docker", executer: async (_c, args) => (appels.push(args), { code: 0, stdout: "", stderr: "" }) });
  await supprimeur.supprimerRecolte({ type: "action", id: "gitlab" });
  await supprimeur.supprimerRecolte("meteo");
  expect(appels).toEqual([["rm", "-f", "webaios-action-gitlab"], ["rm", "-f", "webaios-recolte-meteo"]]);
});

test("commandeRecolte with delaiS 1830: timeout -k 5 1830", () => {
  const atelier = new Atelier({ chemins, docker: "/usr/local/bin/docker" });
  const c = atelier.commandeRecolte("veille", "/d", "/app/docker/moteur", 1830);
  const i = c.indexOf("timeout");
  expect(c.slice(i, i + 4)).toEqual(["timeout", "-k", "5", "1830"]);
  // Without a given delay: 180 s as before.
  const d = atelier.commandeRecolte("veille", "/d", "/app/docker/moteur");
  expect(d.slice(d.indexOf("timeout"), d.indexOf("timeout") + 4)).toEqual(["timeout", "-k", "5", "180"]);
});

async function nomsCites(): Promise<string[]> {
  let lance = false;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 0 }],
    [/ inspect /, () => ({ code: lance ? 0 : 1, stdout: "true\n" })],
    [/ run /, () => ((lance = true), { code: 0 })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  await atelier.assurerDemarre();
  await atelier.arreterSessionsOrphelines();
  // the image is also called webaios-atelier:1, so only container-name positions count
  return appels.flatMap((a) => a.args.filter((x, i) => /^webaios-atelier(-test)?$/.test(x) && a.args[i - 1] !== "-t"));
}

test("uses WEBAIOS_CONTENEUR for every docker command", async () => {
  vi.stubEnv("WEBAIOS_CONTENEUR", "webaios-atelier-test");
  try {
    const noms = await nomsCites();
    expect(noms.length).toBeGreaterThan(2);
    expect(new Set(noms)).toEqual(new Set(["webaios-atelier-test"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("defaults to webaios-atelier", async () => {
  vi.stubEnv("WEBAIOS_CONTENEUR", "");
  try {
    expect(new Set(await nomsCites())).toEqual(new Set(["webaios-atelier"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("WEBAIOS_PORTS_CONTENEUR gives the published range and tells it to the container; invalid falls back to 5280-5299", async () => {
  const runArgs = async () => {
    const { executer, appels } = executeurFactice([
      [/ image inspect /, { code: 0 }],
      [/ inspect -f/, { code: 1 }],
    ]);
    await new Atelier({ chemins, docker: "docker", executer }).assurerDemarre();
    return appels.find((a) => a.args[0] === "run")!.args;
  };
  try {
    vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", "5300-5319");
    expect(containerPortRange()).toEqual([5300, 5319]);
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5300-5319:5300-5319", "WEBAIOS_PORTS=5300-5319"]));
    for (const invalide of ["", "abc", "5319-5300", "80-90"]) {
      vi.stubEnv("WEBAIOS_PORTS_CONTENEUR", invalide);
      expect(containerPortRange()).toEqual([5280, 5299]);
    }
    expect(await runArgs()).toEqual(expect.arrayContaining(["127.0.0.1:5280-5299:5280-5299", "WEBAIOS_PORTS=5280-5299"]));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a failed docker run removes the half-created container, so the next start retries instead of reusing it", async () => {
  let runs = 0;
  const { executer, appels } = executeurFactice([
    [/ image inspect /, { code: 0 }],
    [/ inspect -f/, { code: 1 }],
    [/ run /, () => (++runs === 1 ? { code: 125, stderr: "port is already allocated" } : { code: 0 })],
  ]);
  const atelier = new Atelier({ chemins, docker: "docker", executer });
  await expect(atelier.assurerDemarre()).rejects.toThrow("port is already allocated");
  const iRun = appels.findIndex((a) => a.args[0] === "run");
  expect(appels.slice(iRun + 1).some((a) => a.args.join(" ") === "rm -f webaios-atelier")).toBe(true);
  await atelier.assurerDemarre();
  expect(runs).toBe(2);
});
