// Run by security-check.sh (which sets LIMA_HOME, RESSAC_ROOT, the image and tools, and cleans up): drives the shipped
// code path (createMachine + the kernel's Workshop on the machine engine) and prints one PASS/FAIL line per protection,
// then the measurements. Exits 1 on any FAIL, 2 when the forward checks were skipped (Mac range busy), 0 only on a full pass.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { UPGRADE, createMachine, vmImage } from "../../host/machine.ts";
import { LOGINS_EXTRACT } from "../../host/engines.ts";
import { DEFAULT_DOCKER_FOLDER, IMAGE, Workshop, containerName, spacePaths } from "../../../../packages/kernel/src/index.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const home = env("LIMA_HOME");
const root = env("RESSAC_ROOT");
const engineDir = join(DEFAULT_DOCKER_FOLDER, "engine");
const tools = { limactl: env("RESSAC_LIMACTL"), podman: env("RESSAC_PODMAN"), template: env("RESSAC_VM_TEMPLATE") };
const kernelDir = join(import.meta.dirname, "..", "..", "..", "..", "packages", "kernel");
const ports = env("RESSAC_CONTAINER_PORTS").split("-").map(Number) as [number, number];

let failed = 0;
let skipped = 0;
const line = (ok: boolean, what: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  [${detail.replace(/\s+/g, " ").trim().slice(0, 300)}]` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const machine = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: async () => false, image: vmImage() });
const network = { ports: [] as number[], domains: [] as string[] };
const workshop = new Workshop({ paths: spacePaths(root), engine: () => machine, network: () => network });
const pod = (args: string[], input?: string) => spawnSync(tools.podman, [...machine.args(), ...args], { encoding: "utf8", input, timeout: 15 * 60_000 });
const vm = (cmd: string) => spawnSync(tools.limactl, ["shell", "--workdir", "/", "ressac", "sh", "-c", cmd], { encoding: "utf8", env: process.env, timeout: 120_000 });
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`;
const mb = async () => (await machine.usage())?.memoryMB ?? 0;
/** Physical footprint (what Activity Monitor shows) of the process holding the instance's disk: the vz machine. */
const footprint = () => {
  const pid = spawnSync("lsof", ["-t", join(home, "ressac", "disk")], { encoding: "utf8" }).stdout.split("\n").find((p) => /^\d+$/.test(p));
  if (!pid) return "no vz process";
  const f = spawnSync("footprint", [pid], { encoding: "utf8" }).stdout.match(/Footprint:\s*([\d.]+ \w+)/)?.[1];
  return `${f ?? "?"} footprint`;
};
const listen = (port = 0) =>
  new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer((c) => c.end("hello\n")).on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;
const macConnect = (port: number) =>
  new Promise<string>((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    let data = "";
    c.on("data", (d) => (data += d)).on("end", () => resolve(data)).on("error", (e) => resolve(`error ${(e as NodeJS.ErrnoException).code}`));
    c.setTimeout(3000, () => (c.destroy(), resolve("timeout")));
  });
const vitest = (file: string, flag: string) =>
  spawnSync(join(kernelDir, "node_modules", ".bin", "vitest"), ["run", file], {
    cwd: kernelDir,
    encoding: "utf8",
    env: { ...process.env, [flag]: "1", RESSAC_REAL_ENGINE: "machine", RESSAC_PODMAN_URL: machine.args()[1], TMPDIR: join(root, "tmp") },
    timeout: 15 * 60_000,
  });

const report: string[] = [];
const measure = (what: string, value: string) => report.push(`${what}: ${value}`);

const first = ports[0];
try {
  mkdirSync(join(root, "tmp"), { recursive: true });
  // Else the forward check would reach whatever already holds the port (a Docker workshop publishes the same range).
  const busy = spawnSync("lsof", ["-nP", `-iTCP:${ports[0]}-${ports[1]}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim();
  if (busy) (skipped++, console.log(`SKIP  Mac: 127.0.0.1:${ports.join("-")} is held by another program, the forward checks will not run  [${busy.replace(/\s+/g, " ")}]`));
  else line(true, `Mac: 127.0.0.1:${ports.join("-")} free before the machine starts`);
  // 1. The machine, from the image, through the shipped install path.
  let t = Date.now();
  await machine.install();
  measure("first start (create + boot + podman answers)", `${((Date.now() - t) / 1000).toFixed(1)} s`);
  await sleep(10_000);
  measure("after boot, nothing running (usage() RSS)", `${await mb()} MB RSS, ${footprint()}`);

  // 2. The kernel's integration tests on the machine engine.
  const w = vitest("test/container/workshop.integration.test.ts", "ATELIER_INTEGRATION");
  line(w.status === 0, "integration: workshop.integration.test.ts on the machine");
  if (w.status !== 0) console.log(out(w));

  // 3. The real workshop, with the allowlist rules: the relay is a Mac server whose port is allowed, another is not.
  const relay = await listen();
  const other = await listen();
  network.ports = [portOf(relay)];
  t = Date.now();
  const state = await workshop.ensureStarted();
  line(state === "started", "workshop started with its network rules (secureNetwork)", `${state} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  // exec applies the rules again if the start's apply failed, and throws when they cannot be applied: a check fails loudly.
  const x = (cmd: string) => workshop.exec(["sh", "-c", cmd]);
  measure("after workshop start (usage() RSS)", `${await mb()} MB RSS, ${footprint()}`);

  const s = vitest("test/container/session.integration.test.ts", "SESSION_INTEGRATION");
  line(s.status === 0, "integration: session.integration.test.ts on the machine");
  if (s.status !== 0) console.log(out(s));

  // Mounts: the machine mounts the Ressac root and the engine folder only; the workshop sees no /Users at all.
  const mounts = vm("grep virtiofs /proc/mounts | cut -d' ' -f2");
  const mounted = mounts.stdout.trim().split("\n").sort();
  line(JSON.stringify(mounted) === JSON.stringify([root, engineDir].sort()), "machine: only the Ressac root and the engine folder are mounted", mounted.join(", "));
  const homeDir = process.env.HOME!;
  const leaks = vm(`for f in ${homeDir}/.ssh ${homeDir}/Library ${homeDir}/Desktop ${homeDir}/.zshrc; do [ -e "$f" ] && echo "$f"; done; ls /Users`);
  line(leaks.status === 0 && leaks.stdout.trim() === homeDir.split("/")[2], "machine: no home folder content (ls /Users, ~/.ssh, ~/Library)", out(leaks));
  const users = await x("ls /Users 2>&1; echo code=$?");
  line(/No such file/.test(users.stdout) && !/code=0/.test(users.stdout), "workshop: ls /Users shows nothing (absent)", users.stdout);
  const whoami = await x("id -un");
  line(whoami.stdout.trim() === "node", "workshop: exec runs as node", whoami.stdout);

  // .ressac read-only, logs writable.
  const ro = await x("echo x > /workspace/.ressac/x");
  line(ro.code !== 0 && /Read-only/i.test(ro.stderr), "workshop: writing /workspace/.ressac/x fails (read-only)", `code ${ro.code} ${ro.stderr}`);
  const ws = await x("echo x > /workspace/probe && cat /workspace/probe");
  line(ws.code === 0, "workshop: /workspace writable (control)", out(ws));

  // Web: allowlist proxy only.
  const ex = await x("curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://example.com; echo \" code=$?\"");
  line(/^000 code=56$/.test(ex.stdout.trim()) && /response 403/.test(ex.stderr), "workshop: curl https://example.com is refused by the proxy (CONNECT 403)", out(ex));
  const exDirect = await x("curl -sS -o /dev/null --noproxy '*' --max-time 10 https://93.184.215.14; echo \" code=$?\"");
  line(/code=7$/.test(exDirect.stdout.trim()), "workshop: a direct connection to a literal IP is refused (iptables, curl exit 7)", out(exDirect));
  const an = await x("curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.anthropic.com/; echo \" code=$?\"");
  line(/^\d{3} code=0/.test(an.stdout.trim()) && !an.stdout.startsWith("000"), "workshop: curl https://api.anthropic.com reaches it through the proxy", out(an));

  // The Mac's localhost: only the allowed (relay) port.
  const tcp = (port: number) => x(`node -e "const s=require('net').connect(${port},'192.168.5.2');s.on('data',d=>{process.stdout.write(String(d));process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(1)});setTimeout(()=>{console.log('timeout');process.exit(2)},5000)"`);
  const r1 = await tcp(portOf(relay));
  line(r1.code === 0 && r1.stdout.includes("hello"), `workshop: TCP to 192.168.5.2:${portOf(relay)} (the relay, allowed) succeeds`, out(r1));
  const r2 = await tcp(portOf(other));
  line(r2.code !== 0 && !r2.stdout.includes("hello"), `workshop: TCP to 192.168.5.2:${portOf(other)} (another Mac localhost port) fails`, out(r2));
  relay.close();

  // Harvest: the shipped run flags, with `ls /sys/class/net` in place of the harvester.
  const files = join(root, "home", "widgets", "probe");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "widget.mjs"), "");
  const argv = workshop.harvestCommand("probe", files, engineDir, 30);
  const harvest = spawnSync(argv[0]!, [...argv.slice(1, argv.indexOf(IMAGE) + 1), "sh", "-c", "echo \"net=$(ls /sys/class/net | tr '\\n' ' ')\"; touch /x 2>/dev/null && echo rw=yes || echo rw=no"], { encoding: "utf8", timeout: 120_000 });
  const hLines = harvest.stdout.split("\n");
  line(hLines.includes("net=lo "), "harvest: no network (interfaces: exactly lo)", out(harvest));
  line(hLines.includes("rw=no"), "harvest: read-only root", out(harvest));

  // A real npm install, through the proxy, under the 2.5g cap.
  const project = join(root, "projects", "npm-probe");
  mkdirSync(project, { recursive: true });
  const deps = { react: "^19", "react-dom": "^19", vite: "^7", "@vitejs/plugin-react": "^5", typescript: "^5", eslint: "^9", "typescript-eslint": "^8", vitest: "^3" };
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "npm-probe", private: true, devDependencies: deps }, null, 2));
  t = Date.now();
  const npm = await workshop.exec(["sh", "-c", "cd /workspace/projects/npm-probe && npm install --no-audit --no-fund > /tmp/npm.log 2>&1; echo code=$?; grep -E '^(added|npm error)' /tmp/npm.log; echo $(ls node_modules | wc -l) folders in node_modules"]);
  const oom = pod(["inspect", "-f", "{{.State.OOMKilled}}", containerName()]).stdout.trim();
  line(/code=0/.test(npm.stdout) && /added \d+ packages/.test(npm.stdout), `workshop: npm install of ${Object.keys(deps).join(", ")} succeeds under 2.5g`, `${out(npm)} in ${((Date.now() - t) / 1000).toFixed(0)} s, OOMKilled ${oom}`);
  measure("after the npm install (usage() RSS)", `${await mb()} MB RSS, ${footprint()}`);

  // Caps, inside the workshop container only.
  const limits = pod(["inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.SecurityOpt}}", containerName()]);
  line(limits.stdout.startsWith(`${2.5 * 2 ** 30} 1024 `) && limits.stdout.includes("no-new-privileges"), "workshop: --memory 2.5g, --pids-limit 1024, no-new-privileges", limits.stdout);
  // No capability in the container: root's bounding set is empty, node has none and cannot touch the rules; the proxy
  // (started by secureNetwork's privileged exec, then its own user) keeps none either.
  const caps = pod(["exec", "-u", "root", containerName(), "sh", "-c", "grep '^CapBnd' /proc/self/status"]);
  const nodeCaps = pod(["exec", containerName(), "sh", "-c", "id -un; grep '^CapEff' /proc/self/status; iptables -S >/dev/null 2>&1; echo iptables=$?"]);
  const proxyCaps = pod(["exec", "-u", "root", containerName(), "sh", "-c", "for d in /proc/[0-9]*; do grep -q \"^Uid:\\s*$(id -u ressac-proxy)\\s\" $d/status 2>/dev/null && grep '^CapEff' $d/status; done"]);
  line(
    /CapBnd:\s*0+$/m.test(caps.stdout) && /^node\nCapEff:\s*0+\niptables=[1-9]/.test(nodeCaps.stdout) && /^CapEff:\s*0+$/m.test(proxyCaps.stdout) && !/CapEff:\s*0*[1-9a-f]/.test(proxyCaps.stdout),
    "workshop: no capability (root bounding set empty; node has none and cannot run iptables; the proxy has none)",
    `${out(caps)} | ${out(nodeCaps)} | proxy ${out(proxyCaps)}`,
  );
  // 2.64 GiB: above the container's 2.5 GiB but under what the 3 GiB machine has free, so the cgroup's own OOM must be the
  // killer: its memory.events `oom` (limit reached) and `oom_kill` counters must both go up.
  const events = "while read k v; do printf '%s=%s ' $k $v; done < /sys/fs/cgroup/memory.events; echo";
  const mem = await x(`read m < /sys/fs/cgroup/memory.max; echo "max=$m"; grep MemAvailable /proc/meminfo; echo "before $(${events})"; node -e "const a=[];for(let i=0;i<27;i++)a.push(Buffer.alloc(100*2**20,1));console.log('alive')"; echo code=$?; echo "after $(${events})"`);
  const counter = (when: string, k: string) => Number(new RegExp(`^${when} .*\\b${k}=(\\d+)`, "m").exec(mem.stdout)?.[1] ?? NaN);
  line(
    /^max=2684354560$/m.test(mem.stdout) && !/^alive$/m.test(mem.stdout) && /code=137/.test(mem.stdout) && counter("after", "oom") > counter("before", "oom") && counter("after", "oom_kill") > counter("before", "oom_kill"),
    "workshop: node allocating 2.64 GiB is killed by the container's 2.5g cap (memory.events oom and oom_kill up)",
    out(mem),
  );
  // A fork bomb, bounded: node spawns 1500 sleeps, then reads the cgroup counters with no fork, and kills them all.
  const bomb = `const cp=require('child_process'),fs=require('fs'),kids=[];let failed=0;
for(let i=0;i<1500;i++){try{const k=cp.spawn('sleep',['60']);k.on('error',()=>failed++);kids.push(k)}catch{failed++}}
setTimeout(()=>{const r=(f)=>fs.readFileSync('/sys/fs/cgroup/'+f,'utf8').trim();console.log(r('pids.current'),r('pids.max'),failed,r('pids.events').replace(/\\n/g,' '));for(const k of kids)try{k.kill('SIGKILL')}catch{};setTimeout(()=>process.exit(0),1000)},3000)`;
  const fork = await workshop.exec(["node", "-e", bomb]);
  const [current, max, refused] = fork.stdout.trim().split(" ");
  line(max === "1024" && Number(current) <= 1024 && Number(refused) > 0 && Number(/max (\d+)/.exec(fork.stdout)?.[1] ?? 0) > 0, "workshop: a fork bomb (1500 processes) stops at 1024 pids", `pids.current ${current}, pids.max ${max}, refused spawns ${refused}, ${fork.stdout.trim().split(" ").slice(3).join(" ")} ${fork.stderr.slice(0, 200)}`);
  let alive = await x("echo still-up");
  for (let i = 0; i < 10 && alive.stdout.trim() !== "still-up"; i++) (await sleep(2000), (alive = await x("echo still-up")));
  line(alive.stdout.trim() === "still-up", "workshop: still answers after the memory and pid checks", out(alive));

  if (!busy) {
    // Ports: a server in the workshop on the range's first port reaches the Mac's 127.0.0.1; a guest port outside does not.
    const held = spawnSync("lsof", ["-nP", `-iTCP:${first}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("c")).map((l) => l.slice(1));
    line(held.length > 0 && held.every((c) => c === "limactl"), `Mac: 127.0.0.1:${first} is held by Lima's forward only`, held.join(", "));
    pod(["exec", "-d", containerName(), "node", "-e", `require('http').createServer((q,s)=>s.end('from-workshop')).listen(${first},'0.0.0.0')`]);
    // A container on 0.0.0.0:5400, a guest process on 127.0.0.1:5401: neither in the range.
    const outside = pod(["run", "-d", "--rm", "--name", "ressac-probe-out", "-p", "5400:5400", IMAGE, "node", "-e", "require('http').createServer((q,s)=>s.end('outside')).listen(5400,'0.0.0.0')"]);
    vm("nohup nc -lk -s 127.0.0.1 -p 5401 -e echo outside >/dev/null 2>&1 &");
    await sleep(5000); // Lima's port watcher polls
    const guestListens = vm("netstat -ltn").stdout;
    line(outside.status === 0 && /0\.0\.0\.0:5400\b/.test(guestListens) && /127\.0\.0\.1:5401\b/.test(guestListens), "machine: probe listeners outside the range are up (5400 container, 5401 guest process)", guestListens.split("\n").filter((l) => /:540[01]\b/.test(l)).join(" | "));
    const curl = (port: number) => spawnSync("curl", ["-sS", "--max-time", "5", `http://127.0.0.1:${port}/`], { encoding: "utf8" });
    let fwd = curl(first);
    for (let i = 0; i < 5 && fwd.stdout !== "from-workshop"; i++) (await sleep(1000), (fwd = curl(first)));
    line(fwd.stdout === "from-workshop", `Mac: curl 127.0.0.1:${first} reaches a server in the workshop`, out(fwd));
    for (const p of [5400, 5401]) {
      const macBusy = spawnSync("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim();
      const c = curl(p);
      line(macBusy === "" && !c.stdout.includes("outside"), `Mac: guest port ${p} (outside ${ports.join("-")}) is not forwarded`, macBusy || out(c));
    }
    pod(["rm", "-f", "ressac-probe-out"]);
    const forwards = spawnSync("grep", ["-hiE", "forward|ignor", join(home, "ressac", "ha.stderr.log")], { encoding: "utf8" }).stdout.split("\n").filter((l) => /540[01]|53\d\d/.test(l)).slice(-6);
    console.log(`      Lima's forward decisions:\n${forwards.map((l) => `        ${l.slice(0, 220)}`).join("\n")}`);
  }

  // Cold start → « exec répond », three times, through the same path as a session.
  for (let i = 1; i <= 3; i++) {
    await machine.stop();
    t = Date.now();
    await workshop.ensureStarted();
    const e = await workshop.exec(["true"]);
    measure(`cold start → exec answers, run ${i}`, `${((Date.now() - t) / 1000).toFixed(1)} s (exec code ${e.code})`);
  }

  // The logins copy's extract with the workshop image's own tar: fills what is missing, never overwrites, no staging left.
  const extract = pod(["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", IMAGE, "sh", "-c",
    `mkdir -p /v/.claude /s/.claude && echo machine > /v/.claude/c && echo docker > /s/.claude/c && echo new > /s/x && tar -C /s -cf - . | { ${LOGINS_EXTRACT}; } && cat /v/.claude/c /v/x && ls -A /v && tar --version | head -1`]);
  line(extract.status === 0 && extract.stdout.startsWith("machine\nnew\n.claude\nx\ntar (GNU tar)"), "workshop image: the logins extract (GNU tar) adds the missing files and keeps the machine's", out(extract));

  // A migrated user's volume: the copy container is the first to mount it (at /v, as root); its root must still be node's.
  const vol = "rsc-logins-probe";
  pod(["volume", "rm", "-f", vol]);
  const copied = pod(["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${vol}:/v`, IMAGE, "sh", "-c",
    `mkdir -p /s/.claude && echo docker > /s/.claude/c && chown -R node:node /s && tar -C /s -cf - . | { ${LOGINS_EXTRACT}; } && stat -c %U:%a /v`]);
  const asNode = pod(["run", "--rm", "--pull", "never", "--network", "none", "-u", "node", "-v", `${vol}:/home/node`, IMAGE, "sh", "-c", "mkdir /home/node/.npm && cat /home/node/.claude/c"]);
  pod(["volume", "rm", "-f", vol]);
  line(copied.status === 0 && copied.stdout.trim().split("\n").at(-1)!.startsWith("node:") && asNode.status === 0 && asNode.stdout.trim() === "docker", "logins copy into a new volume: its root is node's, node creates ~/.npm there and reads the copied login", `${out(copied)} | ${out(asNode)}`);

  // The guest upgrade job, as a boot launches it on an older guest: returns at once, one apk at a time, the mark rewritten by the job.
  const sudo = (input: string) => spawnSync(tools.limactl, ["shell", "--workdir", "/", "ressac", "sudo", "sh"], { encoding: "utf8", env: process.env, input, timeout: 120_000 });
  const setup = vm("sed 's/.*-//' /etc/ressac-vm-version").stdout.trim();
  sudo(`echo 3.24.0-5.8.0-${setup} >/etc/ressac-vm-version\n`);
  t = Date.now();
  const job = [sudo(UPGRADE), sudo(UPGRADE)];
  const launched = (Date.now() - t) / 1000;
  const apks = vm("pgrep -x apk | wc -l").stdout.trim();
  while (vm("pgrep -x apk").status === 0 && Date.now() - t < 5 * 60_000) await sleep(2000);
  await sleep(2000);
  const mark = vm("cat /etc/ressac-vm-version").stdout.trim();
  const real = vm(`echo "$(cat /etc/alpine-release)-$(podman version -f '{{.Client.Version}}')-${setup}"`).stdout.trim();
  line(job.every((j) => j.status === 0) && launched < 20 && Number(apks) <= 1 && mark === real && !mark.startsWith("3.24.0-"), "guest: the apk upgrade runs detached (two launches, one apk) and rewrites the mark once done", `launched in ${launched.toFixed(1)} s, apk processes ${apks}, mark ${mark}, after ${((Date.now() - t) / 1000).toFixed(0)} s`);

  // The idle stop: another handle on the same machine with a short idle delay and the real busy rule.
  const idle = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: () => workshop.busy(idle), idleMs: 10_000, pollMs: 2_000, image: vmImage() });
  await idle.wake("user");
  t = Date.now();
  while (idle.status().kind !== "stopped" && Date.now() - t < 120_000) await sleep(1000);
  line(idle.status().kind === "stopped", "machine: stops by itself after the idle delay with nothing running", `${idle.status().kind} after ${((Date.now() - t) / 1000).toFixed(0)} s`);
  measure("after the idle stop (usage() RSS)", `${await mb()} MB RSS, ${footprint()}`);
} catch (e) {
  line(false, "unexpected error", (e as Error).stack ?? String(e));
}

console.log("\nMeasurements:");
for (const m of report) console.log(`  ${m}`);
// Only a full run exits 0: skipped checks (the forward ones, Mac range busy) are not a pass.
console.log(failed ? `\n${failed} FAIL` : skipped ? `\nINCOMPLETE: the forward checks were not run (free 127.0.0.1:${ports.join("-")} and run again)` : "\nall PASS");
process.exit(failed ? 1 : skipped ? 2 : 0);

