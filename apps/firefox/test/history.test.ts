import { mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { History, ICON_MAX, IMPORTED_SPACE, REFUSED_VECTOR, TITLE_MAX } from "../core/history";

let h: History;
let path: string;
const date = (iso: string) => new Date(iso);

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "ressac-hist-")), "history.sqlite");
  h = new History(path);
});
afterEach(() => h.close());

test("noting the same URL twice → one row, visites = 2, title updated", () => {
  h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "Ancien", date: date("2026-10-01T10:00:00Z") });
  h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "Nouveau", date: date("2026-10-02T10:00:00Z") });
  expect(h.recents()).toEqual([{ url: "https://a.fr/", title: "Nouveau", lastVisit: "2026-10-02T10:00:00.000Z", visits: 2, spaceId: "", private: false, kept: false, favicon: null }]);
});

test("rechercher finds by title and by URL, case-insensitively", () => {
  h.note({ spaceId: "", private: false, url: "https://www.youtube.com/watch?v=1", title: "Conférence Rust" });
  h.note({ spaceId: "", private: false, url: "https://github.com/sveltejs/svelte", title: "Svelte" });
  expect(h.search("RUST").map((v) => v.url)).toEqual(["https://www.youtube.com/watch?v=1"]);
  expect(h.search("GitHub").map((v) => v.title)).toEqual(["Svelte"]);
});

test("rechercher ignores case and non-ASCII accents (É, é, e)", () => {
  h.note({ spaceId: "", private: false, url: "https://meteo.fr/", title: "Été à Paris" });
  expect(h.search("été").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
  expect(h.search("ETE").map((v) => v.url)).toEqual(["https://meteo.fr/"]);
});

test("sorting: most visited first", () => {
  h.note({ spaceId: "", private: false, url: "https://rare.fr/", title: "page rare", date: date("2026-10-03T00:00:00Z") });
  for (let i = 0; i < 3; i++) h.note({ spaceId: "", private: false, url: "https://souvent.fr/", title: "page souvent", date: date("2026-10-01T00:00:00Z") });
  expect(h.search("page").map((v) => v.url)).toEqual(["https://souvent.fr/", "https://rare.fr/"]);
});

test("recents: most recent first", () => {
  h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "A", date: date("2026-10-01T00:00:00Z") });
  h.note({ spaceId: "", private: false, url: "https://b.fr/", title: "B", date: date("2026-10-02T00:00:00Z") });
  expect(h.recents().map((v) => v.title)).toEqual(["B", "A"]);
});

test("erase(depuis) only removes recent visits", () => {
  h.note({ spaceId: "", private: false, url: "https://vieux.fr/", title: "V", date: date("2026-10-01T00:00:00Z") });
  h.note({ spaceId: "", private: false, url: "https://recent.fr/", title: "R", date: date("2026-10-05T00:00:00Z") });
  h.erase(date("2026-10-04T00:00:00Z"));
  expect(h.recents().map((v) => v.url)).toEqual(["https://vieux.fr/"]);
  h.erase();
  expect(h.recents()).toEqual([]);
});

test("special characters (% _ ') in the search are treated literally", () => {
  h.note({ spaceId: "", private: false, url: "https://a.fr/100%", title: "cent pour cent" });
  h.note({ spaceId: "", private: false, url: "https://a.fr/x_y", title: "l'apostrophe" });
  h.note({ spaceId: "", private: false, url: "https://a.fr/autre", title: "rien" });
  expect(h.search("%").map((v) => v.url)).toEqual(["https://a.fr/100%"]);
  expect(h.search("_").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.search("l'a").map((v) => v.url)).toEqual(["https://a.fr/x_y"]);
  expect(h.search("\\")).toEqual([]);
});

test("history survives reopening the file", () => {
  h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "A" });
  h.close();
  h = new History(path);
  expect(h.recents().map((v) => v.url)).toEqual(["https://a.fr/"]);
});

test("updateTitle changes the title of an already noted URL, without counting a visit", () => {
  h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "https://a.fr/" });
  h.updateTitle("https://a.fr/", "", "Le vrai titre");
  h.updateTitle("https://inconnu.fr/", "", "ignoré");
  expect(h.recents()).toMatchObject([{ url: "https://a.fr/", title: "Le vrai titre", visits: 1 }]);
});

test("after fermer, noter and updateTitle are ignored without throwing (late events at exit)", () => {
  h.close();
  expect(() => h.note({ spaceId: "", private: false, url: "https://a.fr/", title: "A" })).not.toThrow();
  expect(() => h.updateTitle("https://a.fr/", "", "A")).not.toThrow();
  expect(h.recents()).toEqual([]);
});

test("same URL in two spaces: two rows; a new visit in A only counts for A", () => {
  h.note({ url: "https://a.fr/", title: "A", spaceId: "A", private: false });
  h.note({ url: "https://a.fr/", title: "A", spaceId: "B", private: false });
  h.note({ url: "https://a.fr/", title: "A", spaceId: "A", private: false });
  const lines = h.recents();
  expect(lines).toHaveLength(2);
  expect(Object.fromEntries(lines.map((v) => [v.spaceId, v.visits]))).toEqual({ A: 2, B: 1 });
});

test("updateTitle only touches the targeted space", () => {
  h.note({ url: "https://a.fr/", title: "t", spaceId: "A", private: false });
  h.note({ url: "https://a.fr/", title: "t", spaceId: "B", private: false });
  h.updateTitle("https://a.fr/", "A", "nouveau");
  expect(Object.fromEntries(h.recents().map((v) => [v.spaceId, v.title]))).toEqual({ A: "nouveau", B: "t" });
});

