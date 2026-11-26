#!/usr/bin/env node
// Fake docker for the end-to-end tests: no real container, no network. See plan 3.
const { createHash } = require("node:crypto");
const { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } = require("node:fs");
// Written whole (temp file, then rename): tests poll these files and must never read half of one.
// A temp name per process: two agents starting at once (both windows relaunched) never rename each other's.
const put = (f, v) => (writeFileSync(`${f}.${process.pid}.tmp`, v), renameSync(`${f}.${process.pid}.tmp`, f));
const { dirname, join } = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const args = process.argv.slice(2);
const env = process.env;
// Every call, one per line (a script's newlines escaped), for the tests that check nothing runs docker (AI off).
if (env.RESSAC_ROOT) appendFileSync(join(env.RESSAC_ROOT, "fake-docker-all.log"), `${args.join(" ").replaceAll("\n", "\\n")}\n`);
const failing = env.FAKE_DOCKER_FAILURE === "1";
const quit = (code, out = "", err = "") => {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
};

// FAKE_DOCKER_SLOW: Docker that is starting up, `docker info` only answers after 8 s.
if (args[0] === "info" && env.FAKE_DOCKER_SLOW === "1") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000);
// FAKE_DOCKER_INFO_HOLD=1: `docker info` answers once <RESSAC_ROOT>/fake-docker-info-go exists (the test writes it), or
// after 60 s, so a failed test leaves no process behind.
for (const end = Date.now() + 60_000; args[0] === "info" && env.FAKE_DOCKER_INFO_HOLD === "1" && Date.now() < end && !existsSync(join(env.RESSAC_ROOT, "fake-docker-info-go")); )
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (args[0] === "info") quit(env.FAKE_DOCKER_ABSENT === "1" ? 1 : 0);
// The settings page's workshop operations are noted for the tests; a removed workshop is absent until its next `run -d`.
const removedMark = () => join(env.RESSAC_ROOT, "fake-docker-workshop-removed");
const noteCall = () => appendFileSync(join(env.RESSAC_ROOT, "fake-docker-calls.log"), `${args.join(" ")}\n`);
if (args[0] === "stop") {
  noteCall();
  quit(0);
}
if (args[0] === "rm" && args[1] === "-f" && args[2] === "ressac-workshop") {
  noteCall();
  writeFileSync(removedMark(), "");
  quit(0);
}
if (args[0] === "build") noteCall();
// BuildKit plain progress goes to stderr; FAKE_DOCKER_BUILD_STEP_MS paces the lines (unset: instant, as before).
// FAKE_DOCKER_BUILD_HOLD=1: the last step waits for <RESSAC_ROOT>/fake-docker-build-go (a test that has seen step 2 writes it).
if (args[0] === "build" && Number(env.FAKE_DOCKER_BUILD_STEP_MS) > 0 && !failing) {
  const lines = [
    "#5 [1/3] FROM docker.io/library/node:22-bookworm",
    "#6 [2/3] RUN apt-get update && apt-get install -y git",
    "#7 [3/3] RUN npm install -g @anthropic-ai/claude-code @openai/codex",
  ];
  const next = () => {
    if (lines.length === 1 && env.FAKE_DOCKER_BUILD_HOLD === "1" && !existsSync(join(env.RESSAC_ROOT, "fake-docker-build-go"))) return void setTimeout(next, 50);
    const line = lines.shift();
    if (!line) return process.exit(0);
    process.stderr.write(`${line}\n`);
    setTimeout(next, Number(env.FAKE_DOCKER_BUILD_STEP_MS));
  };
  next();
  return;
}
// The container's shape label (Workshop's mounts by mode), kept from its last `run -d`; none yet: Navigateur's.
const shapeFile = () => join(env.RESSAC_ROOT, "fake-docker-shape");
if (args[0] === "run" && args[1] === "-d") {
  rmSync(removedMark(), { force: true });
  const label = args.find((a) => a.startsWith("ressac.shape="));
  if (label) put(shapeFile(), label.slice("ressac.shape=".length));
}
if (args[0] === "inspect") {
  if (failing || (args[3] === "ressac-workshop" && existsSync(removedMark()))) quit(1, "", "No such object");
  const format = args[2] ?? "";
  if (format.includes("State.Running")) quit(0, "true\n");
  const shape = existsSync(shapeFile()) ? readFileSync(shapeFile(), "utf8") : "2-browser";
  if (format === '{{index .Config.Labels "ressac.shape"}}') quit(0, `${shape}\n`);
  const dockerfile = join(__dirname, "..", "..", "..", "..", "packages", "kernel", "docker", "workshop.Dockerfile");
  // Same recipe as the kernel's dockerfileHash: Dockerfile, network module, run-flags version.
  const network = join(dirname(dockerfile), "ressac-network.mjs");
  const hash = createHash("sha256").update(readFileSync(dockerfile)).update(readFileSync(network)).update("flags-6").digest("hex").slice(0, 12);
  quit(0, `${env.RESSAC_ROOT}|${hash}|${2.5 * 2 ** 30}|${shape}\n`);
}
/** PID of the `run` client of a harvest in progress, by container name. */
const harvestPidFile = (name) => join(env.RESSAC_ROOT, `fake-docker-${name}.pid`);

