import { describe, expect, it } from "vitest";
import { ending, runsForAll, shorten, undoWindow, UNDO_MS } from "../chrome/window/hide-layer";

// « Cacher pour l'agent »: the honest ending says what is true now (hatching only when the agent does not see it).
describe("ending", () => {
  const run = (start: number, end: number) => ({ start, end, type: "nom" as const });
  const o = { agentReached: false, length: 14, siteMatches: true };

  it("an agent-reached tab ends on agentReached, even when the runs cover the value", () => {
    expect(ending({ ...o, agentReached: true, runs: [run(0, 14)] })).toBe("agentReached");
  });

  it("runs covering the whole value end on hidden, in one run or adjacent ones, with or without a site", () => {
    expect(ending({ ...o, runs: [run(0, 14)] })).toBe("hidden");
    expect(ending({ ...o, runs: [run(0, 7), run(7, 14)] })).toBe("hidden");
    expect(ending({ ...o, siteMatches: false, runs: [run(0, 14)] })).toBe("hidden");
  });

  it("partial or no coverage, with the page's site on the entry, ends on next", () => {
    expect(ending({ ...o, runs: [] })).toBe("next");
    expect(ending({ ...o, runs: [run(0, 7)] })).toBe("next");
    expect(ending({ ...o, runs: [run(0, 7), run(8, 14)] })).toBe("next");
    expect(ending({ ...o, runs: [run(1, 14)] })).toBe("next");
    expect(ending({ ...o, length: 0, runs: [] })).toBe("next");
  });

  it("partial or no coverage without a matching site ends on notHere", () => {
    expect(ending({ ...o, siteMatches: false, runs: [] })).toBe("notHere");
    expect(ending({ ...o, siteMatches: false, runs: [run(0, 7)] })).toBe("notHere");
  });
});

describe("undoWindow", () => {
  it("gives the kept hide once within 8 s; after 8 s, nothing", () => {
    let t = 1000;
    const w = undoWindow<string>(UNDO_MS, () => t);
    w.open("a");
    t += UNDO_MS;
    expect(w.take()).toBe("a");
    expect(w.take()).toBe(null);
    w.open("b");
    t += UNDO_MS + 1;
    expect(w.take()).toBe(null);
    w.open("c");
    w.clear();
    expect(w.take()).toBe(null);
  });
});

describe("shorten", () => {
  it("keeps up to 60 characters, cuts longer ones as start…end", () => {
    expect(shorten("Camille Aubrac")).toBe("Camille Aubrac");
    const long = "a".repeat(40) + "b".repeat(40);
    const s = shorten(long);
    expect(s.length).toBe(60);
    expect(s.startsWith("aaaa") && s.endsWith("bbbb") && s.includes("…")).toBe(true);
  });
});

// The ending and the marks share one rule: `hidden` only when every window with a conversation masks the value.
describe("runsForAll", () => {
  const p = { tab: "t1", url: "https://banque.example/", agentReached: false, text: "Camille Aubrac" };
  const answers = (by: Record<string, unknown>) => async (_m: string, q: unknown) => {
    const a = by[(q as { window: string }).window];
    if (a instanceof Error) throw a;
    return a;
  };
  const name = [{ start: 0, end: 14, type: "nom" }];

  it("one window masks, another (with a session) does not: no run, so the ending is not hidden", async () => {
    const runs = await runsForAll(answers({ f1: { runs: [name] }, f2: { runs: [[]] } }), ["f1", "f2"], p);
    expect(runs).toEqual([]);
    expect(ending({ agentReached: false, runs, length: 14, siteMatches: true })).toBe("next");
  });

  it("a window without a session is left out; a failed answer masks nothing", async () => {
    expect(await runsForAll(answers({ f1: { runs: [name] }, f2: { runs: null } }), ["f1", "f2"], p)).toEqual([{ start: 0, end: 14 }]);
    expect(await runsForAll(answers({ f1: { runs: [name] }, f2: new Error("down") }), ["f1", "f2"], p)).toEqual([]);
    expect(await runsForAll(answers({ f1: { runs: null } }), ["f1"], p)).toEqual([]);
  });
});
