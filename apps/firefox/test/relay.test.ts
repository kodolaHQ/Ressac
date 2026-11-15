import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startRelay, type Relay } from "../host/relay";

const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));

let upstream: http.Server;
let other: http.Server;
let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[];
let otherCalls = 0;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let key: string | null;
let claudeKey: string | null;
let target: string | null;
let base: string;
let relay: Relay;
let token: string;

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
const call = (p: string, init: RequestInit = {}, tok: string | null = token) =>
  fetch(`http://127.0.0.1:${relay.port}${p}`, { method: "POST", body: "{}", ...init, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...init.headers } });

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  other = http.createServer((_, res) => {
    otherCalls++;
    res.end();
  });
  const up = await listen(upstream);
  const ot = await listen(other);
  target = base = `http://127.0.0.1:${up}/v1/`;
  (globalThis as { __other?: number }).__other = ot;
  relay = await startRelay({ readKey: async (kind) => (kind === "claude" ? claudeKey : key) });
  token = relay.openSession(target, "codex");
});
afterAll(async () => {
  await relay.stop();
  upstream.close();
  other.close();
  // Last: nothing the relay logged holds the key or a token.
  const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
  expect(logged).not.toContain("sk-secret");
  expect(logged).not.toContain("sk-ant-secret");
  expect(logged).not.toContain(token);
});
beforeEach(() => {
  seen = [];
  otherCalls = 0;
  key = "sk-secret";
  claudeKey = "sk-ant-secret";
  handler = (_, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":1}');
});

describe("relay", () => {
  it("adds the key", async () => {
    const r = await call("/responses", { body: '{"a":1}', headers: { "x-custom": "y" } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"ok":1}');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/responses");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-secret");
    expect(seen[0]!.headers["x-custom"]).toBe("y");
    expect(seen[0]!.body).toBe('{"a":1}');
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(token);
    expect(relay.containerUrl).toBe(`http://host.docker.internal:${relay.port}`);
  });

  it("streams", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    handler = (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      void gate.then(() => res.end());
    };
    const r = await call("/responses");
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: 1");
    finish();
    while (!(await reader.read()).done);
  });

  it("aborts upstream when the client leaves", async () => {
    let closed!: () => void;
    const upstreamClosed = new Promise<void>((r) => (closed = r));
    handler = (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      res.on("close", closed);
    };
    const ac = new AbortController();
    const r = await call("/responses", { signal: ac.signal });
    await r.body!.getReader().read();
    ac.abort();
    await upstreamClosed;
  });

  it("only POST, and a non-ASCII bearer is a 401", async () => {
    expect((await call("/responses", { method: "GET", body: undefined })).status).toBe(405);
    expect((await call("/responses", {}, "é".repeat(64))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("token", async () => {
    const closed = relay.openSession(target!, "codex");
    relay.closeSession(closed);
    for (const t of [null, "wrong", closed]) expect((await call("/responses", {}, t)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("paths", async () => {
    // fetch would normalize `..`, so send the raw path.
    const raw = (p: string) =>
      new Promise<number>((resolve) => {
        http.request({ host: "127.0.0.1", port: relay.port, path: p, method: "POST", headers: { authorization: `Bearer ${token}` } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).end();
      });
    for (const p of ["/files", "/responses/../files", "/v1/responses", "/models"]) expect(await raw(p)).toBe(404);
    expect(seen).toHaveLength(0);
    expect((await call("/responses?x=1")).status).toBe(200);
    expect(seen[0]!.url).toBe("/v1/responses?x=1");
  });

  it("not set", async () => {
    key = null;
    const r = await call("/responses");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: { message: "Aucune clé enregistrée pour l'API compatible (Réglages › Agents)." } });
    expect(seen).toHaveLength(0);
  });

  it("the target is the one the session opened with", async () => {
    const t = relay.openSession("http://127.0.0.1:1/", "codex");
    target = null;
    expect((await call("/responses", {}, t)).status).toBe(502);
    expect(seen).toHaveLength(0);
    expect((await call("/responses")).status).toBe(200);
  });

  it("no redirect", async () => {
    const ot = (globalThis as { __other?: number }).__other;
    handler = (_, res) => res.writeHead(302, { location: `http://127.0.0.1:${ot}/x` }).end();
    expect((await call("/responses")).status).toBe(502);
    expect(otherCalls).toBe(0);
  });

  it("unreachable", async () => {
    const down = await startRelay({ readKey: async () => "k" });
    const t = down.openSession("http://127.0.0.1:1/", "codex");
    const r = await fetch(`http://127.0.0.1:${down.port}/responses`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: { message: "API compatible injoignable" } });
    await down.stop();
  });

  it("masks the key in errors", async () => {
    handler = (_, res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key sk-secret"}');
    const r = await call("/responses");
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('{"error":"bad key ***"}');
  });

  it("claude: its own key in both headers, on its own paths", async () => {
    const t = relay.openSession(base, "claude");
    const r = await call("/v1/messages?beta=true", { headers: { "x-api-key": "from-container", "anthropic-version": "2023-06-01" } }, t);
    expect(r.status).toBe(200);
    expect(seen[0]!.url).toBe("/v1/v1/messages?beta=true");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-ant-secret");
    expect(seen[0]!.headers.authorization).toBe("Bearer sk-ant-secret");
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect((await call("/v1/messages/count_tokens", {}, t)).status).toBe(200);
    expect((await call("/responses", {}, t)).status).toBe(404);
    expect((await call("/v1/messages")).status).toBe(404); // a codex token
    expect(seen).toHaveLength(2);
    relay.closeSession(t);
  });

  it("claude: masks its key in errors", async () => {
    const t = relay.openSession(base, "claude");
    handler = (_, res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key sk-ant-secret"}');
    const r = await call("/v1/messages", {}, t);
    expect(r.status).toBe(401);
    expect(await r.text()).toBe('{"error":"bad key ***"}');
    relay.closeSession(t);
  });

  it("ollama: no key, no auth headers, inference paths only", async () => {
    key = claudeKey = null; // a missing key must not matter
    const c = relay.openSession(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, "claude-ollama");
    const r = await call("/v1/messages", { headers: { "x-api-key": "from-container" } }, c);
    expect(r.status).toBe(200);
    expect(seen[0]!.url).toBe("/v1/messages");
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect((await call("/api/pull", {}, c)).status).toBe(404);
    expect((await call("/chat/completions", {}, c)).status).toBe(404);
    const x = relay.openSession(base, "codex-ollama");
    expect((await call("/chat/completions", {}, x)).status).toBe(200);
    expect(seen[1]!.url).toBe("/v1/chat/completions");
    expect((await call("/responses", {}, x)).status).toBe(200);
    expect((await call("/api/blobs/sha256:x", {}, x)).status).toBe(404);
    expect(seen).toHaveLength(3);
    relay.closeSession(c);
    relay.closeSession(x);
  });
});
