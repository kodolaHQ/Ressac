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
export const BYTES_CAP = 1_000_000_000; // UTF-8 of `text` and `title`, all pages together
/** Characters kept of a title (Firefox's tab label maximum): a page cannot fill the history through its title. */
export const TITLE_MAX = 256;
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

/** On one of `sites` (a host or its subdomains); every URL when there are none. */
const onSites = (url: string, sites: string[]) => {
  if (!sites.length) return true;
  try {
    const host = new URL(url).hostname;
    return sites.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
};

/** Characters of kept text a page's vector is computed from. */
export const VECTOR_EXCERPT = 300;
/** A page waiting for its vector: what its document text is made of (see page-indexer's pageDocument), and when it was last seen. */
export type PendingPage = { url: string; spaceId: string; title: string; host: string; excerpt: string; lastVisit: string };
/** Kept as a page's vector when the model refuses the page: it leaves the queue until its title or text changes. */
export const REFUSED_VECTOR = new Float32Array(0);

/** Lowercase without accents: « Été » and « ete » find each other (SQLite's LIKE only folds ASCII). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** node:sqlite cuts a string at NUL when it reads it back: a title or text that keeps one never equals what was written. */
const noNul = (s: string) => s.replaceAll("\0", "");
/** A title as stored: without NUL, at most TITLE_MAX characters, no half character. */
const cleanTitle = (s: string) => noNul(s).slice(0, TITLE_MAX).replace(/[\uD800-\uDBFF]$/, "");

/** Browsing history: one row per URL and per space, in `<profile>/history.sqlite`. */
export class History {
  private db: DatabaseSync;
  private req: Record<
    | "note" | "updateTitle" | "search" | "recents" | "eraseSince" | "clearAll" | "makePrivate"
    | "keep" | "updateTitleText" | "isPrivate" | "forgetText" | "forgetSpaceTexts" | "eraseTextsSince"
    | "eraseOrphanTexts" | "clearAllTexts" | "purgeBefore" | "purgeVisitsBefore" | "totalBytes" | "oldTexts" | "forgetTextId"
    | "keptText" | "visitsOf" | "excerpt" | "importVisit" | "noteIcon" | "icon" | "clearIcons" | "eraseOrphanIcons"
    | "pendingVectors" | "saveVector" | "similar" | "dropVector",
    StatementSync
  >;
  private byteCap: number;

  /** `vectorModel`: the search model's file name; the vectors of another model are dropped at open. */
  constructor(path: string, options: { byteCap?: number; vectorModel?: string } = {}) {
    this.byteCap = options.byteCap ?? BYTES_CAP;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;");
    this.db.function("fold", { deterministic: true }, (s) => fold(String(s)));
    this.createTables(options.vectorModel);
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
      // An http(s) URL's host ends at `/` or `:` (a port). Ranges, not LIKE, so each test is a seek in the primary key's
      // index (url first): `0` follows `/` and `;` follows `:`. 150k visits, 3000 icons: 41 s with LIKE.
      eraseOrphanIcons: this.db.prepare(`
        DELETE FROM icons WHERE NOT EXISTS (SELECT 1 FROM visits WHERE url >= 'https://' || icons.host || '/' AND url < 'https://' || icons.host || '0')
          AND NOT EXISTS (SELECT 1 FROM visits WHERE url >= 'http://' || icons.host || '/' AND url < 'http://' || icons.host || '0')
          AND NOT EXISTS (SELECT 1 FROM visits WHERE url >= 'https://' || icons.host || ':' AND url < 'https://' || icons.host || ';')
          AND NOT EXISTS (SELECT 1 FROM visits WHERE url >= 'http://' || icons.host || ':' AND url < 'http://' || icons.host || ';')`),
      pendingVectors: this.db.prepare(`
        SELECT v.url, v.space_id AS spaceId, v.title, v.last_visit AS lastVisit, COALESCE(substr(t.text, 1, ${VECTOR_EXCERPT}), '') AS excerpt
        FROM visits v LEFT JOIN texts t ON t.url = v.url AND t.space_id = v.space_id
        WHERE v.private = 0 AND v.last_visit <= ? AND NOT EXISTS (SELECT 1 FROM vectors x WHERE x.url = v.url AND x.space_id = v.space_id)
        ORDER BY v.last_visit DESC LIMIT ?`),
      // Saved only if the page is still as it was embedded (its title or text may have changed meanwhile) and not private.
      // REFUSED_VECTOR binds as NULL: stored as an empty blob.
      saveVector: this.db.prepare(`
        INSERT INTO vectors (url, space_id, vec) SELECT :url, :spaceId, COALESCE(:vec, X'')
        WHERE EXISTS (SELECT 1 FROM visits v WHERE v.url = :url AND v.space_id = :spaceId AND v.private = 0 AND v.title = :title)
          AND COALESCE((SELECT substr(text, 1, ${VECTOR_EXCERPT}) FROM texts WHERE url = :url AND space_id = :spaceId), '') = :excerpt
        ON CONFLICT (url, space_id) DO UPDATE SET vec = excluded.vec`),
      dropVector: this.db.prepare("DELETE FROM vectors WHERE url = ? AND space_id = ?"),
      similar: this.db.prepare(`
        SELECT v.url, v.space_id AS spaceId, v.title, v.last_visit AS lastVisit, v.visits, x.vec, COALESCE(substr(t.text, 1, ${VECTOR_EXCERPT}), '') AS excerpt
        FROM vectors x JOIN visits v ON v.url = x.url AND v.space_id = x.space_id
        LEFT JOIN texts t ON t.url = x.url AND t.space_id = x.space_id
        WHERE v.private = 0 AND v.last_visit >= :since AND v.last_visit <= :until`),
      excerpt: this.db.prepare(
        `SELECT snippet(texts_fts, 2, '', '', '…', ${SNIPPET_WORDS}) AS excerpt FROM texts_fts WHERE texts_fts MATCH ? AND rowid = ?`,
      ),
    };
  }

  /** Creates the tables if they are missing. */
  private createTables(vectorModel?: string): void {
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
      // A page's vector (⌘T Demander), computed from its title, host and text excerpt. The triggers erase it whichever
      // statement erases its visit or text, makes it private, or changes what it was computed from: it is then recomputed.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vectors (url TEXT NOT NULL, space_id TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (url, space_id));
        CREATE TRIGGER IF NOT EXISTS visits_delete_vector AFTER DELETE ON visits BEGIN
          DELETE FROM vectors WHERE url = old.url AND space_id = old.space_id;
        END;
        CREATE TRIGGER IF NOT EXISTS visits_update_vector AFTER UPDATE OF title, private ON visits
        WHEN new.title <> old.title OR new.private <> 0 BEGIN
          DELETE FROM vectors WHERE url = old.url AND space_id = old.space_id;
        END;
        CREATE TRIGGER IF NOT EXISTS texts_insert_vector AFTER INSERT ON texts BEGIN
          DELETE FROM vectors WHERE url = new.url AND space_id = new.space_id;
        END;
        CREATE TRIGGER IF NOT EXISTS texts_delete_vector AFTER DELETE ON texts BEGIN
          DELETE FROM vectors WHERE url = old.url AND space_id = old.space_id;
        END;
        CREATE TRIGGER IF NOT EXISTS texts_update_vector AFTER UPDATE OF text ON texts
        WHEN substr(new.text, 1, ${VECTOR_EXCERPT}) <> substr(old.text, 1, ${VECTOR_EXCERPT}) BEGIN
          DELETE FROM vectors WHERE url = old.url AND space_id = old.space_id;
        END;
        CREATE TABLE IF NOT EXISTS vector_model (name TEXT NOT NULL);`);
      // Rows written with a NUL before noNul existed, cleaned once (user_version 1: the scan reads every text). Read as
      // blobs: node:sqlite and SQLite's replace() both stop at the NUL; a 0 byte is never inside a UTF-8 sequence.
      // texts_update keeps the full-text index in sync.
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version < 1) this.dropNul();
      // An FTS5 'delete' only appends a tombstone: the erased page's words stay in the index. secure-delete (a persistent
      // option) removes them; the rebuild, once (user_version 2), drops those an older file kept.
      if (version < 2) {
        this.db.exec(`INSERT INTO texts_fts (texts_fts, rank) VALUES ('secure-delete', 1);
          INSERT INTO texts_fts (texts_fts) VALUES ('rebuild'); PRAGMA user_version = 2;`);
      }
      const model = this.db.prepare("SELECT name FROM vector_model").get() as { name: string } | undefined;
      if (vectorModel !== undefined && model?.name !== vectorModel) {
        this.db.exec("DELETE FROM vectors; DELETE FROM vector_model;");
        this.db.prepare("INSERT INTO vector_model (name) VALUES (?)").run(vectorModel);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Removes the NUL bytes of every title and text (createTables, once). */
  private dropNul(): void {
    const clean = (b: Uint8Array) => Buffer.from(b.filter((x) => x !== 0)).toString("utf8");
    const nul = (c: string) => `instr(CAST(${c} AS BLOB), X'00') > 0`;
    const visits = this.db.prepare(`SELECT rowid AS id, CAST(title AS BLOB) AS title FROM visits WHERE ${nul("title")}`).all();
    const setVisit = this.db.prepare("UPDATE visits SET title = ?, title_fold = ? WHERE rowid = ?");
    for (const r of visits as { id: number; title: Uint8Array }[]) setVisit.run(clean(r.title), fold(clean(r.title)), r.id);
    const texts = this.db.prepare(`SELECT id, CAST(title AS BLOB) AS title, CAST(text AS BLOB) AS text FROM texts WHERE ${nul("title")} OR ${nul("text")}`).all();
    const setText = this.db.prepare("UPDATE texts SET title = ?, text = ?, bytes = ? WHERE id = ?");
    for (const r of texts as { id: number; title: Uint8Array; text: Uint8Array }[]) {
      const text = clean(r.text);
      setText.run(clean(r.title), text, Buffer.byteLength(text, "utf8"), r.id);
    }
    this.db.exec("PRAGMA user_version = 1");
  }

  note(v: { url: string; title: string; spaceId: string; private: boolean; date?: Date }): void {
    if (!this.db.isOpen) return; // a page can still navigate during the exit
    const title = cleanTitle(v.title);
    this.req.note.run(v.url, v.spaceId, title, (v.date ?? new Date()).toISOString(), v.private ? 1 : 0, fold(v.url), fold(title));
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
        const title = cleanTitle(v.title || v.url);
        count += Number(this.req.importVisit.run(v.url, title, v.date.toISOString(), fold(v.url), fold(title)).changes);
      }
    });
    return count;
  }

  /** The title often arrives after the navigation: it completes the visit without counting a new one. */
  updateTitle(url: string, spaceId: string, raw: string): void {
    if (!this.db.isOpen) return;
    const title = cleanTitle(raw);
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
    this.checkpoint();
  }

  /** Keeps a page's text (truncated to TEXT_MAX characters), replacing that of the previous visit. */
  keep(r: { url: string; spaceId: string; title: string; text: string; date?: Date }): void {
    if (!this.db.isOpen) return;
    if (this.req.isPrivate.get(r.url, r.spaceId)) return; // defense: nothing is kept from a private visit
    let text = noNul(r.text).slice(0, TEXT_MAX);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); // no half character
    const date = (r.date ?? new Date()).toISOString();
    const title = cleanTitle(r.title);
    this.req.keep.run(r.url, r.spaceId, title, date, text, Buffer.byteLength(text, "utf8") + Buffer.byteLength(title, "utf8"));
  }

  /** Forgets a visit's text without erasing the visit. */
  forgetText(url: string, spaceId: string): void {
    if (!this.db.isOpen) return;
    this.req.forgetText.run(url, spaceId);
    this.checkpoint();
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
    this.checkpoint();
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
   * Non-private pages without a vector last seen at or before `before` (an ISO date; any when absent), most recent first.
   * Its scan walks past every vectored page (one primary-key lookup each): a few ms per 10k visits, once a minute when idle;
   * a pass passes its last batch's oldest date as `before` so it does not walk past the pages it already did.
   */
  pendingVectors(limit: number, before = "\uffff"): PendingPage[] {
    if (!this.db.isOpen) return [];
    return (this.req.pendingVectors.all(before, limit) as Omit<PendingPage, "host">[]).map((r) => {
      let host = "";
      try {
        host = new URL(r.url).hostname.replace(/^www\./, "");
      } catch { /* no host */ }
      return { url: r.url, spaceId: r.spaceId, title: r.title, host, excerpt: r.excerpt, lastVisit: r.lastVisit };
    });
  }

  /**
   * Keeps the vectors (L2-normalised, or REFUSED_VECTOR) of pages read by pendingVectors; a page changed or erased since
   * is skipped. Returns the vectors written.
   */
  saveVectors(rows: (PendingPage & { vec: Float32Array })[]): number {
    if (!this.db.isOpen) return 0;
    let written = 0;
    this.transaction(() => {
      for (const r of rows) {
        // Raw Float32 in the platform's order: little-endian on every machine Ressac runs on.
        const vec = new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength);
        written += Number(this.req.saveVector.run({ url: r.url, spaceId: r.spaceId, title: r.title, excerpt: r.excerpt, vec }).changes);
      }
    });
    return written;
  }

  /**
   * The pages nearest to `vec` (L2-normalised: the dot product is the cosine), one per URL with its best score, with
   * non-private visits only, within [since, until], optionally on `sites` (a host or its subdomains).
   * The vectors are read one row at a time (unsorted: sorting them all costs a temp B-tree), grouped per URL in a Map of
   * small hits, and only the `limit` best pages are kept.
   * shortcut: every vector in the period is read and compared in JS (about 3 KB and a few µs per page), fine for tens of
   * thousands of pages; past that, keep the vectors in memory or use a vector index.
   */
  findSimilar(vec: Float32Array, q: { since?: Date; until?: Date; sites?: string[]; limit: number }): (PageHit & { score: number })[] {
    if (!this.db.isOpen) return [];
    const sites = (q.sites ?? []).map((s) => s.toLowerCase());
    const rows = this.req.similar.iterate({ since: q.since?.toISOString() ?? "", until: q.until?.toISOString() ?? "\uffff" }) as Iterable<{
      url: string; spaceId: string; title: string; lastVisit: string; visits: number; vec: Uint8Array; excerpt: string;
    }>;
    type Hit = PageHit & { score: number };
    const hits = new Map<string, Hit>();
    const stale: [url: string, spaceId: string][] = [];
    for (const r of rows) {
      if (!onSites(r.url, sites)) continue;
      if (r.vec.byteLength === 0) continue; // refused by the model
      if (r.vec.byteLength !== vec.byteLength) {
        stale.push([r.url, r.spaceId]); // another model's vector: computed again (dropped after the read)
        continue;
      }
      const b = r.vec;
      const page = b.byteOffset % 4 === 0 ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Float32Array(b.slice().buffer);
      let score = 0;
      for (let i = 0; i < page.length; i++) score += page[i]! * vec[i]!;
      const hit = hits.get(r.url);
      if (!hit) {
        hits.set(r.url, { url: r.url, title: r.title, lastVisit: r.lastVisit, visits: r.visits, excerpt: r.excerpt, favicon: null, score });
        continue;
      }
      hit.visits += r.visits;
      if (r.lastVisit > hit.lastVisit) Object.assign(hit, { title: r.title, lastVisit: r.lastVisit });
      if (score > hit.score) Object.assign(hit, { score, excerpt: r.excerpt });
    }
    const top: Hit[] = []; // best first (equal scores by URL), at most q.limit
    for (const hit of hits.values()) {
      const i = top.findIndex((x) => x.score < hit.score || (x.score === hit.score && x.url > hit.url));
      if (i < 0 && top.length >= q.limit) continue;
      top.splice(i < 0 ? top.length : i, 0, hit);
      if (top.length > q.limit) top.pop();
    }
    if (stale.length) this.transaction(() => { for (const [url, spaceId] of stale) this.req.dropVector.run(url, spaceId); });
    return top.map((x) => ({ ...x, favicon: this.favicon(x.url) }));
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
    this.checkpoint();
  }

  /** Empties the WAL into the database (where secure_delete zeroes the freed pages): erased text leaves no copy behind. */
  private checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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
