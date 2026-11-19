import { format } from "../../../shared/i18n";
import type { BrowserImportApi, ImportProgress, ImportSource, ImportType } from "../../../shared/api";
import type { AgentHost } from "../../agent/host";
import { showAlert } from "../notifications";
import type { Store } from "../store";
import { parseArcSidebar, parseZenSpaces, planSpaceImport, planTabImport } from "./spaces";
import { chromiumMigrator, chromiumProfiles, appIcon, detectSources, firefoxMigrator, sourceApp, firefoxProfiles, safariMigrator, sourceRoot, type SourceDef } from "./sources";
import { testEnv } from "../../test-env";

/** Visits per `history.import` call (the host takes up to 50 000). */
export const HISTORY_BATCH = 5000;

/** A migrator's page, as given to MigrationUtils.insertVisitsWrapper. */
export interface PageInfo {
  url: URL | string;
  title?: string | null;
  visits: { date?: Date | number | string }[];
}

/** The latest visit of each URL (never in the future), in batches of `size`, as the host's `history.import` takes them. */
export function visitBatches(pages: PageInfo[], size = HISTORY_BATCH, now = new Date()): { url: string; title: string; date: string }[][] {
  const latest = new Map<string, { title: string; date: Date }>();
  for (const p of pages)
    for (const v of p.visits ?? []) {
      if (v.date === undefined) continue;
      const date = new Date(Math.min(new Date(v.date).getTime(), now.getTime()));
      const url = String(p.url);
      const prev = latest.get(url);
      if (Number.isNaN(date.getTime()) || (prev && prev.date >= date)) continue;
      latest.set(url, { title: p.title || prev?.title || "", date });
    }
  const all = [...latest].map(([url, v]) => ({ url, title: v.title, date: v.date.toISOString() }));
  const batches = [];
  for (let i = 0; i < all.length; i += size) batches.push(all.slice(i, i + size));
  return batches;
}

export interface BookmarkItem {
  url?: string;
  title?: string;
  children?: BookmarkItem[];
  [k: string]: unknown;
}

/**
 * Drops the bookmarks whose URL is already under a folder of the same title (`existing` holds `title\nurl`, and gets
 * what is kept), then the folders left empty. `count`: the bookmarks kept.
 */
export function pruneBookmarks(items: BookmarkItem[], parentTitle: string, existing: Set<string>): { items: BookmarkItem[]; count: number } {
  let count = 0;
  const kept: BookmarkItem[] = [];
  for (const item of items) {
    if (Array.isArray(item.children)) {
      const sub = pruneBookmarks(item.children, item.title ?? "", existing);
      if (sub.items.length) kept.push({ ...item, children: sub.items });
      count += sub.count;
    } else if (typeof item.url === "string") {
      let url = item.url;
      try {
        url = new URL(url).href;
      } catch {}
      const key = `${parentTitle}\n${url}`;
      if (existing.has(key)) continue;
      existing.add(key);
      kept.push(item);
      count++;
    }
  }
  return { items: kept, count };
}

const ORDER: ImportType[] = ["bookmarks", "history", "passwords", "spaces", "tabs"];
/** The end notification: what came in, then what failed and why. */
export function summary(p: ImportProgress, locale: string): { title: string; text: string } {
  const got = ORDER.filter((t) => p.counts[t] !== undefined)
    .map((t) => format(locale, `chrome-import-count-${t}`, { count: p.counts[t]!, shown: p.counts[t]!.toLocaleString(locale) }))
    .join(", ");
  const failed = ORDER.filter((t) => p.failed[t])
    .map((t) => `${format(locale, `chrome-import-type-${t}`)} (${p.failed[t]})`)
    .join(", ");
  const title = format(locale, failed ? "chrome-import-partial" : "chrome-import-done");
  return { title, text: [got, failed && format(locale, "chrome-import-not-imported", { failed })].filter(Boolean).join(". ") };
}

/** macOS refused the read (another app's data, macOS 26+): the person can allow it, unlike a lock or a bad file. */
export const isAccessDenied = (e: unknown) => (e as { name?: unknown } | null)?.name === "NotAllowedError" || /NS_ERROR_FILE_ACCESS_DENIED/.test(String((e as { message?: unknown } | null)?.message ?? e));

