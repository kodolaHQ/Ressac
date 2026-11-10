import { expect, test, vi } from "vitest";
import { readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  KEY_INVALID, KEY_MAX, SITE_MEMORY_SIZE, MEMORY_DEPTH_MAX, MEMORY_WRITE_MS, MEMORY_FULL, SiteMemory, POSITIONS_MAX, NON_JSON_VALUE,
} from "../../src/sites/memory.js";
import { tempFolder } from "../helpers/temp.js";

const file = (d: string) => join(d, "s", "memory.json");
let n = 0;
const clock = () => new Date(Date.UTC(2026, 0, 1) + n++ * 1000).toISOString();
const open = (d: string) => SiteMemory.open(d, "s", { now: clock });
const exists = (p: string) => stat(p).then(() => true, () => false);

test("retenir then read, re-read by a new instance after vider()", async () => {
  const d = await tempFolder();
  const m = await open(d);
  const v = { series: "The Bear", season: 2, episode: 4 };
  expect(m.keep("encours.the-bear", v, "/serie/the-bear")).toEqual({ ok: true });
  expect(m.read("encours.the-bear")).toEqual(v);
  expect(m.read("absente")).toBeNull();
  await m.clear();
  const m2 = await open(d);
  expect(m2.read("encours.the-bear")).toEqual(v);
  expect(m2.content().values["encours.the-bear"]?.url).toBe("/serie/the-bear");
  m2.forget("encours.the-bear");
  expect(m2.read("encours.the-bear")).toBeNull();
});

test("the write is deferred by at most ECRITURE_MEMOIRE_MS and grouped", async () => {
  const d = await tempFolder();
  const m = await open(d);
  m.keep("a", 1, null);
  m.keep("b", 2, null);
  expect(await exists(file(d))).toBe(false);
  await sleep(MEMORY_WRITE_MS + 300);
  expect(JSON.parse(await readFile(file(d), "utf8")).values).toMatchObject({ a: { value: 1 }, b: { value: 2 } });
});

test("300 KB value: MEMORY_FULL, memory unchanged", async () => {
  const m = await open(await tempFolder());
  m.keep("petite", 1, null);
  m.notePosition("/v", 100, 2400);
  const before = JSON.stringify(m.content());
  expect(m.keep("grosse", "x".repeat(300 * 1024), null)).toEqual({ ok: false, error: MEMORY_FULL });
  expect(JSON.stringify(m.content())).toBe(before);
});

test("the oldest positions are forgotten before refusing", async () => {
  const m = await open(await tempFolder());
  for (let i = 0; i < 400; i++) m.notePosition(`/video/${i}-${"x".repeat(300)}`, 100, 2400);
  expect(m.keep("grosse", "x".repeat(200 * 1024), null)).toEqual({ ok: true });
  const remaining = Object.keys(m.content().positions);
  expect(remaining.length).toBeLessThan(400);
  expect(remaining.at(-1)).toContain("/video/399-");
  expect(m.position(`/video/0-${"x".repeat(300)}`)).toBeNull();
});

test("fonction, cycle, undefined : NON_JSON_VALUE", async () => {
  const m = await open(await tempFolder());
  const cycle: Record<string, unknown> = {};
  cycle.soi = cycle;
  for (const v of [() => 1, cycle, undefined, 10n]) {
    expect(m.keep("k", v, null)).toEqual({ ok: false, error: NON_JSON_VALUE });
  }
  expect(m.read("k")).toBeNull();
});

test("empty or 201-character key: KEY_INVALID", async () => {
  const m = await open(await tempFolder());
  expect(m.keep("", 1, null)).toEqual({ ok: false, error: KEY_INVALID });
  expect(m.keep("a".repeat(KEY_MAX + 1), 1, null)).toEqual({ ok: false, error: KEY_INVALID });
  expect(m.keep("a".repeat(KEY_MAX), 1, null)).toEqual({ ok: true });
});

test("__proto__ is a key like any other", async () => {
  const d = await tempFolder();
  const m = await open(d);
  expect(m.keep("__proto__", { polluted: true }, null)).toEqual({ ok: true });
  expect(({} as Record<string, unknown>).polluee).toBeUndefined();
  expect(Object.getPrototypeOf(m.content().values)).toBeNull();
  expect(m.read("__proto__")).toEqual({ polluted: true });
  expect(m.read("toString")).toBeNull();
  await m.clear();
  const m2 = await open(d);
  expect(m2.read("__proto__")).toEqual({ polluted: true });
  expect(Object.getPrototypeOf(m2.content().values)).toBeNull();
});

