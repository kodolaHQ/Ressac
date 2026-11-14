import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { History } from "../core/history";
import { createAsk } from "../host/ask";

// Saturday 14 November 2026, noon local time.
const NOW = new Date(2026, 10, 14, 12);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let h: History;
beforeEach(() => {
  h = new History(join(mkdtempSync(join(tmpdir(), "ressac-ask-")), "history.sqlite"));
});
afterEach(() => h.close());

const visit = (url: string, title: string, text: string | null, date: Date, priv = false) => {
  h.note({ url, title, spaceId: "s", private: priv, date });
  if (text !== null) h.keep({ url, spaceId: "s", title, text, date });
};

const make = (answer: unknown, o: { timeoutMs?: number } = {}) => {
  const gemma = vi.fn(async (_: { prompt: string; json?: boolean; signal?: AbortSignal }) => answer);
  const check = vi.fn(async () => ({ kev: false, uv: false, ollama: true, gemma: true, gemmaModel: "gemma4:e4b" as string | null, decision: false }));
  const warm = vi.fn(async () => {});
  const history = { searchForAgent: vi.fn((q: Parameters<History["searchForAgent"]>[0]) => h.searchForAgent(q)) };
  const ask = createAsk({ ai: { gemma, check, warm }, history: () => history, now: () => NOW, ...o });
  return { ask, gemma, check, warm, history };
};

const page = (extra: Record<string, unknown> = {}) => ({ kind: "page", terms: ["mascaret", "mascarets"], ...extra });

test("a page question finds the recent visit, the older one is left out by since", async () => {
  visit("https://www.youtube.com/watch?v=1", "Le mascaret de la Dordogne", "vidéo du mascaret à Saint-Pardon", daysAgo(3));
  visit("https://old.fr/mascaret", "Mascaret ancien", "un vieux mascaret", daysAgo(30));
  const { ask } = make(JSON.stringify(page({ since: "2026-11-07" })));
  const r = await ask.find("la vidéo du mascaret l'autre jour", "fr");
  expect(r).toEqual({
    kind: "page",
    hits: [{ url: "https://www.youtube.com/watch?v=1", title: "Le mascaret de la Dordogne", lastVisit: daysAgo(3).toISOString(), excerpt: expect.stringContaining("mascaret") }],
  });
});

test("an already parsed answer works too; until covers its whole day", async () => {
  visit("https://a.fr/", "Mascaret hier soir", null, new Date(2026, 10, 13, 23, 30));
  visit("https://b.fr/", "Mascaret aujourd'hui", null, new Date(2026, 10, 14, 9));
  const { ask } = make(page({ since: "2026-11-13", until: "2026-11-13" }));
  expect(await ask.find("le mascaret d'hier", "fr")).toEqual({
    kind: "page",
    hits: [{ url: "https://a.fr/", title: "Mascaret hier soir", lastVisit: new Date(2026, 10, 13, 23, 30).toISOString(), excerpt: null }],
  });
});

test("a hinted site ranks first", async () => {
  visit("https://blog.fr/mascaret", "Mascaret", "mascaret mascaret mascaret", daysAgo(1));
  visit("https://www.youtube.com/watch?v=2", "Vidéo", "le mascaret", daysAgo(2));
  const plain = await make(page()).ask.find("le mascaret", "fr");
  expect(plain.kind === "page" && plain.hits.map((x) => x.url)).toEqual(["https://blog.fr/mascaret", "https://www.youtube.com/watch?v=2"]);
  const { ask } = make(page({ sites: ["youtube.com"] }));
  const r = await ask.find("la vidéo du mascaret", "fr");
  expect(r.kind === "page" && r.hits.map((x) => x.url)).toEqual(["https://www.youtube.com/watch?v=2", "https://blog.fr/mascaret"]);
});

test("sites that are not strings are ignored, not malformed", async () => {
  visit("https://blog.fr/mascaret", "Mascaret", null, daysAgo(1));
  const { ask } = make(page({ sites: "youtube.com" }));
  expect((await ask.find("mascaret", "fr")).kind).toBe("page");
});

