import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { History, IMPORTED_SPACE } from "../core/history";

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
  expect(h.recents()).toEqual([{ url: "https://a.fr/", title: "Nouveau", lastVisit: "2026-10-02T10:00:00.000Z", visits: 2, spaceId: "", private: false, kept: false }]);
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

test("purger erases text older than 183 days and keeps the 182-day-old one", () => {
  const now = date("2026-10-28T12:00:00Z");
  visit("https://vieux.fr/", "V", "vieux", { date: new Date(now.getTime() - 184 * DAY).toISOString() });
  visit("https://jeune.fr/", "J", "jeune", { date: new Date(now.getTime() - 182 * DAY).toISOString() });
  h.purge(now);
  expect(h.keptText("https://vieux.fr/")).toBeNull();
  expect(h.keptText("https://jeune.fr/")).not.toBeNull();
  expect(h.recents()).toHaveLength(2); // the visits remain
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

describe("findPages: every group must match, title and URL before kept text", () => {
  let h: History;
  const d = (day: number) => new Date(2026, 10, day, 12);
  beforeEach(() => {
    h = new History(join(mkdtempSync(join(tmpdir(), "ressac-find-")), "history.sqlite"));
  });
  afterEach(() => h.close());
  const visit = (url: string, title: string, text: string | null, date: Date, priv = false) => {
    h.note({ url, title, spaceId: "s", private: priv, date });
    if (text !== null) h.keep({ url, spaceId: "s", title, text, date });
  };
  const urls = (q: Parameters<History["findPages"]>[0]) => h.findPages(q).map((r) => r.url);

  test("an English title found from French words with English variants, noise left out", () => {
    visit("https://www.youtube.com/watch?v=a", "I discovered a sound that leaks your exact location", null, d(12));
    visit("https://github.com/x/readme", "README", "son lieu vidéo sound location everything", d(14));
    visit("https://www.leboncoin.fr/recherche?text=videoprojecteur", "« vidéoprojecteur 4K »", null, d(13));
    expect(urls({ groups: [["son", "sound"], ["lieu", "location"]], limit: 3 })).toEqual(["https://www.youtube.com/watch?v=a", "https://github.com/x/readme"]);
  });

  test("one group missing → not a hit (AND across groups, OR inside)", () => {
    visit("https://a.fr/", "Le son du mascaret", null, d(12));
    expect(urls({ groups: [["son"], ["lieu", "location"]], limit: 3 })).toEqual([]);
  });

  test("a word matches at a word start, not inside another word", () => {
    visit("https://a.fr/", "Jason and the season", null, d(12));
    visit("https://b.fr/", "Sons et lieux", null, d(12));
    expect(urls({ groups: [["son"], ["lieu"]], limit: 3 })).toEqual(["https://b.fr/"]);
  });

  test("sites filter, period applies, private visits never", () => {
    visit("https://www.youtube.com/watch?v=1", "Mascaret", null, d(12));
    visit("https://m.youtube.com/watch?v=2", "Mascaret mobile", null, d(13));
    visit("https://blog.fr/m", "Mascaret", null, d(13));
    visit("https://www.youtube.com/watch?v=3", "Mascaret ancien", null, d(1));
    visit("https://www.youtube.com/watch?v=4", "Mascaret secret", null, d(13), true);
    expect(urls({ groups: [["mascaret"]], sites: ["youtube.com"], since: d(10), limit: 5 })).toEqual(["https://m.youtube.com/watch?v=2", "https://www.youtube.com/watch?v=1"]);
  });

  test("from 3 groups on, a title may miss one (a model's extra idea); with 2, never", () => {
    visit("https://www.youtube.com/watch?v=a", "I discovered a sound that leaks your exact location", null, d(12));
    expect(urls({ groups: [["son", "sound"], ["lieu", "location"], ["trouver", "find"]], limit: 3 })).toEqual(["https://www.youtube.com/watch?v=a"]);
    expect(urls({ groups: [["son", "sound"], ["trouver", "find"]], limit: 3 })).toEqual([]);
  });

  test("accents and case folded; FTS operators in words are literal", () => {
    visit("https://a.fr/", "L'ÉTÉ à Bordeaux", null, d(12));
    expect(urls({ groups: [["ete"], ["bordeaux"]], limit: 3 })).toEqual(["https://a.fr/"]);
    expect(() => h.findPages({ groups: [['a" OR "b'], ["NEAR("]], limit: 3 })).not.toThrow();
  });
});
