import { expect, test } from "vitest";
import { prefixeContexte } from "../../src/pty/contexte.js";

test("préfixe exact", () => {
  expect(prefixeContexte("sveltejs/svelte", "https://github.com/sveltejs/svelte")).toBe(
    "[contexte : sveltejs/svelte — https://github.com/sveltejs/svelte] ",
  );
});

test("un retour à la ligne dans le titre ne produit jamais \\r ni \\n", () => {
  const p = prefixeContexte("Titre\r\npiégé\x1b[2J", "https://x.test");
  expect(p).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(p).toBe("[contexte : Titre piégé [2J — https://x.test] ");
});

test("l'URL est nettoyée elle aussi", () => {
  expect(prefixeContexte("t", "https://x.test/\na")).toBe("[contexte : t — https://x.test/ a] ");
});

test("titre long tronqué à 120 + …", () => {
  const p = prefixeContexte("a".repeat(200), "https://x.test");
  expect(p).toBe(`[contexte : ${"a".repeat(120)}… — https://x.test] `);
});

test("titre vide → url seule", () => {
  expect(prefixeContexte(" \n ", "https://x.test")).toBe("[contexte : https://x.test] ");
});
