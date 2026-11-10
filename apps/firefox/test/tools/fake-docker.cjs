#!/usr/bin/env node
// Fake docker for the end-to-end tests: no real container, no network. See plan 3.
const { createHash } = require("node:crypto");
const { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const env = process.env;
const failing = env.FAKE_DOCKER_FAILURE === "1";
const quit = (code, out = "", err = "") => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
};

// FAKE_DOCKER_SLOW: Docker that is starting up, `docker info` only answers after 8 s.
if (args[0] === "info" && env.FAKE_DOCKER_SLOW === "1") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000);
if (args[0] === "info") quit(env.FAKE_DOCKER_ABSENT === "1" ? 1 : 0);
// The settings page's workshop operations are noted for the tests; a removed workshop is absent until its next `run -d`.
const removedMark = () => join(env.WEBAIOS_ROOT, "fake-docker-workshop-removed");
const noteCall = () => appendFileSync(join(env.WEBAIOS_ROOT, "fake-docker-calls.log"), `${args.join(" ")}\n`);
if (args[0] === "stop") {
  noteCall();
  quit(0);
}
if (args[0] === "rm" && args[1] === "-f" && args[2] === "webaios-workshop") {
  noteCall();
  writeFileSync(removedMark(), "");
  quit(0);
}
if (args[0] === "build") noteCall();
if (args[0] === "run" && args[1] === "-d") rmSync(removedMark(), { force: true });
if (args[0] === "inspect") {
  if (failing || (args[3] === "webaios-workshop" && existsSync(removedMark()))) quit(1, "", "No such object");
  const format = args[2] ?? "";
  if (format.includes("State.Running")) quit(0, "true\n");
  const dockerfile = join(__dirname, "..", "..", "..", "..", "packages", "kernel", "docker", "workshop.Dockerfile");
  const hash = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12);
  quit(0, `${env.WEBAIOS_ROOT}|${hash}\n`);
}
/** PID of the `run` client of a harvest in progress, by container name. */
const harvestPidFile = (name) => join(env.WEBAIOS_ROOT, `fake-docker-${name}.pid`);

/** A run's container: a widget's harvest or an action's run. */
const isRun = (name) => (name ?? "").startsWith("webaios-harvest-") || (name ?? "").startsWith("webaios-action-");

// A widget's harvest or an action's run (Workshop.harvestCommand):
// `run -i --rm … --name webaios-harvest-<id> (or webaios-action-<id>) … node <harvester> /widget`.
// The harvester runs on the Mac (node), with the host paths recovered from the `-v host:container`. The kernel
// must cut the container's network: without `--network none`, the harvest fails.
if (args[0] === "run" && args.includes("-i") && isRun(args[args.indexOf("--name") + 1])) {
  const network = args.indexOf("--network");
  if (network < 0 || args[network + 1] !== "none") quit(1, "", "fake docker: --network none missing\n");
  const mounts = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-v") continue;
    const [host, container] = args[++i].split(":");
    mounts.set(container, host);
  }
  // A path under a mounted folder (the engine: /opt/webaios/engine/harvester.mjs) is recovered by its prefix.
  const toHost = (c) => {
    if (mounts.has(c)) return mounts.get(c);
    for (const [container, host] of mounts) if (c.startsWith(container + "/")) return host + c.slice(container.length);
    return c;
  };
  const node = args.indexOf("node", args.indexOf("--name"));
  const [harvester, widget] = args.slice(node + 1).map(toHost);
  const child = spawn(process.execPath, [harvester, widget], { stdio: "inherit" });
  // Noted for `rm -f <name>`, which kills the container like the real docker (the `run` client then returns 137).
  const file = harvestPidFile(args[args.indexOf("--name") + 1]);
  writeFileSync(file, String(process.pid));
  let killed = false;
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.on(signal, () => {
      killed = true;
      child.kill("SIGKILL");
    });
  child.on("exit", (code) => {
    rmSync(file, { force: true });
    process.exit(killed ? 137 : (code ?? 1));
  });
  return;
}
// Forced removal of a run container (Workshop.deleteHarvest): the running harvester is killed.
if (args[0] === "rm" && args[1] === "-f" && isRun(args[2])) {
  const file = harvestPidFile(args[2]);
  if (existsSync(file)) {
    try {
      process.kill(Number(readFileSync(file, "utf8")), "SIGTERM");
    } catch {
      // already finished
    }
  }
  quit(0);
}
if (args[0] === "run" && args[1] === "--rm") quit(1);
if (["image", "build", "run"].includes(args[0])) quit(failing ? 1 : 0, "", failing ? "simulated failure" : "");
/** PID of a launched app's group (its shell, group leader). */
const appPidFile = (folder) => join(env.WEBAIOS_ROOT, `fake-docker-app-${folder}.pid`);

