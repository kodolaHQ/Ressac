import type { BrowserImportApi, ImportProgress, ImportSource, ImportType } from "../../../shared/api";
import type { AgentHost } from "../../agent/host";
import { showAlert } from "../notifications";
import type { Store } from "../store";
import { parseArcSidebar, parseZenSpaces, planSpaceImport, planTabImport } from "./spaces";
import { chromiumMigrator, chromiumProfiles, detectSources, firefoxMigrator, firefoxProfiles, safariMigrator, sourceRoot, type SourceDef } from "./sources";

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
/** Singular, plural, and the type's name in a failure. */
const LABELS: Record<ImportType, [string, string, string]> = {
  bookmarks: ["favori", "favoris", "favoris"],
  history: ["page d'historique", "pages d'historique", "historique"],
  passwords: ["mot de passe", "mots de passe", "mots de passe"],
  spaces: ["élément de barre latérale", "éléments de barre latérale", "espaces et onglets épinglés"],
  tabs: ["onglet ouvert", "onglets ouverts", "onglets ouverts"],
};

/** The end notification: what came in, then what failed and why. */
export function summary(p: ImportProgress): { title: string; text: string } {
  const got = ORDER.filter((t) => p.counts[t] !== undefined)
    .map((t) => `${p.counts[t]!.toLocaleString("fr-FR")} ${LABELS[t][p.counts[t]! < 2 ? 0 : 1]}`)
    .join(", ");
  const failed = ORDER.filter((t) => p.failed[t])
    .map((t) => `${LABELS[t][2]} (${p.failed[t]})`)
    .join(", ");
  return { title: failed ? "Import terminé en partie" : "Import terminé", text: [got, failed && `Non importé : ${failed}`].filter(Boolean).join(". ") };
}

