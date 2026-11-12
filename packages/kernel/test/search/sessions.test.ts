import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SearchSessions, type Band } from "../../src/search/sessions.js";

let clock = 1000;
let shown: Array<[string, Band | null]>;
let s: SearchSessions;
const last = () => shown[shown.length - 1]![1];

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1000;
  shown = [];
  s = new SearchSessions({ show: (t, b) => shown.push([t, b]), now: () => clock, idleMs: 120_000 });
  s.setEngineOrigin("https://engine.test");
});
afterEach(() => {
  s.reset();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("SearchSessions", () => {
  test("start, step, idle: the band goes working → idle, and null after 120 s without a call", async () => {
    s.start("w", "t1", "goal");
    expect(s.owns("t1")).toBe(true);
    let during: Band | null = null;
    await s.step("t1", "Je cherche", async () => { during = last(); });
    expect(during).toEqual({ state: "working", text: "Je cherche", pages: 0, startedAt: 1000 });
    expect(last()).toEqual({ state: "idle", text: "Je cherche", pages: 0, startedAt: 1000 });
    vi.advanceTimersByTime(119_999);
    expect(s.current("w")).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(last()).toBeNull();
    expect(s.current("w")).toBeUndefined();
    expect(s.takeStop("w")).toBe(false);
  });

  test("a second start in the same window throws; another window has its own search", () => {
    s.start("w", "t1", "g");
    expect(() => s.start("w", "t2", "g")).toThrow();
    s.start("w2", "t2", "g");
    expect(s.current("w2")?.tabId).toBe("t2");
  });

  test("isFree: the engine's origin and links read in this search are free, the fragment is ignored, any other address is not; a new search forgets them", () => {
    s.start("w", "t1", "g");
    s.pageRead("t1", "https://a.test/page", ["https://b.test/x#frag"]);
    expect(s.isFree("t1", "https://engine.test/search?q=1")).toBe(true);
    expect(s.isFree("t1", "https://a.test/page#top")).toBe(true);
    expect(s.isFree("t1", "https://b.test/x")).toBe(true);
    expect(s.isFree("t1", "https://c.test/")).toBe(false);
    s.dismiss("t1");
    s.start("w", "t1", "g");
    expect(s.isFree("t1", "https://b.test/x")).toBe(false);
    expect(s.isFree("t1", "https://engine.test/")).toBe(true);
  });

  test("pageRead after a redirect frees the arrival page's links", () => {
    s.start("w", "t1", "g");
    s.pageRead("t1", "https://arrival.test/final", ["https://next.test/"]);
    expect(s.isFree("t1", "https://next.test/")).toBe(true);
    expect(s.isFree("t1", "https://arrival.test/final")).toBe(true);
  });

  test("handOver resolves \"continue\" with the URLs navigated meanwhile, at most 20, and frees the last one", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "À vous");
    expect(last()?.state).toBe("yours");
    for (let i = 0; i < 25; i++) s.tabNavigated("t1", `https://n.test/${i}`);
    s.continue("t1");
    const r = await p;
    expect(r.outcome).toBe("continue");
    expect(r.path).toHaveLength(20);
    expect(r.path[19]).toBe("https://n.test/24");
    expect(s.isFree("t1", "https://n.test/24")).toBe(true);
    expect(s.isFree("t1", "https://n.test/23")).toBe(false);
    expect(last()?.state).toBe("idle");
  });

  test("a hand-over never times out by idleness", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "À vous");
    vi.advanceTimersByTime(500_000);
    expect(s.current("w")).toBeDefined();
    s.continue("t1");
    await p;
  });

  test("URLs navigated outside a hand-over are not in the next path", async () => {
    s.start("w", "t1", "g");
    s.tabNavigated("t1", "https://before.test/");
    const p = s.handOver("t1", "À vous");
    s.tabNavigated("t1", "https://during.test/");
    s.continue("t1");
    expect((await p).path).toEqual(["https://during.test/"]);
    s.tabNavigated("t1", "https://after.test/");
    const p2 = s.handOver("t1", "À vous");
    s.continue("t1");
    expect((await p2).path).toEqual([]);
  });

  test("stop during handOver resolves \"stop\"; stop with a call in flight makes takeStop true once, then false; the band is null", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "À vous");
    s.stop("t1");
    expect((await p).outcome).toBe("stop");
    expect(last()).toBeNull();
    expect(s.takeStop("w")).toBe(true);
    expect(s.takeStop("w")).toBe(false);

    s.start("w", "t1", "g");
    let release!: () => void;
    const call = s.step("t1", "x", () => new Promise<string>((r) => { release = () => r("res"); }));
    s.stop("t1");
    release();
    expect(await call).toBe("res");
    expect(last()).toBeNull();
    expect(s.takeStop("w")).toBe(true);
    expect(s.takeStop("w")).toBe(false);
  });

  test("a start clears the stop tombstone", () => {
    s.start("w", "t1", "g");
    s.stop("t1");
    s.start("w", "t1", "g");
    expect(s.takeStop("w")).toBe(false);
  });

  test("tabClosed during handOver resolves \"closed\" and ends the search", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "À vous");
    s.tabClosed("t1");
    expect((await p).outcome).toBe("closed");
    expect(s.current("w")).toBeUndefined();
    expect(last()).toBeNull();
  });

  test("reset during handOver resolves \"stop\" and removes the band", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "À vous");
    s.reset();
    expect((await p).outcome).toBe("stop");
    expect(last()).toBeNull();
    expect(s.owns("t1")).toBe(false);
  });

  test("dismiss ends an idle search", () => {
    s.start("w", "t1", "g");
    s.dismiss("t1");
    expect(last()).toBeNull();
    expect(s.current("w")).toBeUndefined();
    expect(s.takeStop("w")).toBe(false);
  });

  test("log records gestures; goal and gestures are gone once the search ends", () => {
    s.start("w", "t1", "g");
    s.log("t1", { tool: "search", query: "q" });
    expect(s.current("w")).toEqual({ tabId: "t1", goal: "g", gestures: [{ tool: "search", query: "q" }] });
    s.dismiss("t1");
    expect(s.current("w")).toBeUndefined();
    s.start("w", "t1", "g2");
    expect(s.current("w")?.gestures).toEqual([]);
  });

  test("a second handOver returns the pending promise", async () => {
    s.start("w", "t1", "g");
    const a = s.handOver("t1", "first");
    const b = s.handOver("t1", "second");
    expect(last()?.text).toBe("first");
    s.continue("t1");
    expect(await a).toEqual(await b);
  });

  test("concurrent steps: idle and the idle timer only when the last one ends", async () => {
    s.start("w", "t1", "g");
    let r1!: () => void, r2!: () => void;
    const a = s.step("t1", "a", () => new Promise<void>((r) => { r1 = r; }));
    const b = s.step("t1", "b", () => new Promise<void>((r) => { r2 = r; }));
    r1(); await a;
    expect(last()?.state).toBe("working");
    vi.advanceTimersByTime(500_000);
    expect(s.current("w")).toBeDefined();
    r2(); await b;
    expect(last()?.state).toBe("idle");
    vi.advanceTimersByTime(120_000);
    expect(s.current("w")).toBeUndefined();
  });

  test("a hand-over begun inside a step keeps its band", async () => {
    s.start("w", "t1", "g");
    let hand!: Promise<unknown>;
    await s.step("t1", "x", async () => { hand = s.handOver("t1", "À vous"); });
    expect(last()?.state).toBe("yours");
    s.continue("t1");
    await hand;
  });

  test("start throws when the tab already belongs to a search of another window", () => {
    s.start("w", "t1", "g");
    expect(() => s.start("w2", "t1", "g")).toThrow();
  });

  test("tabNavigated caps the path while pushing", async () => {
    s.start("w", "t1", "g");
    const p = s.handOver("t1", "x");
    for (let i = 0; i < 1000; i++) s.tabNavigated("t1", `https://n.test/${i}`);
    s.continue("t1");
    const r = await p;
    expect(r.path).toHaveLength(20);
    expect(r.path[0]).toBe("https://n.test/980");
  });

  test("only http(s) addresses up to 500 characters become free", () => {
    s.start("w", "t1", "g");
    s.pageRead("t1", "javascript:alert(1)", ["file:///etc/passwd", "https://ok.test/" + "a".repeat(500), "https://ok.test/fine"]);
    s.allow("t1", "data:text/html,x");
    expect(s.isFree("t1", "javascript:alert(1)")).toBe(false);
    expect(s.isFree("t1", "file:///etc/passwd")).toBe(false);
    expect(s.isFree("t1", "data:text/html,x")).toBe(false);
    expect(s.isFree("t1", "https://ok.test/" + "a".repeat(500))).toBe(false);
    expect(s.isFree("t1", "https://ok.test/fine")).toBe(true);
  });

  test("engine origin: userinfo, subdomain lookalike, other port and other scheme are not free; a path is normalised", () => {
    s.start("w", "t1", "g");
    for (const u of ["https://engine@evil.example/", "https://engine.test.evil.example/", "https://sub.engine.test/", "https://engine.test:8443/", "http://engine.test/"])
      expect(s.isFree("t1", u)).toBe(false);
    s.setEngineOrigin("https://other.test/some/path?x=1");
    expect(s.isFree("t1", "https://other.test/anything")).toBe(true);
    expect(s.isFree("t1", "https://engine.test/")).toBe(false);
  });
});
