import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { HistoryResult } from "@ressac/kernel";
import type { Visit } from "../shared/model";

export type { HistoryResult, Visit };
/** A ⌘T hit: the agent's result plus the site's favicon (the agent never needs it). */
export type PageHit = HistoryResult & { favicon: string | null };

const COLUMNS = `url, title, last_visit AS lastVisit, visits, space_id AS spaceId, private,
  EXISTS (SELECT 1 FROM texts t WHERE t.url = visits.url AND t.space_id = visits.space_id) AS kept`;

/** Limits of the browsing memory (spec §6.3). */
export const TEXT_MAX = 20_000; // characters per page
export const RETENTION_DAYS = 183;
/** Space id of the visits imported from another browser. */
export const IMPORTED_SPACE = "import";
export const BYTES_CAP = 1_000_000_000; // UTF-8 of `text`, all pages together
const AGENT_LIMIT = { default: 20, max: 50 };
/** Words of the excerpt returned to the agent (64 at most for FTS5): about 300 characters. */
const SNIPPET_WORDS = 54;
/** Characters of a site's favicon kept for the ⌘T rows: a data: URL, larger ones are dropped. */
export const ICON_MAX = 16 * 1024;

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
};

/** Lowercase without accents: « Été » and « ete » find each other (SQLite's LIKE only folds ASCII). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Browsing history: one row per URL and per space, in `<profile>/history.sqlite`. */
export class History {
  private db: DatabaseSync;
  private req: Record<
    | "note" | "updateTitle" | "search" | "recents" | "eraseSince" | "clearAll" | "makePrivate"
    | "keep" | "updateTitleText" | "isPrivate" | "forgetText" | "forgetSpaceTexts" | "eraseTextsSince"
    | "eraseOrphanTexts" | "clearAllTexts" | "purgeBefore" | "purgeVisitsBefore" | "totalBytes" | "oldTexts" | "forgetTextId"
    | "keptText" | "visitsOf" | "excerpt" | "importVisit" | "noteIcon" | "icon" | "clearIcons" | "eraseOrphanIcons",
    StatementSync
  >;
  private byteCap: number;

