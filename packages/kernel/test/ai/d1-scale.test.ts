import { describe, expect, it } from "vitest";
import { D1_ANCHORS, toPplxScale } from "../../src/ai/d1-scale.js";

const noul = (v: unknown) => (toPplxScale({ q: { noul: v } }) as { q: { noul: number } }).q.noul;

describe("toPplxScale", () => {
  it("maps each anchor onto its pplx value", () => {
    for (const [d, p] of D1_ANCHORS) expect(noul(d)).toBeCloseTo(p, 6);
  });

  it("is increasing between anchors", () => {
    const out = Array.from({ length: 101 }, (_, i) => noul(i / 100));
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]!);
    expect(out[0]).toBe(0);
    expect(out[100]).toBe(1);
  });

  it("leaves non-numbers alone and clamps", () => {
    expect(toPplxScale({ q: { noul: null } })).toEqual({ q: { noul: null } });
    expect(toPplxScale({ q: { noul: "0.4" } })).toEqual({ q: { noul: "0.4" } });
    expect(toPplxScale({ q: {} })).toEqual({ q: {} });
    expect(noul(-0.2)).toBe(0);
    expect(noul(1.3)).toBe(1);
    expect(noul(NaN)).toBeNaN();
    expect(toPplxScale(null)).toBeNull();
    expect(toPplxScale("x")).toBe("x");
  });
});