test("noterPosition: 1390/2400 kept, 2300/2400 forgotten", async () => {
  const m = await open(await tempFolder());
  m.notePosition("/v", 1390, 2400);
  expect(m.position("/v")?.t).toBe(1390);
  m.notePosition("/v", 2300, 2400);
  expect(m.position("/v")).toBeNull();
  m.notePosition("/w", Number.NaN, 2400);
  m.notePosition("/w", 5, 0);
  expect(m.position("/w")).toBeNull();
});

test("600 positions: 500 kept, the 100 oldest gone", async () => {
  const m = await open(await tempFolder());
  for (let i = 0; i < 600; i++) m.notePosition(`/v/${i}`, 100, 2400);
  expect(Object.keys(m.content().positions)).toHaveLength(POSITIONS_MAX);
  expect(m.position("/v/99")).toBeNull();
  expect(m.position("/v/100")).not.toBeNull();
  expect(m.position("/v/599")).not.toBeNull();
});

test("damaged memory.json: empty memory, then cleanly rewritten", async () => {
  const d = await tempFolder();
  await mkdir(join(d, "s"), { recursive: true });
  await writeFile(file(d), "{pas du json");
  const m = await open(d);
  expect(m.content()).toEqual({ version: 1, values: {}, positions: {} });
  m.keep("a", 1, null);
  await m.clear();
  expect(JSON.parse(await readFile(file(d), "utf8")).values.a.value).toBe(1);
  await writeFile(file(d), JSON.stringify({ version: 1, values: { a: 3 }, positions: [] }));
  expect((await open(d)).content().values).toEqual({});
});

test("two simultaneous retenir: both keys present", async () => {
  const d = await tempFolder();
  const m = await open(d);
  await Promise.all([
    Promise.resolve().then(() => m.keep("cadre1", 1, null)),
    Promise.resolve().then(() => m.keep("cadre2", 2, null)),
  ]);
  await m.clear();
  const m2 = await open(d);
  expect([m2.read("cadre1"), m2.read("cadre2")]).toEqual([1, 2]);
});

test("erase: file absent, content empty, pending write cancelled, onChange notified", async () => {
  const d = await tempFolder();
  const m = await open(d);
  m.keep("a", 1, null);
  await m.clear();
  expect(await exists(file(d))).toBe(true);
  m.keep("b", 2, null);
  let calls = 0;
  const stop = m.onChange(() => calls++);
  await m.erase();
  expect(calls).toBe(1);
  expect(m.content()).toEqual({ version: 1, values: {}, positions: {} });
  expect(await exists(file(d))).toBe(false);
  await sleep(MEMORY_WRITE_MS + 300);
  expect(await exists(file(d))).toBe(false);
  stop();
  m.keep("c", 3, null);
  expect(calls).toBe(1);
});

test("onChange is notified on retenir, oublier, noterPosition", async () => {
  const m = await open(await tempFolder());
  let calls = 0;
  m.onChange(() => calls++);
  m.keep("a", 1, null);
  m.notePosition("/v", 10, 2400);
  m.forget("a");
  expect(calls).toBe(3);
});

const nested = (n: number) => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
const size = (m: SiteMemory) => Buffer.byteLength(JSON.stringify(m.content()));

test("deeply nested, cyclic or reference-bomb value: refusal without an exception", async () => {
  const m = await open(await tempFolder());
  expect(MEMORY_DEPTH_MAX).toBe(32);
  expect(m.keep("ok", nested(32), null)).toEqual({ ok: true });
  expect(m.keep("trop", nested(33), null)).toMatchObject({ ok: false });
  expect(m.keep("abime", nested(7000), null)).toMatchObject({ ok: false });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(m.keep("cycle", cycle, null)).toMatchObject({ ok: false });
  let bomb: unknown = [1];
  for (let i = 0; i < 40; i++) bomb = [bomb, bomb];
  const t0 = Date.now();
  expect(m.keep("bombe", bomb, null)).toMatchObject({ ok: false });
  expect(Date.now() - t0).toBeLessThan(500);
  const trap = { get x(): number { throw new Error("piège"); } };
  expect(m.keep("piege", trap, null)).toMatchObject({ ok: false });
  expect(() => m.notePosition("/" + "x".repeat(5000), 1, 100)).not.toThrow();
  expect(m.read("trop")).toBeNull();
});

test("noterPosition refuses a position that does not fit and keeps the total under 256 KB", async () => {
  const m = await open(await tempFolder());
  expect(m.keep("gros", "x".repeat(SITE_MEMORY_SIZE - 250), null)).toEqual({ ok: true });
  m.notePosition("/" + "y".repeat(2000), 10, 100);
  expect(m.position("/" + "y".repeat(2000))).toBeNull();
  expect(size(m)).toBeLessThanOrEqual(SITE_MEMORY_SIZE);
});

