import { expect, test } from "vitest";
import { toUrl } from "../core/adresse";

test.each([
  ["https://github.com", "https://github.com/"],
  ["github.com", "https://github.com/"],
  ["  github.com/sveltejs  ", "https://github.com/sveltejs"],
  ["localhost:5280", "http://localhost:5280/"],
  ["localhost", "http://localhost/"],
  ["127.0.0.1:8080/x", "http://127.0.0.1:8080/x"],
  ["file:///Users/t/doc.pdf", "file:///Users/t/doc.pdf"],
  ["about:blank", "about:blank"],
  ["fr.wikipedia.org/wiki/Arc", "https://fr.wikipedia.org/wiki/Arc"],
])("%s → %s", (saisie, attendu) => expect(toUrl(saisie, "google")).toBe(attendu));

test("free text → search with the chosen engine", () => {
  expect(toUrl("svelte 5 runes", "google")).toBe("https://www.google.com/search?q=svelte%205%20runes");
  expect(toUrl("svelte", "duckduckgo")).toBe("https://duckduckgo.com/?q=svelte");
  expect(toUrl("c'est quoi ?", "qwant")).toBe(`https://www.qwant.com/?q=${encodeURIComponent("c'est quoi ?")}`);
});

test("javascript: refused, whatever the case", () => {
  expect(toUrl("javascript:alert(1)", "google")).toBeNull();
  expect(toUrl("  JavaScript:alert(1)", "google")).toBeNull();
});

test("empty entry → null", () => expect(toUrl("   ", "google")).toBeNull());

test("an invalid URL (« http:// » alone) → search instead of an exception", () => {
  expect(toUrl("http://", "google")).toBe("https://www.google.com/search?q=http%3A%2F%2F");
  expect(toUrl("https://exa mple.com", "google")).toBe("https://www.google.com/search?q=https%3A%2F%2Fexa%20mple.com");
});
