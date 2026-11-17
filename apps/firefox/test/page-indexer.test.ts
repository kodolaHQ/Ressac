import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { History } from "../core/history";
import { EmbedRefused, createPageIndexer, llamaEmbed, pageDocument } from "../host/page-indexer";

let path: string;
let h: History;
let indexer: ReturnType<typeof createPageIndexer> | undefined;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "ressac-index-")), "history.sqlite");
  h = new History(path);
});
afterEach(() => {
  indexer?.stop();
  h.close();
});

const fill = (n: number) => {
  const now = Date.now();
  h.importVisits(Array.from({ length: n }, (_, i) => ({ url: `https://p${i}.fr/`, title: `Page ${i}`, date: new Date(now - i * 1000) })));
};
const fake = () => {
  const docs: string[] = [];
  const embed = vi.fn(async (texts: string[]) => (docs.push(...texts), texts.map(() => Float32Array.from([1, 0]))));
  return { docs, embed };
};
const done = () => vi.waitFor(() => expect(h.pendingVectors(1)).toEqual([]), { timeout: 30_000, interval: 20 });

test("the document text: title (or « none »), host without www, then the excerpt", () => {
  expect(pageDocument({ title: "Rust", host: "youtube.com", excerpt: "Une vidéo" })).toBe("title: Rust | text: youtube.com Une vidéo");
  expect(pageDocument({ title: "", host: "a.fr", excerpt: "" })).toBe("title: none | text: a.fr");
  // A giant title is cut at 300 characters, never inside a surrogate pair.
  expect(pageDocument({ title: `${"x".repeat(299)}😀y`, host: "a.fr", excerpt: "" })).toBe(`title: ${"x".repeat(299)} | text: a.fr`);
});

test("a page the model refuses is marked and skipped: the 39 others get vectors and the indexer goes idle", async () => {
  fill(40);
  h.keep({ url: "https://p7.fr/", spaceId: "import", title: "Page 7", text: "POISON" });
  const embed = vi.fn(async (texts: string[]) => {
    if (texts.some((t) => t.includes("POISON"))) throw new EmbedRefused("HTTP 500");
    return texts.map(() => Float32Array.from([1, 0]));
  });
  indexer = createPageIndexer({ history: h, embed, pauseMs: 0, idleMs: 20, passEveryMs: 0 });
  indexer.start();
  await done();
  const calls = embed.mock.calls.length;
  await new Promise((r) => setTimeout(r, 100));
  expect(embed.mock.calls.length).toBe(calls); // idle: nothing retried
  expect(h.findSimilar(Float32Array.from([1, 0]), { limit: 100 }).map((x) => x.url)).toHaveLength(39);
  expect(h.findSimilar(Float32Array.from([1, 0]), { limit: 100, sites: ["p7.fr"] })).toEqual([]);
  // A new text lifts the mark: the page is tried again.
  h.keep({ url: "https://p7.fr/", spaceId: "import", title: "Page 7", text: "sain" });
  await vi.waitFor(() => expect(h.findSimilar(Float32Array.from([1, 0]), { limit: 100, sites: ["p7.fr"] })).toHaveLength(1));
});

test("10 000 pages are indexed in batches of 32, most recent first, and a timer fires between batches", async () => {
  fill(10_000);
  let fired = 0;
  let calls = 0;
  const sizes: number[] = [];
  const firstDocs: string[] = [];
  const embed = async (texts: string[]) => {
    expect(fired).toBe(calls); // the timer set during the previous batch already fired
    calls++;
    setTimeout(() => fired++, 0);
    sizes.push(texts.length);
    if (firstDocs.length === 0) firstDocs.push(texts[0]!);
    return texts.map(() => Float32Array.from([1, 0]));
  };
  indexer = createPageIndexer({ history: h, embed, pauseMs: 0 });
  indexer.start();
  await done();
  expect(sizes.length).toBe(Math.ceil(10_000 / 32));
  expect(Math.max(...sizes)).toBe(32);
  expect(firstDocs[0]).toBe("title: Page 0 | text: p0.fr");
}, 60_000);

