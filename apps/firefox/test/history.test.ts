import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { History } from "../core/history";

let h: History;
let path: string;
const date = (iso: string) => new Date(iso);

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  h = new History(path);
});
afterEach(() => h.fermer());

test("noting the same URL twice → one row, visites = 2, title updated", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Ancien", date: date("2026-10-01T10:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "Nouveau", date: date("2026-10-02T10:00:00Z") });
  expect(h.recents()).toEqual([{ url: "https://a.fr/", titre: "Nouveau", derniereVisite: "2026-10-02T10:00:00.000Z", visites: 2, espaceId: "", prive: false, retenu: false }]);
});

test("rechercher finds by title and by URL, case-insensitively", () => {
  h.noter({ espaceId: "", prive: false, url: "https://www.youtube.com/watch?v=1", titre: "Conférence Rust" });
  h.noter({ espaceId: "", prive: false, url: "https://github.com/sveltejs/svelte", titre: "Svelte" });
  expect(h.rechercher("RUST").map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=1"]);
  expect(h.rechercher("GitHub").map((v) => v.titre)).toEqual(["Svelte"]);
});

test("rechercher ignores case and non-ASCII accents (É, é, e)", () => {
  h.noter({ espaceId: "", prive: false, url: "https://meteo.fr/", titre: "Été à Paris" });
  expect(h.rechercher("été").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
  expect(h.rechercher("ETE").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
});

test("sorting: most visited first", () => {
  h.noter({ espaceId: "", prive: false, url: "https://rare.fr/", titre: "page rare", date: date("2026-10-03T00:00:00Z") });
  for (let i = 0; i < 3; i++) h.noter({ espaceId: "", prive: false, url: "https://souvent.fr/", titre: "page souvent", date: date("2026-10-01T00:00:00Z") });
  expect(h.rechercher("page").map((v) => v.url)).toEqual(["https://souvent.fr/", "https://rare.fr/"]);
});

test("recents: most recent first", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://b.fr/", titre: "B", date: date("2026-10-02T00:00:00Z") });
  expect(h.recents().map((v) => v.titre)).toEqual(["B", "A"]);
});

test("effacer(depuis) only removes recent visits", () => {
  h.noter({ espaceId: "", prive: false, url: "https://vieux.fr/", titre: "V", date: date("2026-10-01T00:00:00Z") });
  h.noter({ espaceId: "", prive: false, url: "https://recent.fr/", titre: "R", date: date("2026-10-05T00:00:00Z") });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.recents().map((v) => v.url)).toEqual(["https://vieux.fr/"]);
  h.effacer();
  expect(h.recents()).toEqual([]);
});

test("special characters (% _ ') in the search are treated literally", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/100%", titre: "cent pour cent" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/x_y", titre: "l'apostrophe" });
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/autre", titre: "rien" });
  expect(h.rechercher("%").map((v) => v.url)).toEqual(["https://a.fr/100%"]);
  expect(h.rechercher("_").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("l'a").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.rechercher("\\")).toEqual([]);
});

test("history survives reopening the file", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" });
  h.fermer();
  h = new History(path);
  expect(h.recents().map((v) => v.url)).toEqual(["https://a.fr/"]);
});

test("majTitre changes the title of an already noted URL, without counting a visit", () => {
  h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "https://a.fr/" });
  h.majTitre("https://a.fr/", "", "Le vrai titre");
  h.majTitre("https://inconnu.fr/", "", "ignoré");
  expect(h.recents()).toMatchObject([{ url: "https://a.fr/", titre: "Le vrai titre", visites: 1 }]);
});

test("after fermer, noter and majTitre are ignored without throwing (late events at exit)", () => {
  h.fermer();
  expect(() => h.noter({ espaceId: "", prive: false, url: "https://a.fr/", titre: "A" })).not.toThrow();
  expect(() => h.majTitre("https://a.fr/", "", "A")).not.toThrow();
  expect(h.recents()).toEqual([]);
});

test("same URL in two spaces: two rows; a new visit in A only counts for A", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false });
  const lignes = h.recents();
  expect(lignes).toHaveLength(2);
  expect(Object.fromEntries(lignes.map((v) => [v.espaceId, v.visites]))).toEqual({ A: 2, B: 1 });
});

test("majTitre only touches the targeted space", () => {
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "t", espaceId: "B", prive: false });
  h.majTitre("https://a.fr/", "A", "nouveau");
  expect(Object.fromEntries(h.recents().map((v) => [v.espaceId, v.titre]))).toEqual({ A: "nouveau", B: "t" });
});

test("a visit in a private space is noted as private", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "P", prive: true });
  expect(h.recents()).toMatchObject([{ espaceId: "P", prive: true }]);
});

