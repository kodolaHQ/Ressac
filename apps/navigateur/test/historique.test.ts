import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Historique } from "../src/main/historique";

let h: Historique;
let chemin: string;
const date = (iso: string) => new Date(iso);

beforeEach(() => {
  chemin = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  h = new Historique(chemin);
});
afterEach(() => h.fermer());

test("noter deux fois la même URL → une ligne, visites = 2, titre mis à jour", () => {
  h.noter({ url: "https://a.fr/", titre: "Ancien", date: date("2026-10-01T10:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Nouveau", date: date("2026-10-02T10:00:00Z") });
  expect(h.recents()).toEqual([{ url: "https://a.fr/", titre: "Nouveau", derniereVisite: "2026-10-02T10:00:00.000Z", visites: 2 }]);
});

test("rechercher trouve par titre et par URL, sans tenir compte de la casse", () => {
  h.noter({ url: "https://www.youtube.com/watch?v=1", titre: "Conférence Rust" });
  h.noter({ url: "https://github.com/sveltejs/svelte", titre: "Svelte" });
  expect(h.rechercher("RUST").map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=1"]);
  expect(h.rechercher("GitHub").map((v) => v.titre)).toEqual(["Svelte"]);
});

test("tri : les plus visitées d'abord", () => {
  h.noter({ url: "https://rare.fr/", titre: "page rare", date: date("2026-10-03T00:00:00Z") });
  for (let i = 0; i < 3; i++) h.noter({ url: "https://souvent.fr/", titre: "page souvent", date: date("2026-10-01T00:00:00Z") });
  expect(h.rechercher("page").map((v) => v.url)).toEqual(["https://souvent.fr/", "https://rare.fr/"]);
});

test("recents : la plus récente d'abord", () => {
  h.noter({ url: "https://a.fr/", titre: "A", date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://b.fr/", titre: "B", date: date("2026-10-02T00:00:00Z") });
  expect(h.recents().map((v) => v.titre)).toEqual(["B", "A"]);
});

test("effacer(depuis) ne retire que les visites récentes", () => {
  h.noter({ url: "https://vieux.fr/", titre: "V", date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://recent.fr/", titre: "R", date: date("2026-10-05T00:00:00Z") });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.recents().map((v) => v.url)).toEqual(["https://vieux.fr/"]);
  h.effacer();
  expect(h.recents()).toEqual([]);
});

test("les caractères spéciaux (% _ ') dans la recherche sont traités littéralement", () => {
  h.noter({ url: "https://a.fr/100%", titre: "cent pour cent" });
  h.noter({ url: "https://a.fr/x_y", titre: "l'apostrophe" });
  h.noter({ url: "https://a.fr/autre", titre: "rien" });
  expect(h.rechercher("%").map((v) => v.url)).toEqual(["https://a.fr/100%"]);
  expect(h.rechercher("_").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("l'a").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("\\")).toEqual([]);
});

test("l'historique survit à la réouverture du fichier", () => {
  h.noter({ url: "https://a.fr/", titre: "A" });
  h.fermer();
  h = new Historique(chemin);
  expect(h.recents().map((v) => v.url)).toEqual(["https://a.fr/"]);
});

test("majTitre change le titre d'une URL déjà notée, sans compter de visite", () => {
  h.noter({ url: "https://a.fr/", titre: "https://a.fr/" });
  h.majTitre("https://a.fr/", "Le vrai titre");
  h.majTitre("https://inconnu.fr/", "ignoré");
  expect(h.recents()).toMatchObject([{ url: "https://a.fr/", titre: "Le vrai titre", visites: 1 }]);
});

test("après fermer, noter et majTitre sont ignorés sans lever d'erreur (événements tardifs à la sortie)", () => {
  h.fermer();
  expect(() => h.noter({ url: "https://a.fr/", titre: "A" })).not.toThrow();
  expect(() => h.majTitre("https://a.fr/", "A")).not.toThrow();
  expect(h.recents()).toEqual([]);
});
