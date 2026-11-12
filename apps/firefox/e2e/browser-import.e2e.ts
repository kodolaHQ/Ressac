import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportProgress, ImportSource } from "../shared/api";
import type { Visit } from "../shared/model";
import { state } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inUi, missingApi } from "./ui";

// Plan 55 Task 2: a fake home with a Chrome-format profile, imported through the engine's Chrome migrator.
// Task 3: a fake Arc sidebar and Zen session (the unit test fixtures), their spaces brought into the store.

let w: LaunchedWebAiOs;
let m: Marionette;
let home = "";
let csv = "";

/** Chrome's time: microseconds since 1601. */
const chromeTime = (d: Date) => (d.getTime() + 11_644_473_600_000) * 1000;

function fakeChrome(root: string): void {
  const profile = join(root, "Library/Application Support/Google/Chrome/Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "..", "Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personne 1" } } } }));
  writeFileSync(
    join(profile, "Bookmarks"),
    JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: { type: "folder", name: "Barre", children: [{ type: "url", name: "Exemple A", url: "https://a.example/" }, { type: "folder", name: "Travail", children: [{ type: "url", name: "Exemple B", url: "https://b.example/page" }] }] },
        other: { type: "folder", name: "Autres", children: [] },
        synced: { type: "folder", name: "Mobile", children: [] },
      },
    }),
  );
  const db = new DatabaseSync(join(profile, "History"));
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)");
  db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
  const day = 86_400_000;
  const add = db.prepare("INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, 1, ?)");
  add.run("https://h1.example/lu", "Page lue un", chromeTime(new Date(Date.now() - 2 * day)));
  add.run("https://h2.example/lu", "Page lue deux", chromeTime(new Date(Date.now() - 3 * day)));
  db.exec("INSERT INTO visits (url, visit_time) SELECT id, last_visit_time FROM urls");
  db.close();
  // Not a database: the passwords fail, the rest comes in. The keychain is never asked (it fails before).
  writeFileSync(join(profile, "Login Data"), "pas une base de données");
}

const fixture = (name: string) => readFileSync(join(__dirname, "../test/fixtures/import", name));

/** mozlz4: magic, size, then an LZ4 block of literals only (valid LZ4, no compression needed). */
function mozLz4(data: Buffer): Buffer {
  const len = [];
  for (let rest = data.length - 15; rest >= 0; rest -= 255) len.push(Math.min(rest, 255));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from("mozLz40\0", "latin1"), size, Buffer.from([Math.min(data.length, 15) << 4, ...(data.length >= 15 ? len : [])]), data]);
}

function fakeArcAndZen(root: string): void {
  const support = join(root, "Library/Application Support");
  mkdirSync(join(support, "Arc/User Data/Default"), { recursive: true });
  writeFileSync(join(support, "Arc/User Data/Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Arc 1" } } } }));
  writeFileSync(join(support, "Arc/StorableSidebar.json"), fixture("arc-StorableSidebar.json"));
  mkdirSync(join(support, "zen/Profiles/abc.Default"), { recursive: true });
  writeFileSync(join(support, "zen/profiles.ini"), "[Profile0]\nName=Default\nIsRelative=1\nPath=Profiles/abc.Default\nDefault=1\n");
  writeFileSync(join(support, "zen/Profiles/abc.Default/zen-sessions.jsonlz4"), mozLz4(fixture("zen-sessions.json")));
}

beforeAll(async () => {
  home = await mkdtemp(join(os.tmpdir(), "webaios-import-home-"));
  fakeChrome(home);
  fakeArcAndZen(home);
  csv = join(home, "passwords.csv");
  writeFileSync(csv, "url,username,password\nhttps://site1.example,alice,secret-1\nhttps://site2.example,bob,secret-2\n");
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_IMPORT_HOME: home, WEBAIOS_TEST_IMPORT_CSV: csv } });
  m = w.marionette;
  await m.setContext("chrome");
});
afterAll(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    await rm(home, { recursive: true, force: true });
  }
});

