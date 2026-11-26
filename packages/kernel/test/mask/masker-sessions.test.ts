import { expect, it } from "vitest";
import { Masker } from "../../src/mask/masker.js";
import { LABELS } from "../../src/mask/table.js";

it("two sessions on one window mask with their own tables", () => {
  const m = new Masker();
  m.open("s1", "w");
  m.open("s2", "w");
  const value = "camille.aubrac@example.com";
  const masked = m.maskTypedFor("s1", value);
  const label = [...masked.text.matchAll(LABELS)][0]![0];
  expect(masked.text).not.toContain(value);
  expect(masked.names.length).toBe(1);
  const found = m.lookupForSession("s1", label)!;
  expect(found.type).toBe("email");
  expect(masked.text.replace(label, found.value)).toBe(value);
  expect(m.lookupForSession("s2", label)).toBeNull();
  m.close("s2");
  expect(m.lookupForSession("s1", label)).toEqual(found);
});

it("uncoveredCauseOf reads the session's own cause, not the window's last session", () => {
  const m = new Masker();
  m.open("s1", "w", { uncovered: true });
  m.open("s2", "w");
  m.markUncovered("s2", [{ profile: "p", id: "a" }]);
  expect(m.uncoveredCauseOf("s1")).toEqual({ resumed: true, passport: [] });
  expect(m.uncoveredCauseOf("s2")).toEqual({ resumed: false, passport: [{ profile: "p", id: "a" }] });
  expect(m.uncoveredCauseOf("gone")).toEqual({ resumed: false, passport: [] });
  expect(m.lookupForSession("gone", "anything")).toBeNull();
});

it("maskTypedFor refuses an unknown or closed session instead of masking into the main table", () => {
  const m = new Masker();
  m.open("s1", "w");
  m.close("s1");
  expect(() => m.maskTypedFor("s1", "camille.aubrac@example.com")).toThrow();
  expect(() => m.maskTypedFor("never", "x")).toThrow();
  expect(m.table(null).touched).toBe(false);
});

it("closing one of a window's sessions leaves the window on another one still open", () => {
  const m = new Masker();
  m.open("s1", "w");
  m.open("s2", "w");
  m.open("s3", "x");
  m.close("s2");
  expect(m.sessionOf("w")).toBe("s1");
  m.close("s1");
  expect(m.sessionOf("w")).toBeNull();
  expect(m.sessionOf("x")).toBe("s3");
});
