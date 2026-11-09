import { describe, expect, it } from "vitest";
import { PREVIEW_MAX, resultsPreview, emptyResults } from "../../src/pages/preview.js";

const ticket = (i: number) => ({ title: `Ticket ${i} ` + "x".repeat(200), priority: "haute", url: `https://gitlab.com/t/${i}` });

describe("resultsPreview", () => {
  it("describes the shape of a list of objects and keeps 3 examples", () => {
    const a = JSON.parse(resultsPreview({ tickets: Array.from({ length: 23 }, (_, i) => ticket(i)) }));
    expect(a.shape.tickets).toBe("liste (23) d'objets { title: texte, priority: texte, url: texte }");
    expect(a.examples.tickets).toHaveLength(3);
    expect(a.examples.tickets[0].title.length).toBeLessThanOrEqual(121);
  });

  it("2 MB of results: preview ≤ 6,000 characters, the tickets shape remains", () => {
    const big = { tickets: Array.from({ length: 10_000 }, (_, i) => ticket(i)), text: "y".repeat(2_000_000) };
    const s = resultsPreview(big);
    expect(s.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(JSON.parse(s).shape.tickets).toContain("liste (10000) d'objets");
  });

  it("a 100,000-character text is cut to 120", () => {
    const a = JSON.parse(resultsPreview({ page: "z".repeat(100_000) }));
    expect(a.examples.page.length).toBeLessThanOrEqual(121);
    expect(a.examples.page.startsWith("zzz")).toBe(true);
  });

  it("30 nesting levels: bounded, no error", () => {
    let v: unknown = "fond";
    for (let i = 0; i < 30; i++) v = { a: v };
    const s = resultsPreview(v);
    expect(s.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it("hundreds of wide keys stay bounded, and __proto__ is a key like any other", () => {
    const large: Record<string, unknown> = JSON.parse('{"__proto__": {"x": 1}}');
    for (let i = 0; i < 500; i++) large["cle" + i + "é".repeat(50)] = { n: i, list: [1, 2, 3, 4] };
    const s = resultsPreview(large);
    expect(s.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(() => JSON.parse(s)).not.toThrow();
  });
});

describe("emptyResults", () => {
  it("null, texte vide, [], {}, objets de vides : vrais ; { total: 0 } faux", () => {
    expect(emptyResults(null)).toBe(true);
    expect(emptyResults("")).toBe(true);
    expect(emptyResults([])).toBe(true);
    expect(emptyResults({})).toBe(true);
    expect(emptyResults({ tickets: [], a: { b: "" } })).toBe(true);
    expect(emptyResults({ total: 0 })).toBe(false);
    expect(emptyResults({ a: [1] })).toBe(false);
  });
});
