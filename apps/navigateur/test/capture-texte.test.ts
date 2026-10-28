import { expect, test } from "vitest";
import { composerTexte, estVideoYoutube, retenable } from "../src/main/onglets/capture-texte";

test("retenable écarte les adresses locales, les URL non http(s) et les pages internes", () => {
  for (const url of [
    "http://localhost:5280/x",
    "http://127.0.0.1/",
    "http://[::1]/",
    "file:///a",
    "webaios://applications",
    "about:blank",
    "data:text/html,x",
    "pas une url",
  ])
    expect(retenable(url), url).toBe(false);
  expect(retenable("https://github.com/a/b")).toBe(true);
  expect(retenable("http://exemple.fr/")).toBe(true);
});

test("retenable : le mode test (boucle locale) ne lève que l'exclusion des adresses locales", () => {
  expect(retenable("http://127.0.0.1:4000/a.html", true)).toBe(true);
  expect(retenable("http://localhost/", true)).toBe(true);
  expect(retenable("file:///a", true)).toBe(false);
  expect(retenable("about:blank", true)).toBe(false);
});

test("estVideoYoutube : seulement les pages /watch de YouTube", () => {
  expect(estVideoYoutube("https://www.youtube.com/watch?v=abc")).toBe(true);
  expect(estVideoYoutube("https://youtube.com/watch?v=abc")).toBe(true);
  expect(estVideoYoutube("https://m.youtube.com/watch?v=abc")).toBe(true);
  expect(estVideoYoutube("https://www.youtube.com/")).toBe(false);
  expect(estVideoYoutube("https://exemple.fr/watch?v=abc")).toBe(false);
});

test("composerTexte : description puis texte de la page, parties vides omises", () => {
  expect(composerTexte({ description: "Résumé", corps: "Corps de page" })).toBe("Résumé\n\nCorps de page");
  expect(composerTexte({ description: "  ", corps: "Corps" })).toBe("Corps");
  expect(composerTexte({ corps: "" })).toBe("");
});

test("composerTexte : une vidéo YouTube donne titre, chaîne et description, sans le reste de la page", () => {
  expect(composerTexte({ video: { titre: "Ma vidéo", chaine: "Ma chaîne", description: "Ce dont parle la vidéo" }, corps: "commentaires…" })).toBe(
    "Ma vidéo\n\nMa chaîne\n\nCe dont parle la vidéo",
  );
});
