// B1-B2 cases, run by run.sh (which sets LIMA_HOME, RESSAC_ROOT, the tools and the template, and cleans up). Drives the
// shipped path: createMachine with machine.ts's pinned VM_IMAGE, the kernel's Workshop (ensureStarted → secureNetwork,
// the real RUN_FLAGS and ressac-network.mjs). Attacks run inside the workshop container as `node`, unless a claim is
// about the guest or the Mac. One JSON line per case on stdout: {id, claim, attack, expected, observed, verdict}.
// Every check reads a structured value (a JSON line printed by a probe, an exit code, an errno, a parsed status line),
// never a substring of mixed stdout and stderr.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { VM_IMAGE, createMachine, vmImage } from "../../../../apps/firefox/host/machine.ts";
import { DEFAULT_DOCKER_FOLDER, IMAGE, Workshop, containerName, dockerfileHash, spacePaths } from "../../../../packages/kernel/src/index.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`${k} missing`); })();
const home = env("LIMA_HOME");
const root = env("RESSAC_ROOT");
const tools = { limactl: env("RESSAC_LIMACTL"), podman: env("RESSAC_PODMAN"), template: env("RESSAC_VM_TEMPLATE") };
const [first, last] = env("RESSAC_CONTAINER_PORTS").split("-").map(Number) as [number, number];
const repo = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const engineDir = join(DEFAULT_DOCKER_FOLDER, "engine");
const MAC = "192.168.5.2"; // Lima's fixed address of the Mac, seen from the guest (host.docker.internal)
const log = (...a: unknown[]) => console.error(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Output: nothing machine-specific leaves this process. ---
const lan = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal).map((i) => i!.address);
const secrets: [string, string][] = [
  [repo, "<repo>"], [realpathSync(root), "<ressac-root>"], [root, "<ressac-root>"], [realpathSync(home), "<lima-home>"], [home, "<lima-home>"],
  [homedir(), "<mac-home>"], [userInfo().username, "<user>"], ...lan.map((a): [string, string] => [a, a.includes(":") ? "<mac-lan-v6>" : "<mac-lan-v4>"]),
];
const scrub = (s: string) => secrets.filter(([k]) => k.length > 3).sort((a, b) => b[0].length - a[0].length).reduce((t, [k, v]) => t.split(k).join(v), s);
type Verdict = "HOLDS" | "BYPASS" | "LIMIT" | "NOT_TESTED";
const tally: Record<string, number> = {};
const emit = (id: string, claim: string, attack: string, expected: string, observed: unknown, verdict: Verdict) => {
  tally[verdict] = (tally[verdict] ?? 0) + 1;
  console.log(scrub(JSON.stringify({ id, claim, attack, expected, observed, verdict })));
  if (verdict === "BYPASS") log(`BYPASS ${id}`);
};
const hold = (ok: boolean): Verdict => (ok ? "HOLDS" : "BYPASS");
/** A probe's tcp() result that means a connection was established. */
const reached = (v: unknown) => /^(data:|connected)/.test(String(v));

// --- Drivers. ---
const machine = createMachine({ ...tools, home, engine: engineDir, ressacRoot: root, busy: async () => true, idleMs: 24 * 3600_000, image: vmImage() });
const relay = net.createServer((c) => c.end("hello\n"));
await new Promise<void>((ok) => relay.listen(0, "127.0.0.1", ok));
const relayPort = (relay.address() as net.AddressInfo).port;
const other = net.createServer((c) => c.end("other\n"));
await new Promise<void>((ok) => other.listen(0, "127.0.0.1", ok));
const otherPort = (other.address() as net.AddressInfo).port;
// A user-added `*.` domain whose DNS answers any address asked: the C1.3 attacker's name.
let network = { ports: [relayPort], domains: ["*.nip.io"] };
const paths = spacePaths(root);
const workshop = new Workshop({ paths, locale: () => "en", engine: () => machine, network: () => network });

