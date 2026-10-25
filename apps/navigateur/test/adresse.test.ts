import { expect, test } from "vitest";
import { versUrl } from "../src/main/adresse";

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
])("%s → %s", (saisie, attendu) => expect(versUrl(saisie, "google")).toBe(attendu));

test("texte libre → recherche avec le moteur choisi", () => {
  expect(versUrl("svelte 5 runes", "google")).toBe("https://www.google.com/search?q=svelte%205%20runes");
  expect(versUrl("svelte", "duckduckgo")).toBe("https://duckduckgo.com/?q=svelte");
  expect(versUrl("c'est quoi ?", "qwant")).toBe(`https://www.qwant.com/?q=${encodeURIComponent("c'est quoi ?")}`);
});

test("javascript: refusé, quelle que soit la casse", () => {
  expect(versUrl("javascript:alert(1)", "google")).toBeNull();
  expect(versUrl("  JavaScript:alert(1)", "google")).toBeNull();
});

test("saisie vide → null", () => expect(versUrl("   ", "google")).toBeNull());

test("une URL invalide (« http:// » seul) → recherche au lieu d'une exception", () => {
  expect(versUrl("http://", "google")).toBe("https://www.google.com/search?q=http%3A%2F%2F");
  expect(versUrl("https://exa mple.com", "google")).toBe("https://www.google.com/search?q=https%3A%2F%2Fexa%20mple.com");
});