test("a pass reads each batch below the last one, without skipping pages that share a date", async () => {
  const date = new Date();
  h.importVisits(Array.from({ length: 35 }, (_, i) => ({ url: `https://t${i}.fr/`, title: `T ${i}`, date: i < 30 ? date : new Date(date.getTime() - 1000) })));
  const befores: (string | undefined)[] = [];
  const history = {
    pendingVectors: (n: number, before?: string) => (befores.push(before), h.pendingVectors(n, before)),
    saveVectors: (rows: Parameters<History["saveVectors"]>[0]) => h.saveVectors(rows),
  };
  const { docs, embed } = fake();
  indexer = createPageIndexer({ history, embed, batch: 10, pauseMs: 0 });
  indexer.start();
  await done();
  expect(new Set(docs).size).toBe(35);
  expect(docs).toHaveLength(35);
  expect(befores.slice(0, 2)).toEqual([undefined, date.toISOString()]);
});

test("a batch that saves nothing ends the pass instead of embedding the same pages again", async () => {
  fill(5);
  const history = { pendingVectors: (n: number) => h.pendingVectors(n), saveVectors: () => 0 };
  const { embed } = fake();
  indexer = createPageIndexer({ history, embed, pauseMs: 0, idleMs: 20 });
  indexer.start();
  await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 100));
  expect(embed).toHaveBeenCalledTimes(1);
});

test("resumes after a restart without embedding a page twice (vectors persisted)", async () => {
  fill(200);
  const first = fake();
  indexer = createPageIndexer({ history: h, embed: first.embed, batch: 10, pauseMs: 0 });
  indexer.start();
  await vi.waitFor(() => expect(first.embed.mock.calls.length).toBeGreaterThanOrEqual(3));
  indexer.stop();
  await new Promise((r) => setTimeout(r, 20));
  h.close();
  h = new History(path);
  const saved = 200 - h.pendingVectors(1000).length;
  expect(saved).toBeGreaterThan(0);
  const second = fake();
  indexer = createPageIndexer({ history: h, embed: second.embed, batch: 10, pauseMs: 0 });
  indexer.start();
  await done();
  expect(second.docs).toHaveLength(200 - saved);
  expect(new Set([...first.docs.slice(0, saved), ...second.docs]).size).toBe(200);
});

test("stop (AI off): the batch in flight is dropped and nothing more is embedded; start resumes", async () => {
  fill(100);
  let release!: () => void;
  const embed = vi.fn((texts: string[]) => new Promise<Float32Array[]>((ok) => (release = () => ok(texts.map(() => Float32Array.from([1, 0]))))));
  indexer = createPageIndexer({ history: h, embed, batch: 10, pauseMs: 0 });
  indexer.start();
  await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
  indexer.stop();
  release();
  await new Promise((r) => setTimeout(r, 30));
  expect(embed).toHaveBeenCalledTimes(1);
  expect(h.pendingVectors(1000)).toHaveLength(100);
  indexer = createPageIndexer({ history: h, embed: fake().embed, batch: 10, pauseMs: 0 });
  indexer.start();
  await done();
});

test("an error stops the loop; it retries later", async () => {
  fill(5);
  const embed = vi.fn(async (texts: string[]) => texts.map(() => Float32Array.from([1, 0])));
  embed.mockRejectedValueOnce(new Error("server down"));
  indexer = createPageIndexer({ history: h, embed, pauseMs: 0, retryMs: 30 });
  indexer.start();
  await done();
  expect(embed).toHaveBeenCalledTimes(2);
});

test("a page whose title changes is embedded again with its new title", async () => {
  h.note({ url: "https://www.a.fr/x", spaceId: "s", title: "A", private: false });
  const { docs, embed } = fake();
  indexer = createPageIndexer({ history: h, embed, pauseMs: 0, idleMs: 20, passEveryMs: 0 });
  indexer.start();
  await done();
  h.updateTitle("https://www.a.fr/x", "s", "A2");
  await vi.waitFor(() => expect(docs).toEqual(["title: A | text: a.fr", "title: A2 | text: a.fr"]));
});

