import { expect, test } from "vitest";
import { bindingFromKey, bindingLabel, bindingProblem, effectiveBindings, SHORTCUTS, type Binding } from "../shared/shortcuts";

const cmd = (key: string, shift = false): Binding => ({ key, shift, alt: false, ctrl: false, meta: true });
const eff = effectiveBindings({});

test("defaults are never problems", () => {
  for (const id of Object.keys(SHORTCUTS) as (keyof typeof SHORTCUTS)[]) expect(bindingProblem(id, SHORTCUTS[id].default, eff)).toBeNull();
});

test("bindingProblem refuses reserved, taken and modifier-less bindings", () => {
  const reserved = { problem: "reserved" };
  expect(bindingProblem("agent", cmd("c"), eff)).toEqual(reserved);
  expect(bindingProblem("agent", cmd("z", true), eff)).toEqual(reserved);
  expect(bindingProblem("agent", cmd("Digit3"), eff)).toEqual(reserved);
  expect(bindingProblem("agent", cmd("k"), eff)).toBeNull();
  expect(bindingProblem("agent", cmd("t"), eff)).toEqual({ problem: "taken", by: "command" });
  expect(bindingProblem("agent", { key: "k", shift: true, alt: true, ctrl: false, meta: false }, eff)).not.toBeNull();
});

test("bindingLabel uses the macOS order", () => {
  expect(bindingLabel(cmd("d", true))).toBe("⇧⌘D");
  expect(bindingLabel({ key: "Digit2", shift: false, alt: true, ctrl: true, meta: true })).toBe("⌃⌥⌘2");
});

test("bindingProblem refuses macOS text-editing, system and tab-switch keys", () => {
  const reserved = { problem: "reserved" };
  const k = (key: string, m: Partial<Binding>): Binding => ({ key, shift: false, alt: false, ctrl: false, meta: false, ...m });
  for (const key of ["arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"])
    for (const m of [{ meta: true }, { meta: true, shift: true }, { meta: true, alt: true }, { meta: true, shift: true, alt: true }])
      expect(bindingProblem("history", k(key, m), eff), `${key} ${JSON.stringify(m)}`).toEqual(reserved);
  for (const key of [..."aebfnpdhk", "arrowleft", "arrowup"]) {
    expect(bindingProblem("history", k(key, { ctrl: true }), eff), key).toEqual(reserved);
    expect(bindingProblem("history", k(key, { ctrl: true, shift: true }), eff), key).toEqual(reserved);
  }
  expect(bindingProblem("history", k("k", { ctrl: true, meta: true }), eff)).toBeNull();
  expect(bindingProblem("history", k("f", { ctrl: true, meta: true }), eff)).toEqual(reserved);
  expect(bindingProblem("history", k(" ", { ctrl: true, meta: true }), eff)).toEqual(reserved);
  expect(bindingProblem("history", k("u", { ctrl: true }), eff)).toBeNull();
  // Keys the window consumes before reading the bindings (keys.ts): a binding there would never fire.
  expect(bindingProblem("history", k("{", { meta: true, shift: true }), eff)).toEqual(reserved);
  expect(bindingProblem("history", k("}", { meta: true, shift: true }), eff)).toEqual(reserved);
  expect(bindingProblem("history", k("pagedown", { ctrl: true }), eff)).toEqual(reserved);
});

test("bindingFromKey reads digits and the zoom keys on the physical key (AZERTY)", () => {
  const e = (key: string, code: string) => ({ key, code, shiftKey: false, altKey: false, ctrlKey: false, metaKey: true });
  expect(bindingFromKey(e("&", "Digit1")).key).toBe("Digit1");
  expect(bindingFromKey(e("à", "Digit0")).key).toBe("0");
  expect(bindingProblem("history", bindingFromKey(e("à", "Digit0")), eff)).toEqual({ problem: "reserved" });
  expect(bindingFromKey(e("K", "KeyK")).key).toBe("k");
});
