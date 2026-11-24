import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImportProgress, ImportSource } from "../shared/api";
import type { Visit } from "../shared/model";
import { dispatch, state } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, typeText, waitUi } from "./ui";

// Plan 55 Task 2: a fake home with a Chrome-format profile, imported through the engine's Chrome migrator.
// Task 4: the import screen, on welcome page 2 and in Réglages › Données.
// Task 3: a fake Arc sidebar and Zen session (the unit test fixtures), their spaces brought into the store.

let w: LaunchedRessac;
let m: Marionette;
let home = "";
let csv = "";
let dataDir = "";

/** Chrome's time: microseconds since 1601. */
const chromeTime = (d: Date) => (d.getTime() + 11_644_473_600_000) * 1000;

const chromeProfile = () => join(home, "Library/Application Support/Google/Chrome/Default");

/** Chrome's Bookmarks file, with more bookmarks in its « Travail » folder. */
function chromeBookmarks(work: { name: string; url: string }[]): void {
  writeFileSync(
    join(chromeProfile(), "Bookmarks"),
    JSON.stringify({
      version: 1,
      roots: {
        bookmark_bar: { type: "folder", name: "Barre", children: [{ type: "url", name: "Exemple A", url: "https://a.example/" }, { type: "folder", name: "Travail", children: work.map((b) => ({ type: "url", ...b })) }] },
        other: { type: "folder", name: "Autres", children: [] },
        synced: { type: "folder", name: "Mobile", children: [] },
      },
    }),
  );
}

