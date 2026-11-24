// Runs as root inside the workshop image, with plain Node (node: built-ins only).
// `apply` locks the container's outbound network down for user `node`; `proxy` is the allowlist CONNECT proxy.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOMAINS_FILE = "/etc/ressac/domains.json";
// Written once the tunnels opened before a lock are dead: until it holds the locked list, every locked apply kills them.
const LOCKED_APPLIED = "/etc/ressac/locked-applied";
const PROXY_PORT = 3128;
const PROXY_USER = "ressac-proxy";

// The model and sign-in domains: all the container keeps while the workspace is locked after a reveal. Measured
// (spike, 2026-11-23): a Claude subscription session reached api.anthropic.com only; platform.claude.com (token refresh) and
// Codex's ChatGPT login hosts are kept unmeasured. Ollama and the compatible APIs go through the Mac's relay port.
// shortcut: the relayed engines answered with an empty list; they still get this one, give them none if a lock ever needs it.
export const MODEL_DOMAINS = ["api.anthropic.com", "platform.claude.com", "auth.openai.com", "chatgpt.com"];

// Unlocked only: sign-in pages and telemetry the engines use when nothing was revealed.
export const BASE_DOMAINS = [
  ...MODEL_DOMAINS, "claude.ai", "console.anthropic.com", "statsig.anthropic.com", "api.openai.com",
  "registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org", "pypi.org", "files.pythonhosted.org",
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
  "raw.githubusercontent.com", "release-assets.githubusercontent.com",
];

// Same syntax as the kernel's validator (a unit test keeps both in agreement).
export function validDomain(d) {
  if (typeof d !== "string" || d.length === 0 || d.length > 253) return false;
  const name = d.startsWith("*.") ? d.slice(2) : d;
  const labels = name.split(".");
  return labels.length >= 2 && labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l) && l.length <= 63) && !/^[0-9.]+$/.test(name);
}

/** What `apply` writes to domains.json: locked, the model domains only; else the base list and the user's valid domains. */
export function domainList({ domains, locked }) {
  if (typeof locked !== "boolean") throw new Error("invalid locked");
  return locked ? [...MODEL_DOMAINS] : [...new Set([...BASE_DOMAINS, ...domains.filter(validDomain)])];
}

export function allowed(host, domains) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return domains.some((d) => (d.startsWith("*.") ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d));
}

export function rules({ mac, ports }) {
  return [
    "*filter",
    ":INPUT ACCEPT [0:0]",
    ":FORWARD ACCEPT [0:0]",
    ":OUTPUT ACCEPT [0:0]",
    "-A OUTPUT -o lo -j ACCEPT",
    "-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    `-A OUTPUT -m owner --uid-owner ${PROXY_USER} -j ACCEPT`,
    "-A OUTPUT -m owner --uid-owner root -j ACCEPT",
    ...ports.map((p) => `-A OUTPUT -d ${mac}/32 -p tcp --dport ${p} -j ACCEPT`),
    "-A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable",
    "-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset",
    "-A OUTPUT -j REJECT",
    "COMMIT",
    "",
  ].join("\n");
}

const refusal = (host) => `Ressac: ${host} is not in the agent's allowed domains (Settings › Agent)`;
const localRefusal = (host) => `Ressac: ${host} resolves to a local or private address, which the agent never reaches`;

const LOCAL = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]]) LOCAL.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]]) LOCAL.addSubnet(a, p, "ipv6");

/** A private, loopback or link-local address (an IPv4-mapped IPv6 one judged as IPv4). */
export function localAddress(address, family) {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4) return LOCAL.check(v4[1], "ipv4");
  return LOCAL.check(address, family === 6 || family === "IPv6" ? "ipv6" : "ipv4");
}

/**
 * The proxy's resolution: an allowed name whose DNS an attacker controls (under a `*.` domain the user added) must not
 * lead to the Mac, the router or the local network. The checked address is the one connected to.
 */
const guardedLookup = (host, opts, cb) =>
  dnsLookup(host, opts, (err, address, family) => {
    if (err) return cb(err, address, family);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((a) => localAddress(a.address, a.family))) return cb(Object.assign(new Error(`${host}: local address`), { code: "ERESSACLOCAL" }));
    cb(null, address, family);
  });

