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
let target: string | null;
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
  target = `http://127.0.0.1:${up}/v1/`;
  (globalThis as { __other?: number }).__other = ot;
  relay = await startRelay({ target: () => target, readKey: async () => key });
  token = relay.openSession();
});
afterAll(async () => {
  await relay.stop();
  upstream.close();
  other.close();
  // Last: nothing the relay logged holds the key or a token.
  const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
  expect(logged).not.toContain("sk-secret");
  expect(logged).not.toContain(token);
});
beforeEach(() => {
  seen = [];
  otherCalls = 0;
  key = "sk-secret";
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

  it("token", async () => {
    const closed = relay.openSession();
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
    target = null;
    let r = await call("/responses");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: { message: "Aucune API compatible n'est réglée dans WebAiOs (Réglages › Agents)." } });
    target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/`;
    key = null;
    r = await call("/responses");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: { message: "Aucune clé enregistrée pour l'API compatible (Réglages › Agents)." } });
    expect(seen).toHaveLength(0);
  });

  it("no redirect", async () => {
    const ot = (globalThis as { __other?: number }).__other;
    handler = (_, res) => res.writeHead(302, { location: `http://127.0.0.1:${ot}/x` }).end();
    expect((await call("/responses")).status).toBe(502);
    expect(otherCalls).toBe(0);
  });

  it("unreachable", async () => {
    const down = await startRelay({ target: () => "http://127.0.0.1:1/", readKey: async () => "k" });
    const t = down.openSession();
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
});