function fakeChrome(): void {
  const profile = chromeProfile();
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "..", "Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personne 1" } } } }));
  chromeBookmarks([{ name: "Exemple B", url: "https://b.example/page" }]);
  const db = new DatabaseSync(join(profile, "History"));
  db.exec("CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)");
  // transition: Chrome's column, which Firefox 161 reads (0 = a followed link).
  db.exec("CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER DEFAULT 0)");
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
  home = await mkdtemp(join(os.tmpdir(), "ressac-import-home-"));
  fakeChrome();
  fakeArcAndZen(home);
  // An empty Safari folder: offered, but its engine migrator never runs under a test home (every type fails as without Full Disk Access).
  mkdirSync(join(home, "Library/Safari"), { recursive: true });
  csv = join(home, "passwords.csv");
  writeFileSync(csv, "url,username,password\nhttps://site1.example,alice,secret-1\nhttps://site2.example,bob,secret-2\n");
  // A copy left by a quit mid-import: removed at startup.
  dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  mkdirSync(join(dataDir, "import-tmp/chrome/Default"), { recursive: true });
  writeFileSync(join(dataDir, "import-tmp/chrome/Default/Login Data"), "copie");
  w = await launchRessac({ dataDir, env: { RESSAC_TEST_IMPORT_HOME: home, RESSAC_TEST_IMPORT_CSV: csv, RESSAC_TEST_REVEAL: join(home, "opened.txt"), RESSAC_TEST_IMPORT_ACCESS: "brave", RESSAC_TEST_IMPORT_PICK: join(home, "pick.txt") } });
  m = w.marionette;
  await m.setContext("chrome");
});
afterAll(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    await rm(home, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

const api = <T>(call: string, args: unknown[] = []) => inUi<T>(m, `return JSON.parse(JSON.stringify(await ui.ressac.browserImport.${call}));`, args);
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
  m.execute<{ title: string; parent: string; parentGuid: string }[]>(
    `return (async () => {
      const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
      const found = await PlacesUtils.bookmarks.search({ url: arguments[0] });
      return Promise.all(found.map(async (b) => ({ title: b.title, parent: (await PlacesUtils.bookmarks.fetch(b.parentGuid)).title, parentGuid: b.parentGuid })));
    })();`,
    [url],
  );
const history = () => inUi<Visit[]>(m, `return JSON.parse(JSON.stringify(await ui.ressac.history.search("lue", 50)));`);
const notifications = () =>
  readFileSync(join(w.dataDir, "notifications.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { title: string; text: string })
    .filter((n) => n.title.startsWith("Import"));

describe("import from another browser", () => {
  it("lists the fake browsers; a source's profiles only when asked", async () => {
    const sources = await api<ImportSource[]>("sources()");
    expect(sources.map((s) => [s.id, s.types])).toEqual([
      ["arc", ["bookmarks", "history", "passwords", "spaces", "tabs"]],
      ["chrome", ["bookmarks", "history", "passwords"]],
      ["safari", ["bookmarks", "history"]],
      ["zen", ["bookmarks", "history", "spaces", "tabs"]],
    ]);
    expect(sources[1]).toMatchObject({ id: "chrome", name: "Google Chrome", types: ["bookmarks", "history", "passwords"], passwordsByCsv: false });
    expect(await api("profiles(arguments[0])", ["chrome"])).toEqual([{ id: "Default", name: "Personne 1" }]);
    await expect.poll(() => existsSync(join(dataDir, "import-tmp"))).toBe(false);
  });

  it("brings bookmarks and history, says why passwords failed, leaves no copy, and a re-import doubles nothing", async () => {
    const start = { source: "chrome", profile: "Default", types: ["bookmarks", "history", "passwords"] };
    const [first, second] = await inUi<unknown[]>(
      m,
      "const a = ui.ressac.browserImport.start(arguments[0]); const b = ui.ressac.browserImport.start(arguments[0]); return JSON.parse(JSON.stringify(await Promise.all([a, b])));",
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
    expect(await bookmarks("https://b.example/page")).toMatchObject([{ title: "Exemple B", parent: "Travail" }]);
    expect(await bookmarks("https://a.example/")).toHaveLength(1);
    const urls = (await history()).map((v) => v.url).sort();
    expect(urls).toEqual(["https://h1.example/lu", "https://h2.example/lu"]);
    expect(existsSync(join(w.dataDir, "import-tmp"))).toBe(false);
    expect(notifications().at(-1)).toMatchObject({ title: "Import terminé en partie" });
    expect(notifications().at(-1)!.text).toMatch(/2 favoris, 2 pages d'historique\. Non importé : mots de passe/);

    // Since then, one more bookmark in « Travail »: it joins the folder already there, never a second « Travail ».
    chromeBookmarks([{ name: "Exemple B", url: "https://b.example/page" }, { name: "Exemple C", url: "https://c.example/" }]);
    expect(await api("start(arguments[0])", [start])).toEqual({ ok: true });
    const again = await finished();
    // The visits are already there, unchanged: none is counted again.
    expect(again.counts).toEqual({ bookmarks: 1, history: 0 });
    const [b] = await bookmarks("https://b.example/page");
    expect(await bookmarks("https://c.example/")).toEqual([{ title: "Exemple C", parent: "Travail", parentGuid: b!.parentGuid }]);
    expect(await bookmarks("https://b.example/page")).toHaveLength(1);
    expect(await bookmarks("https://a.example/")).toHaveLength(1);
    expect((await history()).map((v) => v.url).sort()).toEqual(urls);
    expect(existsSync(join(w.dataDir, "import-tmp"))).toBe(false);
  });

  it("⌘T finds an imported bookmark under « Favoris », and choosing it opens it", async () => {
    await pressKeys(m, "Meta+t");
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"command-input\"]')");
    await typeText(m, "exemple");
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"command-section\"]')].some((s) => s.textContent.trim() === 'Favoris')");
    await waitUi(
      m,
      `const row = [...doc.querySelectorAll('[data-testid="command-row"][data-type="bookmark"]')].find((r) => r.textContent.includes("Exemple A"));
       if (!row) return false;
       row.querySelector("button").click();
       return true;`,
    );
    const deadline = Date.now() + 10_000;
    while (!Object.values((await state(m)).tabs).some((t) => t.url.startsWith("https://a.example"))) {
      if (Date.now() > deadline) throw new Error("the bookmark was not opened");
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it("brings Arc's then Zen's spaces, favorites, pinned and open tabs, once", async () => {
    expect(await api("start(arguments[0])", [{ source: "arc", profile: "Default", types: ["spaces", "tabs"] }])).toEqual({ ok: true });
    expect(await finished()).toMatchObject({ counts: { spaces: 7, tabs: 1 }, failed: {} });
    const s = await state(m);
    // The open tab waits in its space, not loaded.
    const travail = s.spaces.find((e) => e.name === "Travail")!.id;
    expect(Object.values(s.tabs).filter((t) => t.spaceId === travail).map((t) => [t.url, t.title, t.loading])).toEqual([["https://ephemere.example.com/", "Onglet du jour", false]]);
    expect(s.spaces.slice(1).map((e) => ({ name: e.name, private: e.private, pinned: e.pinned.map((f) => f.url) }))).toEqual([
      { name: "Travail", private: false, pinned: ["https://docs.example.com/projet", "https://tickets.example.com/"] },
      { name: "Maison", private: false, pinned: ["https://recettes.example.com/"] },
    ]);
    expect(s.essentials.map((f) => f.url)).toEqual(["https://mail.example.com/", "https://agenda.example.com/"]);
    // Zen has the same spaces and favorites: nothing new.
    const zenProfile = join(home, "Library/Application Support/zen/Profiles/abc.Default");
    expect(await api("start(arguments[0])", [{ source: "zen", profile: zenProfile, types: ["spaces", "tabs"] }])).toEqual({ ok: true });
    expect(await finished()).toMatchObject({ counts: { spaces: 0, tabs: 0 }, failed: {} });
    expect((await state(m)).spaces).toEqual(s.spaces);
    expect(Object.keys((await state(m)).tabs)).toEqual(Object.keys(s.tabs));
  });

  it("imports a CSV of 2 passwords", async () => {
    expect(await api("importPasswordsCsv()")).toEqual({ ok: true, count: 2 });
  });

  const shows = (id: string, wanted: string) =>
    waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted]);
  const there = (id: string) => inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="${id}"]`]);
  /** Gone, once its exit fade ends. */
  const gone = (id: string) => waitUi(m, "return !doc.querySelector(arguments[0])", [`[data-testid="${id}"]`]);
  const checked = (id: string) => inUi<boolean>(m, "return doc.querySelector(arguments[0]).checked", [`[data-testid="${id}"]`]);

  // With three spaces, the sidebar folds its tools behind a button: Réglages opens by its action.
  const openSettings = async () => dispatch(m, { type: "openSettings", windowId: (await state(m)).windows[0]!.id });

  it("welcome page 2: lists the browsers, imports Chrome, and goes on", async () => {
    await openSettings();
    await click(m, '[data-testid="settings-nav-about"]');
    await click(m, '[data-testid="settings-replay-welcome"]');
    await click(m, '[data-testid="welcome-next"]');
    await shows("welcome-2", "Vous venez d'un autre navigateur ?");
    await shows("browser-import", "Arc");
    expect(await inUi(m, `return [...doc.querySelectorAll('[name="import-source"]')].map((r) => r.closest("label").textContent.trim())`)).toEqual(["Arc", "Google Chrome", "Safari", "Zen"]);
    // None is chosen before a click (no browser's profiles are read); then every type is checked, Arc's spaces too.
    expect(await checked("import-source-arc")).toBe(false);
    expect(await inUi(m, `return doc.querySelector('[data-testid="import-start"]').disabled`)).toBe(true);
    await click(m, '[data-testid="import-source-arc"]');
    await shows("browser-import", "Espaces et onglets épinglés");
    expect(await checked("import-type-spaces")).toBe(true);
    await shows("browser-import", "Onglets ouverts");
    expect(await checked("import-type-tabs")).toBe(true);
    expect(await there("welcome-later")).toBe(true);
    await click(m, '[data-testid="import-source-chrome"]');
    for (const t of ["bookmarks", "history", "passwords"]) expect(await checked(`import-type-${t}`)).toBe(true);
    await gone("import-type-spaces");
    expect(await there("import-guide")).toBe(false);
    if (process.env.RESSAC_SHOT) await new Promise((r) => setTimeout(r, 1_000)); // the page's rise ends
    if (process.env.RESSAC_SHOT) writeFileSync(process.env.RESSAC_SHOT, Buffer.from((await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value, "base64"));
    await click(m, '[data-testid="import-start"]');
    await shows("import-started", "Import lancé : une notification vous préviendra à la fin.");
    expect((await finished()).source).toBe("chrome");
    // The run's end and its failure are told once it ends.
    await shows("import-done", "Import terminé.");
    await gone("import-started");
    await shows("import-failed-passwords", "Mots de passe : fichier illisible");
    await click(m, '[data-testid="welcome-next"]');
    await shows("welcome-3", "Vos onglets vivent à gauche");
    // A replay with AI on: page 3, the search engine, the appearance, then straight to the first space.
    await click(m, '[data-testid="welcome-next"]');
    await shows("welcome-8", "Quel moteur de recherche ?");
    await click(m, '[data-testid="welcome-next"]');
    await shows("welcome-9", "Claire ou sombre ?");
    await click(m, '[data-testid="welcome-next"]');
    await shows("welcome-7", "");
    await click(m, '[data-testid="welcome-finish"]');
    await waitUi(m, `return !doc.querySelector('[data-testid="welcome-layer"]')`);
  });

  it("Réglages › Données: the button shows the screen; Zen's passwords go by a CSV", async () => {
    await openSettings();
    await click(m, '[data-testid="settings-nav-data"]');
    await click(m, '[data-testid="data-import"]');
    await shows("browser-import", "Google Chrome");
    await click(m, '[data-testid="import-source-zen"]');
    await shows("import-guide", "Dans Zen, ouvrez about:logins");
    await shows("import-guide", "⋯ › Exporter les identifiants");
    await shows("import-guide", "Supprimez ensuite le fichier exporté : il n'est pas chiffré.");
    await gone("import-type-passwords");
    await click(m, '[data-testid="import-csv"]');
    // Already imported by the API test above: unchanged rows are not counted.
    await shows("import-csv-result", "0 mot de passe importé");
  });

  it("Safari: the CSV guide's four steps, and a refused disk access opens System Settings", async () => {
    await openSettings();
    await click(m, '[data-testid="settings-nav-data"]');
    if (!(await there("browser-import"))) await click(m, '[data-testid="data-import"]');
    await click(m, '[data-testid="import-source-safari"]');
    expect(await inUi(m, `return [...doc.querySelectorAll('[data-testid="import-guide"] li')].map((li) => li.textContent.trim())`)).toEqual([
      "Ouvrez l'app Mots de passe.",
      "Fichier › Exporter tous les mots de passe…",
      "Choisissez le fichier ci-dessous.",
      "Supprimez ensuite le fichier exporté : il n'est pas chiffré.",
    ]);
    await click(m, '[data-testid="import-start"]');
    await shows("import-failed-bookmarks", "Accès complet au disque");
    await click(m, '[data-testid="import-disk-access"]');
    const opened = join(home, "opened.txt");
    await expect.poll(() => (existsSync(opened) ? readFileSync(opened, "utf8") : "")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles\n");
    // In English too: the help follows a Safari failure, not its French text.
    await dispatch(m, { type: "setLocale", locale: "en" });
    try {
      await click(m, '[data-testid="import-start"]');
      await shows("import-failed-bookmarks", "Full Disk Access");
      await waitUi(m, `return !!doc.querySelector('[data-testid="import-disk-access"]')`);
    } finally {
      await dispatch(m, { type: "setLocale", locale: "fr" });
    }
  });
  it("a found app shows its icon; Réglages › À propos opens « Nouveautés »", async () => {
    // Safari is on every Mac: its icon is drawn by macOS.
    await waitUi(m, `const i = doc.querySelector('[data-testid="import-source-safari"]').closest("label").querySelector("img"); return !!i && i.complete && i.naturalWidth > 0 && !i.hidden`);
    await click(m, '[data-testid="settings-nav-about"]');
    await click(m, '[data-testid="settings-release-notes"]');
    await shows("release-notes", "Nouveautés");
    await shows("release-notes", "Import depuis un autre navigateur");
    // The newest version's video is a card (a click opens it in a tab: not pressed here, it would reach the real web).
    await shows("release-video", "Découvrir le passeport en vidéo");
    if (process.env.RESSAC_SHOT) await new Promise((r) => setTimeout(r, 1_000));
    if (process.env.RESSAC_SHOT) writeFileSync(process.env.RESSAC_SHOT + ".notes.png", Buffer.from((await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value, "base64"));
  });

  // A beta tester on macOS 26+: « Accès aux données bloqué », then raw engine errors. Brave stands for a protected browser.
  it("macOS 26+: access is asked before any read; cancelled, refused and granted picks; a refused read is told plainly", async () => {
    const brave = join(home, "Library/Application Support/BraveSoftware/Brave-Browser");
    cpSync(join(home, "Library/Application Support/Google/Chrome"), brave, { recursive: true });
    const [pick, opened] = [join(home, "pick.txt"), join(home, "opened.txt")];
    try {
      await openSettings();
      await click(m, '[data-testid="settings-nav-data"]');
      if (!(await there("browser-import"))) await click(m, '[data-testid="data-import"]');
      expect(await api("access(arguments[0])", ["brave"])).toBe("ask");
      expect(await api("profiles(arguments[0])", ["brave"])).toEqual([]);
      expect(await api("start(arguments[0])", [{ source: "brave", profile: null, types: ["bookmarks"] }])).toEqual({ ok: false, error: "Autorisez d'abord l'accès aux données de Brave" });
      await click(m, '[data-testid="import-source-brave"]');
      await shows("import-access", "macOS protège les données de Brave.");
      expect(await inUi(m, `return doc.querySelector('[data-testid="import-start"]').disabled`)).toBe(true);
      writeFileSync(pick, "cancel");
      await click(m, '[data-testid="import-access-grant"]');
      await shows("import-access-note", "Accès non accordé : sans lui, Ressac ne peut pas lire les données de Brave.");
      expect(await there("import-files-access")).toBe(false);
      // Picked, but macOS still refuses (here: unreadable for its owner): the way to Réglages Système.
      writeFileSync(pick, "");
      chmodSync(join(brave, "Local State"), 0o000);
      await click(m, '[data-testid="import-access-grant"]');
      await shows("import-access-note", "macOS refuse encore l'accès aux données de Brave.");
      await click(m, '[data-testid="import-files-access"]');
      await expect.poll(() => (existsSync(opened) ? readFileSync(opened, "utf8") : "")).toContain("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders\n");
      chmodSync(join(brave, "Local State"), 0o644);
      await click(m, '[data-testid="import-access-grant"]');
      await gone("import-access");
      expect(await api("access(arguments[0])", ["brave"])).toBe("ready");
      // The tester's case: a file macOS refuses during the run, and its copy too. Told plainly, never the engine's text.
      chmodSync(join(brave, "Default/History"), 0o000);
      await click(m, '[data-testid="import-type-passwords"]');
      await click(m, '[data-testid="import-start"]');
      await shows("import-failed-history", "Historique : macOS a refusé l'accès : autorisez Ressac dans Réglages Système › Confidentialité et sécurité › Fichiers et dossiers");
      expect(await inUi(m, `return doc.querySelector('[data-testid="browser-import"]').textContent.includes("NS_ERROR")`)).toBe(false);
      // The bookmarks came in on the first pass: the refused copy fails only History.
      expect(await there("import-failed-bookmarks")).toBe(false);
      expect((await finished()).counts.bookmarks).toBeTypeOf("number");
      await waitUi(m, `return !!doc.querySelector('[data-testid="import-files-access"]')`);
    } finally {
      chmodSync(join(brave, "Local State"), 0o644);
      chmodSync(join(brave, "Default/History"), 0o644);
    }
  });
});