  constructor(path: string, options: { byteCap?: number } = {}) {
    this.byteCap = options.byteCap ?? BYTES_CAP;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.function("fold", { deterministic: true }, (s) => fold(String(s)));
    this.createTables();
    this.req = {
      note: this.db.prepare(`
        INSERT INTO visits (url, space_id, title, last_visit, private, url_fold, title_fold) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (url, space_id) DO UPDATE SET title = excluded.title, title_fold = excluded.title_fold, last_visit = excluded.last_visit,
          visits = CASE WHEN private = 1 AND excluded.private = 0 THEN 1 ELSE visits + 1 END, private = excluded.private`),
      // Re-importing never counts a new visit: the row only moves forward in time.
      importVisit: this.db.prepare(`
        INSERT INTO visits (url, space_id, title, last_visit, private, url_fold, title_fold) VALUES (?, '${IMPORTED_SPACE}', ?, ?, 0, ?, ?)
        ON CONFLICT (url, space_id) DO UPDATE SET title = excluded.title, title_fold = excluded.title_fold, last_visit = excluded.last_visit
        WHERE excluded.last_visit > last_visit`),
      updateTitle: this.db.prepare("UPDATE visits SET title = ?, title_fold = ? WHERE url = ? AND space_id = ?"),
      search: this.db.prepare(`
        SELECT ${COLUMNS} FROM visits
        WHERE url_fold LIKE ? ESCAPE '\\' OR title_fold LIKE ? ESCAPE '\\'
        ORDER BY visits DESC, last_visit DESC LIMIT ?`),
      recents: this.db.prepare(`SELECT ${COLUMNS} FROM visits ORDER BY last_visit DESC LIMIT ?`),
      eraseSince: this.db.prepare("DELETE FROM visits WHERE last_visit >= ?"),
      clearAll: this.db.prepare("DELETE FROM visits"),
      makePrivate: this.db.prepare("UPDATE visits SET private = 1 WHERE space_id = ?"),
      keep: this.db.prepare(`
        INSERT INTO texts (url, space_id, title, date, text, bytes) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (url, space_id) DO UPDATE SET title = excluded.title, date = excluded.date, text = excluded.text,
          bytes = excluded.bytes`),
      updateTitleText: this.db.prepare("UPDATE texts SET title = ? WHERE url = ? AND space_id = ? AND title <> ?"),
      isPrivate: this.db.prepare("SELECT 1 FROM visits WHERE url = ? AND space_id = ? AND private = 1"),
      forgetText: this.db.prepare("DELETE FROM texts WHERE url = ? AND space_id = ?"),
      forgetSpaceTexts: this.db.prepare("DELETE FROM texts WHERE space_id = ?"),
      eraseTextsSince: this.db.prepare("DELETE FROM texts WHERE date >= ?"),
      eraseOrphanTexts: this.db.prepare(
        "DELETE FROM texts WHERE NOT EXISTS (SELECT 1 FROM visits v WHERE v.url = texts.url AND v.space_id = texts.space_id)",
      ),
      clearAllTexts: this.db.prepare("DELETE FROM texts"),
      purgeBefore: this.db.prepare("DELETE FROM texts WHERE date < ?"),
      purgeVisitsBefore: this.db.prepare("DELETE FROM visits WHERE last_visit < ?"),
      totalBytes: this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM texts"),
      oldTexts: this.db.prepare("SELECT id, bytes FROM texts ORDER BY date, id"),
      forgetTextId: this.db.prepare("DELETE FROM texts WHERE id = ?"),
      keptText: this.db.prepare(`
        SELECT t.url, t.title, t.date, t.text FROM texts t
        JOIN visits v ON v.url = t.url AND v.space_id = t.space_id AND v.private = 0
        WHERE t.url = ? ORDER BY t.date DESC LIMIT 1`),
      visitsOf: this.db.prepare(`
        SELECT title, last_visit AS date, visits FROM visits
        WHERE url = :url AND private = 0 AND last_visit >= :since AND last_visit <= :until
        ORDER BY last_visit DESC`),
      noteIcon: this.db.prepare(
        "INSERT INTO icons (host, icon, date) VALUES (?, ?, ?) ON CONFLICT (host) DO UPDATE SET icon = excluded.icon, date = excluded.date",
      ),
      icon: this.db.prepare("SELECT icon FROM icons WHERE host = ?"),
      clearIcons: this.db.prepare("DELETE FROM icons"),
      // An http(s) URL's host ends at `/` or `:` (a port); `_` in LIKE may keep an icon too many, never drop one.
      eraseOrphanIcons: this.db.prepare(`
        DELETE FROM icons WHERE NOT EXISTS (SELECT 1 FROM visits v WHERE
          v.url LIKE 'https://' || icons.host || '/%' OR v.url LIKE 'http://' || icons.host || '/%' OR
          v.url LIKE 'https://' || icons.host || ':%' OR v.url LIKE 'http://' || icons.host || ':%')`),
      excerpt: this.db.prepare(
        `SELECT snippet(texts_fts, 2, '', '', '…', ${SNIPPET_WORDS}) AS excerpt FROM texts_fts WHERE texts_fts MATCH ? AND rowid = ?`,
      ),
    };
  }

