import { expect, test } from "vitest";
import { isAction, parseAsk } from "../host/ask-rules";

// Monday 16 November 2026, afternoon local time (the bench's day).
const TODAY = new Date(2026, 10, 16, 15);
const iso = (d?: Date) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const period = (q: string) => {
  const p = parseAsk(q, TODAY);
  return [iso(p.since) ?? null, iso(p.until) ?? null];
};

// rules.py's self-tests.
test.each([
  ["la vidéo vue hier", "2026-11-15", "2026-11-15"],
  ["avant-hier", "2026-11-14", "2026-11-14"],
  ["last week", "2026-11-09", "2026-11-15"],
  ["ce week-end", "2026-11-14", "2026-11-15"],
  ["l'autre jour", "2026-11-09", null],
  ["mardi dernier", "2026-11-10", "2026-11-10"],
  ["last month", "2026-10-01", "2026-10-31"],
  ["il y a 3 jours", "2026-11-12", "2026-11-14"],
  ["two days ago", "2026-11-13", "2026-11-15"],
  ["la doc MDN sur fetch", null, null],
  ["dimanche", "2026-11-15", "2026-11-15"],
  // The two fixes after the bench.
  ["la recette du dimanche, vue mardi dernier", "2026-11-10", "2026-11-10"],
  ["le marché du dimanche, vus mardi", "2026-11-10", "2026-11-10"],
  ["la page vue la semaine d'avant", "2026-11-09", "2026-11-15"],
  // Curly apostrophe, accents.
  ["l’article d’aujourd’hui", "2026-11-16", "2026-11-16"],
  ["le mois passé", "2026-10-01", "2026-10-31"],
  // Decomposed accents (a pasted or macOS-typed text) read as composed ones.
  ["le mois passe\u0301", "2026-10-01", "2026-10-31"],
  // A weekday after « vu » / « watched on » is the last one past.
  ["la page vu mardi", "2026-11-10", "2026-11-10"],
  ["the video watched on Tuesday", "2026-11-10", "2026-11-10"],
])("period of « %s »", (q, since, until) => {
  expect(period(q)).toEqual([since, until]);
});

test("since is local midnight, until the day's last millisecond", () => {
  const p = parseAsk("hier", TODAY);
  expect(p.since).toEqual(new Date(2026, 10, 15));
  expect(p.until).toEqual(new Date(2026, 10, 15, 23, 59, 59, 999));
});

test("rest: the question without its period words", () => {
  expect(parseAsk("la vidéo de hier", TODAY).rest).toBe("la vidéo de");
  expect(parseAsk("l’article d’aujourd’hui sur Rust", TODAY).rest).toBe("l’article d’ sur Rust");
  expect(parseAsk("la doc MDN sur fetch", TODAY).rest).toBe("la doc MDN sur fetch");
});

test("video words filter video sites", () => {
  expect(parseAsk("la vidéo du mascaret", TODAY).sites).toEqual(["youtube.com", "vimeo.com", "dailymotion.com"]);
  expect(parseAsk("le mascaret", TODAY).sites).toEqual([]);
  // Decomposed accents.
  expect(parseAsk("la vide\u0301o du mascaret", TODAY).sites).toEqual(["youtube.com", "vimeo.com", "dailymotion.com"]);
  expect(isAction("re\u0301sume-moi cette page")).toBe(true);
});

test("action requests", () => {
  expect(parseAsk("the review", TODAY).action).toBe(false);
  expect(isAction("résume-moi cette page")).toBe(true);
  expect(isAction("what's the weather")).toBe(true);
  expect(isAction("what is a monad")).toBe(true);
  expect(isAction("c'était quoi le site de recettes")).toBe(false);
  // A question word with a page noun stays a page search.
  expect(isAction("quelle était la page sur le mascaret")).toBe(false);
  expect(isAction("")).toBe(false);
});

test.each([
  // Sunday 15 and Saturday 14 November 2026: « dernier / last » is the weekend before this one.
  [new Date(2026, 10, 15, 15), "le week-end dernier", "2026-11-07", "2026-11-08"],
  [new Date(2026, 10, 14, 15), "last weekend", "2026-11-07", "2026-11-08"],
  [new Date(2026, 10, 15, 15), "ce week-end", "2026-11-14", "2026-11-15"],
  // Monday: the weekend just past.
  [new Date(2026, 10, 16, 15), "le weekend dernier", "2026-11-14", "2026-11-15"],
  // Sunday 3 January 2027: across the year.
  [new Date(2027, 0, 3, 15), "le week-end dernier", "2026-12-26", "2026-12-27"],
])("on %s, « %s »", (today, q, since, until) => {
  const p = parseAsk(q, today);
  expect([iso(p.since), iso(p.until)]).toEqual([since, until]);
});

test.each([
  // A weekday that is the page's subject is no period.
  ["la recette du dimanche", null, null],
  ["le marché du mardi", null, null],
  ["les crêpes de mardi gras", null, null],
  ["mardi gras", null, null],
  ["le dimanche", null, null],
  // Alone, or marked, it stays a period.
  ["mardi", "2026-11-10", "2026-11-10"],
  ["la page vue le dimanche", "2026-11-15", "2026-11-15"],
  ["le dimanche dernier", "2026-11-15", "2026-11-15"],
])("weekday in « %s »", (q, since, until) => {
  expect(period(q)).toEqual([since, until]);
});