test("a visit in a private space is noted as private", () => {
  h.note({ url: "https://a.fr/", title: "A", spaceId: "P", private: true });
  expect(h.recents()).toMatchObject([{ spaceId: "P", private: true }]);
});

test("makePrivate marks only this space's rows", () => {
  h.note({ url: "https://a.fr/", title: "A", spaceId: "A", private: false });
  h.note({ url: "https://a.fr/", title: "A", spaceId: "B", private: false });
  h.note({ url: "https://b.fr/", title: "B", spaceId: "", private: false });
  h.makePrivate("A");
  expect(Object.fromEntries(h.recents().map((v) => [`${v.spaceId}|${v.url}`, v.private]))).toEqual({
    "A|https://a.fr/": true,
    "B|https://a.fr/": false,
    "|https://b.fr/": false,
  });
});

test("search in distinct mode: a URL seen in two spaces comes out once, and the limit counts URLs", () => {
  h.note({ url: "https://a.fr/", title: "page", spaceId: "A", private: false });
  h.note({ url: "https://a.fr/", title: "page", spaceId: "B", private: false });
  h.note({ url: "https://b.fr/", title: "page", spaceId: "A", private: false });
  expect(h.search("page")).toHaveLength(3);
  expect(h.search("page", 2, true).map((v) => v.url).sort()).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("search in distinct mode keeps per URL the most visited row, then the most recent, in order and within the limit", () => {
  const note = (url: string, spaceId: string, times: number, iso: string) => {
    for (let i = 0; i < times; i++) h.note({ url, title: "page", spaceId: spaceId, private: false, date: date(iso) });
  };
  note("https://a.fr/", "A", 1, "2026-10-05T00:00:00Z");
  note("https://a.fr/", "B", 3, "2026-10-01T00:00:00Z"); // most visited: wins despite the date
  note("https://b.fr/", "A", 2, "2026-10-01T00:00:00Z");
  note("https://b.fr/", "B", 2, "2026-10-03T00:00:00Z"); // tie on visits: the most recent wins
  note("https://c.fr/", "A", 1, "2026-10-09T00:00:00Z");
  expect(h.search("page", 2, true).map((v) => [v.url, v.spaceId])).toEqual([["https://a.fr/", "B"], ["https://b.fr/", "B"]]);
  expect(h.search("page", 50, true).map((v) => v.url)).toEqual(["https://a.fr/", "https://b.fr/", "https://c.fr/"]);
});

test("search in distinct mode reads further when one URL fills the first page", () => {
  for (let i = 0; i < 9; i++) for (let k = 0; k < 2; k++) h.note({ url: "https://a.fr/", title: "page", spaceId: `S${i}`, private: false });
  h.note({ url: "https://b.fr/", title: "page", spaceId: "A", private: false });
  expect(h.search("page", 2, true).map((v) => v.url)).toEqual(["https://a.fr/", "https://b.fr/"]);
});

test("the folded url and title are stored, kept up to date, and filled in an older database", () => {
  h.close();
  const old = new DatabaseSync(path);
  old.exec("DELETE FROM visits; ALTER TABLE visits DROP COLUMN url_fold; ALTER TABLE visits DROP COLUMN title_fold;");
  old.exec("INSERT INTO visits (url, space_id, title, last_visit) VALUES ('https://É.fr/', '', 'Été', '2026-10-01T00:00:00Z')");
  old.close();
  h = new History(path);
  h.note({ spaceId: "", private: false, url: "https://b.fr/Ça", title: "Noël" });
  h.updateTitle("https://b.fr/Ça", "", "Crème brûlée");
  h.importVisits([{ url: "https://c.fr/", title: "Ölçü", date: new Date() }]);
  const raw = new DatabaseSync(path);
  const rows = raw.prepare("SELECT url_fold, title_fold FROM visits ORDER BY url_fold").all();
  raw.close();
  expect(rows).toEqual([
    { url_fold: "https://b.fr/ca", title_fold: "creme brulee" },
    { url_fold: "https://c.fr/", title_fold: "olcu" },
    { url_fold: "https://e.fr/", title_fold: "ete" },
  ]);
  expect(h.search("brulee").map((v) => v.title)).toEqual(["Crème brûlée"]);
});

test("a private row that becomes non-private restarts at one visit, with a fresh title and date", () => {
  h.note({ url: "https://a.fr/", title: "Secret", spaceId: "A", private: true, date: date("2026-10-01T00:00:00Z") });
  h.note({ url: "https://a.fr/", title: "Secret", spaceId: "A", private: true, date: date("2026-10-02T00:00:00Z") });
  h.note({ url: "https://a.fr/", title: "Public", spaceId: "A", private: false, date: date("2026-10-03T00:00:00Z") });
  expect(h.recents()).toMatchObject([{ visits: 1, private: false, title: "Public", lastVisit: "2026-10-03T00:00:00.000Z" }]);
  h.note({ url: "https://a.fr/", title: "Public", spaceId: "A", private: false });
  expect(h.recents()[0]!.visits).toBe(2);
});

// --- Retained page text (browsing memory) ---

const DAY = 86_400_000;
/** A non-private visit and its retained text, at the same date. */
function visit(url: string, title: string, text: string, o: { spaceId?: string; date?: string } = {}) {
  const d = date(o.date ?? "2026-10-01T00:00:00Z");
  h.note({ url, title: title, spaceId: o.spaceId ?? "A", private: false, date: d });
  h.keep({ url, title: title, spaceId: o.spaceId ?? "A", text: text, date: d });
}

test("retenir truncates the text to 20,000 characters", () => {
  visit("https://a.fr/", "A", "x".repeat(25_000));
  expect(h.keptText("https://a.fr/")!.text).toHaveLength(20_000);
});

test("retenir a second time for the same page in the same space replaces the text", () => {
  visit("https://a.fr/", "A", "premier texte");
  visit("https://a.fr/", "A", "second texte", { date: "2026-10-02T00:00:00Z" });
  expect(h.keptText("https://a.fr/")).toEqual({ url: "https://a.fr/", title: "A", date: "2026-10-02T00:00:00.000Z", text: "second texte" });
  expect(h.searchForAgent({ query: "premier" })).toEqual([]);
});

test("Visit.retenu tells whether this visit's text (URL and space) is retained; oublierTexte forgets it alone", () => {
  visit("https://a.fr/", "A", "texte", { spaceId: "A" });
  h.note({ url: "https://a.fr/", title: "A", spaceId: "B", private: false });
  expect(Object.fromEntries(h.recents().map((v) => [v.spaceId, v.kept]))).toEqual({ A: true, B: false });
  h.forgetText("https://a.fr/", "A");
  expect(h.recents().map((v) => v.kept)).toEqual([false, false]);
  expect(h.recents()).toHaveLength(2);
});

test("purger erases visits and text older than 183 days and keeps the 182-day-old ones", () => {
  const now = date("2026-10-28T12:00:00Z");
  visit("https://vieux.fr/", "V", "vieux", { date: new Date(now.getTime() - 184 * DAY).toISOString() });
  visit("https://jeune.fr/", "J", "jeune", { date: new Date(now.getTime() - 182 * DAY).toISOString() });
  h.purge(now);
  expect(h.keptText("https://vieux.fr/")).toBeNull();
  expect(h.keptText("https://jeune.fr/")).not.toBeNull();
  expect(h.recents().map((v) => v.url)).toEqual(["https://jeune.fr/"]);
});

test("purger erases the icon of a host with no visit left", () => {
  const ICON = "data:image/png;base64,AAAA";
  const now = date("2026-10-28T12:00:00Z");
  h.note({ url: "https://vieux.fr/", title: "V", spaceId: "A", private: false, date: new Date(now.getTime() - 184 * DAY) });
  h.note({ url: "https://jeune.fr/", title: "J", spaceId: "A", private: false, date: new Date(now.getTime() - DAY) });
  h.noteIcon("https://vieux.fr/", "A", ICON);
  h.noteIcon("https://jeune.fr/", "A", ICON);
  h.purge(now);
  h.note({ url: "https://vieux.fr/", title: "V", spaceId: "A", private: false, date: now });
  expect(Object.fromEntries(h.recents().map((v) => [v.url, v.favicon]))).toEqual({ "https://vieux.fr/": null, "https://jeune.fr/": ICON });
});

test("beyond the cap, purger erases the oldest text first", () => {
  h.close();
  h = new History(path, { byteCap: 25 });
  visit("https://1.fr/", "1", "a".repeat(10), { date: "2026-10-01T00:00:00Z" });
  visit("https://2.fr/", "2", "é".repeat(5), { date: "2026-10-02T00:00:00Z" }); // 10 bytes in UTF-8
  visit("https://3.fr/", "3", "c".repeat(10), { date: "2026-10-03T00:00:00Z" });
  h.purge(date("2026-10-04T00:00:00Z"));
  expect(["https://1.fr/", "https://2.fr/", "https://3.fr/"].map((u) => h.keptText(u) !== null)).toEqual([false, true, true]);
});

test("titles are cut to TITLE_MAX characters at every write, and a kept title counts in the byte cap", () => {
  const long = "T".repeat(TITLE_MAX - 1) + "😀".repeat(10);
  visit("https://a.fr/", long, "x");
  h.importVisits([{ url: "https://b.fr/", title: long, date: new Date() }]);
  h.note({ url: "https://c.fr/", title: "c", spaceId: "", private: false });
  h.updateTitle("https://c.fr/", "", long);
  for (const v of h.recents()) expect(v.title).toBe("T".repeat(TITLE_MAX - 1)); // no half emoji
  expect(h.keptText("https://a.fr/")!.title).toBe("T".repeat(TITLE_MAX - 1));
  h.close();
  h = new History(path, { byteCap: 300 });
  visit("https://1.fr/", "t".repeat(200), "a", { date: "2026-10-01T00:00:00Z" });
  visit("https://2.fr/", "t".repeat(200), "b", { date: "2026-10-02T00:00:00Z" });
  h.purge(date("2026-10-04T00:00:00Z"));
  expect(["https://1.fr/", "https://2.fr/"].map((u) => h.keptText(u) !== null)).toEqual([false, true]);
});

test("a NUL in the agent's query is ignored instead of breaking the full-text query", () => {
  visit("https://a.fr/", "A", "zorg");
  expect(h.searchForAgent({ query: "zo\0rg" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("erase(depuis) also erases the retained text since that date; erase() erases everything", () => {
  visit("https://vieux.fr/", "V", "vieux", { date: "2026-10-01T00:00:00Z" });
  visit("https://recent.fr/", "R", "recent", { date: "2026-10-05T00:00:00Z" });
  h.erase(date("2026-10-04T00:00:00Z"));
  expect(h.keptText("https://recent.fr/")).toBeNull();
  expect(h.keptText("https://vieux.fr/")).not.toBeNull();
  expect(h.searchForAgent({ query: "recent" })).toEqual([]);
  h.erase();
  expect(h.keptText("https://vieux.fr/")).toBeNull();
  expect(h.searchForAgent({ query: "vieux" })).toEqual([]);
});

test("makePrivate forgets this space's text and keeps the same URL's text in another space", () => {
  visit("https://a.fr/", "A", "texte vu dans A", { spaceId: "A", date: "2026-10-02T00:00:00Z" });
  visit("https://a.fr/", "A", "texte vu dans B", { spaceId: "B", date: "2026-10-01T00:00:00Z" });
  h.makePrivate("A");
  expect(h.keptText("https://a.fr/")!.text).toBe("texte vu dans B");
  expect(h.recents().find((v) => v.spaceId === "A")!.kept).toBe(false);
});

test("searchForAgent finds « eclair » in the text, the title and the URL, ignoring case and accents", () => {
  visit("https://patisserie.fr/1", "Recettes", "Un Éclair au café");
  visit("https://patisserie.fr/2", "L'ÉCLAIR parfait", "chocolat");
  visit("https://eclair.fr/", "Accueil", "rien");
  expect(h.searchForAgent({ query: "eclair" }).map((r) => r.url).sort()).toEqual(["https://eclair.fr/", "https://patisserie.fr/1", "https://patisserie.fr/2"]);
});

test("searchForAgent: one URL per result, made of non-private visits only", () => {
  visit("https://a.fr/", "Titre A", "un texte sur les éclairs", { spaceId: "A", date: "2026-10-01T00:00:00Z" });
  h.note({ url: "https://a.fr/", title: "Titre A", spaceId: "A", private: false, date: date("2026-10-03T00:00:00Z") });
  h.note({ url: "https://a.fr/", title: "Titre B", spaceId: "B", private: false, date: date("2026-10-02T00:00:00Z") });
  h.note({ url: "https://a.fr/", title: "Secret", spaceId: "P", private: true, date: date("2026-10-09T00:00:00Z") });
  h.note({ url: "https://secret.fr/eclairs", title: "Éclairs secrets", spaceId: "P", private: true });
  expect(h.searchForAgent({ query: "éclairs" })).toEqual([
    { url: "https://a.fr/", title: "Titre A", lastVisit: "2026-10-03T00:00:00.000Z", visits: 3, excerpt: "un texte sur les éclairs" },
  ]);
});

test("searchForAgent never returns a private row's text", () => {
  visit("https://a.fr/", "A", "mot de passe xyzzy", { spaceId: "P" });
  h.note({ url: "https://a.fr/", title: "A", spaceId: "P", private: true }); // the space became private without rendrePrive
  h.note({ url: "https://a.fr/", title: "A", spaceId: "B", private: false });
  expect(h.searchForAgent({ query: "xyzzy" })).toEqual([]);
  expect(h.searchForAgent({ query: "a.fr" })).toMatchObject([{ url: "https://a.fr/", excerpt: "", visits: 1 }]);
  expect(h.keptText("https://a.fr/")).toBeNull();
});

test("searchForAgent honours depuis and jusqua", () => {
  for (const j of ["01", "05", "09"]) visit(`https://${j}.fr/`, `page ${j}`, "commun", { date: `2026-10-${j}T00:00:00Z` });
  const r = h.searchForAgent({ query: "commun", since: date("2026-10-02T00:00:00Z"), until: date("2026-10-06T00:00:00Z") });
  expect(r.map((x) => x.url)).toEqual(["https://05.fr/"]);
});

test("searchForAgent returns 20 results by default and never more than 50", () => {
  for (let i = 0; i < 60; i++) h.note({ url: `https://a.fr/${i}`, title: "page", spaceId: "A", private: false });
  expect(h.searchForAgent({ query: "page" })).toHaveLength(20);
  expect(h.searchForAgent({ query: "page", limit: 500 })).toHaveLength(50);
});

test("searchForAgent returns an excerpt of about 300 characters around the found word", () => {
  const before = "Lorem ipsum dolor sit amet. ".repeat(100);
  visit("https://a.fr/", "A", `${before} le mot introuvable est ici. ${before}`);
  const [r] = h.searchForAgent({ query: "introuvable" });
  expect(r!.excerpt).toContain("introuvable");
  expect(r!.excerpt.length).toBeGreaterThan(200);
  expect(r!.excerpt.length).toBeLessThan(400);
});

test("a visit without text is found by title or URL, with an empty excerpt", () => {
  h.note({ url: "https://github.com/sveltejs/svelte", title: "Svelte • Cybernétique", spaceId: "A", private: false });
  expect(h.searchForAgent({ query: "CYBERNETIQUE" })).toMatchObject([{ url: "https://github.com/sveltejs/svelte", excerpt: "" }]);
  expect(h.searchForAgent({ query: "LTEJS/SV" })).toMatchObject([{ title: "Svelte • Cybernétique", excerpt: "" }]);
});

test("ranking: texts found by bm25 first, then titles and URLs alone, from most to least recent", () => {
  h.note({ url: "https://titre-ancien.fr/", title: "rust", spaceId: "A", private: false, date: date("2026-10-01T00:00:00Z") });
  h.note({ url: "https://titre-recent.fr/", title: "rust", spaceId: "A", private: false, date: date("2026-10-08T00:00:00Z") });
  visit("https://peu.fr/", "Peu", `rust ${"autre chose ".repeat(200)}`, { date: "2026-10-09T00:00:00Z" });
  visit("https://beaucoup.fr/", "Beaucoup", "rust rust rust rust", { date: "2026-10-02T00:00:00Z" });
  expect(h.searchForAgent({ query: "rust" }).map((r) => r.url)).toEqual(["https://beaucoup.fr/", "https://peu.fr/", "https://titre-recent.fr/", "https://titre-ancien.fr/"]);
});

test("a query with FTS syntax (quotes, operators) is searched as is, without error", () => {
  visit("https://a.fr/", "A", "le NEAR de la tour");
  for (const q of ['"', "NEAR(", "a* OR", "titre:x", "-", "(((", 'é"é']) expect(() => h.searchForAgent({ query: q })).not.toThrow();
  expect(h.searchForAgent({ query: "NEAR" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("an empty query returns the most recent non-private visits", () => {
  h.note({ url: "https://a.fr/", title: "A", spaceId: "A", private: false, date: date("2026-10-01T00:00:00Z") });
  h.note({ url: "https://b.fr/", title: "B", spaceId: "A", private: false, date: date("2026-10-02T00:00:00Z") });
  h.note({ url: "https://p.fr/", title: "P", spaceId: "P", private: true, date: date("2026-10-03T00:00:00Z") });
  expect(h.searchForAgent({ query: "  " }).map((r) => r.url)).toEqual(["https://b.fr/", "https://a.fr/"]);
});

test("retained text survives reopening the file", () => {
  visit("https://a.fr/", "A", "persistant");
  h.close();
  h = new History(path);
  expect(h.searchForAgent({ query: "persistant" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
});

test("after fermer, the retained-text methods do not throw", () => {
  h.close();
  expect(() => h.keep({ url: "https://a.fr/", title: "A", spaceId: "A", text: "t" })).not.toThrow();
  expect(() => h.purge()).not.toThrow();
  expect(h.searchForAgent({ query: "t" })).toEqual([]);
  expect(h.keptText("https://a.fr/")).toBeNull();
});

test("importVisits: http(s) only, retention, upsert keeps latest, not private, searchable, fast", () => {
  const now = Date.now();
  const day = (n: number) => new Date(now - n * 86_400_000);
  const n = h.importVisits([
    { url: "https://old.fr/", title: "Old", date: day(1) },
    { url: "https://old.fr/", title: "Newer title", date: day(0.5) },
    { url: "ftp://x.fr/", title: "Ftp", date: day(1) },
    { url: "about:blank", title: "Blank", date: day(1) },
    { url: "https://ancient.fr/", title: "Ancient", date: day(200) },
  ]);
  expect(n).toBe(2);
  const rows = h.recents();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ url: "https://old.fr/", title: "Newer title", spaceId: IMPORTED_SPACE, private: false, visits: 1 });
  expect(h.importVisits([{ url: "https://old.fr/", title: "Same", date: day(0.5) }])).toBe(0);
  expect(h.search("newer")).toHaveLength(1);
  expect(h.searchForAgent({ query: "newer" }).map((r) => r.url)).toEqual(["https://old.fr/"]);
  const many = Array.from({ length: 10_000 }, (_, i) => ({ url: `https://s.fr/${i}`, title: `p${i}`, date: day(1) }));
  const t = Date.now();
  expect(h.importVisits(many)).toBe(10_000);
  expect(Date.now() - t).toBeLessThan(2000);
});

test("erased text leaves no trace in the database files, the full-text index's lowercase tokens included", () => {
  // The FTS5 index keeps tokens lowercased: « zorglub » is what a tombstone would leave behind.
  const read = () => ["", "-wal"].map((x) => { try { return readFileSync(path + x).toString("latin1"); } catch { return ""; } }).join("").toLowerCase();
  const keep = (url: string, spaceId: string, date = new Date()) => {
    h.note({ url, spaceId, title: "Zorglubtitle", private: false, date });
    h.keep({ url, spaceId, title: "Zorglubtitle", text: "Zorglubsecret ".repeat(50), date });
    expect(read()).toContain("zorglubsecret");
  };
  keep("https://a.fr/", "s");
  h.erase();
  expect(read()).not.toContain("zorglub");
  keep("https://a.fr/", "s");
  h.erase(new Date(Date.now() - 3_600_000));
  expect(read()).not.toContain("zorglub");
  keep("https://c.fr/", "s", new Date(Date.now() - 200 * 86_400_000));
  h.purge();
  expect(read()).not.toContain("zorglub");
  keep("https://d.fr/", "s");
  h.forgetText("https://d.fr/", "s");
  expect(read()).not.toContain("zorglubsecret"); // the visit keeps its title
  keep("https://b.fr/", "p");
  h.makePrivate("p");
  expect(read()).not.toContain("zorglubsecret"); // the private visit keeps its title
});

test("an index written before secure-delete is rebuilt once at open: its old tombstoned tokens are gone", () => {
  h.close();
  const db = new DatabaseSync(path);
  db.exec("INSERT INTO texts_fts (texts_fts, rank) VALUES ('secure-delete', 0); PRAGMA user_version = 1");
  db.prepare("INSERT INTO texts (url, space_id, title, date, text, bytes) VALUES ('https://a.fr/', 's', 't', '2026-01-01', 'Zorglubsecret', 13)").run();
  db.exec("DELETE FROM texts; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  expect(readFileSync(path).toString("latin1")).toContain("zorglubsecret");
  h = new History(path);
  h.erase(); // a checkpoint: the rebuilt index reaches the main file
  expect(readFileSync(path).toString("latin1")).not.toContain("zorglubsecret");
});

describe("site favicons", () => {
  const ICON = "data:image/png;base64,AAAA";
  const visit = (url: string, spaceId = "e", priv = false) => h.note({ url, title: url, spaceId, private: priv });

  test("noteIcon keeps a data:image/ icon per host, returned by search and recents", () => {
    visit("https://a.fr/page");
    visit("https://a.fr/autre");
    visit("https://b.fr/");
    h.noteIcon("https://a.fr/page", "e", ICON);
    expect(h.search("a.fr").map((v) => v.favicon)).toEqual([ICON, ICON]);
    expect(h.search("a.fr", 50, true).map((v) => v.favicon)).toEqual([ICON, ICON]);
    expect(h.recents().find((v) => v.url === "https://b.fr/")?.favicon).toBeNull();
  });

  test("noteIcon ignores http icons, oversize icons, non-http pages and private visits", () => {
    visit("https://a.fr/");
    visit("https://p.fr/", "P", true);
    h.noteIcon("https://a.fr/", "e", "https://a.fr/favicon.ico");
    h.noteIcon("https://a.fr/", "e", `data:image/png;base64,${"A".repeat(ICON_MAX)}`);
    h.noteIcon("file:///x.html", "e", ICON);
    h.noteIcon("https://p.fr/", "P", ICON);
    expect(h.recents().map((v) => v.favicon)).toEqual([null, null]);
  });

  test("erase() drops every icon; erase(from) drops only those of hosts left without a visit", () => {
    h.note({ url: "https://vieux.fr/", title: "V", spaceId: "e", private: false, date: date("2026-10-01T00:00:00Z") });
    h.note({ url: "https://neuf.fr:8080/", title: "N", spaceId: "e", private: false, date: date("2026-10-05T00:00:00Z") });
    h.noteIcon("https://vieux.fr/", "e", ICON);
    h.noteIcon("https://neuf.fr:8080/", "e", ICON);
    h.erase(date("2026-10-04T00:00:00Z"));
    h.note({ url: "https://neuf.fr/", title: "N", spaceId: "e", private: false });
    expect(h.recents().map((v) => [v.url, v.favicon])).toEqual([["https://neuf.fr/", null], ["https://vieux.fr/", ICON]]);
    h.erase();
    h.note({ url: "https://vieux.fr/", title: "V", spaceId: "e", private: false });
    expect(h.recents()[0]!.favicon).toBeNull();
  });

  test("the orphan icon sweep keeps hosts with a visit (http, https, port), drops the others", () => {
    const old = date("2026-10-01T00:00:00Z");
    // erase(from) erases the recent visits: the « gone » hosts only have recent ones.
    for (const url of ["https://a.fr/x", "http://b.fr/", "https://c.fr:8443/y", "http://d.fr:80/", "https://gone.fr/", "https://gone.fr:1/"]) {
      h.note({ url, title: url, spaceId: "e", private: false, date: url.includes("gone") ? new Date() : old });
      h.noteIcon(url, "e", ICON);
    }
    h.note({ url: "https://a.fr.evil/", title: "x", spaceId: "e", private: false, date: old }); // not a visit of a.fr
    h.note({ url: "https://e.fr/", title: "e", spaceId: "e", private: false });
    h.noteIcon("https://e.fr/", "e", ICON);
    h.note({ url: "https://e.fr.evil/", title: "x", spaceId: "e", private: false, date: old }); // keeps no icon of e.fr
    for (let i = 0; i < 100; i++) {
      h.note({ url: `https://s${i}.fr/${i % 2 ? "" : "p"}`, title: "s", spaceId: "e", private: false, date: i % 2 ? new Date() : old });
      h.noteIcon(`https://s${i}.fr/`, "e", ICON);
    }
    h.erase(date("2026-10-02T00:00:00Z"));
    const icons = new Map(h.recents(10_000).map((v) => [v.url, v.favicon]));
    for (const url of ["https://a.fr/x", "http://b.fr/", "https://c.fr:8443/y", "http://d.fr:80/", "https://s42.fr/p"]) expect(icons.get(url)).toBe(ICON);
    for (const url of ["https://gone.fr/", "https://e.fr/", "https://s43.fr/"]) {
      h.note({ url, title: "g", spaceId: "e", private: false });
      expect(h.recents(1)[0]!.favicon).toBeNull();
    }
  });
});

describe("page vectors", () => {
  let h: History;
  let path: string;
  const d = (day: number) => new Date(2026, 10, day, 12);
  const v = (...xs: number[]) => Float32Array.from(xs);
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "ressac-vec-")), "history.sqlite");
    h = new History(path);
  });
  afterEach(() => h.close());
  const visit = (url: string, title: string, o: { text?: string; date?: Date; spaceId?: string; priv?: boolean } = {}) => {
    h.note({ url, title, spaceId: o.spaceId ?? "s", private: o.priv ?? false, date: o.date ?? d(10) });
    if (o.text !== undefined) h.keep({ url, spaceId: o.spaceId ?? "s", title, text: o.text, date: o.date ?? d(10) });
  };
  /** Gives every pending page the same vector. */
  const indexAll = (vec = v(1, 0)) => h.saveVectors(h.pendingVectors(1000).map((r) => ({ ...r, vec })));
  const pending = () => h.pendingVectors(1000).map((r) => r.url);
  const vectored = () => {
    h.close();
    const db = new DatabaseSync(path);
    const rows = (db.prepare("SELECT url FROM vectors ORDER BY url").all() as { url: string }[]).map((r) => r.url);
    db.close();
    h = new History(path);
    return rows;
  };

  test("pending: non-private pages without a vector, most recent first, with title, host without www and a 300-char excerpt", () => {
    visit("https://www.old.fr/a", "Old", { text: "x".repeat(400), date: d(1) });
    visit("https://new.fr/b", "New", { date: d(5) });
    visit("https://priv.fr/", "Privé", { priv: true, date: d(6) });
    expect(h.pendingVectors(10)).toEqual([
      { url: "https://new.fr/b", spaceId: "s", title: "New", host: "new.fr", excerpt: "", lastVisit: d(5).toISOString() },
      { url: "https://www.old.fr/a", spaceId: "s", title: "Old", host: "old.fr", excerpt: "x".repeat(300), lastVisit: d(1).toISOString() },
    ]);
    expect(h.pendingVectors(1).map((r) => r.url)).toEqual(["https://new.fr/b"]);
    indexAll();
    expect(pending()).toEqual([]);
  });

  test("pending before a date: only pages last seen at or before it (a pass's cursor, ties included)", () => {
    visit("https://a.fr/", "A", { date: d(1) });
    visit("https://b.fr/", "B", { date: d(2) });
    visit("https://c.fr/", "C", { date: d(2) });
    visit("https://e.fr/", "E", { date: d(3) });
    expect(h.pendingVectors(10, d(2).toISOString()).map((r) => r.url).sort()).toEqual(["https://a.fr/", "https://b.fr/", "https://c.fr/"]);
    expect(h.pendingVectors(10, undefined, d(2).toISOString()).map((r) => r.url).sort()).toEqual(["https://b.fr/", "https://c.fr/", "https://e.fr/"]);
  });

  test("a NUL character in a title or text is dropped at every write, so the page's vector is saved", () => {
    visit("https://a.fr/", "a\0b", { text: "x\0y" });
    h.importVisits([{ url: "https://b.fr/", title: "c\0d", date: new Date() }]);
    visit("https://c.fr/", "C");
    h.updateTitle("https://c.fr/", "s", "e\0f");
    const rows = h.pendingVectors(10);
    expect(rows.map((r) => [r.title, r.excerpt]).sort()).toEqual([["ab", "xy"], ["cd", ""], ["ef", ""]]);
    expect(h.saveVectors(rows.map((r) => ({ ...r, vec: v(1, 0) })))).toBe(3);
    expect(pending()).toEqual([]);
  });

  test("titles and texts stored with a NUL before the fix are cleaned once at open, the full-text index too", () => {
    h.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 0"); // a database from before the cleanup
    db.prepare("INSERT INTO visits (url, space_id, title, last_visit, url_fold, title_fold) VALUES (?, 's', ?, ?, ?, ?)").run("https://a.fr/", "a\0b", d(1).toISOString(), "https://a.fr/", "a\0b");
    db.prepare("INSERT INTO texts (url, space_id, title, date, text, bytes) VALUES (?, 's', ?, ?, ?, 4)").run("https://a.fr/", "a\0b", d(1).toISOString(), "x\0yzorg");
    db.close();
    h = new History(path);
    expect(h.pendingVectors(10).map((r) => [r.title, r.excerpt])).toEqual([["ab", "xyzorg"]]);
    expect(h.search("ab").map((r) => r.title)).toEqual(["ab"]);
    expect(h.searchForAgent({ query: "xyzorg" }).map((r) => r.url)).toEqual(["https://a.fr/"]);
    expect(h.saveVectors(h.pendingVectors(10).map((r) => ({ ...r, vec: v(1, 0) })))).toBe(1);
  });

  test("vectors of another search model are dropped at open; the same model keeps them", () => {
    h.close();
    h = new History(path, { vectorModel: "m1.gguf" });
    visit("https://a.fr/", "A");
    indexAll();
    h.close();
    h = new History(path, { vectorModel: "m1.gguf" });
    expect(pending()).toEqual([]);
    h.close();
    h = new History(path, { vectorModel: "m2.gguf" });
    expect(pending()).toEqual(["https://a.fr/"]);
  });

  test("a private space is never pending, and turning a space private drops its vectors", () => {
    visit("https://a.fr/", "A", { spaceId: "x" });
    indexAll();
    h.makePrivate("x");
    expect(vectored()).toEqual([]);
    expect(pending()).toEqual([]);
  });

  test("a vector is kept per URL and per space, and survives a restart", () => {
    visit("https://a.fr/", "A", { spaceId: "x" });
    visit("https://a.fr/", "A", { spaceId: "y" });
    indexAll();
    expect(vectored()).toEqual(["https://a.fr/", "https://a.fr/"]);
    expect(pending()).toEqual([]);
  });

  test("a changed title or excerpt drops the vector (re-embedded); a revisit with the same ones keeps it", () => {
    visit("https://a.fr/", "A", { text: "texte" });
    visit("https://b.fr/", "B", { text: "texte" });
    visit("https://c.fr/", "C");
    indexAll();
    visit("https://a.fr/", "A", { text: "texte" });
    expect(pending()).toEqual([]);
    h.updateTitle("https://a.fr/", "s", "A2");
    h.keep({ url: "https://b.fr/", spaceId: "s", title: "B", text: "autre texte" });
    h.keep({ url: "https://c.fr/", spaceId: "s", title: "C", text: "premier texte" });
    expect(pending().sort()).toEqual(["https://a.fr/", "https://b.fr/", "https://c.fr/"]);
  });

  test("a vector computed before its page changed is not saved", () => {
    visit("https://a.fr/", "A");
    const [row] = h.pendingVectors(1);
    h.updateTitle("https://a.fr/", "s", "A2");
    h.saveVectors([{ ...row!, vec: v(1, 0) }]);
    expect(pending()).toEqual(["https://a.fr/"]);
  });

  describe("every erase removes the matching vectors", () => {
    test("erase() (everything)", () => {
      visit("https://a.fr/", "A", { text: "t" });
      indexAll();
      h.erase();
      expect(vectored()).toEqual([]);
    });

    test("erase(since)", () => {
      visit("https://old.fr/", "O", { date: d(1) });
      visit("https://new.fr/", "N", { text: "t", date: d(5) });
      indexAll();
      h.erase(d(4));
      expect(vectored()).toEqual(["https://old.fr/"]);
    });

    test("forgetText (one URL): its vector goes, re-embedded without the text", () => {
      visit("https://a.fr/", "A", { text: "t" });
      indexAll();
      h.forgetText("https://a.fr/", "s");
      expect(vectored()).toEqual([]);
      expect(h.pendingVectors(1)[0]!.excerpt).toBe("");
    });

    test("purge (retention)", () => {
      const now = new Date();
      visit("https://old.fr/", "O", { text: "t", date: new Date(now.getTime() - 184 * DAY) });
      visit("https://new.fr/", "N", { date: now });
      indexAll();
      h.purge(now);
      expect(vectored()).toEqual(["https://new.fr/"]);
    });

    test("purge (byte cap)", () => {
      h.close();
      h = new History(path, { byteCap: 15 });
      visit("https://1.fr/", "1", { text: "a".repeat(10), date: d(1) });
      visit("https://2.fr/", "2", { text: "b".repeat(10), date: d(2) });
      indexAll();
      h.purge(d(3));
      expect(vectored()).toEqual(["https://2.fr/"]);
    });
  });

  describe("findSimilar", () => {
    const save = (url: string, vec: Float32Array) => {
      const row = h.pendingVectors(1000).find((r) => r.url === url)!;
      h.saveVectors([{ ...row, vec }]);
    };
    test("orders by cosine, returns the score, one hit per URL with its excerpt", () => {
      visit("https://near.fr/", "Near", { text: "proche", date: d(3) });
      visit("https://far.fr/", "Far", { date: d(4) });
      visit("https://mid.fr/", "Mid", { spaceId: "a", date: d(2) });
      visit("https://mid.fr/", "Mid", { spaceId: "b", date: d(5) });
      save("https://near.fr/", v(1, 0));
      save("https://far.fr/", v(0, 1));
      save("https://mid.fr/", v(0.6, 0.8));
      const hits = h.findSimilar(v(1, 0), { limit: 10 });
      expect(hits.map((x) => [x.url, Math.round(x.score * 100) / 100])).toEqual([["https://near.fr/", 1], ["https://mid.fr/", 0.6], ["https://far.fr/", 0]]);
      expect(hits[0]).toMatchObject({ title: "Near", excerpt: "proche", visits: 1, favicon: null });
      expect(h.findSimilar(v(1, 0), { limit: 1 })).toHaveLength(1);
    });

    test("a small limit gives the full ranking's best pages; a URL in two spaces keeps its best score, its latest title and both visits", () => {
      for (let i = 0; i < 40; i++) visit(`https://p${i}.fr/`, `P${i}`, { date: d(1 + (i % 5)) });
      visit("https://two.fr/", "Two old", { spaceId: "a", date: d(2) });
      visit("https://two.fr/", "Two", { spaceId: "b", date: d(3) });
      h.saveVectors(h.pendingVectors(1000).map((r, i) => ({ ...r, vec: r.url === "https://two.fr/" ? (r.spaceId === "a" ? v(0.995, 0.0998) : v(0, 1)) : v(Math.cos(i / 10), Math.sin(i / 10)) })));
      const all = h.findSimilar(v(1, 0), { limit: 100 });
      expect(all).toHaveLength(41);
      expect(h.findSimilar(v(1, 0), { limit: 5 })).toEqual(all.slice(0, 5));
      expect(all.find((x) => x.url === "https://two.fr/")).toMatchObject({ title: "Two", visits: 2 });
      expect(all.find((x) => x.url === "https://two.fr/")!.score).toBeCloseTo(0.995);
    });

    test("honours the period and the sites, never a private visit", () => {
      visit("https://a.fr/", "A", { date: d(1) });
      visit("https://www.youtube.com/w", "Y", { date: d(5) });
      visit("https://b.fr/", "B", { date: d(6) });
      indexAll();
      visit("https://b.fr/", "B", { priv: true, date: d(6) }); // the same page seen again in private
      const urls = (q: Partial<Parameters<History["findSimilar"]>[1]>) => h.findSimilar(v(1, 0), { limit: 10, ...q }).map((x) => x.url).sort();
      expect(urls({ since: d(4), until: d(5) })).toEqual(["https://www.youtube.com/w"]);
      expect(urls({ sites: ["youtube.com"] })).toEqual(["https://www.youtube.com/w"]);
      expect(urls({})).toEqual(["https://a.fr/", "https://www.youtube.com/w"]);
      expect(vectored()).toEqual(["https://a.fr/", "https://www.youtube.com/w"]);
    });

    test("a refused page is skipped and not pending; a vector of another length is ignored and dropped to be recomputed", () => {
      visit("https://refused.fr/", "R");
      visit("https://old-model.fr/", "O");
      visit("https://ok.fr/", "K");
      save("https://refused.fr/", REFUSED_VECTOR);
      save("https://old-model.fr/", v(1, 0, 0));
      save("https://ok.fr/", v(1, 0));
      expect(pending()).toEqual([]);
      expect(h.findSimilar(v(1, 0), { limit: 10 }).map((x) => x.url)).toEqual(["https://ok.fr/"]);
      expect(pending()).toEqual(["https://old-model.fr/"]);
    });
  });
});
