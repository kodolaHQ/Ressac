import { describe, expect, it } from "vitest";
import { ending, shorten } from "../chrome/window/hide-layer";

// « Cacher pour l'agent »: the honest ending says what is true now (hatching only when the agent does not see it).
describe("ending", () => {
  const run = (start: number, end: number) => ({ start, end, type: "nom" as const });

  it("an agent-reached tab ends on agentReached, even when the runs cover the text", () => {
    expect(ending({ agentReached: true, runs: [run(0, 14)], length: 14 })).toBe("agentReached");
  });

  it("runs covering the whole text end on hidden, in one run or adjacent ones", () => {
    expect(ending({ agentReached: false, runs: [run(0, 14)], length: 14 })).toBe("hidden");
    expect(ending({ agentReached: false, runs: [run(0, 7), run(7, 14)], length: 14 })).toBe("hidden");
  });

  it("partial or no coverage ends on next", () => {
    expect(ending({ agentReached: false, runs: [], length: 14 })).toBe("next");
    expect(ending({ agentReached: false, runs: [run(0, 7)], length: 14 })).toBe("next");
    expect(ending({ agentReached: false, runs: [run(0, 7), run(8, 14)], length: 14 })).toBe("next");
    expect(ending({ agentReached: false, runs: [run(1, 14)], length: 14 })).toBe("next");
    expect(ending({ agentReached: false, runs: [], length: 0 })).toBe("next");
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