test("eviction follows when, never the key order, and keeps the written position", async () => {
  const m = await open(await tempFolder());
  m.notePosition("b", 10, 100);
  m.notePosition("5", 10, 100);
  expect(m.keep("gros", "x".repeat(SITE_MEMORY_SIZE - 180), null)).toEqual({ ok: true });
  expect(m.position("b")).toBeNull();
  expect(m.position("5")).not.toBeNull();
  m.notePosition("c", 10, 100);
  expect(m.position("c")).not.toBeNull();
  expect(m.position("5")).toBeNull();
  expect(size(m)).toBeLessThanOrEqual(SITE_MEMORY_SIZE);
});

test("a retenir at the limit with 500 positions stays fast", async () => {
  const m = await open(await tempFolder());
  for (let i = 0; i < 500; i++) m.notePosition(`/v/${i}-${"x".repeat(100)}`, 10, 100);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) m.keep("gros", "x".repeat(SITE_MEMORY_SIZE - 40000 + i), null);
  expect((performance.now() - t0) / 20).toBeLessThan(15);
});

test("a re-read file is brought back to the bounds", async () => {
  const d = await tempFolder();
  await mkdir(join(d, "s"), { recursive: true });
  const values: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) values[`k${i}`] = { value: "x".repeat(100_000), url: null, when: "2026-01-01T00:00:00Z" };
  values.profond = { value: nested(40), url: null, when: "q" };
  const positions: Record<string, unknown> = {};
  for (let i = 0; i < 700; i++) positions[`/p${i}`] = { t: 1, duration: 100, when: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
  await writeFile(file(d), JSON.stringify({ version: 1, values: values, positions }));
  const m = await open(d);
  expect(size(m)).toBeLessThanOrEqual(SITE_MEMORY_SIZE);
  expect(m.read("profond")).toBeNull();
  expect(m.read("k0")).not.toBeNull();
  expect(m.read("k3")).toBeNull();
  expect(Object.keys(m.content().positions).length).toBeLessThanOrEqual(POSITIONS_MAX);
});

test("contenu() and lire() return copies", async () => {
  const m = await open(await tempFolder());
  m.keep("a", { x: [1] }, null);
  m.notePosition("/v", 5, 100);
  const c = m.content();
  (c.values.a!.value as { x: number[] }).x.push(2);
  delete c.positions["/v"];
  c.values.zzz = { value: 1, url: null, when: "q" };
  (m.read("a") as { x: number[] }).x.push(3);
  expect(m.read("a")).toEqual({ x: [1] });
  expect(m.position("/v")).not.toBeNull();
  expect(m.read("zzz")).toBeNull();
});

test("huge value: refusal before any JSON.parse", async () => {
  const m = await open(await tempFolder());
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(m.keep("a", "x".repeat(5_000_000), null)).toEqual({ ok: false, error: MEMORY_FULL });
    expect(m.keep("b", Array.from({ length: 300_000 }, () => 1), null)).toEqual({ ok: false, error: MEMORY_FULL });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test("write failure: the data stays and vider() retries", async () => {
  const d = await tempFolder();
  await writeFile(join(d, "s"), "je suis un fichier");
  const m = await open(d);
  m.keep("a", 1, null);
  await m.clear();
  m.keep("b", 2, null);
  await rm(join(d, "s"));
  await m.clear();
  const raw = JSON.parse(await readFile(file(d), "utf8"));
  expect([raw.values.a.value, raw.values.b.value]).toEqual([1, 2]);
});

test("unknown version: read as empty, saved as .bak, not overwritten", async () => {
  const d = await tempFolder();
  await mkdir(join(d, "s"), { recursive: true });
  const future = JSON.stringify({ version: 2, other: "forme" });
  await writeFile(file(d), future);
  const m = await open(d);
  expect(m.content().values).toEqual({});
  expect(await readFile(join(d, "s", "memory.json.v2.bak"), "utf8")).toBe(future);
  m.keep("a", 1, null);
  await m.clear();
  expect(JSON.parse(await readFile(file(d), "utf8")).version).toBe(1);
  expect(await readFile(join(d, "s", "memory.json.v2.bak"), "utf8")).toBe(future);
});

test("unknown version twice: the first .bak backup is not overwritten", async () => {
  const d = await tempFolder();
  await mkdir(join(d, "s"), { recursive: true });
  const one = JSON.stringify({ version: 2, n: 1 });
  const two = JSON.stringify({ version: 2, n: 2 });
  await writeFile(file(d), one);
  await open(d);
  await writeFile(file(d), two);
  await open(d);
  expect(await readFile(join(d, "s", "memory.json.v2.bak"), "utf8")).toBe(one);
  expect(await readFile(join(d, "s", "memory.json.v2.1.bak"), "utf8")).toBe(two);
});
