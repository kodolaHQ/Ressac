import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { History } from "../core/history";
import { createAsk } from "../host/ask";

// Monday 16 November 2026, afternoon local time.
const NOW = new Date(2026, 10, 16, 15);

/** A fake search server: answers /v1/embeddings with the vector [3, 4] (or as `reply` says) and keeps the texts asked. */
let server: Server;
let base: string;
let inputs: string[];
let reply: "ok" | "500" | "never";
/** Requests whose client went away before an answer. */
let dropped: number;
beforeEach(async () => {
  inputs = [];
  reply = "ok";
  dropped = 0;
  server = createServer((req, res) => {
    res.on("close", () => void (res.writableEnded || dropped++));
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      inputs.push(...(JSON.parse(body) as { input: string[] }).input);
      if (reply === "never") return;
      if (reply === "500") return void res.writeHead(500).end("{}");
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

const hit = (url: string, score: number) => ({ url, title: url, lastVisit: "2026-11-15T10:00:00.000Z", visits: 1, excerpt: "", favicon: null, score });

const make = (hits: ReturnType<typeof hit>[] = [], o: { timeoutMs?: number; installed?: boolean } = {}) => {
  const embed = { ready: vi.fn(async () => base), warm: vi.fn(), installed: vi.fn(() => o.installed ?? true) };
  const history = { findSimilar: vi.fn((_v: Float32Array, _q: Parameters<History["findSimilar"]>[1]) => hits) };
  const ask = createAsk({ embed, history: () => history, now: () => NOW, timeoutMs: o.timeoutMs });
  return { ask, embed, history };
};

test("the query text is the measured prompt and the question without its period words; filters reach findSimilar", async () => {
  const { ask, history } = make([hit("https://www.youtube.com/watch?v=1", 0.8)]);
  const r = await ask.find("la vidéo du mascaret vue hier");
  expect(inputs).toEqual(["task: search result | query: la vidéo du mascaret vue"]);
  const [vec, q] = history.findSimilar.mock.calls[0]!;
  expect(Array.from(vec).map((x) => Math.round(x * 100) / 100)).toEqual([0.6, 0.8]);
  expect(q).toEqual({
    since: new Date(2026, 10, 15),
    until: new Date(2026, 10, 15, 23, 59, 59, 999),
    sites: ["youtube.com", "vimeo.com", "dailymotion.com"],
    limit: 3,
  });
  expect(r).toEqual({
    kind: "page",
    hits: [{ url: "https://www.youtube.com/watch?v=1", title: "https://www.youtube.com/watch?v=1", lastVisit: "2026-11-15T10:00:00.000Z", excerpt: null, favicon: null }],
  });
});

test("no period: no dates; scores under 0.30 are dropped", async () => {
  const { ask, history } = make([hit("https://a.fr/", 0.9), hit("https://b.fr/", 0.3), hit("https://c.fr/", 0.29)]);
  const r = await ask.find("le mascaret");
  expect(history.findSimilar.mock.calls[0]![1]).toEqual({ since: undefined, until: undefined, sites: [], limit: 3 });
  expect(r.kind === "page" && r.hits.map((x) => x.url)).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("nothing at 0.30 or more → agent", async () => {
  const { ask } = make([hit("https://a.fr/", 0.2)]);
  expect(await ask.find("le mascaret")).toEqual({ kind: "agent" });
});

test("an action request → agent, nothing embedded nor searched", async () => {
  const { ask, embed, history } = make([hit("https://a.fr/", 0.9)]);
  expect(await ask.find("résume-moi cette page")).toEqual({ kind: "agent" });
  expect(embed.ready).not.toHaveBeenCalled();
  expect(history.findSimilar).not.toHaveBeenCalled();
});

test("the server refusing, down, or no history → agent", async () => {
  reply = "500";
  expect(await make([hit("https://a.fr/", 0.9)]).ask.find("le mascaret")).toEqual({ kind: "agent" });
  const down = make([hit("https://a.fr/", 0.9)]);
  down.embed.ready.mockRejectedValueOnce(new Error("Local AI not installed"));
  expect(await down.ask.find("le mascaret")).toEqual({ kind: "agent" });
  const none = createAsk({ embed: make().embed, history: () => null, now: () => NOW });
  expect(await none.find("le mascaret")).toEqual({ kind: "agent" });
});

test("no vector within timeoutMs → agent, and the query's request is aborted", async () => {
  reply = "never";
  const { ask, history } = make([hit("https://a.fr/", 0.9)], { timeoutMs: 50 });
  const start = Date.now();
  expect(await ask.find("le mascaret")).toEqual({ kind: "agent" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(history.findSimilar).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(dropped).toBe(1), { timeout: 1000 });
});

test("usable: the search model is installed; warm starts its server", async () => {
  expect(await make([], { installed: true }).ask.usable()).toBe(true);
  const { ask, embed } = make([], { installed: false });
  expect(await ask.usable()).toBe(false);
  ask.warm();
  expect(embed.warm).toHaveBeenCalled();
});
