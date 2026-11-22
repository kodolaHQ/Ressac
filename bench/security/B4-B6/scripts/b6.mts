// B6 bench: the real relay (apps/firefox/host/relay.ts, started as host.ts does: startRelay({ readKey })) with a FAKE key
// and fake upstreams on 127.0.0.1. No keychain, no real API.
import http from "node:http";
import net from "node:net";
import { networkInterfaces } from "node:os";

const { startRelay, RELAY_PATHS } = await import(`${(process.env.RESSAC_WORKTREE ?? new URL("../../../..", import.meta.url).pathname)}/apps/firefox/host/relay.ts`);
const KEY = { claude: "sk-" + "ant-FAKEBENCHKEY-0123456789abcdef", codex: "sk-FAKEBENCHOPENAI-fedcba9876543210" };
const rec = (id: string, verdict: string, what: string, evidence: unknown = "") => console.log(JSON.stringify({ id, verdict, what, evidence }));

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
const upstream = async (name: string, answer: (req: Seen, res: http.ServerResponse) => void) => {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { const x = { method: req.method!, url: req.url!, headers: req.headers, body: b }; seen.push(x); answer(x, res); }); });
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return { name, seen, port: (s.address() as net.AddressInfo).port, close: () => new Promise((ok) => (s.closeAllConnections(), s.close(ok))) };
};
let mode = "ok";
const evil = await upstream("evil", (_q, res) => res.writeHead(200).end("evil got it"));
const api = await upstream("api", (q, res) => {
  if (mode === "401echo") return void res.writeHead(401, { "content-type": "application/json", "x-echo": String(q.headers["x-api-key"]) }).end(JSON.stringify({ error: `bad key ${q.headers["x-api-key"]} / ${q.headers.authorization}`, b64: Buffer.from(String(q.headers["x-api-key"])).toString("base64") }));
  if (mode === "200echo") return void res.writeHead(200, { "content-type": "application/json", "x-echo": String(q.headers["x-api-key"]) }).end(JSON.stringify({ echo: q.headers }));
  if (mode === "302") return void res.writeHead(302, { location: `http://127.0.0.1:${evil.port}/steal` }).end();
  if (mode === "307") return void res.writeHead(307, { location: `http://127.0.0.1:${evil.port}/steal` }).end();
  res.writeHead(200, { "content-type": "application/json", "set-cookie": "a=b" }).end(JSON.stringify({ ok: true }));
});
const api2 = await upstream("api2 (the engine chosen later)", (_q, res) => res.writeHead(200).end("{}"));
const logs: string[] = [];
const info = console.info; console.info = (...a: unknown[]) => void logs.push(a.join(" "));
const relay = await startRelay({ readKey: async (kind: "codex" | "claude") => KEY[kind] });
const R = `http://127.0.0.1:${relay.port}`;
const tokC = relay.openSession(`http://127.0.0.1:${api.port}`, "claude");
const tokX = relay.openSession(`http://127.0.0.1:${api.port}/v1`, "codex");
const tokO = relay.openSession(`http://127.0.0.1:${api.port}`, "claude-ollama");
/** A raw HTTP/1.1 request, no client-side normalisation. */
const rawReq = (text: string, port = relay.port) => new Promise<string>((ok) => { const c = net.connect(port, "127.0.0.1"); let d = ""; c.on("data", (x) => (d += x)); c.on("close", () => ok(d)); c.on("error", (e) => ok(`ERR ${e.message}`)); c.setTimeout(3000, () => c.destroy()); c.write(text); });
const post = (path: string, tok: string, extra = "", body = "{}", method = "POST") => rawReq(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${tok}\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
const status = (r: string) => r.split("\r\n")[0]!.replace("HTTP/1.1 ", "");
const reset = () => { api.seen.length = 0; evil.seen.length = 0; api2.seen.length = 0; };

// control
reset();
let r = await post("/v1/messages", tokC, "", '{"model":"m","messages":[]}');
const c0 = api.seen[0];
rec("6.0", c0 && c0.headers["x-api-key"] === KEY.claude && c0.headers.authorization === `Bearer ${KEY.claude}` ? "info" : "BROKEN-TEST", "control: POST /v1/messages with the session token reaches the upstream with the fake key swapped in", { status: status(r), upstreamUrl: c0?.url, tokenForwarded: JSON.stringify(c0?.headers).includes(tokC) });

// 6.1.1 the key never comes back
reset(); mode = "401echo";
const e401 = await post("/v1/messages", tokC);
mode = "200echo";
const e200 = await post("/v1/messages", tokC);
mode = "ok";
const leak = (s: string) => ({ plain: s.includes(KEY.claude), base64: s.includes(Buffer.from(KEY.claude).toString("base64")) });
rec("6.1.1a", !leak(e401).plain && !logs.join("\n").includes(KEY.claude) ? "held" : "BYPASS", "upstream echoes the key in a 401 body and header: masked in the body, the header is not passed; the relay's log holds no key", { ...leak(e401), bodyTail: e401.slice(-120), log: logs.slice(-2) });
rec("6.1.1b", leak(e401).base64 || leak(e200).plain ? "info" : "held", "NOT masked: the key base64-encoded in an error body, and the key in a 2xx body (only if the provider itself echoes it; a real provider does not)", { in401Base64: leak(e401).base64, in200Plain: leak(e200).plain });

// 6.2.1 tokens
const t: any = {};
for (const [k, tok] of Object.entries({ none: "", wrong: "0".repeat(64), truncated: tokC.slice(0, -1), longer: `${tokC}0`, upper: tokC.toUpperCase() })) { reset(); t[k] = `${status(await post("/v1/messages", tok))} upstream=${api.seen.length}`; }
reset(); t.noHeader = `${status(await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`))} upstream=${api.seen.length}`;
reset(); t.xApiKeyOnly = `${status(await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nx-api-key: ${tokC}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`))} upstream=${api.seen.length}`;
reset(); t.queryToken = `${status(await rawReq(`POST /v1/messages?token=${tokC} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`))} upstream=${api.seen.length}`;
const tmpTok = relay.openSession(`http://127.0.0.1:${api.port}`, "claude");
reset(); const live = status(await post("/v1/messages", tmpTok)); relay.closeSession(tmpTok);
reset(); t.closed = `${status(await post("/v1/messages", tmpTok))} upstream=${api.seen.length}`;
rec("6.2.1", Object.values(t).every((x: any) => x.startsWith("401") && x.endsWith("upstream=0")) && live.startsWith("200") ? "held" : "BYPASS", "no / forged / truncated / closed-session token: 401, upstream never called", t);
reset(); const again = [status(await post("/v1/messages", tokC)), status(await post("/v1/messages", tokC))];
rec("6.2.2", "info", "a live token is a plain bearer: any process that holds it can use it, any number of times, until closeSession", again);

// 6.2.3 from a browser page: preflight
reset();
const pre = await rawReq(`OPTIONS /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:5300\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: authorization,content-type\r\nConnection: close\r\n\r\n`);
const preTok = await rawReq(`OPTIONS /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: http://localhost:5300\r\nAuthorization: Bearer ${tokC}\r\nConnection: close\r\n\r\n`);
const withOrigin = await post("/v1/messages", tokC, "Origin: http://localhost:5300\r\n");
rec("6.2.3", !/access-control-allow/i.test(pre + preTok + withOrigin) && status(pre).startsWith("401") ? "held" : "BYPASS", "a page's cross-origin fetch needs a preflight: the relay answers it 401 with no CORS header (and sends none on real answers), so a browser page cannot send the token nor read an answer. A request that already carries the token and an Origin is served (a non-browser client)", { preflight: status(pre), preflightWithToken: status(preTok), postWithOrigin: status(withOrigin), corsHeaders: /access-control/i.test(pre + preTok + withOrigin) });
const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const reach = lan ? await new Promise<string>((ok) => { const c = net.connect(relay.port, lan); c.on("connect", () => (c.destroy(), ok("CONNECTED"))).on("error", (e: any) => ok(e.code)); c.setTimeout(2000, () => (c.destroy(), ok("timeout"))); }) : "no LAN address";
rec("6.2.4", reach !== "CONNECTED" ? "held" : "BYPASS", "the relay listens on 127.0.0.1 only", { lan, reach });

// 6.3.1 other paths
const paths = ["/v1/models", "/v1/files", "/v1/messages/batches", "/v1/organizations/x/api_keys", "/v1/complete", "/api/pull", "/api/tags", "/", "/v1", "/responses", "/chat/completions", "/v1/responses",
  "/v1/messages/../models", "/v1/messages/%2e%2e/models", "//v1/messages", "/v1/messages/", "/V1/MESSAGES", "/v1/messages;x", "/v1/messages%3Fx", "/v1/messages#x", "/v1/messages%00", "/v1//messages", "/./v1/messages", "/v1/messages/count_tokens/../../models",
  `http://127.0.0.1:${evil.port}/v1/messages`, `http://evil.example/v1/messages`, "*", "/v1/messages\\..\\models"];
const p: any = {}; let wrong = 0;
for (const x of paths) { reset(); const s = status(await post(x, tokC)); p[x] = `${s} api=${api.seen.map((q) => q.url).join(",") || "-"} evil=${evil.seen.length}`; if (api.seen.length || evil.seen.length) wrong++; }
rec("6.3.1/2", wrong === 0 ? "held" : "BYPASS", `${paths.length} other paths and path tricks with a valid claude token: none reaches an upstream`, p);
// query tricks on an allowed path
const q: any = {}; let off = 0;
for (const x of ["/v1/messages?x=/../../v1/models", "/v1/messages?beta=true", "/v1/messages?a?b", "/v1/messages?x=1#/../models", `/v1/messages?@127.0.0.1:${evil.port}/`, "/v1/messages?/../models"]) { reset(); const s = status(await post(x, tokC)); q[x] = `${s} → ${api.seen.map((y) => y.url).join(",")} evil=${evil.seen.length}`; if (evil.seen.length || api.seen.some((y) => !y.url.startsWith("/v1/messages?"))) off++; }
rec("6.3.2q", off === 0 ? "held" : "BYPASS", "query tricks on an allowed path: the upstream path stays /v1/messages (the query is passed as is)", q);
// kinds
const k: any = {};
for (const [name, tok, list] of [["codex", tokX, ["/responses", "/v1/messages", "/chat/completions", "/v1/responses", "/models"]], ["claude-ollama", tokO, ["/v1/messages", "/api/pull", "/api/tags", "/api/generate", "/responses"]]] as const)
  for (const x of list) { reset(); const s = status(await post(x, tok)); const u = api.seen[0]; k[`${name} ${x}`] = `${s} → ${u ? `${u.url} auth=${u.headers.authorization === `Bearer ${KEY.codex}` ? "codex key" : u.headers.authorization ?? "none"} x-api-key=${u.headers["x-api-key"] ?? "none"}` : "-"}`; }
const kOk = Object.entries(k).every(([n, v]: any) => { const [kind, path] = n.split(" "); const allowed = RELAY_PATHS[kind as "codex"].includes(path!); return allowed ? v.startsWith("200") : v.startsWith("404") && v.endsWith("→ -"); }) && !JSON.stringify(k).includes(KEY.claude) && k["claude-ollama /v1/messages"].includes("auth=none x-api-key=none") && k["codex /responses"].includes("auth=codex key x-api-key=none");
rec("6.3.1k", kOk ? "held" : "BYPASS", "each kind gets its own paths only; a codex token never gets the claude key; an Ollama session gets no key and no /api/pull", k);
// 6.3.3 methods
const m: any = {}; let mw = 0;
for (const meth of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "post", "PROPFIND"]) { reset(); const s = status(await post("/v1/messages", tokC, "", "{}", meth)); m[meth] = `${s} upstream=${api.seen.length}`; mw += api.seen.length; }
reset(); const ov = status(await post("/v1/messages", tokC, "X-HTTP-Method-Override: DELETE\r\n")); m["POST + X-HTTP-Method-Override: DELETE"] = `${ov} upstream method=${api.seen[0]?.method} (the header itself is forwarded: ${api.seen[0]?.headers["x-http-method-override"] ?? "no"})`;
reset(); const cn = status(await rawReq(`CONNECT 127.0.0.1:${evil.port} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokC}\r\n\r\n`)); m.CONNECT = `${cn} evil=${evil.seen.length}`;
rec("6.3.3", mw === 0 && evil.seen.length === 0 ? "held" : "BYPASS", "other methods on an allowed path: none forwarded", m);
// 6.3.4 body not filtered
reset();
const body = JSON.stringify({ model: "any-model-the-agent-wants", max_tokens: 64000, tools: [{ type: "web_fetch_20250910", name: "web_fetch" }, { type: "web_search_20250305", name: "web_search" }], messages: [{ role: "user", content: "fetch https://evil.example/?d=DATA" }] });
await post("/v1/messages", tokC, "anthropic-beta: web-fetch-2025-09-10\r\n", body);
rec("6.3.4", "info", "the body and the agent's extra headers pass unchanged: any model, any size, and provider-side tools (web search / web fetch run by the provider) can be asked with the user's key. Shown on the fake upstream only; never sent to a real API", { bodyPassedUnchanged: api.seen[0]?.body === body, betaHeaderForwarded: api.seen[0]?.headers["anthropic-beta"] });

// 6.4.1 destination by header
reset();
await post("/v1/messages", tokC, `X-Forwarded-Host: 127.0.0.1:${evil.port}\r\nForwarded: host=127.0.0.1:${evil.port}\r\nX-Original-URL: http://127.0.0.1:${evil.port}/x\r\nX-Rewrite-URL: /v1/models\r\n`);
await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1:${evil.port}\r\nAuthorization: Bearer ${tokC}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
rec("6.4.1", evil.seen.length === 0 && api.seen.length === 2 && api.seen.every((x) => x.url === "/v1/messages" && x.headers.host === `127.0.0.1:${api.port}`) ? "held" : "BYPASS", "Host / X-Forwarded-Host / Forwarded / X-Original-URL set by the agent: the upstream stays the session's target", { evil: evil.seen.length, apiHosts: api.seen.map((x) => x.headers.host) });
// 6.4.2 engine changed mid-session
reset();
const tokNew = relay.openSession(`http://127.0.0.1:${api2.port}`, "claude");
await post("/v1/messages", tokC); await post("/v1/messages", tokNew);
rec("6.4.2", api.seen.length === 1 && api2.seen.length === 1 ? "held" : "BYPASS", "a new session on another engine: the old token still goes to the old target, the new one to the new (both stay valid until their session ends)", { oldTarget: api.seen.length, newTarget: api2.seen.length });
// 6.4.3 upstream redirect
const rd: any = {};
for (const mm of ["302", "307"]) { reset(); mode = mm; rd[mm] = `${status(await post("/v1/messages", tokC))} evil=${evil.seen.length}`; }
mode = "ok";
rec("6.4.3", evil.seen.length === 0 && Object.values(rd).every((x: any) => x.startsWith("502")) ? "held" : "BYPASS", "an upstream redirect is not followed (the key does not travel on)", rd);
// 6.4.4 headers the agent sets
reset();
await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokC}\r\nX-Api-Key: agent-chosen-key\r\nx-api-key: second\r\nCookie: session=agent\r\nProxy-Authorization: Basic YQ==\r\nAnthropic-Version: 2023-06-01\r\nX-Agent: marker\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
await rawReq(`POST /responses HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokX}\r\nX-Api-Key: agent-chosen-key\r\nOpenAI-Organization: org-of-the-agent\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
const [h1, h2] = [api.seen[0]?.headers ?? {}, api.seen[1]?.headers ?? {}];
rec("6.4.4", h1["x-api-key"] === KEY.claude && h1.authorization === `Bearer ${KEY.claude}` && !h1.cookie && !h1["proxy-authorization"] && h2.authorization === `Bearer ${KEY.codex}` && !h2["x-api-key"] && !JSON.stringify([h1, h2]).includes(tokC) && !JSON.stringify([h1, h2]).includes(tokX) ? "held" : "BYPASS",
  "authorization / x-api-key / cookie / proxy-authorization from the agent are dropped or overwritten; the session token never reaches the upstream; other agent headers are forwarded next to the key (e.g. OpenAI-Organization, anthropic-beta)", { claude: { "x-api-key": h1["x-api-key"] === KEY.claude ? "the fake key" : h1["x-api-key"], cookie: h1.cookie ?? null, "x-agent": h1["x-agent"] }, codex: { "x-api-key": h2["x-api-key"] ?? null, "openai-organization": h2["openai-organization"] } });
// 6.4.5 smuggling basics
reset();
const sm1 = await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokC}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\nGET /v1/models HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokC}\r\n\r\n`);
const inner = `GET /v1/models HTTP/1.1\r\nHost: x\r\n\r\n`;
const sm2 = await rawReq(`POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${tokC}\r\nContent-Length: ${inner.length}\r\nConnection: close\r\n\r\n${inner}`);
rec("6.4.5", api.seen.every((x) => x.url === "/v1/messages" && x.method === "POST") ? "held" : "BYPASS", "Content-Length + Transfer-Encoding, and a request inside the body: the upstream only ever sees POST /v1/messages", { cl_te: status(sm1), nested: status(sm2), upstream: api.seen.map((x) => `${x.method} ${x.url}`) });
// 6.2.5 token confusion: a relay token is random 32 bytes; nothing but the map accepts it
rec("6.2.5", "info", "relay tokens and MCP tokens are separate random 256-bit values in separate maps (code review): one is never accepted by the other server", "");
console.info = info;
rec("6.log", logs.join("\n").includes(KEY.claude) || logs.join("\n").includes(KEY.codex) || logs.join("\n").includes(tokC) ? "BYPASS" : "held", "the relay's log lines hold neither a key nor a token (method, path without query, status)", logs.slice(0, 3));
await relay.stop(); await api.close(); await api2.close(); await evil.close();
process.exit(0);