test("rendrePrive marks only this space's rows", () => {
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

test("old schema (url key alone): rows kept, empty space, non-private", () => {
  h.fermer();
  const old = join(mkdtempSync(join(tmpdir(), "webaios-hist-")), "historique.sqlite");
  const db = new DatabaseSync(old);
  db.exec(`CREATE TABLE visites (url TEXT PRIMARY KEY, titre TEXT NOT NULL, derniere_visite TEXT NOT NULL, visites INTEGER NOT NULL DEFAULT 1);
    INSERT INTO visites VALUES ('https://vieux.fr/', 'Vieux', '2026-01-01T00:00:00.000Z', 3);`);
  db.close();
  h = new History(old);
  expect(h.recents()).toEqual([{ url: "https://vieux.fr/", titre: "Vieux", derniereVisite: "2026-01-01T00:00:00.000Z", visites: 3, espaceId: "", prive: false, retenu: false }]);
  h.noter({ url: "https://vieux.fr/", titre: "Vieux", espaceId: "A", prive: false });
  expect(h.recents()).toHaveLength(2);
  h.fermer();
  h = new History(old); // already migrated: reopening changes nothing
  expect(h.recents()).toHaveLength(2);
});

test("rechercher in distinct mode: a URL seen in two spaces comes out once, and the limit counts URLs", () => {
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "A", prive: false });
  h.noter({ url: "https://a.fr/", titre: "page", espaceId: "B", prive: false });
  h.noter({ url: "https://b.fr/", titre: "page", espaceId: "A", prive: false });
  expect(h.rechercher("page")).toHaveLength(3);
  expect(h.rechercher("page", 2, true).map((v) => v.url).sort()).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("rechercher in distinct mode keeps per URL the most visited row, then the most recent, in order and within the limit", () => {
  const note = (url: string, spaceId: string, times: number, iso: string) => {
    for (let i = 0; i < times; i++) h.noter({ url, titre: "page", espaceId: spaceId, prive: false, date: date(iso) });
  };
  note("https://a.fr/", "A", 1, "2026-10-05T00:00:00Z");
  note("https://a.fr/", "B", 3, "2026-10-01T00:00:00Z"); // most visited: wins despite the date
  note("https://b.fr/", "A", 2, "2026-10-01T00:00:00Z");
  note("https://b.fr/", "B", 2, "2026-10-03T00:00:00Z"); // tie on visits: the most recent wins
  note("https://c.fr/", "A", 1, "2026-10-09T00:00:00Z");
  expect(h.rechercher("page", 2, true).map((v) => [v.url, v.espaceId])).toEqual([["https://a.fr/", "B"], ["https://b.fr/", "B"]]);
  expect(h.rechercher("page", 50, true).map((v) => v.url)).toEqual(["https://a.fr/", "https://b.fr/", "https://c.fr/"]);
});

test("a private row that becomes non-private restarts at one visit, with a fresh title and date", () => {
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "A", prive: true, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false, date: date("2026-10-03T00:00:00Z") });
  expect(h.recents()).toMatchObject([{ visites: 1, prive: false, titre: "Public", derniereVisite: "2026-10-03T00:00:00.000Z" }]);
  h.noter({ url: "https://a.fr/", titre: "Public", espaceId: "A", prive: false });
  expect(h.recents()[0]!.visites).toBe(2);
});

// --- Retained page text (browsing memory) ---

const DAY = 86_400_000;
/** A non-private visit and its retained text, at the same date. */
function visit(url: string, title: string, text: string, o: { espaceId?: string; date?: string } = {}) {
  const d = date(o.date ?? "2026-10-01T00:00:00Z");
  h.noter({ url, titre: title, espaceId: o.espaceId ?? "A", prive: false, date: d });
  h.retenir({ url, titre: title, espaceId: o.espaceId ?? "A", texte: text, date: d });
}

test("retenir truncates the text to 20,000 characters", () => {
  visit("https://a.fr/", "A", "x".repeat(25_000));
  expect(h.texteRetenu("https://a.fr/")!.texte).toHaveLength(20_000);
});

test("retenir a second time for the same page in the same space replaces the text", () => {
  visit("https://a.fr/", "A", "premier texte");
  visit("https://a.fr/", "A", "second texte", { date: "2026-10-02T00:00:00Z" });
  expect(h.texteRetenu("https://a.fr/")).toEqual({ url: "https://a.fr/", titre: "A", date: "2026-10-02T00:00:00.000Z", texte: "second texte" });
  expect(h.rechercherPourAgent({ requete: "premier" })).toEqual([]);
});

test("Visite.retenu tells whether this visit's text (URL and space) is retained; oublierTexte forgets it alone", () => {
  visit("https://a.fr/", "A", "texte", { espaceId: "A" });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  expect(Object.fromEntries(h.recents().map((v) => [v.espaceId, v.retenu]))).toEqual({ A: true, B: false });
  h.oublierTexte("https://a.fr/", "A");
  expect(h.recents().map((v) => v.retenu)).toEqual([false, false]);
  expect(h.recents()).toHaveLength(2);
});

