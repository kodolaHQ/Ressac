import type { ImportSourceId, ImportType } from "../../../shared/api";

/** How a source is read: the engine's Chromium migrators, its Safari migrator, or our Firefox-format reader. */
export type SourceKind = "chromium" | "safari" | "firefox";

export interface SourceDef {
  id: ImportSourceId;
  name: string;
  kind: SourceKind;
  /** The data folder, under the home folder. */
  dir: string[];
  types: ImportType[];
  passwordsByCsv: boolean;
  /** Chromium: the engine's migrator class to reuse (Arc has none: it extends ChromeProfileMigrator). */
  engineClass?: string;
  /** Chromium: the keychain item holding the key of its saved passwords. */
  keychain?: { service: string; account: string };
}

const SUPPORT = ["Library", "Application Support"];
const CHROMIUM: ImportType[] = ["bookmarks", "history", "passwords"];
// Safari's passwords cannot be read by another app; Firefox's and Zen's are encrypted by their own NSS key.
const NO_PASSWORDS: ImportType[] = ["bookmarks", "history"];

export const SOURCES: SourceDef[] = [
  // shortcut: Arc is not installed on the Mac this was built on; folder and keychain names are Chromium's usual pattern, measure them on a real Arc install.
  { id: "arc", name: "Arc", kind: "chromium", dir: [...SUPPORT, "Arc", "User Data"], types: [...CHROMIUM, "spaces", "tabs"], passwordsByCsv: false, engineClass: "ChromeProfileMigrator", keychain: { service: "Arc Safe Storage", account: "Arc" } },
  { id: "chrome", name: "Google Chrome", kind: "chromium", dir: [...SUPPORT, "Google", "Chrome"], types: CHROMIUM, passwordsByCsv: false, engineClass: "ChromeProfileMigrator" },
  { id: "brave", name: "Brave", kind: "chromium", dir: [...SUPPORT, "BraveSoftware", "Brave-Browser"], types: CHROMIUM, passwordsByCsv: false, engineClass: "BraveProfileMigrator" },
  { id: "edge", name: "Microsoft Edge", kind: "chromium", dir: [...SUPPORT, "Microsoft Edge"], types: CHROMIUM, passwordsByCsv: false, engineClass: "ChromiumEdgeMigrator" },
  { id: "vivaldi", name: "Vivaldi", kind: "chromium", dir: [...SUPPORT, "Vivaldi"], types: CHROMIUM, passwordsByCsv: false, engineClass: "VivaldiProfileMigrator" },
  { id: "opera", name: "Opera", kind: "chromium", dir: [...SUPPORT, "com.operasoftware.Opera"], types: CHROMIUM, passwordsByCsv: false, engineClass: "OperaProfileMigrator" },
  { id: "safari", name: "Safari", kind: "safari", dir: ["Library", "Safari"], types: NO_PASSWORDS, passwordsByCsv: true },
  { id: "firefox", name: "Firefox", kind: "firefox", dir: [...SUPPORT, "Firefox"], types: NO_PASSWORDS, passwordsByCsv: true },
  { id: "zen", name: "Zen", kind: "firefox", dir: [...SUPPORT, "zen"], types: [...NO_PASSWORDS, "spaces", "tabs"], passwordsByCsv: true },
];

/** macOS only: plain `/` joins keep this module loadable by the unit tests. */
export const sourceRoot = (home: string, def: SourceDef) => [home, ...def.dir].join("/");

/** The sources whose data folder exists under `home` (a test home too: there the importer never runs Safari's migrator). */
export async function detectSources(home: string, exists: (path: string) => Promise<boolean>): Promise<SourceDef[]> {
  const found = await Promise.all(SOURCES.map((d) => exists(sourceRoot(home, d))));
  return SOURCES.filter((_, i) => found[i]);
}

/** A Chromium `Local State`'s profiles, the last used first; null when it has none. */
export function chromiumProfiles(localState: unknown): { id: string; name: string }[] | null {
  const profile = (localState as { profile?: { info_cache?: Record<string, { name?: string }>; last_used?: string } })?.profile;
  const cache = profile?.info_cache;
  if (!cache || typeof cache !== "object") return null;
  // The ids become paths: one that could leave the data folder is dropped.
  const list = Object.entries(cache)
    .filter(([id]) => id && !id.includes("/") && !id.includes(".."))
    .map(([id, p]) => ({ id, name: typeof p?.name === "string" && p.name ? p.name : id }));
  return list.sort((a, b) => Number(b.id === profile?.last_used) - Number(a.id === profile?.last_used));
}

/** A Firefox-format `profiles.ini`'s profiles (id: the absolute folder), the default first. */
export function firefoxProfiles(ini: string, root: string): { id: string; name: string }[] {
  const sections: Record<string, string>[] = [];
  for (const line of ini.split(/\r?\n/)) {
    if (/^\s*\[.*\]\s*$/.test(line)) sections.push({ "": line.trim() });
    else if (sections.length && line.includes("=")) sections.at(-1)![line.slice(0, line.indexOf("=")).trim()] = line.slice(line.indexOf("=") + 1).trim();
  }
  // The install's default wins over the older `Default=1`.
  const preferred = sections.find((s) => s[""]!.startsWith("[Install") && s.Default)?.Default;
  const profiles = sections
    .filter((s) => /^\[Profile\d+\]$/.test(s[""]!) && s.Path)
    .map((s) => ({ id: s.IsRelative === "1" ? `${root}/${s.Path}` : s.Path!, name: s.Name || s.Path!, first: preferred ? s.Path === preferred : s.Default === "1" }));
  return profiles.sort((a, b) => Number(b.first) - Number(a.first)).map(({ id, name }) => ({ id, name }));
}