/** Why a type could not be read when no error says it: the engine's migrators only say that it failed. */
function reason(def: SourceDef, type: ImportType, unreadableFile: boolean): string {
  if (def.kind === "safari") return "accès refusé : autorisez WebAiOs dans Réglages Système › Confidentialité et sécurité › Accès complet au disque";
  if (type === "passwords" && def.kind === "chromium" && !unreadableFile) return "accès au trousseau refusé";
  // Firefox and Zen are always read from a copy: a lock is not the cause.
  return def.kind === "firefox" ? `profil ${def.name} illisible` : `fichier illisible : fermez ${def.name} puis réessayez`;
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
  const BITS: Partial<Record<ImportType, number>> = { bookmarks: MigrationUtils.resourceTypes.BOOKMARKS, history: MigrationUtils.resourceTypes.HISTORY, passwords: MigrationUtils.resourceTypes.PASSWORDS };
  const testHome = Services.env.get("WEBAIOS_TEST_IMPORT_HOME");
  const home = testHome || Services.dirsvc.get("Home", Ci.nsIFile).path;
  const tmp = PathUtils.join(dataDir, "import-tmp");
  // A quit or crash mid-import may have left copies (Login Data, History): never kept. A run waits for it.
  const cleared = IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch((e: unknown) => console.error("[import] old copy not removed:", e));
  let progress: ImportProgress | null = null;
  let running = false;

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
        else await MigrationUtils.getRowsFromDBWithoutLocks(path, "WebAiOs import check", "SELECT 1 FROM sqlite_master LIMIT 1");
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
    if (!arc && !profile) throw new Error("profil Zen introuvable");
    const path = arc ? sourceRoot(home, def).replace(/\/User Data$/, "/StorableSidebar.json") : `${profile!.id}/zen-sessions.jsonlz4`;
    if (!(await IOUtils.exists(path))) throw new Error("aucun espace trouvé");
    let json: unknown;
    try {
      json = await IOUtils.readJSON(path, { decompress: !arc });
    } catch {
      throw new Error(reason(def, "spaces", true));
    }
    const read = arc ? parseArcSidebar(json) : parseZenSpaces(json);
    if (!read) throw new Error(`format ${def.name} non reconnu`);
    const [sidebar, tabs] = [types.includes("spaces"), types.includes("tabs")];
    const imported = { spaces: read.spaces.map((s) => ({ name: s.name, pinned: sidebar ? s.pinned : [], tabs: tabs ? s.tabs : [] })), essentials: sidebar ? read.essentials : [] };
    const size = () => store.state.spaces.reduce((n, e) => n + 1 + e.pinned.length, store.state.essentials.length);
    const open = () => Object.keys(store.state.tabs).length;
    const before = [size(), open()];
    for (const a of planSpaceImport(store.state, imported)) store.dispatch(a);
    // shortcut: the open tabs all land in the first window, upgrade if importing with several windows open matters.
    const windowId = store.state.windows[0]?.id;
    if (windowId) for (const a of planTabImport(store.state, imported, windowId)) store.dispatch(a);
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
        (e) => sidebar.forEach((t) => (p.failed[t] = e instanceof Error ? e.message : String(e))),
      );
    const savedPrefs = RUN_PREFS.map(([name, value]) => {
      const saved = Services.prefs.prefHasUserValue(name) ? Services.prefs.getIntPref(name) : null;
      Services.prefs.setIntPref(name, value);
      return [name, saved] as const;
    });
    const visits = MigrationUtils.insertVisitsWrapper;
    const bookmarks = MigrationUtils.insertManyBookmarksWrapper;
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
        await copyChromium(root, profile.id, copy);
        for (const t of retry) {
          reported.delete(t);
          unreadableTypes.delete(t);
          errors.delete(t);
          delete counts[t];
        }
        await migrate(make(copy), retry);
        failed = [...failed.filter((t) => !retry.includes(t)), ...(await bad(retry, `${copy}/${profile.id}`))];
      }
      for (const t of asked) {
        if (failed.includes(t)) p.failed[t] = errors.get(t) ?? reason(def, t, unreadableTypes.has(t));
        else if (testHome && def.kind === "chromium" && t === "passwords") p.failed[t] = "trousseau non consulté pendant les tests";
        else p.counts[t] = counts[t] ?? 0;
      }
    } catch (e) {
      console.error("[import] failed:", e);
      for (const t of types) if (p.counts[t] === undefined) p.failed[t] ??= e instanceof Error ? e.message : String(e);
    } finally {
      for (const [name, saved] of savedPrefs) saved === null ? Services.prefs.clearUserPref(name) : Services.prefs.setIntPref(name, saved);
      MigrationUtils.insertVisitsWrapper = visits;
      MigrationUtils.insertManyBookmarksWrapper = bookmarks;
      await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch((e: unknown) => console.error("[import] copy not removed:", e));
      p.done = true;
      running = false;
      const s = summary(p);
      showAlert(s.title, s.text);
    }
  }

  return {
    async sources() {
      // Only which data folders exist: no file of another browser is read before the person picks it.
      return (await detectSources(home, (path) => IOUtils.exists(path))).map((d): ImportSource => ({ id: d.id, name: d.name, types: [...d.types], passwordsByCsv: d.passwordsByCsv }));
    },
    async profiles(source) {
      const def = (await detectSources(home, (path) => IOUtils.exists(path))).find((d) => d.id === source);
      return def ? profilesOf(def) : [];
    },
    async start(o) {
      if (running) return { ok: false, error: "Un import est déjà en cours" };
      running = true;
      try {
        const def = (await detectSources(home, (path) => IOUtils.exists(path))).find((d) => d.id === o?.source);
        if (!def) throw new Error("Ce navigateur n'est pas sur ce Mac");
        const types = Array.isArray(o.types) ? def.types.filter((t) => o.types.includes(t)) : [];
        if (!types.length) throw new Error("Rien à importer");
        const profiles = await profilesOf(def);
        const profile = o.profile === null ? (profiles[0] ?? null) : (profiles.find((p) => p.id === o.profile) ?? null);
        if (!profile && (o.profile !== null || def.kind !== "safari")) throw new Error("Profil introuvable");
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
      let path = Services.env.get("WEBAIOS_TEST_IMPORT_CSV");
      if (!path) {
        const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
        fp.init(Services.wm.getMostRecentBrowserWindow()?.browsingContext, "Choisissez l'export de vos mots de passe (CSV)", Ci.nsIFilePicker.modeOpen);
        fp.appendFilter("CSV", "*.csv");
        const r = await new Promise((done) => fp.open(done));
        if (r !== Ci.nsIFilePicker.returnOK || !fp.file) return { ok: false, error: "Aucun fichier choisi" };
        path = fp.file.path as string;
      }
      try {
        const { LoginCSVImport } = ChromeUtils.importESModule("resource://gre/modules/LoginCSVImport.sys.mjs");
        const report: { result: string }[] = await LoginCSVImport.importFromCSV(path);
        return { ok: true, count: report.filter((r) => r.result === "added" || r.result === "modified").length };
      } catch (e: any) {
        console.error("[import] CSV:", e);
        if (e?.errorType === "FILE_PERMISSIONS_ERROR" || e?.errorType === "UNABLE_TO_READ_ERROR") return { ok: false, error: "Ce fichier n'a pas pu être lu." };
        return { ok: false, error: "Ce fichier n'est pas un export de mots de passe (CSV)." };
      }
    },
  };
}