/** Kills the group of each app targeted by a stop script (`WEBAIOS_APP=<folder>` or `WEBAIOS_APP=.*`). */
function stopApps(script) {
  // The dot of a folder name is escaped for grep (`my\.app`).
  const pattern = /WEBAIOS_APP=(\.\*|(?:[A-Za-z0-9_-]|\\\.)+)/.exec(script)?.[1]?.replaceAll("\\.", ".");
  if (!pattern) return;
  const files =
    pattern === ".*"
      ? readdirSync(env.WEBAIOS_ROOT).filter((f) => /^fake-docker-app-.*\.pid$/.test(f)).map((f) => join(env.WEBAIOS_ROOT, f))
      : [appPidFile(pattern)];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      process.kill(-Number(readFileSync(f, "utf8")), "SIGTERM");
    } catch {
      // already stopped
    }
    rmSync(f, { force: true });
  }
}

/**
 * Launch of an app (Workshop.appCommand): the shell runs on the Mac, /workspace becoming WEBAIOS_ROOT,
 * in its own group (like the container's processes, which the stop targets by their mark).
 */
function launchApp(options, command) {
  const local = (s) => s.replaceAll("/workspace", env.WEBAIOS_ROOT);
  const vars = {};
  let folder = "/workspace";
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "-e") {
      const [key, ...value] = local(options[++i]).split("=");
      vars[key] = value.join("=");
    } else if (options[i] === "-w") folder = options[++i];
  }
  const [program, ...rest] = command.map(local);
  const child = spawn(program, rest, { cwd: local(folder), env: { ...env, ...vars }, stdio: "inherit", detached: true });
  writeFileSync(appPidFile(vars.WEBAIOS_APP), String(child.pid));
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"])
    process.on(signal, () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // already stopped
      }
    });
  child.on("exit", (code) => process.exit(code ?? 1));
}

if (args[0] === "exec") {
  const options = args.slice(1, args.indexOf("webaios-workshop"));
  let command = args.slice(args.indexOf("webaios-workshop") + 1);
  if (options.some((o) => o.startsWith("WEBAIOS_APP="))) {
    launchApp(options, command);
    return;
  }
  // Claude Code's account (settings page): <WEBAIOS_ROOT>/fake-claude-auth.json is the signed-in account.
  const auth = join(env.WEBAIOS_ROOT, "fake-claude-auth.json");
  if (command.join(" ") === "claude auth status --json") quit(0, existsSync(auth) ? readFileSync(auth, "utf8") : '{"loggedIn":false}\n');
  if (command.join(" ") === "claude auth logout") {
    rmSync(auth, { force: true });
    quit(0);
  }
  // Stop of a session or an app in the container (Workshop session and app stops…): noted for the
  // tests; the targeted apps are killed beforehand, the log is the proof of the stop.
  if (command[0] === "sh" && !command[2].includes('exec "$@"')) {
    stopApps(command[2]);
    appendFileSync(join(env.WEBAIOS_ROOT, "fake-docker-stops.log"), `${command[2]}\n`);
    quit(0);
  }
  // Interactive session (Workshop.sessionCommand): sh -c '<notes the PID>; exec "$@"' webaios-session <agent…>
  if (command[0] === "sh") command = command.slice(4);
  const r = spawnSync(process.execPath, [join(__dirname, "fake-agent.mjs"), ...command], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
quit(0);
