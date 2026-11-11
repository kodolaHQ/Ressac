import { expect, test } from "vitest";
import { bindingLabel, bindingProblem, effectiveBindings, SHORTCUTS, type Binding } from "../shared/shortcuts";

const cmd = (key: string, shift = false): Binding => ({ key, shift, alt: false, ctrl: false, meta: true });
const eff = effectiveBindings({});

test("defaults are never problems", () => {
  for (const id of Object.keys(SHORTCUTS) as (keyof typeof SHORTCUTS)[]) expect(bindingProblem(id, SHORTCUTS[id].default, eff)).toBeNull();
});

test("bindingProblem refuses reserved, taken and modifier-less bindings", () => {
  const reserved = "Réservé par macOS ou l'édition de texte";
  expect(bindingProblem("agent", cmd("c"), eff)).toBe(reserved);
  expect(bindingProblem("agent", cmd("z", true), eff)).toBe(reserved);
  expect(bindingProblem("agent", cmd("Digit3"), eff)).toBe(reserved);
  expect(bindingProblem("agent", cmd("k"), eff)).toBeNull();
  expect(bindingProblem("agent", cmd("t"), eff)).toBe("Déjà utilisé par Barre de commande");
  expect(bindingProblem("agent", { key: "k", shift: true, alt: true, ctrl: false, meta: false }, eff)).not.toBeNull();
});

test("bindingLabel uses the macOS order", () => {
  expect(bindingLabel(cmd("d", true))).toBe("⇧⌘D");
  expect(bindingLabel({ key: "Digit2", shift: false, alt: true, ctrl: true, meta: true })).toBe("⌃⌥⌘2");
});
