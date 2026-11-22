// B7 C7.10: the external design-mode server, the real one on a free port, raw requests.
import net from "node:net";
import os from "node:os";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "../../../../packages/kernel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../../../../packages/kernel/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { ExternalRegistry } from "../../../../packages/kernel/src/design/external.ts";
import { Remarks } from "../../../../packages/kernel/src/design/remarks.ts";
import { startExternalServer } from "../../../../packages/kernel/src/design/external-server.ts";

const rows: { id: string; input: string; outcome: string }[] = [];
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } });

/** One raw HTTP/1.1 request; returns the status line (or the socket error). */
function raw(host: string, port: number, head: string[], body = ""): Promise<string> {
  return new Promise((ok) => {
    const c = net.connect({ host, port, timeout: 3000 });
    let data = "";
    c.on("connect", () => c.write([...head, ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), "Connection: close", "", body].join("\r\n")));
    c.on("data", (d) => { data += d; if (data.includes("\r\n")) { ok(data.split("\r\n")[0]!); c.destroy(); } });
    c.on("error", (e: any) => ok(`socket error ${e.code}`));
    c.on("timeout", () => { ok("timeout"); c.destroy(); });
    c.on("close", () => ok(data.split("\r\n")[0] || "closed without answer"));
  });
}

test("design server", async () => {
  const base = realpathSync(await mkdtemp(join(os.tmpdir(), "b7-design-")));
  const home = join(base, "home"), spaceRoot = join(base, "Ressac");
  await mkdir(join(home, "projA"), { recursive: true });
  await mkdir(join(home, "projB"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  await symlink(join(home, "projA"), join(home, "linkA"));
  const registry = await ExternalRegistry.open(join(base, "design"));
  const remarks = new Remarks({ folders: { spaceRemarks: join(spaceRoot, ".ressac/remarks"), private: join(base, "design") } });
  const options = { ranges: [[5300, 5319]] as [number, number][], spaceRoot, home };
  const server = await startExternalServer({ registry, remarks, port: 0, declare: async (client, d) => ({ project: (await registry.declare(client.id, d, options)).project }) });
  const P = server.port;
  const A = await registry.connect("A");
  const B = await registry.connect("B");
  const H = `Host: 127.0.0.1:${P}`;
  const AUTH = `Authorization: Bearer ${A.token}`;
  const post = ["POST /mcp-external HTTP/1.1"];
  const std = ["Content-Type: application/json", "Accept: application/json, text/event-stream"];
  const row = async (id: string, input: string, head: string[], body = INIT, host = "127.0.0.1") => rows.push({ id, input, outcome: await raw(host, P, head, body) });

  await row("J0", "control: valid token, valid Host, no Origin", [...post, H, AUTH, ...std]);

  // J1 where it listens
  const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal).map((a) => a!.address);
  for (const a of ["::1", ...lan.slice(0, 3)]) rows.push({ id: "J1", input: `connect to ${a.includes(":") && a !== "::1" ? "<mac-v6>" : a.startsWith("192.") ? "<lan-v4>" : a}`, outcome: await raw(a, P, [...post, H, AUTH, ...std], INIT) });

  // J2 Origin, with a valid token and Host
  for (const o of ["https://evil.example", "null", "", `http://127.0.0.1:${P}`, "http://localhost", "moz-extension://abc"]) await row("J2", `Origin: ${JSON.stringify(o)} + valid token`, [...post, H, AUTH, `Origin: ${o}`, ...std]);
  await row("J2", "lowercase header name origin:", [...post, H, AUTH, "origin: https://evil.example", ...std]);

  // J3 Host
  for (const h of ["evil.example", `evil.example:${P}`, "127.0.0.1", `127.0.0.1:${P + 1}`, `LOCALHOST:${P}`, `localhost:${P}`, `127.0.0.1:${P}.`, `[::1]:${P}`, `127.0.0.1.nip.io:${P}`, `127.0.0.1:${P}@evil.example`, `2130706433:${P}`, ` 127.0.0.1:${P}`])
    await row("J3", `Host: ${h.replace(String(P), "<port>").replace(String(P + 1), "<port+1>")} + valid token`, [...post, `Host: ${h}`, AUTH, ...std]);
  await row("J3", "no Host header (HTTP/1.1)", [...post, AUTH, ...std]);
  await row("J3", "no Host header (HTTP/1.0)", ["POST /mcp-external HTTP/1.0", AUTH, ...std]);
  await row("J3", "two Host headers (good then evil)", [...post, H, "Host: evil.example", AUTH, ...std]);
  await row("J3", "absolute-URI request line to evil.example, Host good", [`POST http://evil.example/mcp-external HTTP/1.1`, H, AUTH, ...std]);
  await row("J3", "absolute-URI request line, Host evil", [`POST http://127.0.0.1:${P}/mcp-external HTTP/1.1`, "Host: evil.example", AUTH, ...std]);

  // J4 token
  const hash = (registry as any).theClients?.[0]?.hash as string | undefined;
  for (const [label, line] of [
    ["none", ""], ["wrong", "Authorization: Bearer " + "0".repeat(64)], ["Basic", `Authorization: Basic ${Buffer.from("x:" + A.token).toString("base64")}`],
    ["lowercase bearer", `Authorization: bearer ${A.token}`], ["trailing space", `Authorization: Bearer ${A.token} `], ["two tokens", `Authorization: Bearer ${A.token} x`],
    ["prefix of token", `Authorization: Bearer ${A.token.slice(0, 32)}`], ["token + suffix", `Authorization: Bearer ${A.token}00`], ["stored hash as token", `Authorization: Bearer ${hash}`],
    ["uppercase token", `Authorization: Bearer ${A.token.toUpperCase()}`], ["empty bearer", "Authorization: Bearer "],
  ] as const) await row("J4", `token: ${label}`, [...post, H, ...(line ? [line] : []), ...std]);
  await row("J4", "token in the query string only", [`POST /mcp-external?token=${A.token}&access_token=${A.token} HTTP/1.1`, H, ...std]);
  await row("J4", "token in a cookie only", [...post, H, `Cookie: token=${A.token}`, ...std]);

  // J5 order and path oracle
  await row("J5", "wrong token, unknown path (401 expected, not 404)", ["POST /nope HTTP/1.1", H, "Authorization: Bearer nope", ...std]);
  await row("J5", "valid token, unknown path", ["POST /nope HTTP/1.1", H, AUTH, ...std]);
  await row("J5", "valid token, path with dot segments /x/../mcp-external", ["POST /x/../mcp-external HTTP/1.1", H, AUTH, ...std]);
  await row("J5", "valid token, //mcp-external", ["POST //mcp-external HTTP/1.1", H, AUTH, ...std]);

  // J6 browser-shaped requests without a token
  await row("J6", "GET, no Origin, no token (an <img>)", ["GET /mcp-external HTTP/1.1", H], "");
  await row("J6", "POST text/plain, Origin (a form or fetch no-cors)", [...post, H, "Origin: https://evil.example", "Content-Type: text/plain"]);
  await row("J6", "OPTIONS preflight", ["OPTIONS /mcp-external HTTP/1.1", H, "Origin: https://evil.example", "Access-Control-Request-Method: POST", "Access-Control-Request-Headers: authorization"], "");

  // J7 one client reading another's project; J8 declaration limits. Through a real MCP client.
  const mcp = async (token: string) => {
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${P}/mcp-external`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return c;
  };
  const say = (r: any) => (r.content as any[]).map((x) => x.text ?? `[${x.type}]`).join(" | ").split(base).join("<tmp>").slice(0, 200) + (r.isError ? " (isError)" : "");
  const ca = await mcp(A.token), cb = await mcp(B.token);
  const call = async (c: Client, name: string, args: any) => say(await c.callTool({ name, arguments: args }));
  rows.push({ id: "J7", input: "A declares projA port 3000", outcome: await call(ca, "declare_project", { folder: join(home, "projA"), ports: [3000] }) });
  rows.push({ id: "J7", input: "B reads A's folder", outcome: await call(cb, "read_remarks", { folder: join(home, "projA") }) });
  rows.push({ id: "J7", input: "B reads A's folder through a symlink", outcome: await call(cb, "read_remarks", { folder: join(home, "linkA") }) });
  rows.push({ id: "J7", input: "B reads projB/../projA", outcome: await call(cb, "read_remarks", { folder: join(home, "projB", "..", "projA") }) });
  rows.push({ id: "J7", input: "B marks A's remark handled", outcome: await call(cb, "mark_handled", { folder: join(home, "projA"), ids: ["e-00000000"] }) });
  rows.push({ id: "J7", input: "B declares A's folder itself (takes it over?)", outcome: await call(cb, "declare_project", { folder: join(home, "projA"), ports: [3001] }) });
  rows.push({ id: "J7", input: "after that, A reads its own folder", outcome: await call(ca, "read_remarks", { folder: join(home, "projA") }) });
  rows.push({ id: "J7", input: "B declares A's port 3000 on projB (port taken over?)", outcome: await call(cb, "declare_project", { folder: join(home, "projB"), ports: [3000] }) });
  rows.push({ id: "J7", input: "registry after", outcome: JSON.stringify(registry.projects().map((p) => ({ folder: p.folder.replace(base, "<tmp>"), ports: p.ports, client: p.client === A.client.id ? "A" : p.client === B.client.id ? "B" : p.client }))) });
  for (const [label, args] of [
    ["agent port 5300", { folder: join(home, "projB"), ports: [5300] }], ["port 80", { folder: join(home, "projB"), ports: [80] }], ["port 70000", { folder: join(home, "projB"), ports: [70000] }],
    ["11 ports", { folder: join(home, "projB"), ports: [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, 3011] }], ["no port", { folder: join(home, "projB"), ports: [] }],
    ["folder = home", { folder: home, ports: [3002] }], ["folder = /", { folder: "/", ports: [3002] }], ["folder outside home (/tmp)", { folder: realpathSync(os.tmpdir()), ports: [3002] }],
    ["folder in the Ressac space", { folder: spaceRoot, ports: [3002] }], ["relative folder", { folder: "projB", ports: [3002] }], ["folder missing", { folder: join(home, "nope"), ports: [3002] }],
    ["port 5279 (the server's own default)", { folder: join(home, "projB"), ports: [5279] }], ["port 11434 (Ollama)", { folder: join(home, "projB"), ports: [11434] }],
  ] as const) rows.push({ id: "J8", input: label, outcome: await call(cb, "declare_project", args) });
  await ca.close(); await cb.close();

  // J10
  rows.push({ id: "J10", input: "token shape", outcome: `${A.token.length} hex chars (${A.token.length * 4} bits), stored as sha256: ${hash ? hash.length + " hex chars" : "?"}` });
  await registry.revoke(A.client.id);
  await row("J4", "token after revoke", [...post, H, AUTH, ...std]);
  await server.stop();
  writeFileSync(new URL("./results/design-server.json", import.meta.url), JSON.stringify(rows, null, 1));
}, 60_000);
