import { describe, expect, it } from "vitest";
import { Masker } from "../../src/mask/masker.js";
import { PassportStore } from "../../src/mask/passport.js";

/** The window's banner says « non couverte ». */
const uncovered = (m: Pick<Masker, "uncoveredCause">, win: string) => {
  const c = m.uncoveredCause(win);
  return c.resumed || c.passport.length > 0;
};

describe("Masker and the passport", () => {
  it("gives its store to every table, the main token's included", () => {
    const passport = new PassportStore();
    const m = new Masker({ passport });
    m.open("s1", "w1");
    expect(m.passport).toBe(passport);
    expect(m.table("s1").passport).toBe(passport);
    expect(m.table(null).passport).toBe(passport);
    expect(new Masker().table(null).passport).toBeUndefined();
  });

  it("marks a session uncovered", () => {
    const m = new Masker();
    let changes = 0;
    m.onChange(() => changes++);
    m.open("s1", "w1");
    m.open("s2", "w2");
    m.markUncovered("s1", [{ profile: "p", id: "a" }]);
    m.markUncovered("gone", [{ profile: "p", id: "a" }]);
    expect(uncovered(m, "w1")).toBe(true);
    expect(uncovered(m, "w2")).toBe(false);
    expect(changes).toBe(3);
  });

  it("keeps, per session, the passport entries (profile and id only) that marked it, apart from a resume's cause", () => {
    const m = new Masker();
    m.open("s1", "w1");
    m.open("s2", "w2", { uncovered: true });
    m.markUncovered("s1", [{ profile: "p", id: "a" }]);
    m.markUncovered("s1", [{ profile: "p", id: "a" }, { profile: "p", id: "b" }]);
    expect(m.uncoveredCause("w1")).toEqual({ resumed: false, passport: [{ profile: "p", id: "a" }, { profile: "p", id: "b" }] });
    expect(m.uncoveredCause("w2")).toEqual({ resumed: true, passport: [] });
    expect(m.uncoveredCause("w3")).toEqual({ resumed: false, passport: [] });
    m.close("s1");
    m.open("s3", "w1");
    expect(m.uncoveredCause("w1")).toEqual({ resumed: false, passport: [] });
  });

  it("lists only the sessions whose table was touched", () => {
    const m = new Masker();
    m.open("s1", "w1");
    m.open("s2", "w2");
    m.table("s2").touched = true;
    m.table(null).touched = true;
    expect(m.touchedSessions()).toEqual(["s2"]);
  });
});

describe("Masker.peekOrigins (chrome's mask.runs)", () => {
  const entry = (id: string, origins: string[]) => ({ id, field: "nom" as const, value: { given: "Camille", family: "Aubrac" }, variants: [], origins, how: "click" as const, created: "", updated: "" });
  it("does not take the snapshot: a site added after a peek still counts at the first tool call; after it, the peek gives the snapshot", () => {
    const passport = new PassportStore();
    const m = new Masker({ passport });
    m.open("s1", "w1");
    passport.replace("p", [entry("a", ["a.example"])]);
    expect(m.peekOrigins("s1")?.isOrigin("https://b.example/")).toBe(false);
    passport.replace("p", [entry("a", ["a.example", "b.example"])]);
    // The first tool call's snapshot includes the site added after the peek.
    expect(m.originsOf("s1")?.isOrigin("https://b.example/")).toBe(true);
    passport.replace("p", [entry("a", ["a.example", "b.example", "c.example"])]);
    expect(m.peekOrigins("s1")?.isOrigin("https://c.example/")).toBe(false);
    expect(m.originsOf("s1")?.isOrigin("https://c.example/")).toBe(false);
  });
});