type R = { code: number; stdout: string; stderr: string };
const sp = (cmd: string, args: string[], input?: string, timeout = 180_000): R => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, timeout, env: process.env });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
};
const pod = (args: string[], input?: string) => sp(tools.podman, [...machine.args(), ...args], input);
const guest = (cmd: string) => sp(tools.limactl, ["shell", "--workdir", "/", "ressac", "sh", "-c", cmd]);
/** `key=value` lines of a probe's stdout (each line trimmed: no end-of-line anchor to beat). */
const kv = (s: string) => Object.fromEntries(s.split("\n").map((l) => /^([A-Za-z0-9_.-]+)=(.*)$/.exec(l.trim())).filter((m) => m).map((m) => [m![1], m![2]!.trim()]));
/** The JSON object a probe prints on its last stdout line. */
const lastJson = (r: R) => {
  const line = r.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe printed no JSON (code ${r.code}): ${r.stdout.slice(-300)} | ${r.stderr.slice(-300)}`);
  }
};
const LIB = `const net=require('net'),dgram=require('dgram'),fs=require('fs'),dns=require('dns');
const tcp=(host,port,ms=4000)=>new Promise(r=>{let c=false,d='';const s=net.connect({host,port});const fin=v=>{clearTimeout(t);s.destroy();r(v)};const t=setTimeout(()=>fin(d?'data:'+d.trim():c?'connected':'timeout'),ms);s.on('connect',()=>{c=true});s.on('data',x=>{d+=x});s.on('end',()=>fin('data:'+d.trim()));s.on('error',e=>fin(d?'data:'+d.trim():c?'connected-then-'+e.code:e.code))});
const raw=(req,ms=12000)=>new Promise(r=>{let d='';const s=net.connect(3128,'127.0.0.1',()=>s.write(req));const done=()=>{clearTimeout(t);s.destroy();r(d)};const t=setTimeout(done,ms);s.on('data',x=>{d+=x;if(d.startsWith('HTTP/1.1 200 Connection Established'))done()});s.on('close',done);s.on('error',e=>{d=d||('error '+e.code);done()})});
const sum=d=>({status:(/^HTTP\\/1\\.[01] (\\d{3})/.exec(d)||[])[1]||d.slice(0,40),local:d.includes('resolves to a local or private address'),refused:d.includes('is not in the agent'),exampleBody:d.includes('Example Domain')});
const C=hp=>raw('CONNECT '+hp+' HTTP/1.1\\r\\nHost: '+hp+'\\r\\n\\r\\n').then(sum);
const errOf=f=>{try{f();return 'ok'}catch(e){return e.code||String(e.message).slice(0,60)}};`;
/** `code` (an async body over LIB, returning a JSON value) run by node in the workshop container. */
const probe = async (code: string, user = "node") => {
  const js = `${LIB}\n(async()=>{${code}})().then(v=>console.log(JSON.stringify(v)),e=>console.log(JSON.stringify({probeError:String(e)})))`;
  const r = user === "node" ? await workshop.exec(["node", "-e", js]) : pod(["exec", "-u", user, containerName(), "node", "-e", js]);
  const v = lastJson(r);
  // A crashed probe found nothing, which must not read as « nothing got through »: the case becomes NOT_TESTED.
  if (v && typeof v === "object" && "probeError" in v) throw new Error(`probe crashed: ${v.probeError}`);
  return v;
};
const sh = async (cmd: string) => workshop.exec(["sh", "-c", cmd]);

async function run(id: string, claim: string, attack: string, expected: string, f: () => Promise<{ observed: unknown; verdict: Verdict }>) {
  log(id);
  try {
    const { observed, verdict } = await f();
    emit(id, claim, attack, expected, observed, verdict);
  } catch (e) {
    emit(id, claim, attack, expected, { runnerError: String((e as Error).stack ?? e).slice(0, 600) }, "NOT_TESTED");
  }
}

let ok = false;
try {
  for (const p of [first, 5400, 5401]) {
    const held = sp("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN", "-t"]).stdout.trim();
    if (held) throw new Error(`the Mac's port ${p} is already held: free ${first}-${last}, 5400 and 5401 first`);
  }
  if (sp("lsof", ["-nP", "-iUDP:5402", "-t"]).stdout.trim()) throw new Error("the Mac's UDP port 5402 is already held");
  if (JSON.stringify(vmImage()) !== JSON.stringify(VM_IMAGE)) throw new Error("vmImage() is not machine.ts's pinned VM_IMAGE (an override is set)");
  let t = Date.now();
  const seen = new Set<string>();
  machine.onStatus((s) => seen.add(s.kind));
  log(`installing the machine from ${VM_IMAGE.url}…`);
  await machine.install();
  log(`machine up in ${((Date.now() - t) / 1000).toFixed(0)} s (states ${[...seen].join(", ")})`);
  t = Date.now();
  const state = await workshop.ensureStarted();
  log(`workshop ${state} in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  if (state !== "started") throw new Error(`workshop ${state}`);
  const C = containerName();
  const hash = pod(["image", "inspect", "-f", '{{index .Config.Labels "ressac.dockerfile"}}', IMAGE]).stdout.trim();
  log(`workshop image label ${hash}, repo's dockerfileHash ${dockerfileHash()}`);

  // ======================= B1 — the agent's network is an allowlist =======================
  const C11 = "C1.1 the agent's user reaches only localhost, the Mac's MCP/relay ports and the allowlist proxy";
  await run("C1.1-A1", C11, "direct TCP connect() from node to public IPs (1.1.1.1:443, 8.8.8.8:443, 9.9.9.9:443, 8.8.8.8:53), proxy ignored; control: the same connect as root (let out by the owner rule)",
    "every node connect refused (no 'connected'); root's control connects, so the refusal is the rules, not a dead network", async () => {
      const node = await probe("const o={};for(const [h,p] of [['1.1.1.1',443],['8.8.8.8',443],['9.9.9.9',443],['8.8.8.8',53]])o[h+':'+p]=await tcp(h,p);return o");
      const rootCtl = await probe("return await tcp('1.1.1.1',443)", "root");
      return { observed: { node, rootControl: rootCtl }, verdict: !reached(rootCtl) ? "NOT_TESTED" : hold(!Object.values(node).some(reached)) };
    });
  await run("C1.1-A2", C11, "direct UDP from node: a DNS query to 8.8.8.8:53 and 1.1.1.1:53, a datagram to 1.1.1.1:9999",
    "no reply to any datagram (send refused, EPERM / port unreachable)", async () => {
      const q = [0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, ..."example".split("").map((c) => c.charCodeAt(0)), 3, ..."com".split("").map((c) => c.charCodeAt(0)), 0, 0, 1, 0, 1];
      const udp = `const q=Buffer.from(${JSON.stringify(q)});const udp=(h,p)=>new Promise(r=>{const s=dgram.createSocket('udp4');let res='no-reply';s.on('message',()=>{res='reply'});s.on('error',e=>{if(res!=='reply')res='error '+e.code});s.send(q,p,h,e=>{if(e)res='send-error '+e.code});setTimeout(()=>{try{s.close()}catch{};r(res)},3000)});`;
      const o = await probe(`${udp}return {'8.8.8.8:53':await udp('8.8.8.8',53),'1.1.1.1:53':await udp('1.1.1.1',53),'1.1.1.1:9999':await udp('1.1.1.1',9999)}`);
      // Control: the same DNS query as root (let out by the owner rule) gets its reply, so a refusal is the rules.
      const rootControl = await probe(`${udp}return await udp('8.8.8.8',53)`, "root");
      // Only the rules' refusal at send proves it; a silent no-reply could be a lost datagram.
      const vals = Object.values(o);
      return { observed: { node: o, rootControl }, verdict: vals.includes("reply") ? "BYPASS" : rootControl === "reply" && vals.every((v) => v === "send-error EPERM") ? "HOLDS" : "NOT_TESTED" };
    });
  await run("C1.1-A3", C11, "DNS as an egress channel: getaddrinfo, the container's resolv.conf servers, and a resolver set to 8.8.8.8, for example.com",
    "every name resolution fails from node (names are resolved by the proxy only)", async () => {
      const o = await probe(`const t=p=>p.then(v=>'resolved '+JSON.stringify(v).slice(0,80),e=>e.code);const R=new dns.promises.Resolver({timeout:2000,tries:1});R.setServers(['8.8.8.8']);
        return {resolvConf:fs.readFileSync('/etc/resolv.conf','utf8').split('\\n').filter(l=>l.startsWith('nameserver')).join(' '),lookup:await t(dns.promises.lookup('example.com')),resolve4:await t(new dns.promises.Resolver({timeout:2000,tries:1}).resolve4('example.com')),at8888:await t(R.resolve4('example.com'))}`);
      // Control: root (let out by the owner rule) resolves the same name through 8.8.8.8.
      const rootControl = await probe("const R=new dns.promises.Resolver({timeout:2000,tries:1});R.setServers(['8.8.8.8']);return await R.resolve4('example.com').then(()=>'resolved',e=>e.code)", "root");
      const leaked = [o.lookup, o.resolve4, o.at8888].some((v: string) => v.startsWith("resolved"));
      return { observed: { ...o, rootControl }, verdict: leaked ? "BYPASS" : rootControl === "resolved" ? "HOLDS" : "NOT_TESTED" };
    });
  await run("C1.1-A4", C11, "IPv6 egress: connect to [2606:4700:4700::1111]:443 and to ::ffff:1.1.1.1:443 (IPv4-mapped), from node",
    "no connection", async () => {
      const o = await probe("return {v6:await tcp('2606:4700:4700::1111',443),mapped:await tcp('::ffff:1.1.1.1',443)}");
      return { observed: o, verdict: hold(!Object.values(o).some(reached)) };
    });
  await run("C1.1-A5-A6", C11, "ICMP and raw sockets from node: ping -c1 1.1.1.1; python3 socket(AF_INET, SOCK_RAW, IPPROTO_ICMP) and SOCK_DGRAM ICMP",
    "ping fails (exit != 0, binary present); both sockets refused", async () => {
      const r = await sh(`if command -v ping >/dev/null; then ping -c1 -W2 1.1.1.1 >/dev/null 2>&1; echo ping=$?; else echo ping=absent; fi
python3 -c "
import socket
for n,t in (('raw',socket.SOCK_RAW),('dgram',socket.SOCK_DGRAM)):
    try:
        s=socket.socket(socket.AF_INET,t,socket.IPPROTO_ICMP); s.settimeout(2); s.sendto(b'\\x08\\x00\\xf7\\xff\\x00\\x00\\x00\\x00',('1.1.1.1',0)); s.recv(64); print(n+'=reply')
    except Exception as e: print(n+'='+type(e).__name__+':'+str(getattr(e,'errno','')))
"`);
      const o = kv(r.stdout);
      const pingOk = o.ping === "absent" || (o.ping !== undefined && o.ping !== "0");
      // A timeout would mean the socket opened and sent: only a refusal at creation or send counts.
      const sockOk = [o.raw, o.dgram].every((v) => v?.startsWith("PermissionError"));
      return { observed: o, verdict: o.raw === undefined ? "NOT_TESTED" : hold(pingOk && sockOk) };
    });
  await run("C1.1-A7-A8", C11, "become a uid the rules let out (ressac-proxy, root): su, sudo, setuid binaries under no-new-privileges; kill the proxy",
    "uid stays 1000, NoNewPrivs 1, su/sudo fail, the proxy cannot be signalled", async () => {
      const r = await sh(`echo uid=$(id -u); echo nnp=$(grep NoNewPrivs /proc/self/status | tr -dc 0-9)
su -s /bin/sh -c 'id -u' ressac-proxy </dev/null >/tmp/su.out 2>&1; echo su=$?; echo suuid=$(grep -x '[0-9][0-9]*' /tmp/su.out | head -1)
if command -v sudo >/dev/null; then sudo -n id -u >/dev/null 2>&1; echo sudo=$?; else echo sudo=absent; fi
echo setuid=$(find / -xdev -perm -4000 -type f 2>/dev/null | tr '\\n' ' ')
p=$(for d in /proc/[0-9]*; do grep -q "^Uid:[[:space:]]*$(id -u ressac-proxy)[[:space:]]" $d/status 2>/dev/null && echo \${d#/proc/}; done | head -1)
echo proxypid=$p; kill -9 $p 2>/dev/null; echo kill=$?`);
      const o = kv(r.stdout);
      const ok = o.uid === "1000" && o.nnp === "1" && o.su !== "0" && o.suuid === "" && o.sudo !== "0" && o.proxypid !== "" && o.kill !== "0";
      return { observed: o, verdict: hold(ok) };
    });

  const C12 = "C1.2 the proxy allows only base domains plus user-added ones, HTTPS CONNECT and plain HTTP";
  await run("C1.2-A13", C12, "absolute-form and Host disagreement on the plain-HTTP path: GET http://example.com/; GET http://github.com/ with Host: example.com; GET http://example.com/ with Host: github.com; origin-form GET / with Host: github.com",
    "example.com refused (403) whatever the Host; github.com goes to github.com (no 'Example Domain' body); origin-form refused", async () => {
      const o = await probe(`const G=(u,h)=>raw('GET '+u+' HTTP/1.1\\r\\nHost: '+h+'\\r\\nConnection: close\\r\\n\\r\\n').then(sum);
        return {abs:await G('http://example.com/','example.com'),hostExample:await G('http://github.com/','example.com'),urlExample:await G('http://example.com/','github.com'),origin:await G('/','github.com')}`);
      const ok = o.abs.status === "403" && o.abs.refused && o.urlExample.status === "403" && o.urlExample.refused && o.hostExample.status !== "403" && !o.hostExample.exampleBody && o.origin.status === "403";
      return { observed: o, verdict: hold(ok) };
    });
  await run("C1.2-A14", C12, "ports other than 443/80: CONNECT github.com:22, api.anthropic.com:8443, github.com:" + first + "; plain HTTP http://github.com:8080/",
    "all 403", async () => {
      const o = await probe(`return {c22:await C('github.com:22'),c8443:await C('api.anthropic.com:8443'),capp:await C('github.com:${first}'),h8080:sum(await raw('GET http://github.com:8080/ HTTP/1.1\\r\\nHost: github.com:8080\\r\\nConnection: close\\r\\n\\r\\n'))}`);
      return { observed: o, verdict: hold(Object.values(o).every((v: any) => v.status === "403")) };
    });
  await run("C1.2-A15", C12, "IP literals through CONNECT and HTTP: 1.1.1.1:443, 16843009:443 (decimal), 0x01010101:443, [::ffff:1.1.1.1]:443, GET http://1.1.1.1/",
    "all 403", async () => {
      const o = await probe(`const o={};for(const hp of ['1.1.1.1:443','16843009:443','0x01010101:443','[::ffff:1.1.1.1]:443','[2606:4700:4700::1111]:443'])o[hp]=await C(hp);o['GET http://1.1.1.1/']=sum(await raw('GET http://1.1.1.1/ HTTP/1.1\\r\\nHost: 1.1.1.1\\r\\nConnection: close\\r\\n\\r\\n'));return o`);
      return { observed: o, verdict: hold(Object.values(o).every((v: any) => v.status === "403")) };
    });
  await run("C1.2-A16", C12, "correctness, not a bypass: allowed host in upper case and with a trailing dot (CONNECT API.ANTHROPIC.COM:443, api.anthropic.com.:443), and the plain control api.anthropic.com:443",
    "all three 200 Connection Established", async () => {
      const o = await probe("return {plain:await C('api.anthropic.com:443'),upper:await C('API.ANTHROPIC.COM:443'),dot:await C('api.anthropic.com.:443')}");
      // A refusal here is a usability bug, not a hole: never a BYPASS.
      return { observed: o, verdict: Object.values(o).every((v: any) => v.status === "200") ? "HOLDS" : "NOT_TESTED" };
    });
  await run("C1.2-A17", C12, "suffix over-match with the user domain *.nip.io and base domains: CONNECT evilnip.io:443, nip.io.evil.example:443, evilgithub.com:443, api.anthropic.com.evil.example:443, github.com.evil.example:443",
    "all 403 (not allowed)", async () => {
      const o = await probe("const o={};for(const h of ['evilnip.io','nip.io.evil.example','evilgithub.com','api.anthropic.com.evil.example','github.com.evil.example'])o[h]=await C(h+':443');return o");
      return { observed: o, verdict: hold(Object.values(o).every((v: any) => v.status === "403" && v.refused)) };
    });
  await run("C1.2-A12", C12, "request smuggling on the plain-HTTP path: a request with both Content-Length and Transfer-Encoding followed by GET http://example.com/; two pipelined requests, the second to example.com; a CRLF-encoded path",
    "example.com's page never comes back ('Example Domain' in no response; root fetching it directly does see that text, the control); whether the smuggled request gets its own 403 is recorded, not required", async () => {
      const o = await probe(`const a=await raw('GET http://github.com/ HTTP/1.1\\r\\nHost: github.com\\r\\nContent-Length: 4\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\nGET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n');
        const b=await raw('GET http://github.com/ HTTP/1.1\\r\\nHost: github.com\\r\\n\\r\\nGET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n');
        const c=await raw('GET http://github.com/%0d%0aHost:%20example.com HTTP/1.1\\r\\nHost: github.com\\r\\nConnection: close\\r\\n\\r\\n');
        const st=d=>[...d.matchAll(/^HTTP\\/1\\.1 (\\d{3})/gm)].map(m=>m[1]);
        return {clte:{statuses:st(a),exampleBody:a.includes('Example Domain')},pipelined:{statuses:st(b),exampleRefused:b.includes('example.com is not in'),exampleBody:b.includes('Example Domain')},crlf:{statuses:st(c),exampleBody:c.includes('Example Domain')}}`);
      // exampleRefused is recorded, not required: a proxy that drops the pipelined request is not a bypass.
      const ok = !o.clte.exampleBody && !o.pipelined.exampleBody && !o.crlf.exampleBody;
      // Control: root (let out by the owner rule) fetching example.com directly sees the text the check looks for.
      const control = pod(["exec", "-u", "root", C, "curl", "-s", "--noproxy", "*", "--max-time", "10", "http://example.com/"]).stdout.includes("Example Domain");
      return { observed: { ...o, rootControlSeesExampleDomain: control }, verdict: control ? hold(ok) : ok ? "NOT_TESTED" : "BYPASS" };
    });
  await run("C1.2-A18", C12, "domains-file poisoning: node appends a domain to /etc/ressac/domains.json",
    "file owned by root, mode 644, write refused (EACCES)", async () => {
      const o = await probe("const st=fs.statSync('/etc/ressac/domains.json');return {uid:st.uid,mode:(st.mode&0o777).toString(8),write:errOf(()=>fs.appendFileSync('/etc/ressac/domains.json',' ')),replace:(fs.writeFileSync('/tmp/b1b2-d','[]'),errOf(()=>fs.renameSync('/tmp/b1b2-d','/etc/ressac/domains.json')))}");
      return { observed: o, verdict: hold(o.uid === 0 && o.mode === "644" && o.write === "EACCES" && o.replace !== "ok") };
    });
  emit("C1.2-A10", C12, "DNS rebinding between the proxy's check and its connect", "the checked address is the connected one (guardedLookup is the connect's own lookup)",
    { note: "argued from code (ressac-network.mjs passes guardedLookup as the lookup of net.connect / http.request: one resolution, checked and used); no live race" }, "NOT_TESTED");
  emit("C1.2-A11", C12, "CONNECT to an allowed host, then TLS SNI / Host of another origin (domain fronting)", "the tunnel is opaque: the upstream is whatever the allowed CONNECT name resolves to",
    { note: "argued from code: the proxy gates the CONNECT target only; fronting through a shared CDN of an allowed host is not reproduced live" }, "NOT_TESTED");

  const C13 = "C1.3 the proxy refuses names that resolve to private addresses";
  await run("C1.3-A9", C13, "allowed user domain *.nip.io resolving to private addresses: CONNECT 127-0-0-1.nip.io:443, 192-168-5-2.nip.io:443 (the Mac), 169-254-169-254.nip.io:443, 10-0-0-1.nip.io:443; GET http://127-0-0-1.nip.io/ and http://192-168-5-2.nip.io/; control: CONNECT 1-1-1-1.nip.io:443",
    "every private one 403 with the « local or private address » refusal; the public control 200 (else nip.io did not answer: NOT_TESTED)", async () => {
      const o = await probe(`const o={};for(const h of ['127-0-0-1','192-168-5-2','169-254-169-254','10-0-0-1'])o['CONNECT '+h]=await C(h+'.nip.io:443');
        for(const h of ['127-0-0-1','192-168-5-2'])o['GET '+h]=sum(await raw('GET http://'+h+'.nip.io/ HTTP/1.1\\r\\nHost: '+h+'.nip.io\\r\\nConnection: close\\r\\n\\r\\n'));
        o.control=await C('1-1-1-1.nip.io:443');return o`);
      const { control, ...priv } = o;
      return { observed: o, verdict: control.status !== "200" ? "NOT_TESTED" : hold(Object.values(priv).every((v: any) => v.status === "403" && v.local)) };
    });

  await run("C1.1-A20-A21-A23", C11, `reach the Mac: TCP from node to ${MAC} on the allowed relay port (control), another Mac localhost port, and 22, 3306, 5432, 3128, ${first}; the Podman or Docker socket inside the container`,
    "only the relay port answers ('hello'); every other port refused; no engine socket in the container", async () => {
      const o = await probe(`const o={relay:await tcp('${MAC}',${relayPort}),other:await tcp('${MAC}',${otherPort})};for(const p of [22,3306,5432,3128,${first}])o['p'+p]=await tcp('${MAC}',p);
        o.sockets=['/run/podman/podman.sock','/var/run/docker.sock','/run/docker.sock','/var/run/podman/podman.sock'].filter(f=>fs.existsSync(f));return o`);
      const { relay: r, sockets, ...rest } = o;
      const ok = r === "data:hello" && !Object.values(rest).some(reached) && sockets.length === 0;
      return { observed: o, verdict: r !== "data:hello" ? "NOT_TESTED" : hold(ok) };
    });

  const C15 = "C1.5 (limit) allowed domains can carry data to an attacker-controlled account";
  await run("C1.5-A29", C15, "measure the channel: GET through the proxy to six base domains; POST harmless test JSON (and a 20 KB filler body) to https://api.github.com/graphql without any token",
    "a stated limit: requests and bodies leave through allowed hosts; no account, no token, nothing from this Mac", async () => {
      const curl = async (args: string) => {
        const r = await sh(`curl -sS -o /dev/null --max-time 20 -w '%{json}' ${args}`);
        try {
          const j = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
          return { http: j.http_code, up: j.size_upload, curlExit: j.exitcode };
        } catch {
          return { http: 0, up: 0, curlExit: r.code };
        }
      };
      const hosts: Record<string, unknown> = {};
      for (const h of ["api.anthropic.com", "github.com", "api.github.com", "registry.npmjs.org", "pypi.org", "raw.githubusercontent.com"]) hosts[h] = await curl(`https://${h}/`);
      const body = JSON.stringify({ query: "query { ressacBenchHarmlessTestText }" });
      const post = await curl(`-X POST -H 'content-type: application/json' --data '${body}' https://api.github.com/graphql`);
      const big = await curl(`-X POST -H 'content-type: application/json' --data "{\\"q\\":\\"$(head -c 20000 /dev/zero | tr '\\0' x)\\"}" https://api.github.com/graphql`);
      const left = (x: any) => x.http > 0;
      return { observed: { hosts, post, big20k: big }, verdict: left(post) || left(big) || Object.values(hosts).some(left) ? "LIMIT" : "HOLDS" };
    });

  // ======================= B2 — VM and container isolation =======================
  const C21 = "C2.1 the VM sees only the Ressac folder (rw) and the engine folder (ro), never the home folder";
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  await run("C2.1-B3", C21, "list the guest's virtiofs mounts (/proc/mounts)", "exactly the Ressac root (rw) and the engine folder (ro)", async () => {
    const r = guest("grep virtiofs /proc/mounts | cut -d' ' -f2,4");
    const mounts = r.stdout.trim().split("\n").filter(Boolean).map((l) => { const [p, o] = l.split(" "); return { path: p!, rw: o!.split(",")[0] }; });
    const got = new Map(mounts.map((m) => [real(m.path), m.rw]));
    return { observed: { mounts }, verdict: hold(mounts.length === 2 && got.get(real(root)) === "rw" && got.get(real(engineDir)) === "ro") };
  });
  const macHome = homedir();
  await run("C2.1-B1", C21, "from the guest: the Mac home's ~/.ssh, ~/Library, ~/.aws, ~/.zshrc, ~/.config, ~/Desktop, and everything under /Users",
    "none of the home's content exists; /Users holds only the folders leading to the engine mount", async () => {
      const r = guest(`for f in .ssh Library .aws .zshrc .config Desktop Documents; do [ -e "${macHome}/$f" ] && echo "present=$f"; done; find /Users -mindepth 1 -maxdepth 12 2>/dev/null | grep -v '^${real(engineDir)}/' ; echo end=1`);
      const present = r.stdout.split("\n").filter((l) => l.startsWith("present=")).map((l) => l.slice(8));
      const ancestors = new Set<string>();
      for (let p = real(engineDir); p !== "/"; p = p.slice(0, p.lastIndexOf("/")) || "/") ancestors.add(p);
      const docs = join(macHome, "Documents");
      const extra = r.stdout.split("\n").filter((l) => l.startsWith("/Users")).filter((p) => !ancestors.has(p));
      // Documents may only appear as a path step to the engine folder.
      const ok = present.every((f) => f === "Documents" && ancestors.has(docs)) && extra.length === 0 && kv(r.stdout).end === "1";
      return { observed: { present, entriesNotOnTheEnginePath: extra }, verdict: hold(ok) };
    });
  await run("C2.1-B2-B4", C21, "from the container as node: /Users, the Mac home paths, the container's mounts, and the engine folder",
    "/Users absent; no mount under /Users or of the engine; mounts are /workspace, its .ressac and logs, /home/node and the runtime's own", async () => {
      const o = await probe(`const m=fs.readFileSync('/proc/mounts','utf8').trim().split('\\n').map(l=>l.split(' ')[1]);
        return {users:fs.existsSync('/Users'),home:${JSON.stringify(["/.ssh", "/Library", "/.aws"].map((f) => macHome + f))}.filter(f=>fs.existsSync(f)),
        mounts:m.filter(p=>!/^\\/(proc|sys|dev)(\\/|$)/.test(p)&&!['/etc/hosts','/etc/hostname','/etc/resolv.conf','/run/.containerenv','/'].includes(p)),engine:fs.existsSync('/opt/ressac/engine')?fs.readdirSync('/opt/ressac/engine').length:'absent'}`);
      const expected = ["/workspace", "/workspace/.ressac", "/workspace/.ressac/logs", "/home/node"];
      const ok = !o.users && o.home.length === 0 && o.mounts.every((p: string) => expected.includes(p) || p.startsWith("/run/secrets") || p === "/dev/shm");
      return { observed: o, verdict: hold(ok) };
    });
  await run("C2.1-B8", C21, "write outside the intended places as node: /, /etc, /opt/ressac, /usr/local/bin, /usr/local/lib/node_modules; control: /workspace, /home/node, /tmp",
    "the first five refused (EACCES/EROFS), the three controls written", async () => {
      const o = await probe(`const o={};for(const d of ['/','/etc','/opt/ressac','/usr/local/bin','/usr/local/lib/node_modules','/workspace','/home/node','/tmp']){const f=d.replace(/\\/$/,'')+'/b1b2-probe';o[d]=errOf(()=>fs.writeFileSync(f,'x'));if(o[d]==='ok')fs.unlinkSync(f)}return o`);
      const ok = ["/", "/etc", "/opt/ressac", "/usr/local/bin", "/usr/local/lib/node_modules"].every((d) => o[d] !== "ok") && ["/workspace", "/home/node", "/tmp"].every((d) => o[d] === "ok");
      return { observed: o, verdict: hold(ok) };
    });

  const C22 = "C2.2 no ~/.ssh authorized and no SSH agent forwarded into the VM";
  await run("C2.2-B25-B26", C22, "guest: SSH_AUTH_SOCK, /tmp/ssh-* sockets, ssh-add -l; guest authorized_keys against the Mac's ~/.ssh/*.pub and Lima's own key; container: SSH_AUTH_SOCK",
    "no agent anywhere; the guest's authorized keys are Lima's own instance key only, none of the Mac's", async () => {
      const r = guest('echo "sock=${SSH_AUTH_SOCK:-}"; echo tmpssh=$(ls -d /tmp/ssh-* 2>/dev/null | wc -l); ssh-add -l >/dev/null 2>&1; echo sshadd=$?; cat ~/.ssh/authorized_keys 2>/dev/null | awk \'{print "key=" $2}\'');
      const keys = r.stdout.split("\n").filter((l) => l.startsWith("key=")).map((l) => l.slice(4).trim());
      const body = (f: string) => readFileSync(f, "utf8").trim().split(/\s+/)[1];
      const lima = readdirSync(join(home, "_config")).filter((f) => f.endsWith(".pub")).map((f) => body(join(home, "_config", f)));
      const sshDir = join(macHome, ".ssh");
      const macKeys = existsSync(sshDir) ? readdirSync(sshDir).filter((f) => f.endsWith(".pub")).map((f) => body(join(sshDir, f))) : [];
      const o = kv(r.stdout);
      const inContainer = await probe("return {sock:process.env.SSH_AUTH_SOCK||'',dotSsh:fs.existsSync('/home/node/.ssh')}");
      const observed = { guestSock: o.sock, guestTmpSsh: o.tmpssh, sshAddExit: o.sshadd, authorizedKeys: keys.length, allLimaOwn: keys.every((k) => lima.includes(k)), macKeysAuthorized: keys.filter((k) => macKeys.includes(k)).length, macPubKeysCompared: macKeys.length, container: inContainer };
      // ssh-add exit 2: no agent (127: no ssh-add in the guest at all) to talk to (1 would be an agent with no key, 0 an agent with keys).
      const ok = o.sock === "" && o.tmpssh === "0" && (o.sshadd === "2" || o.sshadd === "127") && keys.length > 0 && observed.allLimaOwn && observed.macKeysAuthorized === 0 && inContainer.sock === "" && !inContainer.dotSsh;
      return { observed, verdict: hold(ok) };
    });

  const C23 = "C2.3 Lima's SSH port listens on the Mac's localhost only; C2.4 the VM forwards only the Podman socket and the app ports on 127.0.0.1";
  const haPid = () => readFileSync(join(home, "ressac", "ha.pid"), "utf8").trim();
  /** Lima's own DNS server for the guest (« DNS listening on: 127.0.0.1:N », TCP and UDP): a host service, not a forward. */
  const limaDns = () => [...readFileSync(join(home, "ressac", "ha.stderr.log"), "utf8").matchAll(/DNS listening on: (127\.0\.0\.1:\d+)/g)].map((m) => m[1]!);
  const listeners = (pid: string, proto: "TCP" | "UDP") => sp("lsof", ["-nP", "-a", "-p", pid, `-i${proto}`, ...(proto === "TCP" ? ["-sTCP:LISTEN"] : []), "-Fn"]).stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  await run("C2.3-B27", C23, "Mac side: every TCP/UDP listener of this instance's Lima host agent and its SSH port; the rendered lima.yaml's SSH settings",
    "every listener on 127.0.0.1 (SSH included); loadDotSSHPubKeys false", async () => {
      // UDP: only unconnected sockets are listeners; « a->b » ones are the guest's own NAT'd traffic (NTP…), counted apart.
      const pid = haPid();
      const list = sp(tools.limactl, ["list", "--json", "ressac"]).stdout.trim();
      const sshPort = JSON.parse(list.split("\n")[0]!).sshLocalPort;
      const tcp = listeners(pid, "TCP"), udpAll = listeners(pid, "UDP"), udp = udpAll.filter((a) => !a.includes("->"));
      const sshListen = sp("lsof", ["-nP", `-iTCP:${sshPort}`, "-sTCP:LISTEN", "-Fn"]).stdout.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
      const yaml = readFileSync(join(home, "ressac", "lima.yaml"), "utf8");
      const observed = { sshLocalPort: sshPort, sshListeners: sshListen, hostAgentTcp: tcp.length, hostAgentTcpNotLoopback: tcp.filter((a) => !a.startsWith("127.0.0.1:")), hostAgentUdpListeners: udp, hostAgentUdpListenersNotLoopback: udp.filter((a) => !a.startsWith("127.0.0.1:")), guestOutboundUdpFlows: udpAll.length - udp.length, limaDns: limaDns(), loadDotSSHPubKeysFalse: /loadDotSSHPubKeys:\s*false/.test(yaml) };
      const ok = sshListen.length > 0 && sshListen.every((a) => a.startsWith("127.0.0.1:")) && observed.hostAgentTcpNotLoopback.length === 0 && observed.hostAgentUdpListenersNotLoopback.length === 0 && observed.loadDotSSHPubKeysFalse;
      return { observed, verdict: hold(ok) };
    });
  await run("C2.4-B28", C23, `a server in the workshop on ${first} (in range, 0.0.0.0), a container publishing 0.0.0.0:5400 and a guest process on 127.0.0.1:5401 (out of range), and guest UDP listeners on 5402 (out of range) and ${first + 1} (in range, recorded only)`,
    `the Mac's 127.0.0.1:${first} reaches the workshop; 5400, 5401 and UDP 5402 are not forwarded; the host agent's TCP listeners are all 127.0.0.1 ports in ${first}-${last}, its SSH port or Lima's own DNS`, async () => {
      pod(["exec", "-d", C, "node", "-e", `require('http').createServer((q,s)=>s.end('from-workshop')).listen(${first},'0.0.0.0')`]);
      const out = pod(["run", "-d", "--rm", "--name", "ressac-b1b2-out", "-p", "5400:5400", IMAGE, "node", "-e", "require('http').createServer((q,s)=>s.end('outside')).listen(5400,'0.0.0.0')"]);
      guest(`nohup nc -lk -s 127.0.0.1 -p 5401 -e echo outside >/dev/null 2>&1 & nohup nc -lu -p 5402 >/dev/null 2>&1 & nohup nc -lu -p ${first + 1} >/dev/null 2>&1 &`);
      const curl = (p: number) => sp("curl", ["-sS", "--max-time", "5", `http://127.0.0.1:${p}/`]);
      let inRange = curl(first);
      for (let i = 0; i < 30 && inRange.stdout !== "from-workshop"; i++) (await sleep(1000), (inRange = curl(first)));
      const guestUp = guest("netstat -ltnu").stdout;
      // Must-not-happen window: started once the in-range forward is up, Lima's port watcher having then seen the
      // listeners; 5 s more covers its next polls.
      await sleep(5000);
      const macHeld = (p: number, proto = "TCP") => sp("lsof", ["-nP", `-i${proto}:${p}`, ...(proto === "TCP" ? ["-sTCP:LISTEN"] : []), "-t"]).stdout.trim();
      const tcp = listeners(haPid(), "TCP");
      const sshPort = JSON.parse(sp(tools.limactl, ["list", "--json", "ressac"]).stdout.trim().split("\n")[0]!).sshLocalPort;
      const stray = tcp.filter((a) => { const m = /^127\.0\.0\.1:(\d+)$/.exec(a); const p = m ? Number(m[1]) : -1; return !(p === sshPort || (p >= first && p <= last) || limaDns().includes(a)); });
      const observed = {
        inRange: inRange.stdout, probesUp: out.code === 0 && /:5400\b/.test(guestUp) && /127\.0\.0\.1:5401\b/.test(guestUp) && /:5402\b/.test(guestUp),
        mac5400: macHeld(5400) ? "listening" : "free", mac5401: macHeld(5401) ? "listening" : "free", macUdp5402: macHeld(5402, "UDP") ? "listening" : "free", macUdpInRange: macHeld(first + 1, "UDP") ? "listening" : "free",
        curl5400: curl(5400).stdout, curl5401: curl(5401).stdout, hostAgentTcpOutsideRange: stray,
        podmanSocketOnMac: existsSync(join(home, "ressac", "sock", "podman.sock")),
      };
      pod(["rm", "-f", "ressac-b1b2-out"]);
      guest("pkill -f 'nc -l' ; true");
      if (observed.inRange !== "from-workshop" || !observed.probesUp) return { observed, verdict: "NOT_TESTED" };
      const ok = observed.mac5400 === "free" && observed.mac5401 === "free" && observed.macUdp5402 === "free" && !observed.curl5400.includes("outside") && !observed.curl5401.includes("outside") && stray.length === 0;
      return { observed, verdict: hold(ok) };
    });

  const C25 = "C2.5 the container has no new privileges and its limits (memory, pids)";
  await run("C2.5-B12-B15", C25, "podman inspect of the workshop; as node: capability sets, iptables, raising pids.max/memory.max, a child cgroup, /proc/sysrq-trigger, /proc/sys writes",
    "PidsLimit 1024, memory cap set, no-new-privileges, CapDrop ALL; node's caps all 0; every write and iptables refused", async () => {
      const hc = JSON.parse(pod(["inspect", "-f", "{{json .HostConfig}}", C]).stdout);
      const r = await sh(`grep -E '^(CapEff|CapPrm|CapBnd|CapAmb|CapInh):' /proc/self/status | sed 's/:[[:space:]]*/=/'
iptables -S >/dev/null 2>&1; echo iptables=$?
echo 4096 > /sys/fs/cgroup/pids.max 2>/dev/null; echo pidsmax=$?
echo max > /sys/fs/cgroup/memory.max 2>/dev/null; echo memmax=$?
mkdir /sys/fs/cgroup/b1b2 2>/dev/null; echo cgchild=$?
echo h > /proc/sysrq-trigger 2>/dev/null; echo sysrq=$?
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null; echo procsys=$?
echo pidsmaxnow=$(cat /sys/fs/cgroup/pids.max)`);
      const o = kv(r.stdout);
      const caps = ["CapEff", "CapPrm", "CapBnd", "CapAmb", "CapInh"].every((k) => /^0+$/.test(o[k] ?? "x"));
      const writes = ["iptables", "pidsmax", "memmax", "cgchild", "sysrq", "procsys"].every((k) => o[k] !== undefined && o[k] !== "0");
      const insp = { PidsLimit: hc.PidsLimit, Memory: hc.Memory, SecurityOpt: hc.SecurityOpt, CapDrop: hc.CapDrop, Privileged: hc.Privileged };
      const flags = hc.PidsLimit === 1024 && hc.Memory > 0 && (hc.SecurityOpt ?? []).some((s: string) => s.startsWith("no-new-privileges")) && !hc.Privileged;
      return { observed: { inspect: insp, node: o }, verdict: hold(caps && writes && flags && o.pidsmaxnow === "1024") };
    });
  await run("C2.5-B16", C25, "unprivileged user namespace: unshare -Urm as node, then remount /workspace/.ressac rw, write in it, mknod, /proc/1/root, iptables; after exit, write .ressac again",
    "inside the namespace every step refused; .ressac still read-only after", async () => {
      const r = await sh(`unshare -Urm sh -c 'echo nsuid=$(id -u); mount -o remount,rw,bind /workspace/.ressac 2>/dev/null; echo remount=$?; echo x > /workspace/.ressac/b1b2 2>/dev/null; echo write=$?; mknod /tmp/b1b2-mem c 1 1 2>/dev/null; echo mknod=$?; ls /proc/1/root/ >/dev/null 2>&1; echo proc1root=$?; iptables -S >/dev/null 2>&1; echo iptables=$?'; echo unshare=$?
echo x > /workspace/.ressac/b1b2 2>/dev/null; echo after=$?`);
      const o = kv(r.stdout);
      const inside = o.unshare !== "0" || ["remount", "write", "mknod", "proc1root", "iptables"].every((k) => o[k] !== undefined && o[k] !== "0");
      return { observed: o, verdict: o.after === undefined ? "NOT_TESTED" : hold(inside && o.after !== "0") };
    });
  await run("C2.5-B17-B18", C25, "devices and the PID namespace as node: /dev/mem, /dev/kmsg, block devices; the processes visible, PID 1",
    "no such device; only the container's own processes (no conmon, podman, lima, sshd, systemd); PID 1 is `sleep infinity`", async () => {
      const o = await probe(`const dev=fs.readdirSync('/dev').filter(n=>/^(mem|kmem|kmsg|port|sd|vd|nvme|loop|disk)/.test(n));
        const cmd=p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').join(' ').trim()}catch{return ''}};
        const procs=fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)&&n!==String(process.pid)).map(cmd).filter(Boolean);
        return {dev,pid1:cmd(1),procs,foreign:procs.filter(c=>['conmon','podman','limactl','lima-guestagent','sshd','containerd','systemd','init','catatonit','netavark','aardvark-dns'].includes(c.split(' ')[0].split('/').pop()))}`);
      // Every visible process is the container's own: PID 1, this probe (left out) and what the bench started.
      return { observed: o, verdict: hold(o.dev.length === 0 && o.pid1 === "sleep infinity" && o.foreign.length === 0) };
    });

  await run("C2.6-B30", "C2.6 IPv6 off in the container", "as node: disable_ipv6, /proc/net/if_inet6, listen on ::1, connect to [2606:4700:4700::1111]:443",
    "disable_ipv6 = 1, no inet6 address, listen and connect refused", async () => {
      const o = await probe(`const rd=f=>{try{return fs.readFileSync(f,'utf8').trim()}catch(e){return e.code}};
        const l=await new Promise(r=>{const s=net.createServer().on('error',e=>r(e.code)).listen(0,'::1',()=>{s.close();r('listening')})});
        return {disable:rd('/proc/sys/net/ipv6/conf/all/disable_ipv6'),inet6:rd('/proc/net/if_inet6'),listen:l,connect:await tcp('2606:4700:4700::1111',443)}`);
      const ok = o.disable === "1" && (o.inet6 === "" || o.inet6 === "ENOENT") && o.listen !== "listening" && !reached(o.connect);
      return { observed: o, verdict: hold(ok) };
    });

  const C28 = "C2.8 base image pinned by digest; Claude Code and Codex root-owned; autoupdater off";
  await run("C2.8-B19-B21", C28, "as node: overwrite the claude and codex entry points (through their links), write the npm global folder, rewrite the managed settings; the container's env; the Dockerfile's FROM; the running image's label",
    "every write refused, all files root-owned (managed files 644), DISABLE_AUTOUPDATER=1 and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 set, FROM pinned @sha256, image label = the repo's dockerfileHash", async () => {
      const o = await probe(`const o={};for(const b of ['/usr/local/bin/claude','/usr/local/bin/codex']){const t=fs.realpathSync(b);o[b]={owner:fs.statSync(t).uid,write:errOf(()=>fs.appendFileSync(t,'')),unlink:errOf(()=>fs.unlinkSync(b)),dir:errOf(()=>fs.writeFileSync(require('path').dirname(t)+'/b1b2','x'))}}
        o.npmGlobal=errOf(()=>fs.mkdirSync('/usr/local/lib/node_modules/b1b2'));
        for(const f of ['/etc/claude-code/managed-settings.json','/etc/codex/requirements.toml']){const st=fs.statSync(f);o[f]={owner:st.uid,mode:(st.mode&0o777).toString(8),write:errOf(()=>fs.appendFileSync(f,''))}}
        o.env={DISABLE_AUTOUPDATER:process.env.DISABLE_AUTOUPDATER,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC};return o`);
      const from = readFileSync(join(DEFAULT_DOCKER_FOLDER, "workshop.Dockerfile"), "utf8").split("\n").filter((l) => /^FROM\s/i.test(l));
      const pinned = from.length > 0 && from.every((l) => /@sha256:[0-9a-f]{64}(\s|$)/.test(l));
      const bins = ["/usr/local/bin/claude", "/usr/local/bin/codex"].every((b) => o[b].owner === 0 && o[b].write !== "ok" && o[b].unlink !== "ok" && o[b].dir !== "ok");
      const managed = ["/etc/claude-code/managed-settings.json", "/etc/codex/requirements.toml"].every((f) => o[f].owner === 0 && o[f].mode === "644" && o[f].write !== "ok");
      const envOk = o.env.DISABLE_AUTOUPDATER === "1" && o.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1";
      return { observed: { ...o, dockerfileFrom: from, imageLabel: hash, dockerfileHash: dockerfileHash() }, verdict: hold(bins && managed && o.npmGlobal !== "ok" && envOk && pinned && hash === dockerfileHash()) };
    });

  const C210 = "C2.10 .ressac read-only except logs; planted symlinks removed before each mount";
  await run("C2.10-B9-B10", C210, "as node: write, mkdir and symlink in /workspace/.ressac, rename and rmdir the mount point; control: write in .ressac/logs",
    "every change refused (EROFS / EBUSY); logs writable", async () => {
      const o = await probe(`const o={write:errOf(()=>fs.writeFileSync('/workspace/.ressac/b1b2','x')),mkdir:errOf(()=>fs.mkdirSync('/workspace/.ressac/b1b2d')),symlink:errOf(()=>fs.symlinkSync('/etc','/workspace/.ressac/b1b2l')),
        rename:errOf(()=>fs.renameSync('/workspace/.ressac','/workspace/b1b2-moved')),rmdir:errOf(()=>fs.rmdirSync('/workspace/.ressac')),logs:errOf(()=>{fs.writeFileSync('/workspace/.ressac/logs/b1b2','x');fs.unlinkSync('/workspace/.ressac/logs/b1b2')})};return o`);
      const ok = ["write", "mkdir", "symlink"].every((k) => o[k] === "EROFS") && o.rename !== "ok" && o.rmdir !== "ok" && o.logs === "ok";
      return { observed: o, verdict: hold(ok) };
    });

  await run("C2.11-B5-B6", "C2.11 kernel reads in the workspace refuse links the agent planted", "as node, in a widget folder: widget.mjs → /etc/passwd, a link to /etc, a regular file; a widget folder that is itself a link to /etc; a hard link of a guest file into /workspace; then the kernel's stageHarvest on both folders",
    "the staged copy holds only the regular file, no byte of the Mac's /etc/passwd; the linked folder refused; the hard link fails (EXDEV)", async () => {
      const r = await sh("mkdir -p /workspace/home/widgets/probe && cd /workspace/home/widgets/probe && echo 'export default 1' > ok.mjs && ln -sf /etc/passwd widget.mjs && ln -sfn /etc etc-dir && ln -sfn /etc /workspace/home/widgets/evil && echo planted=1; ln /etc/hostname /workspace/b1b2-hard 2>/dev/null; echo hard=$?");
      const p = kv(r.stdout);
      const staged = await workshop.stageHarvest("probe", join(root, "home", "widgets", "probe"));
      const files = readdirSync(staged);
      const leaked = files.some((f) => /:0:0:/.test(readFileSync(join(staged, f), "utf8")));
      const evil = await workshop.stageHarvest("evil", join(root, "home", "widgets", "evil")).then((s) => `staged ${readdirSync(s).length} files`, (e) => `refused: ${String((e as Error).message).slice(0, 80)}`);
      const observed = { planted: p.planted, hardLinkExit: p.hard, staged: files, passwdBytes: leaked, linkedFolder: evil };
      return { observed, verdict: p.planted !== "1" ? "NOT_TESTED" : hold(JSON.stringify(files) === '["ok.mjs"]' && !leaked && evil.startsWith("refused") && p.hard !== "0") };
    });

  await run("C2.7-B31", "C2.7 every agent process killed when a conversation opens", "as node, start `setsid env -i sleep 300` (new session, empty env) and a plain sleep, then the kernel's stopAgentProcesses",
    "no process of uid 1000 left but PID 1 (the documented limit: an app the user launches afterwards runs as the same user)", async () => {
      pod(["exec", "-d", "-u", "node", C, "setsid", "env", "-i", "sleep", "300"]);
      pod(["exec", "-d", "-u", "node", C, "sleep", "301"]);
      // uid 1000's processes but PID 1 (the container's `sleep infinity`, the image's user too, spared by design).
      const list = () => pod(["exec", "-u", "root", C, "sh", "-c", "for d in /proc/[0-9]*; do p=${d#/proc/}; [ $p = 1 ] && continue; grep -q '^Uid:[[:space:]]*1000[[:space:]]' $d/status 2>/dev/null && echo \"$(tr '\\0' ' ' < $d/cmdline)\"; done"]).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const count = () => list().length;
      let before = count();
      for (let i = 0; i < 10 && before < 2; i++) (await sleep(500), (before = count()));
      await workshop.stopAgentProcesses();
      let after = count();
      for (let i = 0; i < 10 && after > 0; i++) (await sleep(500), (after = count()));
      return { observed: { nodeProcessesBefore: before, after, left: list() }, verdict: before < 2 ? "NOT_TESTED" : hold(after === 0) };
    });

  const C14 = "C1.4 the rules are applied again before each session, which does not start unless a direct connection is refused";
  await run("C1.4-A25", C14, "workshop.restart() (container stop + start: iptables rules are lost), then the rules in place and a direct curl from node through workshop.exec",
    "rules back (REJECT in OUTPUT) and the direct curl exits 7 (refused)", async () => {
      await workshop.restart();
      const rules = pod(["exec", "--privileged", "-u", "root", C, "iptables", "-S", "OUTPUT"]).stdout.split("\n").filter((l) => /REJECT/.test(l)).length;
      const d = await workshop.exec(["curl", "-s", "-o", "/dev/null", "--noproxy", "*", "--max-time", "5", "https://1.1.1.1"]);
      return { observed: { rejectRules: rules, directCurlExit: d.code }, verdict: hold(rules >= 3 && d.code === 7) };
    });
  await run("C1.4-A28", C14, "fool the probe: as root, move curl away so the post-apply probe cannot return 7; then secureNetwork() (what a session runs) and workshop.exec; then restore curl",
    "secureNetwork rejects and exec refuses to run while the probe is not 7; both work again once curl is back", async () => {
      const bin = pod(["exec", "-u", "root", C, "sh", "-c", "command -v curl"]).stdout.trim();
      if (!bin) throw new Error("no curl in the image");
      pod(["exec", "-u", "root", C, "mv", bin, `${bin}.b1b2-off`]);
      const sec = await workshop.secureNetwork().then(() => "applied", (e) => `rejected: ${String((e as Error).message).slice(0, 120)}`);
      const ex = await workshop.exec(["id", "-u"]).then((r) => `ran (code ${r.code})`, (e) => `refused: ${String((e as Error).message).slice(0, 120)}`);
      pod(["exec", "-u", "root", C, "mv", `${bin}.b1b2-off`, bin]);
      const back = await workshop.secureNetwork().then(() => "applied", (e) => `rejected: ${String(e)}`);
      const exBack = await workshop.exec(["id", "-u"]).then((r) => r.stdout.trim(), (e) => `refused: ${String(e)}`);
      return { observed: { probeBroken: { secureNetwork: sec, exec: ex }, restored: { secureNetwork: back, exec: exBack } }, verdict: back !== "applied" ? "NOT_TESTED" : hold(sec.startsWith("rejected") && ex.startsWith("refused") && exBack === "1000") };
    });

  await run("C2.10-B7", C210, "Mac side, container removed (as after a rebuild): plant .ressac/evil → a decoy folder, then the whole .ressac → the decoy; each time the kernel's ensureStarted (realInternal before the mount)",
    "the inner link removed; the outer link replaced by a real folder; the decoy untouched; .ressac read-only in the new container", async () => {
      const decoy = join(root, "b1b2-decoy");
      mkdirSync(decoy, { recursive: true });
      writeFileSync(join(decoy, "keep"), "decoy");
      pod(["rm", "-f", C]);
      symlinkSync(decoy, join(paths.internal, "b1b2-evil"));
      await workshop.ensureStarted();
      const inner = lstatSync(join(paths.internal, "b1b2-evil"), { throwIfNoEntry: false }) !== undefined;
      pod(["rm", "-f", C]);
      rmSync(paths.internal, { recursive: true, force: true });
      symlinkSync(decoy, paths.internal);
      await workshop.ensureStarted();
      const st = lstatSync(paths.internal);
      const ro = await probe("return errOf(()=>fs.writeFileSync('/workspace/.ressac/b1b2','x'))");
      const observed = { innerLinkLeft: inner, ressacIsRealFolder: st.isDirectory() && !st.isSymbolicLink(), decoy: readdirSync(decoy), writeInRessac: ro };
      return { observed, verdict: hold(!inner && observed.ressacIsRealFolder && JSON.stringify(observed.decoy) === '["keep"]' && ro === "EROFS") };
    });

  await run("C2.9-B33", "C2.9 the VM image is pinned by SHA-256", "the run's image is machine.ts's VM_IMAGE (no override), fetched and checked by the kernel's own install; then a second machine (own LIMA_HOME) fed a file whose bytes do not match the pinned SHA-256",
    "the run used the pinned url + sha256; the mismatched file is refused before any instance exists", async () => {
      const bad = join(home, "..", "b1b2-bad");
      mkdirSync(bad, { recursive: true });
      const file = join(bad, "ressac-vm-b1b2bad.raw.zst");
      writeFileSync(file, "not the pinned image\n");
      const m2 = createMachine({ ...tools, home: join(bad, "l"), engine: engineDir, ressacRoot: root, busy: async () => true, image: { ...VM_IMAGE, version: "b1b2bad", url: `file://${file}` } });
      const refused = await m2.install().then(() => "installed", (e) => `refused: ${String((e as Error).message).slice(0, 160)}`);
      const left = spawnSync(tools.limactl, ["list", "-q"], { encoding: "utf8", env: { ...process.env, LIMA_HOME: join(bad, "l") } }).stdout.trim();
      rmSync(bad, { recursive: true, force: true });
      const observed = { pinned: { url: VM_IMAGE.url, sha256: VM_IMAGE.sha256 }, usedPinned: JSON.stringify(vmImage()) === JSON.stringify(VM_IMAGE), statesSeen: [...seen], mismatched: refused, instancesInBadHome: left };
      // A reused instance (B1B2_KEEP) downloads nothing: the pinned fetch was then not exercised by this run.
      if (!seen.has("downloading")) return { observed, verdict: "NOT_TESTED" };
      return { observed, verdict: hold(observed.usedPinned && refused.startsWith("refused") && left === "") };
    });

  emit("C2.12-B32", "C2.12 (limit, Docker fallback) Docker Desktop shares /Users, so an escape reaches further", "run the workshop on a local Docker engine and compare mounts and flags",
    "same container and flags; /Users shared by the engine's VM (the stated limit)",
    { docker: sp("docker", ["info", "--format", "{{.ServerVersion}}"], undefined, 20_000).code === 0 ? "an engine answers, but this runner does not drive the Docker path" : "no Docker engine running on the bench Mac" }, "NOT_TESTED");
  ok = true;
} catch (e) {
  log("stopped:", (e as Error).stack ?? e);
} finally {
  relay.close();
  other.close();
  await machine.stop().catch(() => {});
  log(`tally ${JSON.stringify(tally)}`);
}
process.exit(ok ? (tally.BYPASS ? 1 : 0) : 2);
