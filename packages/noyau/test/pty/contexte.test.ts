import { expect, test } from "vitest";
import { prefixeApplication, prefixeContexte } from "../../src/pty/contexte.js";

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

test("caractères de contrôle C1 et séparateurs Unicode retirés aussi", () => {
  expect(prefixeContexte("a\x9b2Jb c d\x85e", "https://x.test")).toBe("[contexte : a 2Jb c d e — https://x.test] ");
});

test("URL très longue tronquée à 300 + …", () => {
  const url = `https://x.test/${"q".repeat(1000)}`;
  expect(prefixeContexte("t", url)).toBe(`[contexte : t — ${url.slice(0, 300)}…] `);
});

test("prefixeApplication", () => {
  expect(prefixeApplication({ nom: "Todo\r", dossier: "todo", sansFiche: false })).toBe(
    "[application : Todo — /workspace/projets/todo — journal : /workspace/.webaios/journaux/todo.log] ",
  );
  expect(prefixeApplication({ nom: "x", dossier: "vieux", sansFiche: true })).toBe(
    "[projet sans fiche webaios.json : /workspace/projets/vieux] ",
  );
});

test("prefixeApplication nettoie aussi le dossier : un \\r n'y tape jamais Entrée", () => {
  expect(prefixeApplication({ nom: "x", dossier: "a\rb", sansFiche: true })).toBe("[projet sans fiche webaios.json : /workspace/projets/a b] ");
  const p = prefixeApplication({ nom: "x", dossier: "a\rb", sansFiche: false });
  expect(p).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(p).toBe("[application : x — /workspace/projets/a b — journal : /workspace/.webaios/journaux/a b.log] ");
});
