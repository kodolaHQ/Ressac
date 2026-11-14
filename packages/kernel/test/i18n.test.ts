import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { say } from "../src/i18n.js";

// The script is plain .mjs (run by node, no types): loaded dynamically.
const { generate } = (await import(join(import.meta.dirname, "../scripts/locales.mjs"))) as { generate(): string };

test("say follows the locale, falls back to English, then to the id", () => {
  expect(say("fr", "kernel-test", { n: 2 })).toBe("2 éléments");
  expect(say("fr", "kernel-test", { n: 1 })).toBe("1 élément");
  expect(say("de", "kernel-test", { n: 2 })).toBe("2 items");
  expect(say("fr", "nope")).toBe("nope");
});

test("messages.ts is up to date with locales/", () => {
  expect(readFileSync(join(import.meta.dirname, "../src/i18n/messages.ts"), "utf8")).toBe(generate());
});

test("a message formatted with a missing variable returns text and does not throw", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => say("en", "kernel-grant-widget-unknown")).not.toThrow();
  expect(say("en", "kernel-grant-widget-unknown")).toContain("Unknown widget");
  expect(spy).toHaveBeenCalled();
  spy.mockRestore();
});
