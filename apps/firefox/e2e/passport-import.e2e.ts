import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { readPassport, type PassportEntry } from "./passport-file";
import { click, inUi, missingApi, waitUi } from "./ui";

// « Remplir le passeport » Task 8: the saved addresses of the old browser (a fake Chrome home, RESSAC_TEST_IMPORT_HOME,
// its `Web Data` in Chromium's tables) offered after the welcome's import and in Réglages › Passeport › « Importer
// depuis… »; Ressac's own Firefox address store, erased only for the records fully written. Touch ID: RESSAC_TEST_REAUTH.

const STORAGE = "resource://autofill/FormAutofillStorage.sys.mjs";
const PHONE = ["06", "12", "34", "56", "78"].join(" ");
const PHONE_2 = ["07", "11", "22", "33", "44"].join(" ");

let w: LaunchedRessac | undefined;
let m: Marionette;
const dirs: string[] = [];
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
});

/** Chromium FieldType codes (chrome/passport/addresses.ts). */
const T = { given: 3, family: 5, email: 9, tel: 14, city: 33, postcode: 35, country: 36, street: 77 } as const;
type Saved = { guid: string; useCount: number; values: Partial<Record<keyof typeof T, string>> };

/** A fake home with a Chrome profile: a bookmark (the import's one type here), and `addresses` in its `Web Data` when given. */
async function fakeHome(addresses?: Saved[]): Promise<string> {
  const home = await mkdtemp(join(os.tmpdir(), "ressac-import-home-"));
  dirs.push(home);
  const profile = join(home, "Library/Application Support/Google/Chrome/Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "..", "Local State"), JSON.stringify({ profile: { last_used: "Default", info_cache: { Default: { name: "Personne 1" } } } }));
  writeFileSync(join(profile, "Bookmarks"), JSON.stringify({ version: 1, roots: { bookmark_bar: { type: "folder", name: "Barre", children: [{ type: "url", name: "Exemple A", url: "https://a.example/" }] }, other: { type: "folder", name: "Autres", children: [] }, synced: { type: "folder", name: "Mobile", children: [] } } }));
  if (addresses) {
    const db = new DatabaseSync(join(profile, "Web Data"));
    db.exec("CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, PRIMARY KEY (guid, type))");
    const now = Math.floor(Date.now() / 1000);
    for (const a of addresses) {
      db.prepare("INSERT INTO addresses VALUES (?, ?, ?)").run(a.guid, a.useCount, now - a.useCount);
      for (const [k, v] of Object.entries(a.values)) db.prepare("INSERT INTO address_type_tokens VALUES (?, ?, ?)").run(a.guid, T[k as keyof typeof T], v);
    }
    db.close();
  }
  return home;
}
const CAMILLE: Saved = { guid: "a1", useCount: 5, values: { given: "Camille", family: "Aubrac", street: "14 rue des Tanneurs", postcode: "69001", city: "Lyon", country: "FR", tel: PHONE, email: "camille@exemple.fr" } };
const JEANNE: Saved = { guid: "b1", useCount: 1, values: { given: "Jeanne", family: "Durand", street: "3 place Bellecour", postcode: "69002", city: "Lyon", country: "FR" } };

let profileDir = "";
let dataDir = "";
async function launch(home: string): Promise<void> {
  profileDir = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  dirs.push(profileDir, dataDir);
  w = await launchRessac({ profile: profileDir, dataDir, env: { RESSAC_TEST_IMPORT_HOME: home, RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PASSPORT_TIMES: "600000,1500" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}

const tid = (id: string) => `[data-testid="${id}"]`;
const has = (id: string, ms = 10_000) => waitUi(m, "return !!doc.querySelector(arguments[0])", [tid(id)], ms);
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [tid(id), wanted], ms);
/** The card's lines: their text and whether ticked. */
const lines = () =>
  inUi<{ text: string; on: boolean }[]>(m, `return [...doc.querySelectorAll('[data-testid="passport-import-line"]')].map((l) => ({ text: l.textContent.replace(/\\s+/g, " ").trim(), on: l.querySelector('[data-testid="passport-import-tick"]').checked }));`);
/** Ticks the line whose text holds `text` and not `but` (a click on its box). */
async function tick(text: string, but?: string): Promise<void> {
  const i = (await lines()).findIndex((l) => l.text.includes(text) && !(but && l.text.includes(but)));
  if (i < 0) throw new Error(`no line with « ${text} »`);
  await click(m, `[data-testid="passport-import-line"]:nth-child(${i + 1}) [data-testid="passport-import-tick"]`);
  await waitUi(m, `return doc.querySelectorAll('[data-testid="passport-import-line"]')[${i}].querySelector("input").checked`);
}
type Written = PassportEntry & { how?: string; from?: string };
const passport = async (): Promise<Written[]> => (existsSync(join(profileDir, "ressac", "passport", "default.json")) ? ((await readPassport(profileDir)) as Written[]) : []);
const openSettings = async () => dispatch(m, { type: "openSettings", windowId: (await state(m)).windows[0]!.id });
/** Welcome page 2 (replayed from Réglages › À propos), Chrome picked with its bookmarks only, the import run to its end. */
async function importChromeFromWelcome(): Promise<void> {
  await openSettings();
  await click(m, tid("settings-nav-about"));
  await click(m, tid("settings-replay-welcome"));
  await click(m, tid("welcome-next"));
  await shows("welcome-2", "Vous venez d'un autre navigateur ?");
  await click(m, tid("import-source-chrome"));
  for (const t of ["history", "passwords"]) {
    await click(m, tid(`import-type-${t}`));
    await waitUi(m, "return doc.querySelector(arguments[0])?.checked === false", [tid(`import-type-${t}`)]);
  }
  await click(m, tid("import-start"));
  await has("import-done", 30_000);
}
/** The scratch copy of `Web Data`: gone, or an empty folder. */
const scratchEmpty = () => {
  const dir = join(dataDir, "passport-import-tmp");
  return !existsSync(dir) || readdirSync(dir).length === 0;
};

describe("passport import of saved addresses", () => {
  it("welcome: after Chrome's import, the card shows its addresses, the user's ticked; « Un proche » writes only a name; no copy left", async () => {
    await launch(await fakeHome([CAMILLE, JEANNE]));
    await importChromeFromWelcome();
    await shows("passport-import", "Google Chrome a enregistré ces adresses");
    await expect.poll(async () => (await lines()).length).toBe(2);
    const shown = await lines();
    expect(shown.filter((l) => l.on).map((l) => l.text)).toEqual([expect.stringContaining("Camille Aubrac")]);
    expect(shown.find((l) => l.on)!.text).toContain("14 rue des Tanneurs, 69001 Lyon");
    // Jeanne's line: another person, « Un proche » by default.
    expect(await inUi(m, "return doc.querySelector(arguments[0])?.value", [tid("passport-import-as")])).toBe("proche");
    await tick("Jeanne Durand");
    await click(m, tid("passport-import-add"));
    await has("passport-import-done");
    await expect.poll(async () => (await passport()).map((e) => e.field).sort()).toEqual(["adresse", "email", "nom", "proche", "tel"]);
    const written = await passport();
    expect(written.every((e) => e.how === "import" && e.from === "chrome" && e.origins.length === 0)).toBe(true);
    expect(written.find((e) => e.field === "proche")!.value).toEqual({ given: "Jeanne", family: "Durand" });
    expect(written.find((e) => e.field === "adresse")!.value.text).toBe("14 rue des Tanneurs\n69001 Lyon");
    expect(JSON.stringify(written)).not.toContain("Bellecour");
    expect(scratchEmpty()).toBe(true);
  });

  it("a browser with no address: no card after the welcome's import; Réglages › « Importer depuis… » says so", async () => {
    await launch(await fakeHome());
    // Each read of a browser's addresses, noted when it answers: the card's decision comes right after.
    await inUi(m, "const pi = ui.ressac.settings.passportImport; const read = pi.proposals; ui.proposed = []; pi.proposals = async (id) => { const r = await read(id); ui.proposed.push(r.proposals.length); return r; };");
    await importChromeFromWelcome();
    await waitUi(m, "return ui.proposed.length > 0");
    expect(await inUi(m, "return ui.proposed")).toEqual([0]);
    // A short window after that answer: no card may show late from it.
    await new Promise((r) => setTimeout(r, 500));
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tid("passport-import")])).toBe(false);
    // The welcome stays over Réglages until it ends.
    await dispatch(m, { type: "finishOnboarding" });
    await waitUi(m, "return !doc.querySelector(arguments[0])", [tid("welcome-layer")]);
    await openSettings();
    await click(m, tid("settings-nav-passport"));
    await click(m, tid("passport-unlock"));
    await has("passport-open");
    await click(m, tid("passport-import-open"));
    await click(m, tid("passport-import-source-chrome"));
    await shows("passport-import-none", "Aucune adresse enregistrée dans Google Chrome.");
    expect(scratchEmpty()).toBe(true);
  });

  it("Réglages › Importer depuis… › Ressac, « Les effacer de Firefox »: only the ticked, fully written records leave Firefox's store; the open passport shows the new rows", async () => {
    await launch(await fakeHome());
    // Ressac's own Firefox address store: Camille's full address, Jeanne's (another person, left unticked), and Camille's
    // street with no town (incomplete: written in part, so kept in Firefox).
    const guids = await m.execute<string[]>(
      `return (async () => {
         const { formAutofillStorage } = ChromeUtils.importESModule("${STORAGE}");
         await formAutofillStorage.initialize();
         const a = formAutofillStorage.addresses;
         return [await a.add(arguments[0]), await a.add(arguments[1]), await a.add(arguments[2])];
       })();`,
      [
        { "given-name": "Camille", "family-name": "Aubrac", "street-address": "14 rue des Tanneurs", "postal-code": "69001", "address-level2": "Lyon", country: "FR", tel: PHONE, email: "camille@exemple.fr" },
        { "given-name": "Jeanne", "family-name": "Durand", "street-address": "3 place Bellecour", "postal-code": "69002", "address-level2": "Lyon", country: "FR" },
        { "given-name": "Camille", "family-name": "Aubrac", "street-address": "12 rue Sans Ville", country: "FR", tel: PHONE_2 },
      ],
    );
    const [full, other, partial] = guids;
    const stored = () => m.execute<string[]>(`return (async () => { const { formAutofillStorage } = ChromeUtils.importESModule("${STORAGE}"); await formAutofillStorage.initialize(); return (await formAutofillStorage.addresses.getAll()).map((r) => r.guid).sort(); })();`);
    await openSettings();
    await click(m, tid("settings-nav-passport"));
    await click(m, tid("passport-unlock"));
    await has("passport-open");
    await click(m, tid("passport-import-open"));
    await click(m, tid("passport-import-source-ressac"));
    await expect.poll(async () => (await lines()).length).toBe(3);
    expect((await lines()).filter((l) => l.on).map((l) => l.text)).toEqual([expect.stringContaining("14 rue des Tanneurs")]);
    await shows("passport-import-incomplete", "1");
    // The incomplete record's line (its street had no town, so no address): ticked, written in part, never erased.
    await tick("Camille Aubrac", "Tanneurs");
    await click(m, tid("passport-import-erase"));
    await waitUi(m, "return doc.querySelector(arguments[0]).checked", [tid("passport-import-erase")]);
    await click(m, tid("passport-import-add"));
    await has("passport-import-done");
    await expect.poll(stored).toEqual([other!, partial!].sort());
    expect(guids).toContain(full);
    const written = await passport();
    expect(written.every((e) => e.how === "import" && e.from === "ressac")).toBe(true);
    expect(JSON.stringify(written)).not.toContain("Durand");
    // The open passport read the import back: its rows are there without a relock.
    await has("passport-row-adresse");
    await has("passport-row-tel");
  });
});