test("5 matches → 3 hits, searched with limit 20", async () => {
  for (let i = 0; i < 5; i++) visit(`https://s${i}.fr/`, `Mascaret ${i}`, null, daysAgo(i + 1));
  const { ask, history } = make(page());
  const r = await ask.find("mascaret", "fr");
  expect(r.kind === "page" && r.hits.length).toBe(3);
  expect(history.searchForAgent).toHaveBeenCalledWith({ query: "mascaret mascarets", since: undefined, until: undefined, limit: 20 });
});

test("a private visit is not a hit; no match → agent", async () => {
  visit("https://secret.fr/", "Mascaret secret", null, daysAgo(1), true);
  const { ask } = make(page());
  expect(await ask.find("mascaret", "fr")).toEqual({ kind: "agent" });
});

test("kind other → agent, history not searched", async () => {
  const { ask, history } = make({ kind: "other" });
  expect(await ask.find("résume cette page", "fr")).toEqual({ kind: "agent" });
  expect(history.searchForAgent).not.toHaveBeenCalled();
});

test.each([
  ["non-JSON", "pas du json"],
  ["terms not strings", page({ terms: [1] })],
  ["empty terms", page({ terms: [] })],
  ["since not a date", page({ since: "hier" })],
  ["since an impossible date", page({ since: "2026-02-31" })],
  ["too many terms", page({ terms: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })],
])("malformed answer (%s) → agent", async (_, answer) => {
  visit("https://a.fr/", "Mascaret", null, daysAgo(1));
  const { ask, history } = make(answer);
  expect(await ask.find("mascaret", "fr")).toEqual({ kind: "agent" });
  expect(history.searchForAgent).not.toHaveBeenCalled();
});

test("gemma throwing, or no history → agent", async () => {
  const { ask, gemma } = make(page());
  gemma.mockRejectedValueOnce(new Error("Ollama n'est pas lancé"));
  expect(await ask.find("mascaret", "fr")).toEqual({ kind: "agent" });
  const none = createAsk({ ai: { gemma: async () => page(), check: async () => ({}) as never, warm: async () => {} }, history: () => null, now: () => NOW });
  expect(await none.find("mascaret", "fr")).toEqual({ kind: "agent" });
});

test("no answer within timeoutMs → agent, and gemma's signal is aborted", async () => {
  const { ask, gemma } = make(undefined, { timeoutMs: 50 });
  gemma.mockImplementationOnce(() => new Promise(() => {}));
  const start = Date.now();
  expect(await ask.find("mascaret", "fr")).toEqual({ kind: "agent" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(gemma.mock.calls[0]![0].signal!.aborted).toBe(true);
});

test("the prompt asks for JSON and gives today's date and weekday, in the UI language", async () => {
  const { ask, gemma } = make({ kind: "other" });
  await ask.find("mascaret", "fr");
  await ask.find("mascaret", "en");
  const [fr, en] = gemma.mock.calls.map((c) => c[0]);
  expect(fr!.json).toBe(true);
  expect(fr!.prompt).toContain("2026-11-14");
  expect(fr!.prompt).toContain("samedi");
  expect(fr!.prompt).toContain("mascaret");
  expect(en!.prompt).toContain("2026-11-14");
  expect(en!.prompt).toContain("Saturday");
});

test("usable: Ollama and Gemma both there; a failing check is false; warm calls the AI", async () => {
  const { ask, check, warm } = make(null);
  expect(await ask.usable()).toBe(true);
  check.mockResolvedValueOnce({ kev: false, uv: false, ollama: true, gemma: false, gemmaModel: null, decision: false });
  expect(await ask.usable()).toBe(false);
  check.mockRejectedValueOnce(new Error("boom"));
  expect(await ask.usable()).toBe(false);
  ask.warm();
  expect(warm).toHaveBeenCalled();
});