const api = <T>(call: string, args: unknown[] = []) => inUi<T>(m, `return JSON.parse(JSON.stringify(await ui.webaios.browserImport.${call}));`, args);
async function finished(): Promise<ImportProgress> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const p = await api<ImportProgress | null>("progress()");
    if (p?.done) return p;
    if (Date.now() > deadline) throw new Error(`import not done: ${JSON.stringify(p)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const bookmarks = (url: string) =>
  m.execute<{ title: string; parent: string }[]>(
    `return (async () => {
      const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
      const found = await PlacesUtils.bookmarks.search({ url: arguments[0] });
      return Promise.all(found.map(async (b) => ({ title: b.title, parent: (await PlacesUtils.bookmarks.fetch(b.parentGuid)).title })));
    })();`,
    [url],
  );
const history = () => inUi<Visit[]>(m, `return JSON.parse(JSON.stringify(await ui.webaios.history.search("lue", 50)));`);
const notifications = () =>
  readFileSync(join(w.dataDir, "notifications.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { title: string; text: string })
    .filter((n) => n.title.startsWith("Import"));

describe("import from another browser", () => {
  it("lists the fake browsers, with their profiles", async () => {
    const sources = await api<ImportSource[]>("sources()");
    expect(sources.map((s) => [s.id, s.types])).toEqual([
      ["arc", ["bookmarks", "history", "passwords", "spaces"]],
      ["chrome", ["bookmarks", "history", "passwords"]],
      ["zen", ["bookmarks", "history", "spaces"]],
    ]);
    expect(sources[1]).toEqual({ id: "chrome", name: "Google Chrome", profiles: [{ id: "Default", name: "Personne 1" }], types: ["bookmarks", "history", "passwords"], passwordsByCsv: false });
  });

  it("brings bookmarks and history, says why passwords failed, leaves no copy, and a re-import doubles nothing", async () => {
    const start = { source: "chrome", profile: "Default", types: ["bookmarks", "history", "passwords"] };
    const [first, second] = await inUi<unknown[]>(
      m,
      "const a = ui.webaios.browserImport.start(arguments[0]); const b = ui.webaios.browserImport.start(arguments[0]); return JSON.parse(JSON.stringify(await Promise.all([a, b])));",
      [start],
    );
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, error: "Un import est déjà en cours" });
    const p = await finished();
    expect(p.counts).toEqual({ bookmarks: 2, history: 2 });
    // The garbage Login Data is found unreadable (and the copy retried) before the test guard on the keychain.
    expect(p.failed.passwords).toMatch(/fichier illisible : fermez Google Chrome/);
    // The engine's history caps are lifted for the run only.
    expect(
      await m.execute(`return ["browser.migrate.chrome.history.limit", "browser.migrate.history.maxAgeInDays"].map((n) => Services.prefs.prefHasUserValue(n));`),
    ).toEqual([false, false]);
    expect(await bookmarks("https://b.example/page")).toEqual([{ title: "Exemple B", parent: "Travail" }]);
    expect(await bookmarks("https://a.example/")).toHaveLength(1);
    const urls = (await history()).map((v) => v.url).sort();
    expect(urls).toEqual(["https://h1.example/lu", "https://h2.example/lu"]);
    expect(existsSync(join(w.dataDir, "import-tmp"))).toBe(false);
    expect(notifications().at(-1)).toMatchObject({ title: "Import terminé en partie" });
    expect(notifications().at(-1)!.text).toMatch(/2 favoris, 2 pages d'historique\. Non importé : mots de passe/);

    expect(await api("start(arguments[0])", [start])).toEqual({ ok: true });
    const again = await finished();
    expect(again.counts).toEqual({ bookmarks: 0, history: 2 });
    expect(await bookmarks("https://b.example/page")).toHaveLength(1);
    expect(await bookmarks("https://a.example/")).toHaveLength(1);
    expect((await history()).map((v) => v.url).sort()).toEqual(urls);
    expect(existsSync(join(w.dataDir, "import-tmp"))).toBe(false);
  });

  it("brings Arc's then Zen's spaces, favorites and pinned tabs, once", async () => {
    expect(await api("start(arguments[0])", [{ source: "arc", profile: "Default", types: ["spaces"] }])).toEqual({ ok: true });
    expect(await finished()).toMatchObject({ counts: { spaces: 7 }, failed: {} });
    const s = await state(m);
    expect(s.spaces.slice(1).map((e) => ({ name: e.name, private: e.private, pinned: e.pinned.map((f) => f.url) }))).toEqual([
      { name: "Travail", private: false, pinned: ["https://docs.example.com/projet", "https://tickets.example.com/"] },
      { name: "Maison", private: false, pinned: ["https://recettes.example.com/"] },
    ]);
    expect(s.essentials.map((f) => f.url)).toEqual(["https://mail.example.com/", "https://agenda.example.com/"]);
    // Zen has the same spaces and favorites: nothing new.
    const zenProfile = join(home, "Library/Application Support/zen/Profiles/abc.Default");
    expect(await api("start(arguments[0])", [{ source: "zen", profile: zenProfile, types: ["spaces"] }])).toEqual({ ok: true });
    expect(await finished()).toMatchObject({ counts: { spaces: 0 }, failed: {} });
    expect((await state(m)).spaces).toEqual(s.spaces);
  });

  it("imports a CSV of 2 passwords", async () => {
    expect(await api("importPasswordsCsv()")).toEqual({ ok: true, count: 2 });
  });
});
