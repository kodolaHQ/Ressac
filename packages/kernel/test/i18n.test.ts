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

test("the search band and the outflow speak the user's language", async () => {
  const { OUTFLOW_PAUSE } = await import("../src/mcp/server.js");
  expect(say("fr", "kernel-search-reading-pages", { total: 1, done: 0 })).toBe("Lecture de 1 page, 0 faite");
  expect(say("fr", "kernel-search-reading-pages", { total: 3, done: 2 })).toBe("Lecture de 3 pages, 2 faites");
  expect(say("en", "kernel-search-reading-pages", { total: 1, done: 0 })).toBe("Reading 1 page, 0 done");
  expect(say("en", "kernel-activity-reads-pages", { n: 2 })).toBe("Reading 2 pages");
  const hit = { kind: "iban", masked: "FR76••••89", source: say("en", "kernel-outflow-source-history") } as const;
  expect(OUTFLOW_PAUSE("en", hit)).toBe("The watcher paused: the search contains an IBAN, from your history (FR76••••89)");
  expect(OUTFLOW_PAUSE("fr", { ...hit, source: say("fr", "kernel-outflow-source-history") })).toBe(
    "Le surveillant a mis en pause : la recherche contient un IBAN, lu dans votre historique (FR76••••89)",
  );
});