/** Why a type could not be read when no error says it: the engine's migrators only say that it failed. */
function reason(locale: string, def: SourceDef, type: ImportType, unreadableFile: boolean): string {
  if (def.kind === "safari") return format(locale, "chrome-import-safari-denied");
  if (type === "passwords" && def.kind === "chromium" && !unreadableFile) return format(locale, "chrome-import-keychain-denied");
  // Firefox and Zen are always read from a copy: a lock is not the cause.
  return def.kind === "firefox" ? format(locale, "chrome-import-profile-unreadable", { name: def.name }) : format(locale, "chrome-import-file-unreadable", { name: def.name });
}

/** The engine caps Chromium history at 2 000 pages and 180 days: for an import, all of it within our retention. */
const RUN_PREFS: [string, number][] = [
  ["browser.migrate.chrome.history.limit", 0],
  ["browser.migrate.history.maxAgeInDays", 183],
];

/** The files of a Chromium profile each type reads. */
const CHROMIUM_FILES: Partial<Record<ImportType, string[]>> = { bookmarks: ["Bookmarks", "AccountBookmarks"], history: ["History"], passwords: ["Login Data"] };

const MIGRATION_UTILS = "moz-src:///browser/components/migration/MigrationUtils.sys.mjs";

export function createBrowserImporter(dataDir: string, host: Pick<AgentHost, "request">, store: Pick<Store, "state" | "dispatch">): BrowserImportApi {
  const { MigrationUtils } = ChromeUtils.importESModule(MIGRATION_UTILS);
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { MigratorBase } = ChromeUtils.importESModule("moz-src:///browser/components/migration/MigratorBase.sys.mjs");
  const BITS: Partial<Record<ImportType, number>> = { bookmarks: MigrationUtils.resourceTypes.BOOKMARKS, history: MigrationUtils.resourceTypes.HISTORY, passwords: MigrationUtils.resourceTypes.PASSWORDS };
  const testHome = testEnv("RESSAC_TEST_IMPORT_HOME");
  const home = testHome || Services.dirsvc.get("Home", Ci.nsIFile).path;
  const tmp = PathUtils.join(dataDir, "import-tmp");
  // A quit or crash mid-import may have left copies (Login Data, History): never kept. A run waits for it.
  const cleared = IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch((e: unknown) => console.error("[import] old copy not removed:", e));
  let progress: ImportProgress | null = null;
  let running = false;
  const say = (id: string, args?: Record<string, string>) => format(store.state.locale, id, args);
  /** An error's text for the screen, and whether macOS refused the read. */
  const failure = (e: unknown) => ({ text: isAccessDenied(e) ? say("chrome-import-access-denied") : e instanceof Error ? e.message : String(e), denied: isAccessDenied(e) });

  // Since macOS 26, reading another app's data needs the person's consent: a folder picker on that folder gives it
  // (the engine's getPermissions does the same). Firefox and Zen are not asked, as in the engine.
  // shortcut: granted for this launch only (any check is a read that macOS would block); upgrade if testers mind the picker per launch.
  const testAccess = (testEnv("RESSAC_TEST_IMPORT_ACCESS") || "").split(",");
  const granted = new Set<string>();
  // Read once: a run switches the engine's answer off while it reads, which must not open other browsers.
  const protectedData = MigratorBase.needsFolderSelectionToReadData();
  const asks = (def: SourceDef) => def.kind === "chromium" && !granted.has(def.id) && (testHome ? testAccess.includes(def.id) : protectedData);
  /** The folder to pick: Arc's sidebar file sits next to its `User Data`, so its parent. */
  const accessFolder = (def: SourceDef) => (def.id === "arc" ? sourceRoot(home, def).replace(/\/User Data$/, "") : sourceRoot(home, def));
  const findSource = async (id: unknown) => (await detectSources(home, (path) => IOUtils.exists(path))).find((d) => d.id === id);

  /** The macOS folder picker opened on `folder`: false when cancelled. Tests answer from RESSAC_TEST_IMPORT_PICK. */
  async function pickFolder(folder: string): Promise<boolean> {
    const test = testEnv("RESSAC_TEST_IMPORT_PICK");
    if (testHome) return !test || (await IOUtils.readUTF8(test).catch(() => "")).trim() !== "cancel";
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    // No title, as the engine: macOS open panels do not show one (the import screen explains the step).
    fp.init(Services.wm.getMostRecentBrowserWindow()?.browsingContext, "", Ci.nsIFilePicker.modeGetFolder);
    // ~/Library is hidden in the picker: it opens where the person only has to choose « Ouvrir ».
    const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(folder);
    fp.displayDirectory = dir;
    return (await new Promise((done) => fp.open(done))) !== Ci.nsIFilePicker.returnCancel;
  }

  async function profilesOf(def: SourceDef): Promise<{ id: string; name: string }[]> {
    const root = sourceRoot(home, def);
    const existing = async (list: { id: string; name: string }[]) => (await Promise.all(list.map((p) => IOUtils.exists(def.kind === "chromium" ? `${root}/${p.id}` : p.id)))).flatMap((ok, i) => (ok ? [list[i]!] : []));
    if (def.kind === "chromium") {
      const listed = chromiumProfiles(await IOUtils.readUTF8(`${root}/Local State`).then(JSON.parse, () => null));
      return existing(listed ?? [{ id: "Default", name: "Default" }]);
    }
    if (def.kind === "firefox") return existing(firefoxProfiles(await IOUtils.readUTF8(`${root}/profiles.ini`).catch(() => ""), root));
    return [];
  }

  /** Is a type's file there but unreadable? (an empty or absent one is not: nothing to import). */
  async function unreadable(def: SourceDef, folder: string, type: ImportType): Promise<boolean> {
    if (def.kind === "safari") return true;
    for (const name of def.kind === "chromium" ? (CHROMIUM_FILES[type] ?? []) : []) {
      const path = `${folder}/${name}`;
      if (!(await IOUtils.exists(path))) continue;
      try {
        if (type === "bookmarks") JSON.parse(await IOUtils.readUTF8(path));
        else await MigrationUtils.getRowsFromDBWithoutLocks(path, "Ressac import check", "SELECT 1 FROM sqlite_master LIMIT 1");
      } catch {
        return true;
      }
    }
    return false;
  }

  /** The profile's files, for a source that keeps them locked (open in that browser). */
  async function copyChromium(root: string, profile: string, to: string): Promise<void> {
    await IOUtils.makeDirectory(`${to}/${profile}`, { createAncestors: true, ignoreExisting: true });
    if (await IOUtils.exists(`${root}/Local State`)) await IOUtils.copy(`${root}/Local State`, `${to}/Local State`);
    for (const name of ["Bookmarks", "AccountBookmarks", "History", "Login Data", "Favicons"])
      for (const suffix of ["", "-journal", "-wal"]) {
        const from = `${root}/${profile}/${name}${suffix}`;
        if (await IOUtils.exists(from)) await IOUtils.copy(from, `${to}/${profile}/${name}${suffix}`);
      }
  }

  /**
   * Arc's or Zen's spaces, favorites and pinned tabs (`spaces`) and open tabs (`tabs`) into the store, each only if in
   * `types`. Counts: the spaces created plus the favorites added, and the tabs opened.
   */
  async function importSpaces(def: SourceDef, profile: { id: string } | null, types: ImportType[]): Promise<{ spaces: number; tabs: number }> {
    const arc = def.id === "arc";
    // Arc keeps its sidebar next to its Chromium data folder; Zen, in the profile's session file (written whole, never locked).
    if (!arc && !profile) throw new Error(say("chrome-import-no-zen-profile"));
    const path = arc ? sourceRoot(home, def).replace(/\/User Data$/, "/StorableSidebar.json") : `${profile!.id}/zen-sessions.jsonlz4`;
    if (!(await IOUtils.exists(path))) throw new Error(say("chrome-import-no-space"));
    let json: unknown;
    try {
      json = await IOUtils.readJSON(path, { decompress: !arc });
    } catch (e) {
      throw isAccessDenied(e) ? e : new Error(reason(store.state.locale, def, "spaces", true));
    }
    const read = arc ? parseArcSidebar(json) : parseZenSpaces(json);
    if (!read) throw new Error(say("chrome-import-format", { name: def.name }));
    const [sidebar, tabs] = [types.includes("spaces"), types.includes("tabs")];
    const imported = { spaces: read.spaces.map((s) => ({ name: s.name, pinned: sidebar ? s.pinned : [], tabs: tabs ? s.tabs : [] })), essentials: sidebar ? read.essentials : [] };
    const size = () => store.state.spaces.reduce((n, e) => n + 1 + e.pinned.length, store.state.essentials.length);
    // Not the tabs the essentials keep loaded: they are favorites, counted with the spaces.
    const open = () => Object.values(store.state.tabs).filter((o) => !o.link).length;
    const before = [size(), open()];
    for (let pass = 0; pass < 2; pass++) for (const a of planSpaceImport(store.state, imported)) store.dispatch(a);
    // shortcut: the open tabs all land in the first window, upgrade if importing with several windows open matters.
    const windowId = store.state.windows[0]?.id;
    if (windowId) store.dispatch({ type: "openTabs", tabs: planTabImport(store.state, imported, windowId) });
    return { spaces: size() - before[0]!, tabs: open() - before[1]! };
  }

  async function run(def: SourceDef, profile: { id: string; name: string } | null, types: ImportType[], p: ImportProgress): Promise<void> {
    const counts: Partial<Record<ImportType, number>> = {};
    const reported = new Map<ImportType, boolean>();
    /** Types whose file could not be read, and the errors our own inserts met. */
    const unreadableTypes = new Set<ImportType>();
    const errors = new Map<ImportType, string>();
    const noted = (type: ImportType) => (e: unknown) => {
      errors.set(type, e instanceof Error ? e.message : String(e));
      throw e;
    };
    await cleared;
    // First, on its own: a migrator that crashes never takes the spaces with it.
    const sidebar = types.filter((t) => t === "spaces" || t === "tabs");
    if (sidebar.length)
      await importSpaces(def, profile, types).then(
        (n) => sidebar.forEach((t) => (p.counts[t] = n[t as "spaces" | "tabs"])),
        (e) => {
          const f = failure(e);
          sidebar.forEach((t) => (p.failed[t] = f.text));
          if (f.denied) p.denied = true;
        },
      );
    const savedPrefs = RUN_PREFS.map(([name, value]) => {
      const saved = Services.prefs.prefHasUserValue(name) ? Services.prefs.getIntPref(name) : null;
      Services.prefs.setIntPref(name, value);
      return [name, saved] as const;
    });
    const visits = MigrationUtils.insertVisitsWrapper;
    const bookmarks = MigrationUtils.insertManyBookmarksWrapper;
    // Firefox 160 reads a Chromium browser's data on macOS 26+ only after its own folder picker: ours ran before the
    // run (grantAccess), so during the run it reads as on 159.
    const needsFolder = MigratorBase.needsFolderSelectionToReadData;
    MigratorBase.needsFolderSelectionToReadData = () => false;
    let existing: Set<string> | null = null;
    // Our history is the kernel's (Firefox's is off: places.history.enabled), so the visits go there, not into Places.
    MigrationUtils.insertVisitsWrapper = async (pages: PageInfo[]) => {
      for (const batch of visitBatches(pages)) {
        // The rows written or updated: a URL the kernel drops, or an unchanged re-import, is not counted.
        const r = await host.request<{ count: number }>("history.import", { visits: batch }).catch(noted("history"));
        counts.history = (counts.history ?? 0) + r.count;
      }
    };
    // insertTree directly: the engine's wrapper would also show Firefox's bookmarks toolbar.
    MigrationUtils.insertManyBookmarksWrapper = async (items: BookmarkItem[], parentGuid: string) => {
      await insertBookmarks(items, parentGuid).catch(noted("bookmarks"));
    };
    const insertBookmarks = async (items: BookmarkItem[], parentGuid: string) => {
      if (!existing) {
        const db = await PlacesUtils.promiseDBConnection();
        const rows = await db.execute("SELECT h.url, p.title FROM moz_bookmarks b JOIN moz_places h ON h.id = b.fk JOIN moz_bookmarks p ON p.id = b.parent");
        existing = new Set(rows.map((r: any) => `${r.getResultByName("title") ?? ""}\n${r.getResultByName("url")}`));
      }
      const parent = await PlacesUtils.bookmarks.fetch(parentGuid);
      const kept = pruneBookmarks(items, parent?.title ?? "", existing);
      await mergeTree(kept.items, parentGuid);
      counts.bookmarks = (counts.bookmarks ?? 0) + kept.count;
    };
    /** Already pruned items under `parentGuid`: a folder of the same title there gets the new children, never a twin. */
    const mergeTree = async (items: BookmarkItem[], parentGuid: string): Promise<void> => {
      const db = await PlacesUtils.promiseDBConnection();
      const rows = await db.execute("SELECT b.guid, b.title FROM moz_bookmarks b JOIN moz_bookmarks p ON p.id = b.parent WHERE p.guid = :guid AND b.type = 2", { guid: parentGuid });
      const folders = new Map<string, string>(rows.map((r: any) => [r.getResultByName("title") ?? "", r.getResultByName("guid")]));
      const fresh: BookmarkItem[] = [];
      for (const item of items) {
        const folder = Array.isArray(item.children) ? folders.get(item.title ?? "") : undefined;
        if (folder) await mergeTree(item.children!, folder);
        else fresh.push(item);
      }
      if (fresh.length) await PlacesUtils.bookmarks.insertTree({ guid: parentGuid, children: fresh });
    };
    const migrate = async (migrator: any, asked: ImportType[]) => {
      // Tests never reach the real keychain: a readable Login Data would ask it for its key.
      const want = testHome && def.kind === "chromium" ? asked.filter((t) => t !== "passwords") : asked;
      const bits = want.reduce((b, t) => b | (BITS[t] ?? 0), 0);
      // 0 would mean every type to the engine.
      if (!bits) return;
      try {
        await migrator.migrate(bits, false, profile, (bit: number, ok: boolean) => {
          const type = want.find((t) => BITS[t] === bit);
          if (type) reported.set(type, ok);
        });
      } catch (e) {
        // No resource for any wanted type: each is checked below.
        console.warn("[import] nothing migrated:", e);
      }
      // The engine resets its counts on each run: a run without passwords would read 0.
      if (want.includes("passwords") && reported.get("passwords")) counts.passwords = MigrationUtils.getImportedCount("logins");
    };
    try {
      const root = sourceRoot(home, def);
      const asked = types.filter((t) => t in BITS);
      const make = (from: string) => (def.kind === "chromium" ? chromiumMigrator(def, from) : def.kind === "safari" ? safariMigrator() : firefoxMigrator(PathUtils.join(tmp, def.id)));
      const bad = async (want: ImportType[], folder: string) => {
        const out: ImportType[] = [];
        for (const t of want) {
          if (reported.get(t) === false) out.push(t);
          else if (!reported.has(t) && (await unreadable(def, folder, t))) out.push(t), unreadableTypes.add(t);
        }
        return out;
      };
      // The engine's Safari migrator reads the real ~/Library whatever the home: under a test home it never runs, and
      // every type fails as without Full Disk Access.
      if (!(testHome && def.kind === "safari")) await migrate(make(root), asked);
      let failed = await bad(asked, `${root}/${profile?.id}`);
      // A browser that is open may lock its files: one more try on a copy. Not for passwords that read but failed:
      // that is the keychain refused, and a retry would ask again.
      const retry = failed.filter((t) => !(t === "passwords" && reported.get(t) === false));
      if (retry.length && def.kind === "chromium" && profile) {
        const copy = PathUtils.join(tmp, def.id);
        // A copy macOS refuses fails only the types retried: the others came in on the first pass.
        const copied = await copyChromium(root, profile.id, copy).then(
          () => true,
          (e) => {
            if (!isAccessDenied(e)) throw e;
            for (const t of retry) errors.set(t, say("chrome-import-access-denied"));
            p.denied = true;
            return false;
          },
        );
        if (copied) {
          for (const t of retry) {
            reported.delete(t);
            unreadableTypes.delete(t);
            errors.delete(t);
            delete counts[t];
          }
          await migrate(make(copy), retry);
          failed = [...failed.filter((t) => !retry.includes(t)), ...(await bad(retry, `${copy}/${profile.id}`))];
        }
      }
      for (const t of asked) {
        if (failed.includes(t)) p.failed[t] = errors.get(t) ?? reason(store.state.locale, def, t, unreadableTypes.has(t));
        else if (testHome && def.kind === "chromium" && t === "passwords") p.failed[t] = say("chrome-import-keychain-test");
        else p.counts[t] = counts[t] ?? 0;
      }
    } catch (e) {
      console.error("[import] failed:", e);
      const f = failure(e);
      for (const t of types) if (p.counts[t] === undefined) p.failed[t] ??= f.text;
      if (f.denied) p.denied = true;
    } finally {
      for (const [name, saved] of savedPrefs) saved === null ? Services.prefs.clearUserPref(name) : Services.prefs.setIntPref(name, saved);
      MigrationUtils.insertVisitsWrapper = visits;
      MigrationUtils.insertManyBookmarksWrapper = bookmarks;
      MigratorBase.needsFolderSelectionToReadData = needsFolder;
      await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch((e: unknown) => console.error("[import] copy not removed:", e));
      p.done = true;
      running = false;
      const s = summary(p, store.state.locale);
      showAlert(s.title, s.text);
    }
  }

  return {
    async sources() {
      // Only which data folders exist: no file of another browser is read before the person picks it.
      const exists = (path: string) => IOUtils.exists(path);
      // The app sits under the real home even when a test home holds the data.
      const realHome = Services.dirsvc.get("Home", Ci.nsIFile).path;
      return Promise.all((await detectSources(home, exists)).map(async (d): Promise<ImportSource> => ({ id: d.id, name: d.name, icon: await sourceApp(realHome, d, exists).then((app) => app && appIcon(app)), types: [...d.types], passwordsByCsv: d.passwordsByCsv })));
    },
    async profiles(source) {
      const def = await findSource(source);
      // Not before macOS lets us: the read itself would be blocked, with its notification.
      return def && !asks(def) ? profilesOf(def) : [];
    },
    async access(source) {
      const def = await findSource(source);
      return def && asks(def) ? "ask" : "ready";
    },
    async grantAccess(source) {
      const def = await findSource(source);
      if (!def || !asks(def)) return { ok: true };
      if (!(await pickFolder(accessFolder(def)))) return { ok: false, error: say("chrome-import-access-cancelled", { name: def.name }), denied: false };
      // The engine's check: one byte of `Local State`, and Arc's sidebar next to `User Data` (an absent file is no refusal).
      const files = [`${sourceRoot(home, def)}/Local State`, ...(def.id === "arc" ? [`${accessFolder(def)}/StorableSidebar.json`] : [])];
      for (const file of files)
        try {
          await IOUtils.read(file, { maxBytes: 1 });
        } catch (e) {
          if (isAccessDenied(e)) return { ok: false, error: say("chrome-import-access-wrong", { name: def.name }), denied: true };
        }
      granted.add(def.id);
      return { ok: true };
    },
    async start(o) {
      if (running) return { ok: false, error: say("chrome-import-running") };
      running = true;
      try {
        const def = await findSource(o?.source);
        if (!def) throw new Error(say("chrome-import-no-browser"));
        if (asks(def)) throw new Error(say("chrome-import-access-first", { name: def.name }));
        const types = Array.isArray(o.types) ? def.types.filter((t) => o.types.includes(t)) : [];
        if (!types.length) throw new Error(say("chrome-import-nothing"));
        const profiles = await profilesOf(def);
        const profile = o.profile === null ? (profiles[0] ?? null) : (profiles.find((p) => p.id === o.profile) ?? null);
        if (!profile && (o.profile !== null || def.kind !== "safari")) throw new Error(say("chrome-import-no-profile"));
        progress = { source: def.id, done: false, counts: {}, failed: {} };
        void run(def, profile, types, progress);
        return { ok: true };
      } catch (e) {
        running = false;
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    progress: async () => progress && structuredClone(progress),
    async importPasswordsCsv() {
      let path = testEnv("RESSAC_TEST_IMPORT_CSV");
      if (!path) {
        const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
        fp.init(Services.wm.getMostRecentBrowserWindow()?.browsingContext, say("chrome-import-csv-pick"), Ci.nsIFilePicker.modeOpen);
        fp.appendFilter("CSV", "*.csv");
        const r = await new Promise((done) => fp.open(done));
        if (r !== Ci.nsIFilePicker.returnOK || !fp.file) return { ok: false, error: say("chrome-import-no-file") };
        path = fp.file.path as string;
      }
      try {
        const { LoginCSVImport } = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");
        const report: { result: string }[] = await LoginCSVImport.importFromCSV(path);
        return { ok: true, count: report.filter((r) => r.result === "added" || r.result === "modified").length };
      } catch (e: any) {
        console.error("[import] CSV:", e);
        if (e?.errorType === "FILE_PERMISSIONS_ERROR" || e?.errorType === "UNABLE_TO_READ_ERROR") return { ok: false, error: say("chrome-import-csv-unreadable") };
        return { ok: false, error: say("chrome-import-csv-invalid") };
      }
    },
  };
}
