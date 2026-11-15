// Runs as root inside the workshop image, with plain Node (node: built-ins only).
// `apply` locks the container's outbound network down for user `node`; `proxy` is the allowlist CONNECT proxy.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, chmodSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOMAINS_FILE = "/etc/ressac/domains.json";
const PROXY_PORT = 3128;
const PROXY_USER = "ressac-proxy";

export const BASE_DOMAINS = [
  "api.anthropic.com", "claude.ai", "platform.claude.com", "console.anthropic.com", "statsig.anthropic.com",
  "api.openai.com", "auth.openai.com", "chatgpt.com",
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

/** `getDomains` is called per request so a changed list applies to new connections. `opts` exists for tests only. */
export function createProxy(getDomains, { ports = [443, 80], httpPort = 80 } = {}) {
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
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const fail = () => (res.headersSent ? res.destroy() : res.writeHead(502).end());
    const out = http.request({ host: url.hostname, port: httpPort, method: req.method, path: url.pathname + url.search, headers }, (r) => {
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
    const upstream = net.connect(port, m[1].replace(/\.$/, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
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
  const { ports, domains } = JSON.parse(input);
  if (!Array.isArray(ports) || !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new Error("invalid ports");
  if (!Array.isArray(domains) || domains.length > 100) throw new Error("invalid domains");
  const user = domains.filter(validDomain);
  for (const d of domains) if (!validDomain(d)) process.stderr.write(`ressac-network: dropped invalid domain ${JSON.stringify(d)}\n`);
  const { address } = await dns.lookup("host.docker.internal", { family: 4 });
  mkdirSync("/etc/ressac", { recursive: true });
  writeFileSync(`${DOMAINS_FILE}.tmp`, JSON.stringify([...new Set([...BASE_DOMAINS, ...user])]));
  chmodSync(`${DOMAINS_FILE}.tmp`, 0o644);
  renameSync(`${DOMAINS_FILE}.tmp`, DOMAINS_FILE);
  execFileSync("iptables-restore", [], { input: rules({ mac: address, ports }) });
  if (!(await listening())) {
    const id = (flag) => Number(execFileSync("id", [flag, PROXY_USER]).toString());
    spawn(process.execPath, [process.argv[1], "proxy"], { uid: id("-u"), gid: id("-g"), detached: true, stdio: "ignore" }).unref();
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