test("a history error (read or write) does not end indexing: it retries later", async () => {
  fill(5);
  const history = {
    pendingVectors: vi.fn((n: number) => h.pendingVectors(n)).mockImplementationOnce(() => { throw new Error("database is locked"); }),
    saveVectors: vi.fn((rows: Parameters<History["saveVectors"]>[0]) => h.saveVectors(rows)).mockImplementationOnce(() => { throw new Error("disk full"); }),
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  indexer = createPageIndexer({ history, embed: fake().embed, pauseMs: 0, retryMs: 20 });
  indexer.start();
  await done();
  expect(history.saveVectors).toHaveBeenCalledTimes(2);
  expect(error.mock.calls.map((c) => c[1])).toEqual(["database is locked", "disk full"]);
  error.mockRestore();
});

test("between passes a few new pages wait: a pass runs at start, then at 32 pages waiting or 10 min after the last pass", async () => {
  let now = 0;
  const add = (from: number, n: number) => h.importVisits(Array.from({ length: n }, (_, i) => ({ url: `https://q${from + i}.fr/`, title: `Q ${from + i}`, date: new Date() })));
  fill(3);
  const { docs, embed } = fake();
  indexer = createPageIndexer({ history: h, embed, pauseMs: 0, idleMs: 10, clock: () => now });
  indexer.start();
  await done(); // at start, whatever the count
  add(0, 31);
  now += 9 * 60_000;
  await new Promise((r) => setTimeout(r, 100));
  expect(docs).toHaveLength(3); // 31 waiting, 9 min: the search server stays off
  add(31, 1);
  await done(); // 32 waiting
  expect(docs).toHaveLength(35);
  add(32, 1);
  await new Promise((r) => setTimeout(r, 100));
  expect(docs).toHaveLength(35);
  now += 10 * 60_000;
  await done(); // 10 min since the last pass
  expect(docs).toHaveLength(36);
});

test("idle looks only read pages seen since the last full look; the look 10 min after a pass reads them all", async () => {
  let now = 0;
  fill(3);
  const afters: (string | undefined)[] = [];
  const history = {
    pendingVectors: (n: number, before?: string, after?: string) => (afters.push(after), h.pendingVectors(n, before, after)),
    saveVectors: (rows: Parameters<History["saveVectors"]>[0]) => h.saveVectors(rows),
  };
  const started = new Date().toISOString();
  indexer = createPageIndexer({ history, embed: fake().embed, pauseMs: 0, idleMs: 10, clock: () => now });
  indexer.start();
  await done();
  await vi.waitFor(() => expect(afters.length).toBeGreaterThan(3));
  expect(afters[0]).toBeUndefined(); // the pass at start
  const idle = afters.at(-1)!;
  expect(idle >= started && idle <= new Date().toISOString()).toBe(true);
  now += 10 * 60_000;
  const n = afters.length;
  await vi.waitFor(() => expect(afters.slice(n)).toContain(undefined));
  await vi.waitFor(() => expect(afters.at(-1)).toBeDefined()); // then bounded again
});

describe("llamaEmbed", () => {
  let server: ReturnType<typeof createServer>;
  afterEach(() => server.close());

  test("a refusal (HTTP 4xx/5xx) is EmbedRefused; a server still loading (503) or down is not", async () => {
    let status = 500;
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await expect(llamaEmbed(async () => base)(["a"])).rejects.toBeInstanceOf(EmbedRefused);
    status = 503;
    await expect(llamaEmbed(async () => base)(["a"])).rejects.not.toBeInstanceOf(EmbedRefused);
    await expect(llamaEmbed(async () => "http://127.0.0.1:1")(["a"])).rejects.not.toBeInstanceOf(EmbedRefused);
  });

  test("posts the batch to /v1/embeddings and returns L2-normalised vectors in input order", async () => {
    const bodies: unknown[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        bodies.push({ url: req.url, ...JSON.parse(body) });
        res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const out = await llamaEmbed(async () => base)(["a", "b"]);
    expect(bodies).toEqual([{ url: "/v1/embeddings", input: ["a", "b"] }]);
    expect(out.map((x) => Array.from(x).map((n) => Math.round(n * 100) / 100))).toEqual([[0.6, 0.8], [0, 1]]);
  });
});
