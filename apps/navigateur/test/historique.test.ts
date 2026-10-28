import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Ancien", date: date("2026-10-01T10:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Nouveau", date: date("2026-10-02T10:00:00Z") });
  expect(h.recents()).toEqual([{ url: "https://a.fr/", titre: "Nouveau", derniereVisite: "2026-10-02T10:00:00.000Z", visites: 2, espaceId: "", prive: false, retenu: false }]);
});

test("rechercher trouve par titre et par URL, sans tenir compte de la casse", () => {
  h.noter({ espaceId: "", prive: false, url: "https://www.youtube.com/watch?v=1", titre: "Conférence Rust" });
  h.noter({ espaceId: "", prive: false, url: "https://github.com/sveltejs/svelte", titre: "Svelte" });
  expect(h.rechercher("RUST").map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=1"]);
  expect(h.rechercher("GitHub").map((v) => v.titre)).toEqual(["Svelte"]);
});

test("rechercher ignore la casse et les accents hors ASCII (É, é, e)", () => {
  h.noter({ espaceId: "", prive: false, url: "https://meteo.fr/", titre: "Été à Paris" });
  expect(h.rechercher("été").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
  expect(h.rechercher("ETE").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
});

test("tri : les plus visitées d'abord", () => {
  h.noter({ espaceId: "", prive: false, url: "https://rare.fr/", titre: "page rare", date: date("2026-10-03T00:00:00Z") });
  for (let i = 0; i < 3; i++) h.noter({ espaceId: "", prive: false, url: "https://souvent.fr/", titre: "page souvent", date: date("2026-10-01T00:00:00Z") });
  expect(h.rechercher("page").map((v) => v.url)).toEqual(["https://souvent.fr/", "https://rare.fr/"]);
});

test("recents : la plus récente d'abord", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://b.fr/", titre: "B", date: date("2026-10-02T00:00:00Z") });
  expect(h.recents().map((v) => v.titre)).toEqual(["B", "A"]);
});

test("effacer(depuis) ne retire que les visites récentes", () => {
  h.noter({ espaceId: "", prive: false, url: "https://vieux.fr/", titre: "V", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://recent.fr/", titre: "R", date: date("2026-10-05T00:00:00Z") });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.recents().map((v) => v.url)).toEqual(["https://vieux.fr/"]);
  h.effacer();
  expect(h.recents()).toEqual([]);
});

test("les caractères spéciaux (% _ ') dans la recherche sont traités littéralement", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/100%", titre: "cent pour cent" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/x_y", titre: "l'apostrophe" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/autre", titre: "rien" });
  expect(h.rechercher("%").map((v) => v.url)).toEqual(["https://a.fr/100%"]);
  expect(h.rechercher("_").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("l'a").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("\\")).toEqual([]);
});

test("l'historique survit à la réouverture du fichier", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" });
  h.fermer();
  h = new Historique(chemin);
  expect(h.recents().map((v) => v.url)).toEqual(["https://a.fr/"]);
});

test("majTitre change le titre d'une URL déjà notée, sans compter de visite", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "https://a.fr/" });
  h.majTitre("https://a.fr/", "", "Le vrai titre");
  h.majTitre("https://inconnu.fr/", "", "ignoré");
  expect(h.recents()).toMatchObject([{ url: "https://a.fr/", titre: "Le vrai titre", visites: 1 }]);
});

test("après fermer, noter et majTitre sont ignorés sans lever d'erreur (événements tardifs à la sortie)", () => {
  h.fermer();
  expect(() => h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" })).not.toThrow();
  expect(() => h.majTitre("https://a.fr/", "", "A")).not.toThrow();
  expect(h.recents()).toEqual([]);
});

test("même URL dans deux espaces : deux lignes ; une nouvelle visite dans A ne compte que pour A", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  const lignes = h.recents();
  expect(lignes).toHaveLength(2);
  expect(Object.fromEntries(lignes.map((v) => [v.espaceId, v.visites]))).toEqual({ A: 2, B: 1 });
});

test("majTitre ne touche que l'espace visé", () => {
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "B", prive: false });
  h.majTitre("https://a.fr/", "A", "nouveau");
  expect(Object.fromEntries(h.recents().map((v) => [v.espaceId, v.titre]))).toEqual({ A: "nouveau", B: "t" });
});

test("une visite dans un espace privé est notée privée", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "P", prive: true });
  expect(h.recents()).toMatchObject([{ espaceId: "P", prive: true }]);
});

test("rendrePrive marque les lignes de cet espace seulement", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  h.noter({ url: "https://b.fr/", titre: "B", espaceId: "", prive: false });
  h.rendrePrive("A");
  expect(Object.fromEntries(h.recents().map((v) => [`${v.espaceId}|${v.url}`, v.prive]))).toEqual({
    "A|https://a.fr/": true,
    "B|https://a.fr/": false,
    "|https://b.fr/": false,
  });
});

test("ancien schéma (clé url seule) : lignes gardées, espace vide, non privées", () => {
  h.fermer();
  const vieux = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  const db = new DatabaseSync(vieux);
  db.exec(`CREATE TABLE visites (url TEXT PRIMARY KEY, titre TEXT NOT NULL, derniere_visite TEXT NOT NULL, visites INTEGER NOT NULL DEFAULT 1);
    INSERT INTO visites VALUES ('https://vieux.fr/', 'Vieux', '2026-01-01T00:00:00.000Z', 3);`);
  db.close();
  h = new Historique(vieux);
  expect(h.recents()).toEqual([{ url: "https://vieux.fr/", titre: "Vieux", derniereVisite: "2026-01-01T00:00:00.000Z", visites: 3, espaceId: "", prive: false, retenu: false }]);
  h.noter({ url: "https://vieux.fr/", titre: "Vieux", espaceId: "A", prive: false });
  expect(h.recents()).toHaveLength(2);
  h.fermer();
  h = new Historique(vieux); // déjà migrée : rouvrir ne change rien
  expect(h.recents()).toHaveLength(2);
});

test("rechercher en mode distinct : une URL vue dans deux espaces sort une fois, et la limite compte des URL", () => {
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "B", prive: false });
  h.noter({ url: "https://b.fr/", titre: "page", espaceId: "A", prive: false });
  expect(h.rechercher("page")).toHaveLength(3);
  expect(h.rechercher("page", 2, true).map((v) => v.url).sort()).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("une ligne privée qui redevient non privée repart à une visite, avec titre et date neufs", () => {
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false, date: date("2026-10-03T00:00:00Z") });
  expect(h.recents()).toMatchObject([{ visites: 1, prive: false, titre: "Public", derniereVisite: "2026-10-03T00:00:00.000Z" }]);
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false });
  expect(h.recents()[0]!.visites).toBe(2);
});