/** A run's container: a widget's harvest or an action's run. */
const isRun = (name) => (name ?? "").startsWith("ressac-harvest-") || (name ?? "").startsWith("ressac-action-");

// A widget's harvest or an action's run (Workshop.harvestCommand):
// `run -i --rm … --name ressac-harvest-<id> (or ressac-action-<id>) … node <harvester> /widget`.
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
  // A path under a mounted folder (the engine: /opt/ressac/engine/harvester.mjs) is recovered by its prefix.
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
  put(file, String(process.pid));
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
const appPidFile = (folder) => join(env.RESSAC_ROOT, `fake-docker-app-${folder}.pid`);

/** Kills the group of each app targeted by a stop script (`RESSAC_APP=<folder>` or `RESSAC_APP=.*`). */
function stopApps(script) {
  // The dot of a folder name is escaped for grep (`my\.app`).
  const pattern = /RESSAC_APP=(\.\*|(?:[A-Za-z0-9_-]|\\\.)+)/.exec(script)?.[1]?.replaceAll("\\.", ".");
  if (!pattern) return;
  const files =
    pattern === ".*"
      ? readdirSync(env.RESSAC_ROOT).filter((f) => /^fake-docker-app-.*\.pid$/.test(f)).map((f) => join(env.RESSAC_ROOT, f))
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
 * Launch of an app (Workshop.appCommand): the shell runs on the Mac, /workspace becoming RESSAC_ROOT,
 * in its own group (like the container's processes, which the stop targets by their mark).
 */
function launchApp(options, command) {
  const local = (s) => s.replaceAll("/workspace", env.RESSAC_ROOT);
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
  put(appPidFile(vars.RESSAC_APP), String(child.pid));
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

/**
 * The workspace lock's lift (packages/kernel/src/mask/lift.ts): /workspace is RESSAC_ROOT, /home/node a fake-home beside
 * it, the reveal stamp and its folder list files beside it too. The scan prints every folder (`D` changed since the
 * stamp) and every other entry changed (ctime) after the stamp, leaving out `.ressac` and this fake's own `fake-*` files
 * at the root.
 */
const inside = (p) =>
  p === "/workspace" || p.startsWith("/workspace/") ? env.RESSAC_ROOT + p.slice("/workspace".length)
  : p === "/home/node" || p.startsWith("/home/node/") ? join(dirname(env.RESSAC_ROOT), "fake-home") + p.slice("/home/node".length)
  : null;
const revealStamp = () => join(dirname(env.RESSAC_ROOT), "fake-reveal-stamp");
const revealDirs = () => join(dirname(env.RESSAC_ROOT), "fake-reveal-dirs");
/** Every entry under the fake's roots: [container path, lstat]. */
function walkRoots() {
  const out = [];
  const walk = (dir, shown, top) => {
    if (!existsSync(dir)) return;
    out.push([shown, lstatSync(dir)]);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (top && (e.name === ".ressac" || e.name.startsWith("fake-"))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, `${shown}/${e.name}`, false);
      else out.push([`${shown}/${e.name}`, lstatSync(full)]);
    }
  };
  walk(env.RESSAC_ROOT, "/workspace", true);
  walk(join(dirname(env.RESSAC_ROOT), "fake-home"), "/home/node", false);
  return out;
}
const typeOf = (st) => (st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : st.isFile() ? "f" : "p");
function changedListing() {
  const since = existsSync(revealStamp()) ? statSync(revealStamp()).mtimeMs : -1;
  return walkRoots()
    .map(([p, st]) => (st.isDirectory() ? `${st.ctimeMs > since ? "D" : "d"} 0 ${p}\0` : st.ctimeMs > since ? `${typeOf(st)} ${st.size} ${p}\0` : ""))
    .join("");
}
const CONTAINER_FILE = /^ressac-workshop(?:-firefox)?:(\/.*)$/;
if (args[0] === "cp") {
  const [from, to] = [CONTAINER_FILE.exec(args[1])?.[1], CONTAINER_FILE.exec(args[2])?.[1]];
  const source = from ? inside(from) : args[1];
  const target = to ? inside(to) : args[2];
  if (!source || !target || !lstatSync(source, { throwIfNoEntry: false })) quit(1, "", "Error: No such container:path\n");
  // Like docker cp: a link is copied as a link, never followed.
  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
  else copyFileSync(source, target);
  quit(0);
}

if (args[0] === "exec") {
  const options = args.slice(1, args.indexOf("ressac-workshop"));
  let command = args.slice(args.indexOf("ressac-workshop") + 1);
  if (command[0] === "sh" && command[2]?.includes("touch /run/ressac-reveal-stamp")) {
    // The list first, then the stamp (never moved forward), as Workshop.stampReveal does.
    if (!existsSync(revealDirs())) {
      put(revealDirs(), walkRoots().filter(([, st]) => st.isDirectory()).map(([p]) => `${p}\0`).join(""));
      if (!existsSync(revealStamp())) writeFileSync(revealStamp(), "");
    }
    quit(0);
  }
  if (command[0] === "sh" && command[2]?.includes("cat /run/ressac-reveal-dirs")) {
    if (!existsSync(revealDirs())) quit(3);
    const late = !existsSync(revealStamp()) || statSync(revealDirs()).mtimeMs > statSync(revealStamp()).mtimeMs;
    quit(0, `${late ? "late" : "first"}\0${readFileSync(revealDirs(), "utf8")}`);
  }
  if (command[0] === "find" && command.includes("-empty")) {
    const dirs = command.slice(1, command.indexOf("-xdev"));
    const out = walkRoots()
      .filter(([p]) => dirs.some((d) => p === d || p.startsWith(`${d}/`)))
      .map(([p, st]) => (st.isDirectory() ? (readdirSync(inside(p)).length === 0 ? `e 0 ${p}\0` : "") : `${typeOf(st)} ${st.size} ${p}\0`))
      .join("");
    process.stdout.write(out, () => process.exit(0));
    return;
  }
  // « Rendre à l'atelier »: the content in base64 on stdin, or a link's target as the last argument.
  if (command[0] === "sh" && command.includes("ressac-restore")) {
    const at = command.indexOf("ressac-restore");
    const file = inside(command[at + 1]);
    if (!file) quit(1, "", "outside the fake's folders\n");
    mkdirSync(dirname(file), { recursive: true });
    if (command[2].includes("ln -sfn")) {
      rmSync(file, { force: true });
      symlinkSync(command[at + 2], file);
      quit(0);
    }
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      writeFileSync(file, Buffer.from(input, "base64"));
      quit(0);
    });
    return;
  }
  if (command[0] === "rmdir") {
    for (const d of command.slice(command.indexOf("--") + 1)) {
      const dir = inside(d);
      if (dir && existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    }
    quit(0);
  }
  if (command[0] === "sh" && command[2]?.includes("exec find ")) {
    // Not quit(): process.exit() would cut an output larger than the pipe's 64 KB.
    process.stdout.write(changedListing(), () => process.exit(0));
    return;
  }
  if (command.join(" ") === "rm -f /run/ressac-reveal-stamp /run/ressac-reveal-dirs") {
    rmSync(revealStamp(), { force: true });
    rmSync(revealDirs(), { force: true });
    quit(0);
  }
  if ((command[0] === "rm" || command[0] === "mkdir" || command[0] === "head" || command[0] === "chown") && command.at(-2) === "--") {
    const file = inside(command.at(-1));
    if (!file) quit(1, "", `${command[0]}: outside the fake's folders\n`);
    if (command[0] === "rm") rmSync(file, { recursive: true, force: true });
    if (command[0] === "mkdir") mkdirSync(file, { recursive: true });
    if (command[0] === "head") quit(existsSync(file) ? 0 : 1, existsSync(file) ? readFileSync(file).subarray(0, Number(command[2])).toString("utf8") : "", existsSync(file) ? "" : "head: No such file\n");
    quit(0);
  }
  // Network securing (Workshop.secureNetwork): the rules apply (stdin drained), the direct probe is blocked (curl exit 7).
  if (command[0] === "node" && command[1] === "/opt/ressac/ressac-network.mjs") {
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    // The rules the kernel sent (JSON), one per line: tests read what each apply carried.
    process.stdin.on("end", () => {
      appendFileSync(join(env.RESSAC_ROOT, "fake-docker-network.log"), input.replaceAll("\n", "") + "\n");
      quit(0);
    });
    return;
  }
  if (command[0] === "curl" && command.includes("https://1.1.1.1")) quit(7);
  // Instruction files (Workshop.readInstructions/writeInstructions): the same node -e runs here, /workspace becoming
  // RESSAC_ROOT and /home/node a fake-home beside it, in the paths (arrays, keys) only, never in file contents.
  if (command.includes("ressac-instructions")) {
    const root = realpathSync(env.RESSAC_ROOT);
    const pairs = [["/workspace", root], ["/home/node", join(dirname(root), "fake-home")]];
    const swap = (s, back) => {
      for (const [inside, outside] of pairs) {
        const [from, to] = back ? [outside, inside] : [inside, outside];
        if (s === from || s.startsWith(`${from}/`)) return to + s.slice(from.length);
      }
      return s;
    };
    const paths = (v, back) =>
      Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k, back), Array.isArray(x) ? x.map((s) => swap(s, back)) : x]));
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      const d = JSON.parse(input); // { input, extra }: only the input carries paths
      const r = spawnSync(process.execPath, command.slice(1), { input: JSON.stringify({ ...d, input: paths(d.input, false) }), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) quit(r.status ?? 1, "", r.stderr);
      const out = JSON.parse(r.stdout);
      // Not quit(): process.exit() would cut an output larger than the pipe's 64 KB.
      process.stdout.write(JSON.stringify(typeof out === "object" && out ? paths(out, true) : out), () => process.exit(0));
    });
    return;
  }
  // Codex's requirements (Workshop.restrictCodex), written as root from stdin: drained, not a stop.
  if (command[0] === "sh" && command[2].includes("/etc/codex/requirements.toml")) {
    process.stdin.resume();
    process.stdin.on("end", () => quit(0));
    return;
  }
  // An app's log (ApplicationManager.log): tail -n <lines> -- /workspace/<path>, read from the mounted folder.
  if (command[0] === "tail" && command[3] === "--" && command[4].startsWith("/workspace/")) {
    const file = join(env.RESSAC_ROOT, command[4].slice("/workspace/".length));
    if (!existsSync(file)) quit(1, "", "tail: No such file\n");
    quit(0, readFileSync(file, "utf8").split("\n").slice(-Number(command[2]) - 1).join("\n"));
  }
  if (options.some((o) => o.startsWith("RESSAC_APP="))) {
    launchApp(options, command);
    return;
  }
  // The writer (Workshop.execWrite): sh -c <script> ressac-write <id> <agent argv…>, the prompt on stdin. The script is emulated:
  // the PID file (RESSAC_ROOT stands for /tmp) lives while the call is pending, the prompt goes to the e2e's fake Ollama.
  if (command[0] === "sh" && command.includes("ressac-write")) {
    const at = command.indexOf("ressac-write");
    const [id, agent] = [command[at + 1], command[at + 2].split("/").pop()];
    const pidFile = join(env.RESSAC_ROOT, `ressac-write-${id}.pid`);
    put(pidFile, String(process.pid));
    // No signal handler: killing this client leaves the "container" process, only the stop script removes the PID file.
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", async () => {
      try {
        const res = await fetch(`${env.RESSAC_OLLAMA_URL}/api/chat`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: input }] }) });
        const content = (await res.json()).message.content;
        const usage = { input_tokens: 10, output_tokens: 5 };
        rmSync(pidFile, { force: true });
        quit(0, agent === "claude" ? JSON.stringify({ type: "result", is_error: false, result: content, usage }) : content);
      } catch (e) {
        rmSync(pidFile, { force: true });
        quit(1, "", String(e));
      }
    });
    return;
  }
  // Claude Code's account (settings page): <RESSAC_ROOT>/fake-claude-auth.json is the signed-in account.
  const auth = join(env.RESSAC_ROOT, "fake-claude-auth.json");
  if (command.join(" ") === "claude auth status --json") quit(0, existsSync(auth) ? readFileSync(auth, "utf8") : '{"loggedIn":false}\n');
  if (command.join(" ") === "claude auth logout") {
    rmSync(auth, { force: true });
    quit(0);
  }
  // Codex's account: <RESSAC_ROOT>/fake-codex-auth means signed in; the sign-in by code creates it 1 s after showing the code.
  const codexAuth = join(env.RESSAC_ROOT, "fake-codex-auth");
  if (command.join(" ") === "codex login status") quit(existsSync(codexAuth) ? 0 : 1, "", existsSync(codexAuth) ? "Logged in using ChatGPT\n" : "Not logged in\n");
  if (command.join(" ") === "codex logout") {
    rmSync(codexAuth, { force: true });
    quit(0);
  }
  if (command.join(" ") === "codex login --device-auth") {
    process.stderr.write("Follow these steps to sign in:\n1. Open https://auth.openai.com/codex/device\n2. Enter this code: ABCD-12345\n");
    // <RESSAC_ROOT>/fake-codex-device-delay-ms: how long the code takes to be "entered" (1 s by default); a test changes it between sign-ins.
    const delayFile = join(env.RESSAC_ROOT, "fake-codex-device-delay-ms");
    // <RESSAC_ROOT>/fake-codex-device-expires: the code is never entered, the CLI gives up (as at its 15 min).
    const expires = existsSync(join(env.RESSAC_ROOT, "fake-codex-device-expires"));
    setTimeout(() => {
      if (expires) process.exit(1);
      writeFileSync(codexAuth, "");
      process.exit(0);
    }, existsSync(delayFile) ? Number(readFileSync(delayFile, "utf8")) : 1_000);
    return;
  }
  // Stop of a session or an app in the container (Workshop session and app stops…): noted for the
  // tests; the targeted apps are killed beforehand, the log is the proof of the stop.
  if (command[0] === "sh" && !command[2].includes('exec "$@"')) {
    stopApps(command[2]);
    // The writer's stop script: its PID file is under /tmp in the container, under RESSAC_ROOT here.
    const writer = /\/tmp\/(ressac-write-[\w-]+\.pid)/.exec(command[2])?.[1];
    if (writer) {
      const f = join(env.RESSAC_ROOT, writer);
      if (existsSync(f)) {
        try {
          process.kill(Number(readFileSync(f, "utf8")), "SIGTERM");
        } catch {
          // already finished
        }
        rmSync(f, { force: true });
      }
    }
    appendFileSync(join(env.RESSAC_ROOT, "fake-docker-stops.log"), `${command[2]}\n`);
    // <RESSAC_ROOT>/fake-docker-sweep-hold: the sweep before a first session (`kill -KILL -1`) lasts until the test removes it.
    const hold = join(env.RESSAC_ROOT, "fake-docker-sweep-hold");
    if (command[2].includes("kill -KILL -1") && existsSync(hold)) {
      setInterval(() => existsSync(hold) || quit(0), 50);
      return;
    }
    quit(0);
  }
  // Interactive session (Workshop.sessionCommand): sh -c '<notes the PID>; exec "$@"' ressac-session <agent…>
  if (command[0] === "sh") command = command.slice(4);
  // Like docker exec: `-e NAME=value` sets it, `-e NAME` passes the client's value (session tokens).
  const vars = {};
  for (let i = 0; i < options.length; i++)
    if (options[i] === "-e") {
      const [key, ...value] = options[++i].split("=");
      vars[key] = value.length ? value.join("=") : env[key];
    }
  // The chat's login terminal (openLoginSession): signed in once the test writes <RESSAC_ROOT>/fake-claude-login-go, or
  // given up after 60 s, so a failed test leaves no process behind.
  if (command.join(" ") === "claude auth login") {
    // Shaped like the real output: a long sign-in address that wraps, then the prompt as the last line.
    const url = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code&code_challenge=${"x".repeat(43)}&code_challenge_method=S256&state=${"y".repeat(43)}`;
    process.stdout.write(`fake login: waiting\r\n\r\nOpening browser to sign in…\r\nBrowser didn't open? Use the url below to sign in:\r\n\r\n${url}\r\n\r\nPaste code here if prompted > `);
    const end = Date.now() + 60_000;
    const go = join(env.RESSAC_ROOT, "fake-claude-login-go");
    setInterval(() => {
      if (existsSync(go)) put(auth, '{"loggedIn":true,"email":"camille.aubrac@example.org"}\n');
      if (existsSync(go) || Date.now() > end) quit(existsSync(go) ? 0 : 1);
    }, 50);
    return;
  }
  // A deleted discussion's engine history (host/chat-history.ts): logged above, nothing to erase here.
  if (command[0] === "find") quit(0);
  // What the agent received from docker exec, for the tests.
  put(join(env.RESSAC_ROOT, "fake-agent-env.json"), JSON.stringify(Object.fromEntries(Object.entries(vars).filter(([k]) => /^(RESSAC_|ANTHROPIC_|CLAUDE_CODE_)/.test(k)))));
  // A chat's pipe session: the engine's protocol fake, its trace in RESSAC_ROOT; FAKE_CHAT_GO releases a held « Bonjour ».
  const chat =
    command[0] === "claude" && command.includes("--input-format") ? "fake-claude-stream.mjs"
    : command[0] === "codex" && command.includes("app-server") ? "fake-codex-app-server.cjs"
    : null;
  const traces = { FAKE_CLAUDE_LOG: join(env.RESSAC_ROOT, "fake-chat-claude.jsonl"), FAKE_CODEX_LOG: join(env.RESSAC_ROOT, "fake-chat-codex.jsonl"), FAKE_CHAT_GO: join(env.RESSAC_ROOT, "fake-chat-go") };
  const r = chat
    ? spawnSync(process.execPath, [join(__dirname, chat), ...command.slice(1)], { stdio: "inherit", env: { ...env, ...vars, ...traces } })
    : spawnSync(process.execPath, [env.FAKE_DOCKER_AGENT || join(__dirname, "fake-agent.mjs"), ...command], { stdio: "inherit", env: { ...env, ...vars } });
  process.exit(r.status ?? 1);
}
quit(0);