test("purger erases text older than 183 days and keeps the 182-day-old one", () => {
  const now = date("2026-10-28T12:00:00Z");
  visit("https://vieux.fr/", "V", "vieux", { date: new Date(now.getTime() - 184 * DAY).toISOString() });
  visit("https://jeune.fr/", "J", "jeune", { date: new Date(now.getTime() - 182 * DAY).toISOString() });
  h.purger(now);
  expect(h.texteRetenu("https://vieux.fr/")).toBeNull();
  expect(h.texteRetenu("https://jeune.fr/")).not.toBeNull();
  expect(h.recents()).toHaveLength(2); // the visits remain
});

test("beyond the cap, purger erases the oldest text first", () => {
  h.fermer();
  h = new History(path, { plafondOctets: 25 });
  visit("https://1.fr/", "1", "a".repeat(10), { date: "2026-10-01T00:00:00Z" });
  visit("https://2.fr/", "2", "é".repeat(5), { date: "2026-10-02T00:00:00Z" }); // 10 bytes in UTF-8
  visit("https://3.fr/", "3", "c".repeat(10), { date: "2026-10-03T00:00:00Z" });
  h.purger(date("2026-10-04T00:00:00Z"));
  expect(["https://1.fr/", "https://2.fr/", "https://3.fr/"].map((u) => h.texteRetenu(u) !== null)).toEqual([false, true, true]);
});

test("effacer(depuis) also erases the retained text since that date; effacer() erases everything", () => {
  visit("https://vieux.fr/", "V", "vieux", { date: "2026-10-01T00:00:00Z" });
  visit("https://recent.fr/", "R", "recent", { date: "2026-10-05T00:00:00Z" });
  h.effacer(date("2026-10-04T00:00:00Z"));
  expect(h.texteRetenu("https://recent.fr/")).toBeNull();
  expect(h.texteRetenu("https://vieux.fr/")).not.toBeNull();
  expect(h.rechercherPourAgent({ requete: "recent" })).toEqual([]);
  h.effacer();
  expect(h.texteRetenu("https://vieux.fr/")).toBeNull();
  expect(h.rechercherPourAgent({ requete: "vieux" })).toEqual([]);
});

test("rendrePrive forgets this space's text and keeps the same URL's text in another space", () => {
  visit("https://a.fr/", "A", "texte vu dans A", { espaceId: "A", date: "2026-10-02T00:00:00Z" });
  visit("https://a.fr/", "A", "texte vu dans B", { espaceId: "B", date: "2026-10-01T00:00:00Z" });
  h.rendrePrive("A");
  expect(h.texteRetenu("https://a.fr/")!.texte).toBe("texte vu dans B");
  expect(h.recents().find((v) => v.espaceId === "A")!.retenu).toBe(false);
});

test("rechercherPourAgent finds « eclair » in the text, the title and the URL, ignoring case and accents", () => {
  visit("https://patisserie.fr/1", "Recettes", "Un Éclair au café");
  visit("https://patisserie.fr/2", "L'ÉCLAIR parfait", "chocolat");
  visit("https://eclair.fr/", "Accueil", "rien");
  expect(h.rechercherPourAgent({ requete: "eclair" }).map((r) => r.url).sort()).toEqual(["https://eclair.fr/", "https://patisserie.fr/1", "https://patisserie.fr/2"]);
});

test("rechercherPourAgent: one URL per result, made of non-private visits only", () => {
  visit("https://a.fr/", "Titre A", "un texte sur les éclairs", { espaceId: "A", date: "2026-10-01T00:00:00Z" });
  h.noter({ url: "https://a.fr/", titre: "Titre A", espaceId: "A", prive: false, date: date("2026-10-03T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Titre B", espaceId: "B", prive: false, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://a.fr/", titre: "Secret", espaceId: "P", prive: true, date: date("2026-10-09T00:00:00Z") });
  h.noter({ url: "https://secret.fr/eclairs", titre: "Éclairs secrets", espaceId: "P", prive: true });
  expect(h.rechercherPourAgent({ requete: "éclairs" })).toEqual([
    { url: "https://a.fr/", titre: "Titre A", derniereVisite: "2026-10-03T00:00:00.000Z", visites: 3, extrait: "un texte sur les éclairs" },
  ]);
});

test("rechercherPourAgent never returns a private row's text", () => {
  visit("https://a.fr/", "A", "mot de passe xyzzy", { espaceId: "P" });
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "P", prive: true }); // the space became private without rendrePrive
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "B", prive: false });
  expect(h.rechercherPourAgent({ requete: "xyzzy" })).toEqual([]);
  expect(h.rechercherPourAgent({ requete: "a.fr" })).toMatchObject([{ url: "https://a.fr/", extrait: "", visites: 1 }]);
  expect(h.texteRetenu("https://a.fr/")).toBeNull();
});

