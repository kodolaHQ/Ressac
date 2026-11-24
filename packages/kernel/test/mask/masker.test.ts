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