  /** Creates the tables if they are missing. */
  private createTables(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS visits (
          url TEXT NOT NULL,
          space_id TEXT NOT NULL,
          title TEXT NOT NULL,
          last_visit TEXT NOT NULL,
          visits INTEGER NOT NULL DEFAULT 1,
          private INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (url, space_id)
        )`);
      // fold(url) and fold(title), stored: the search runs LIKE on them, never a JS call per row (150k rows: 200 ms).
      const columns = (this.db.prepare("PRAGMA table_info(visits)").all() as { name: string }[]).map((c) => c.name);
      if (!columns.includes("url_fold")) {
        this.db.exec(`
          ALTER TABLE visits ADD COLUMN url_fold TEXT NOT NULL DEFAULT '';
          ALTER TABLE visits ADD COLUMN title_fold TEXT NOT NULL DEFAULT '';
          UPDATE visits SET url_fold = fold(url), title_fold = fold(title);`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS visits_date ON visits (last_visit)");
      // Kept text: one row per URL and per space. The FTS5 index reads its content from `texts` (nothing is stored
      // twice); the triggers keep it up to date whichever method writes or erases.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS texts (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          space_id TEXT NOT NULL,
          title TEXT NOT NULL,
          date TEXT NOT NULL,
          text TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          UNIQUE (url, space_id)
        );
        CREATE INDEX IF NOT EXISTS texts_date ON texts (date);
        CREATE INDEX IF NOT EXISTS texts_space ON texts (space_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(
          title, url, text, content = 'texts', content_rowid = 'id', tokenize = "unicode61 remove_diacritics 2"
        );
        CREATE TRIGGER IF NOT EXISTS texts_insert AFTER INSERT ON texts BEGIN
          INSERT INTO texts_fts (rowid, title, url, text) VALUES (new.id, new.title, new.url, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS texts_delete AFTER DELETE ON texts BEGIN
          INSERT INTO texts_fts (texts_fts, rowid, title, url, text) VALUES ('delete', old.id, old.title, old.url, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS texts_update AFTER UPDATE ON texts BEGIN
          INSERT INTO texts_fts (texts_fts, rowid, title, url, text) VALUES ('delete', old.id, old.title, old.url, old.text);
          INSERT INTO texts_fts (rowid, title, url, text) VALUES (new.id, new.title, new.url, new.text);
        END;`);
      // The last favicon seen per site: the UI has no network, so the ⌘T rows show this data: URL.
      this.db.exec("CREATE TABLE IF NOT EXISTS icons (host TEXT PRIMARY KEY, icon TEXT NOT NULL, date TEXT NOT NULL)");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  note(v: { url: string; title: string; spaceId: string; private: boolean; date?: Date }): void {
    if (!this.db.isOpen) return; // a page can still navigate during the exit
    this.req.note.run(v.url, v.spaceId, v.title, (v.date ?? new Date()).toISOString(), v.private ? 1 : 0, fold(v.url), fold(v.title));
  }