const MIGRATION = "moz-src:///browser/components/migration";

/** A Chromium source's migrator: the engine's class, reading `root` (the real data folder, or its copy). */
export function chromiumMigrator(def: SourceDef, root: string): any {
  const Base = ChromeUtils.importESModule(`${MIGRATION}/ChromeProfileMigrator.sys.mjs`)[def.engineClass!];
  const m = new (class extends Base {
    // The engine resolves the folder from the real home: ours follows WEBAIOS_TEST_IMPORT_HOME and the copy.
    async _getChromeUserDataPathIfExists() {
      return (await IOUtils.exists(root)) ? root : null;
    }
  })();
  if (def.keychain) Object.assign(m, { _keychainServiceName: def.keychain.service, _keychainAccountName: def.keychain.account });
  return m;
}

export function safariMigrator(): any {
  return new (ChromeUtils.importESModule(`${MIGRATION}/SafariProfileMigrator.sys.mjs`).SafariProfileMigrator)();
}

/**
 * Firefox and Zen. The engine's FirefoxProfileMigrator only paves over a profile at startup (its resources copy files
 * into `MigrationUtils.profileStartup`, null in a running browser): its resources here read a copy of `places.sqlite`
 * and insert through the same MigrationUtils wrappers as the other migrators.
 */
export function firefoxMigrator(copyDir: string): any {
  const { FirefoxProfileMigrator } = ChromeUtils.importESModule(`${MIGRATION}/FirefoxProfileMigrator.sys.mjs`);
  const { MigrationUtils } = ChromeUtils.importESModule(`${MIGRATION}/MigrationUtils.sys.mjs`);
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
  const types = MigrationUtils.resourceTypes;
  return new (class extends FirefoxProfileMigrator {
    async getResources(profile: { id: string }) {
      const source = `${profile.id}/places.sqlite`;
      if (!(await IOUtils.exists(source))) return [];
      // A running Firefox holds places.sqlite in exclusive mode: always read a copy, with its WAL.
      await IOUtils.makeDirectory(copyDir, { createAncestors: true, ignoreExisting: true });
      const copy = `${copyDir}/places.sqlite`;
      for (const suffix of ["", "-wal"]) if (await IOUtils.exists(source + suffix)) await IOUtils.copy(source + suffix, copy + suffix);
      const rows = async (sql: string) => {
        const db = await Sqlite.openConnection({ path: copy });
        try {
          return await db.execute(sql);
        } finally {
          await db.close();
        }
      };
      const resource = (type: number, run: () => Promise<void>) => ({ type, migrate: (done: (ok: boolean) => void) => run().then(() => done(true), (e) => (console.error("[import]", e), done(false))) });
      return [
        resource(types.BOOKMARKS, async () => {
          const all = await rows("SELECT b.id, b.parent, b.type, b.title, b.guid, h.url FROM moz_bookmarks b LEFT JOIN moz_places h ON h.id = b.fk ORDER BY b.parent, b.position");
          const children = new Map<number, any[]>();
          for (const r of all) {
            const parent = r.getResultByName("parent");
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent)!.push(r);
          }
          const tree = (id: number): object[] =>
            (children.get(id) ?? []).flatMap((r): object[] => {
              const type = r.getResultByName("type");
              if (type === 1 && /^https?:/.test(r.getResultByName("url") ?? "")) return [{ url: r.getResultByName("url"), title: r.getResultByName("title") ?? "" }];
              if (type === 2) return [{ type: PlacesUtils.bookmarks.TYPE_FOLDER, title: r.getResultByName("title") ?? "", children: tree(r.getResultByName("id")) }];
              return [];
            });
          for (const guid of [PlacesUtils.bookmarks.toolbarGuid, PlacesUtils.bookmarks.menuGuid, PlacesUtils.bookmarks.unfiledGuid]) {
            const root = all.find((r: any) => r.getResultByName("guid") === guid);
            const items = root ? tree(root.getResultByName("id")) : [];
            if (items.length) await MigrationUtils.insertManyBookmarksWrapper(items, guid);
          }
        }),
        resource(types.HISTORY, async () => {
          const since = (Date.now() - MigrationUtils.HISTORY_MAX_AGE_IN_MILLISECONDS) * 1000;
          const all = await rows(`SELECT url, title, last_visit_date FROM moz_places WHERE hidden = 0 AND last_visit_date > ${since} AND url LIKE 'http%'`);
          const pages = all.flatMap((r: any) => {
            try {
              return [{ url: new URL(r.getResultByName("url")), title: r.getResultByName("title") ?? "", visits: [{ date: new Date(r.getResultByName("last_visit_date") / 1000) }] }];
            } catch {
              return [];
            }
          });
          if (pages.length) await MigrationUtils.insertVisitsWrapper(pages);
        }),
      ];
    }
  })();
}