/** `getDomains` is called per request so a changed list applies to new connections. `opts` exists for tests only. */
export function createProxy(getDomains, { ports = [443, 80], httpPort = 80, localOk = false } = {}) {
  const lookup = localOk ? undefined : guardedLookup;
  const server = http.createServer((req, res) => {
    req.on("error", () => res.destroy());
    res.on("error", () => {});
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "http:" || Number(url.port || 80) !== httpPort || !allowed(url.hostname, getDomains())) {
      res.writeHead(403, { "content-type": "text/plain" }).end(refusal(url?.hostname ?? "?"));
      return;
    }
    const headers = { ...req.headers, host: url.host };
    delete headers["proxy-connection"];
    const fail = (e) => (res.headersSent ? res.destroy() : e?.code === "ERESSACLOCAL" ? res.writeHead(403, { "content-type": "text/plain" }).end(localRefusal(url.hostname)) : res.writeHead(502).end());
    const out = http.request({ host: url.hostname, port: httpPort, method: req.method, path: url.pathname + url.search, headers, agent: new http.Agent(), ...(lookup ? { lookup } : {}) }, (r) => {
      r.on("error", () => res.destroy());
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    out.on("error", fail);
    req.pipe(out);
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("connect", (req, client, head) => {
    client.on("error", () => client.destroy());
    const m = /^([^:]+):(\d+)$/.exec(req.url ?? "");
    const port = m ? Number(m[2]) : 0;
    if (!m || !ports.includes(port) || !allowed(m[1], getDomains())) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${refusal(m ? m[1] : "?")}`);
      return;
    }
    // The proxy resolves the name itself: a client-side resolution never picks the destination.
    const host = m[1].replace(/\.$/, "");
    const upstream = net.connect({ port, host, ...(lookup ? { lookup } : {}) }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (e) => (e.code === "ERESSACLOCAL" ? client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${localRefusal(host)}`) : client.destroy()));
    client.on("close", () => upstream.destroy());
  });
  return server;
}

function fileDomains() {
  let mtime = 0;
  let cached = BASE_DOMAINS;
  return () => {
    try {
      const m = statSync(DOMAINS_FILE).mtimeMs;
      if (m !== mtime) {
        cached = JSON.parse(readFileSync(DOMAINS_FILE, "utf8")).filter((d) => typeof d === "string");
        mtime = m;
      }
    } catch {}
    return cached;
  };
}

/** The processes of user `uid` (numeric names under `proc`). */
export function pidsOf(uid, proc = "/proc") {
  return readdirSync(proc).filter((n) => /^\d+$/.test(n) && statSync(`${proc}/${n}`, { throwIfNoEntry: false })?.uid === uid);
}

/**
 * A locked apply: kills the proxy (and every tunnel it holds) unless `marker` already says this locked list was applied
 * with the kill done. The marker is written last: an apply that dies before it kills again next time. True when it killed.
 */
export async function cutTunnels(list, { marker = LOCKED_APPLIED, kill, stillListening }) {
  const done = JSON.stringify(list);
  let current = null;
  try {
    current = readFileSync(marker, "utf8");
  } catch {}
  if (current === done) return false;
  kill();
  for (let i = 0; i < 50 && (await stillListening()); i++) await new Promise((r) => setTimeout(r, 100));
  if (await stillListening()) throw new Error("proxy did not stop");
  writeFileSync(`${marker}.tmp`, done);
  renameSync(`${marker}.tmp`, marker);
  return true;
}

// Any listener on 3128 is safe to reuse: iptables only lets uid ressac-proxy (and root) out, so a rogue one cannot reach the network.
const listening = () =>
  new Promise((resolve) => {
    const s = net.connect(PROXY_PORT, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });

async function apply() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { ports, domains, locked } = JSON.parse(input);
  if (!Array.isArray(ports) || !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error("invalid ports");
  if (!Array.isArray(domains) || domains.length > 100) throw new Error("invalid domains");
  const list = domainList({ domains, locked });
  for (const d of domains) if (!validDomain(d)) process.stderr.write(`ressac-network: dropped invalid domain ${JSON.stringify(d)}\n`);
  const { address } = await dns.lookup("host.docker.internal", { family: 4 });
  mkdirSync("/etc/ressac", { recursive: true });
  writeFileSync(`${DOMAINS_FILE}.tmp`, JSON.stringify(list));
  chmodSync(`${DOMAINS_FILE}.tmp`, 0o644);
  renameSync(`${DOMAINS_FILE}.tmp`, DOMAINS_FILE);
  execFileSync("iptables-restore", [], { input: rules({ mac: address, ports }) });
  // A tunnel opened before the lock (to a code domain, a user domain) would outlive the cut: the proxy dies with them all.
  if (locked) {
    const uid = Number(execFileSync("id", ["-u", PROXY_USER]).toString());
    const kill = () => {
      for (const pid of pidsOf(uid)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
      }
    };
    await cutTunnels(list, { kill, stillListening: listening });
  } else rmSync(LOCKED_APPLIED, { force: true });
  if (!(await listening())) {
    const id = (flag) => Number(execFileSync("id", [flag, PROXY_USER]).toString());
    spawn(process.execPath, [process.argv[1], "proxy"], { uid: id("-u"), gid: id("-g"), detached: true, stdio: "ignore", env: { PATH: process.env.PATH } }).unref();
    for (let i = 0; i < 50 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await listening())) throw new Error("proxy did not start");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "proxy") {
    process.on("uncaughtException", (e) => console.error(e));
    createProxy(fileDomains()).listen(PROXY_PORT, "127.0.0.1");
  } else if (process.argv[2] === "apply") {
    apply().catch((e) => {
      process.stderr.write(`ressac-network: ${e.message}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write("usage: ressac-network.mjs apply|proxy\n");
    process.exit(2);
  }
}