  /** Imported visits (http(s) only, within RETENTION_DAYS) in one transaction; returns the rows written or updated. */
  importVisits(visits: { url: string; title: string; date: Date }[]): number {
    if (!this.db.isOpen) return 0;
    const oldest = Date.now() - RETENTION_DAYS * 86_400_000;
    let count = 0;
    this.transaction(() => {
      for (const v of visits) {
        const t = v.date.getTime();
        if (!/^https?:\/\//i.test(v.url) || !(t >= oldest)) continue;
        const title = v.title || v.url;
        count += Number(this.req.importVisit.run(v.url, title, v.date.toISOString(), fold(v.url), fold(title)).changes);
      }
    });
    return count;
  }

  /** The title often arrives after the navigation: it completes the visit without counting a new one. */
  updateTitle(url: string, spaceId: string, title: string): void {
    if (!this.db.isOpen) return;
    this.req.updateTitle.run(title, fold(title), url, spaceId);
    this.req.updateTitleText.run(title, url, spaceId, title);
  }

  /** Keeps the site's favicon (a data:image/ URL up to ICON_MAX characters) for an http(s) page; never from a private visit. */
  noteIcon(url: string, spaceId: string, icon: string): void {
    if (!this.db.isOpen) return;
    const host = hostOf(url);
    if (!host || typeof icon !== "string" || !icon.startsWith("data:image/") || icon.length > ICON_MAX) return;
    if (this.req.isPrivate.get(url, spaceId)) return;
    this.req.noteIcon.run(host, icon, new Date().toISOString());
  }

  private favicon(url: string): string | null {
    const host = hostOf(url);
    return host ? ((this.req.icon.get(host) as { icon: string } | undefined)?.icon ?? null) : null;
  }

  /** The space became private: all its already recorded visits become so, and their kept text is forgotten. */
  makePrivate(spaceId: string): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.req.makePrivate.run(spaceId);
      this.req.forgetSpaceTexts.run(spaceId);
    });
  }

  /** Keeps a page's text (truncated to TEXT_MAX characters), replacing that of the previous visit. */
  keep(r: { url: string; spaceId: string; title: string; text: string; date?: Date }): void {
    if (!this.db.isOpen) return;
    if (this.req.isPrivate.get(r.url, r.spaceId)) return; // defense: nothing is kept from a private visit
    let text = r.text.slice(0, TEXT_MAX);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); // no half character
    const date = (r.date ?? new Date()).toISOString();
    this.req.keep.run(r.url, r.spaceId, r.title, date, text, Buffer.byteLength(text, "utf8"));
  }

  /** Forgets a visit's text without erasing the visit. */
  forgetText(url: string, spaceId: string): void {
    if (!this.db.isOpen) return;
    this.req.forgetText.run(url, spaceId);
  }

  /** Forgets visits and text older than RETENTION_DAYS days, then the oldest text while the total exceeds the cap. */
  purge(now = new Date()): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
      // The same window as the text's: importVisits already keeps no visit older than RETENTION_DAYS.
      const gone = Number(this.req.purgeVisitsBefore.run(before).changes) + Number(this.req.purgeBefore.run(before).changes);
      // The icon sweep is slow on a long history: only when something was forgotten.
      if (gone > 0) {
        this.req.eraseOrphanTexts.run();
        this.req.eraseOrphanIcons.run();
      }
      let total = Number((this.req.totalBytes.get() as { total: number }).total);
      if (total <= this.byteCap) return;
      const toForget: number[] = [];
      for (const l of this.req.oldTexts.iterate() as Iterable<{ id: number; bytes: number }>) {
        if (total <= this.byteCap) break;
        toForget.push(l.id);
        total -= l.bytes;
      }
      for (const id of toForget) this.req.forgetTextId.run(id);
    });
  }

  /** The most recent kept text of this URL, excluding private visits. */
  keptText(url: string): { url: string; title: string; date: string; text: string } | null {
    if (!this.db.isOpen) return null;
    return (this.req.keptText.get(url) as { url: string; title: string; date: string; text: string } | undefined) ?? null;
  }

  /**
   * Search for the agent, made of non-private visits only (within [since, until]), one row per URL.
   * Each word of the query is searched separately (OR): in the kept text, the title and the URL through the full-text
   * index, and as a folded substring in the title and URL of any visit (a visit without text is found too).
   * Ranking: pages found by the index first (bm25, then the most recent), then those found by their
   * title or URL alone, from most to least recent. An empty query returns the most recent.
   */
  searchForAgent(q: { query: string; since?: Date; until?: Date; limit?: number }): HistoryResult[] {
    if (!this.db.isOpen) return [];
    const limit = Math.max(1, Math.min(AGENT_LIMIT.max, Math.floor(q.limit ?? AGENT_LIMIT.default)));
    const period = { since: q.since?.toISOString() ?? "", until: q.until?.toISOString() ?? "\uffff" };
    const words = q.query.split(/\s+/).filter(Boolean);
    // Each word is a quoted FTS phrase: no query operator is interpreted.
    const fts = words.map((m) => `"${m.replaceAll('"', '""')}"`).join(" OR ");
    const patterns = Object.fromEntries(words.map((m, i) => [`m${i}`, `%${fold(m).replace(/[\\%_]/g, (c) => `\\${c}`)}%`]));
    const inPeriod = "v.private = 0 AND v.last_visit >= :since AND v.last_visit <= :until";
    const byTitleOrUrl = words.length
      ? words.map((_, i) => `v.url_fold LIKE :m${i} ESCAPE '\\' OR v.title_fold LIKE :m${i} ESCAPE '\\'`).join(" OR ")
      : "1";
    const found = words.length
      ? `SELECT t.url, t.id, bm25(texts_fts) AS score FROM texts_fts
           JOIN texts t ON t.id = texts_fts.rowid
           JOIN visits v ON v.url = t.url AND v.space_id = t.space_id
           WHERE texts_fts MATCH :fts AND ${inPeriod}`
      : "SELECT NULL AS url, NULL AS id, NULL AS score WHERE 0";
    const lines = this.db
      .prepare(`
        WITH matches AS MATERIALIZED (${found}),
        candidates AS (
          SELECT url, MIN(score) AS score FROM (
            SELECT url, score FROM matches
            UNION ALL SELECT v.url, NULL FROM visits v WHERE ${inPeriod} AND (${byTitleOrUrl})
          ) GROUP BY url
        )
        SELECT c.url, c.score,
          (SELECT id FROM matches t WHERE t.url = c.url ORDER BY t.score LIMIT 1) AS id,
          (SELECT MAX(v.last_visit) FROM visits v WHERE v.url = c.url AND ${inPeriod}) AS latest
        FROM candidates c
        ORDER BY c.score IS NULL, c.score, latest DESC
        LIMIT :limit`)
      .all({ ...period, ...patterns, ...(words.length ? { fts } : {}), limit: limit }) as { url: string; id: number | null }[];
    return lines.map(({ url, id }) => {
      const visits = this.req.visitsOf.all({ url, ...period }) as { title: string; date: string; visits: number }[];
      const snippet = id === null ? undefined : (this.req.excerpt.get(fts, id) as { excerpt: string } | undefined);
      return {
        url,
        title: visits[0]!.title,
        lastVisit: visits[0]!.date,
        visits: visits.reduce((n, v) => n + v.visits, 0),
        excerpt: snippet?.excerpt ?? "",
      };
    });
  }

  /**
   * Precise search for the ⌘T bar (few hits, all relevant), unlike searchForAgent's wide one: every group must match
   * (variants of a group are alternatives), each word at a word start, case and accents folded. Pages whose title or
   * URL hold every group come first (most recent first), then pages whose kept text does (best rank first).
   * Non-private visits only, within [since, until], optionally on `sites` (a host or its subdomains).
   */
  findPages(q: { groups: string[][]; since?: Date; until?: Date; sites?: string[]; limit: number }): PageHit[] {
    if (!this.db.isOpen) return [];
    const groups = q.groups.map((g) => g.map((w) => fold(w).trim()).filter(Boolean)).filter((g) => g.length);
    if (!groups.length) return [];
    const period = { since: q.since?.toISOString() ?? "", until: q.until?.toISOString() ?? "￿" };
    const sites = (q.sites ?? []).map((s) => s.toLowerCase());
    const onSites = (url: string) => {
      if (!sites.length) return true;
      try {
        const host = new URL(url).hostname;
        return sites.some((s) => host === s || host.endsWith(`.${s}`));
      } catch {
        return false;
      }
    };
    const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = groups.map((g) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${g.map(escape).join("|")})`, "u"));
    const fts = groups.map((g) => `(${g.map((w) => `"${w.replaceAll('"', '""')}"`).join(" OR ")})`).join(" AND ");
    const likes = groups.flat().map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = this.db
      .prepare(`
        WITH found AS MATERIALIZED (
          SELECT t.url, t.id, bm25(texts_fts) AS score FROM texts_fts JOIN texts t ON t.id = texts_fts.rowid WHERE texts_fts MATCH :fts
        ),
        -- One text per URL, the best ranked (the bare id comes from the MIN row).
        m AS (SELECT url, id, MIN(score) AS score FROM found GROUP BY url),
        -- Only the URLs that can match: their text, or a word in the title or URL of a non-private row (a substring here,
        -- checked at a word start below), so a big history is not grouped and folded whole.
        candidates AS (
          SELECT url FROM m UNION SELECT url FROM visits WHERE private = 0 AND (${likes.map((_, i) => `url_fold LIKE :l${i} ESCAPE '\\' OR title_fold LIKE :l${i} ESCAPE '\\'`).join(" OR ")})
        )
        SELECT v.url, MAX(v.last_visit) AS lastVisit, SUM(v.visits) AS visits,
          (SELECT title FROM visits w WHERE w.url = v.url AND w.private = 0 ORDER BY w.last_visit DESC LIMIT 1) AS title,
          m.id, m.score
        FROM visits v LEFT JOIN m ON m.url = v.url
        WHERE v.url IN candidates AND v.private = 0 AND v.last_visit >= :since AND v.last_visit <= :until
        GROUP BY v.url`)
      .all({ ...period, fts, ...Object.fromEntries(likes.map((l, i) => [`l${i}`, l])) }) as { url: string; lastVisit: string; visits: number; title: string; id: number | null; score: number | null }[];
    // A small model often adds one idea too many: from 3 groups on, a title may miss one.
    const needed = groups.length >= 3 ? groups.length - 1 : groups.length;
    const inTitle = (r: (typeof rows)[number]) => {
      const s = fold(`${r.title} ${r.url}`);
      return patterns.filter((p) => p.test(s)).length;
    };
    const ranked = rows
      .filter((r) => onSites(r.url))
      .map((r) => ({ r, title: inTitle(r) }))
      .map((x) => ({ ...x, title: x.title >= needed ? x.title : 0 }))
      .filter((x) => x.title || x.r.id !== null)
      .sort((a, b) => b.title - a.title || (a.title ? b.r.lastVisit.localeCompare(a.r.lastVisit) : a.r.score! - b.r.score!))
      .slice(0, q.limit);
    return ranked.map(({ r }) => ({
      url: r.url,
      title: r.title,
      lastVisit: r.lastVisit,
      visits: r.visits,
      excerpt: r.id === null ? "" : ((this.req.excerpt.get(fts, r.id) as { excerpt: string } | undefined)?.excerpt ?? ""),
      favicon: this.favicon(r.url),
    }));
  }

  /** Substring insensitive to case and accents on the URL and title; `%`, `_` and `\` are literal. */
  search(text: string, limit = 50, distinct = false): Visit[] {
    if (!this.db.isOpen) return [];
    const pattern = `%${fold(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (!distinct) return this.lines(this.req.search.all(pattern, pattern, limit));
    // A single row per URL, the best ranked: the first one in the search's order. Fetched in growing pages, so the
    // limit counts URLs without ranking every match (a window over 150k rows took 160 ms).
    for (let n = limit * 4; ; n *= 4) {
      const rows = this.req.search.all(pattern, pattern, n);
      const seen = new Set<unknown>();
      const best = rows.filter((r) => !seen.has(r.url) && seen.add(r.url));
      if (best.length >= limit || rows.length < n) return this.lines(best.slice(0, limit));
    }
  }

  recents(limit = 100): Visit[] {
    if (!this.db.isOpen) return [];
    return this.lines(this.req.recents.all(limit));
  }

  private lines(raw: Record<string, unknown>[]): Visit[] {
    return raw.map((l) => ({ ...l, private: l.private === 1, kept: l.kept === 1, favicon: this.favicon(String(l.url)) }) as unknown as Visit);
  }

  /** Erases the visits and kept text since `from` (everything without a date), and the text whose visit is erased. */
  erase(from?: Date): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      if (from) {
        this.req.eraseSince.run(from.toISOString());
        this.req.eraseTextsSince.run(from.toISOString());
        this.req.eraseOrphanTexts.run();
        this.req.eraseOrphanIcons.run();
      } else {
        this.req.clearAll.run();
        this.req.clearAllTexts.run();
        this.req.clearIcons.run();
      }
    });
  }

  private transaction(f: () => void): void {
    this.db.exec("BEGIN");
    try {
      f();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