test("rechercherPourAgent honours depuis and jusqua", () => {
  for (const j of ["01", "05", "09"]) visit(`https://${j}.fr/`, `page ${j}`, "commun", { date: `2026-10-${j}T00:00:00Z` });
  const r = h.rechercherPourAgent({ requete: "commun", depuis: date("2026-10-02T00:00:00Z"), jusqua: date("2026-10-06T00:00:00Z") });
  expect(r.map((x) => x.url)).toEqual(["https://05.fr/"]);
});

test("rechercherPourAgent returns 20 results by default and never more than 50", () => {
  for (let i = 0; i < 60; i++) h.noter({ url: `https://a.fr/${i}`, titre: "page", espaceId: "A", prive: false });
  expect(h.rechercherPourAgent({ requete: "page" })).toHaveLength(20);
  expect(h.rechercherPourAgent({ requete: "page", limite: 500 })).toHaveLength(50);
});

test("rechercherPourAgent returns an excerpt of about 300 characters around the found word", () => {
  const before = "Lorem ipsum dolor sit amet. ".repeat(100);
  visit("https://a.fr/", "A", `${before} le mot introuvable est ici. ${before}`);
  const [r] = h.rechercherPourAgent({ requete: "introuvable" });
  expect(r!.extrait).toContain("introuvable");
  expect(r!.extrait.length).toBeGreaterThan(200);
  expect(r!.extrait.length).toBeLessThan(400);
});

test("a visit without text is found by title or URL, with an empty excerpt", () => {
  h.noter({ url: "https://github.com/sveltejs/svelte", titre: "Svelte • Cybernétique", espaceId: "A", prive: false });
  expect(h.rechercherPourAgent({ requete: "CYBERNETIQUE" })).toMatchObject([{ url: "https://github.com/sveltejs/svelte", extrait: "" }]);
  expect(h.rechercherPourAgent({ requete: "LTEJS/SV" })).toMatchObject([{ titre: "Svelte • Cybernétique", extrait: "" }]);
});

test("ranking: texts found by bm25 first, then titles and URLs alone, from most to least recent", () => {
  h.noter({ url: "https://titre-ancien.fr/", titre: "rust", espaceId: "A", prive: false, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://titre-recent.fr/", titre: "rust", espaceId: "A", prive: false, date: date("2026-10-08T00:00:00Z") });
  visit("https://peu.fr/", "Peu", `rust ${"autre chose ".repeat(200)}`, { date: "2026-10-09T00:00:00Z" });
  visit("https://beaucoup.fr/", "Beaucoup", "rust rust rust rust", { date: "2026-10-02T00:00:00Z" });
  expect(h.rechercherPourAgent({ requete: "rust" }).map((r) => r.url)).toEqual(["https://beaucoup.fr/", "https://peu.fr/", "https://titre-recent.fr/", "https://titre-ancien.fr/"]);
});

test("a query with FTS syntax (quotes, operators) is searched as is, without error", () => {
  visit("https://a.fr/", "A", "le NEAR de la tour");
  for (const q of ['"', "NEAR(", "a* OR", "titre:x", "-", "(((", 'é"é']) expect(() => h.rechercherPourAgent({ requete: q })).not.toThrow();
  expect(h.rechercherPourAgent({ requete: "NEAR" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("an empty query returns the most recent non-private visits", () => {
  h.noter({ url: "https://a.fr/", titre: "A", espaceId: "A", prive: false, date: date("2026-10-01T00:00:00Z") });
  h.noter({ url: "https://b.fr/", titre: "B", espaceId: "A", prive: false, date: date("2026-10-02T00:00:00Z") });
  h.noter({ url: "https://p.fr/", titre: "P", espaceId: "P", prive: true, date: date("2026-10-03T00:00:00Z") });
  expect(h.rechercherPourAgent({ requete: "  " }).map((r) => r.url)).toEqual(["https://b.fr/", "https://a.fr/"]);
});

test("retained text survives reopening the file", () => {
  visit("https://a.fr/", "A", "persistant");
  h.fermer();
  h = new History(path);
  expect(h.rechercherPourAgent({ requete: "persistant" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("after fermer, the retained-text methods do not throw", () => {
  h.fermer();
  expect(() => h.retenir({ url: "https://a.fr/", titre: "A", espaceId: "A", texte: "t" })).not.toThrow();
  expect(() => h.purger()).not.toThrow();
  expect(h.rechercherPourAgent({ requete: "t" })).toEqual([]);
  expect(h.texteRetenu("https://a.fr/")).toBeNull();
});
