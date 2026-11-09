import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { HistoryResult } from "@webaios/kernel";
import type { Visit } from "../shared/model";

export type { HistoryResult, Visit };

const COLUMNS = `url, titre, derniere_visite AS derniereVisite, visites, espace_id AS espaceId, prive,
  EXISTS (SELECT 1 FROM textes t WHERE t.url = visites.url AND t.espace_id = visites.espace_id) AS retenu`;

/** Limits of the browsing memory (spec §6.3). */
export const TEXT_MAX = 20_000; // characters per page
export const RETENTION_DAYS = 183;
export const BYTES_CAP = 1_000_000_000; // UTF-8 de `texte`, toutes pages confondues
const AGENT_LIMIT = { default: 20, max: 50 };
/** Words of the excerpt returned to the agent (64 at most for FTS5): about 300 characters. */
const SNIPPET_WORDS = 54;

/** Lowercase without accents: « Été » and « ete » find each other (SQLite's LIKE only folds ASCII). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Browsing history: one row per URL and per space, in `<profile>/historique.sqlite`. */
export class History {
  private db: DatabaseSync;
  private req: Record<
    | "note" | "updateTitle" | "search" | "searchDistinct" | "recents" | "eraseSince" | "clearAll" | "makePrivate"
    | "keep" | "updateTitleText" | "isPrivate" | "forgetText" | "forgetSpaceTexts" | "eraseTextsSince"
    | "eraseOrphanTexts" | "clearAllTexts" | "purgeBefore" | "totalBytes" | "oldTexts" | "forgetTextId"
    | "keptText" | "visitesDe" | "excerpt",
    StatementSync
  >;
  private byteCap: number;

  constructor(path: string, options: { byteCap?: number } = {}) {
    this.byteCap = options.byteCap ?? BYTES_CAP;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
    this.db.function("plier", { deterministic: true }, (s) => fold(String(s)));
    this.req = {
      note: this.db.prepare(`
        INSERT INTO visites (url, espace_id, titre, derniere_visite, prive) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (url, espace_id) DO UPDATE SET titre = excluded.titre, derniere_visite = excluded.derniere_visite,
          visites = CASE WHEN prive = 1 AND excluded.prive = 0 THEN 1 ELSE visites + 1 END, prive = excluded.prive`),
      updateTitle: this.db.prepare("UPDATE visites SET titre = ? WHERE url = ? AND espace_id = ?"),
      search: this.db.prepare(`
        SELECT ${COLUMNS} FROM visites
        WHERE plier(url) LIKE ? ESCAPE '\\' OR plier(titre) LIKE ? ESCAPE '\\'
        ORDER BY visites DESC, derniere_visite DESC LIMIT ?`),
      // A single row per URL, the best ranked, chosen in SQL so that the LIMIT counts URLs.
      searchDistinct: this.db.prepare(`
        SELECT ${COLUMNS} FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY url ORDER BY visites DESC, derniere_visite DESC) AS rang FROM visites
          WHERE plier(url) LIKE ? ESCAPE '\\' OR plier(titre) LIKE ? ESCAPE '\\'
        ) AS visites
        WHERE rang = 1
        ORDER BY visites DESC, derniere_visite DESC LIMIT ?`),
      recents: this.db.prepare(`SELECT ${COLUMNS} FROM visites ORDER BY derniere_visite DESC LIMIT ?`),
      eraseSince: this.db.prepare("DELETE FROM visites WHERE derniere_visite >= ?"),
      clearAll: this.db.prepare("DELETE FROM visites"),
      makePrivate: this.db.prepare("UPDATE visites SET prive = 1 WHERE espace_id = ?"),
      keep: this.db.prepare(`
        INSERT INTO textes (url, espace_id, titre, date, texte, octets) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (url, espace_id) DO UPDATE SET titre = excluded.titre, date = excluded.date, texte = excluded.texte,
          octets = excluded.octets`),
      updateTitleText: this.db.prepare("UPDATE textes SET titre = ? WHERE url = ? AND espace_id = ? AND titre <> ?"),
      isPrivate: this.db.prepare("SELECT 1 FROM visites WHERE url = ? AND espace_id = ? AND prive = 1"),
      forgetText: this.db.prepare("DELETE FROM textes WHERE url = ? AND espace_id = ?"),
      forgetSpaceTexts: this.db.prepare("DELETE FROM textes WHERE espace_id = ?"),
      eraseTextsSince: this.db.prepare("DELETE FROM textes WHERE date >= ?"),
      eraseOrphanTexts: this.db.prepare(
        "DELETE FROM textes WHERE NOT EXISTS (SELECT 1 FROM visites v WHERE v.url = textes.url AND v.espace_id = textes.espace_id)",
      ),
      clearAllTexts: this.db.prepare("DELETE FROM textes"),
      purgeBefore: this.db.prepare("DELETE FROM textes WHERE date < ?"),
      totalBytes: this.db.prepare("SELECT COALESCE(SUM(octets), 0) AS total FROM textes"),
      oldTexts: this.db.prepare("SELECT id, octets FROM textes ORDER BY date, id"),
      forgetTextId: this.db.prepare("DELETE FROM textes WHERE id = ?"),
      keptText: this.db.prepare(`
        SELECT t.url, t.titre, t.date, t.texte FROM textes t
        JOIN visites v ON v.url = t.url AND v.espace_id = t.espace_id AND v.prive = 0
        WHERE t.url = ? ORDER BY t.date DESC LIMIT 1`),
      visitesDe: this.db.prepare(`
        SELECT titre, derniere_visite AS date, visites FROM visites
        WHERE url = :url AND prive = 0 AND derniere_visite >= :depuis AND derniere_visite <= :jusqua
        ORDER BY derniere_visite DESC`),
      excerpt: this.db.prepare(
        `SELECT snippet(textes_fts, 2, '', '', '…', ${SNIPPET_WORDS}) AS extrait FROM textes_fts WHERE textes_fts MATCH ? AND rowid = ?`,
      ),
    };
  }

  /** Creates the table, or migrates the old one (`url` key alone): rows kept, space `""` (none), non-private. */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(visites)").all() as { name: string }[]).map((c) => c.name);
    const fresh = `(
        url TEXT NOT NULL,
        espace_id TEXT NOT NULL,
        titre TEXT NOT NULL,
        derniere_visite TEXT NOT NULL,
        visites INTEGER NOT NULL DEFAULT 1,
        prive INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (url, espace_id)
      )`;
    this.db.exec("BEGIN");
    try {
      if (columns.length === 0) this.db.exec(`CREATE TABLE visites ${fresh}`);
      else if (!columns.includes("espace_id")) {
        this.db.exec(`
          CREATE TABLE visites_v2 ${fresh};
          INSERT INTO visites_v2 (url, espace_id, titre, derniere_visite, visites, prive)
            SELECT url, '', titre, derniere_visite, visites, 0 FROM visites;
          DROP TABLE visites;
          ALTER TABLE visites_v2 RENAME TO visites;`);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS visites_date ON visites (derniere_visite)");
      // Kept text: one row per URL and per space. The FTS5 index reads its content from `textes` (nothing is stored
      // twice); the triggers keep it up to date whichever method writes or erases.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS textes (
          id INTEGER PRIMARY KEY,
          url TEXT NOT NULL,
          espace_id TEXT NOT NULL,
          titre TEXT NOT NULL,
          date TEXT NOT NULL,
          texte TEXT NOT NULL,
          octets INTEGER NOT NULL,
          UNIQUE (url, espace_id)
        );
        CREATE INDEX IF NOT EXISTS textes_date ON textes (date);
        CREATE INDEX IF NOT EXISTS textes_espace ON textes (espace_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS textes_fts USING fts5(
          titre, url, texte, content = 'textes', content_rowid = 'id', tokenize = "unicode61 remove_diacritics 2"
        );
        CREATE TRIGGER IF NOT EXISTS textes_ajout AFTER INSERT ON textes BEGIN
          INSERT INTO textes_fts (rowid, titre, url, texte) VALUES (new.id, new.titre, new.url, new.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS textes_retrait AFTER DELETE ON textes BEGIN
          INSERT INTO textes_fts (textes_fts, rowid, titre, url, texte) VALUES ('delete', old.id, old.titre, old.url, old.texte);
        END;
        CREATE TRIGGER IF NOT EXISTS textes_maj AFTER UPDATE ON textes BEGIN
          INSERT INTO textes_fts (textes_fts, rowid, titre, url, texte) VALUES ('delete', old.id, old.titre, old.url, old.texte);
          INSERT INTO textes_fts (rowid, titre, url, texte) VALUES (new.id, new.titre, new.url, new.texte);
        END;`);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  note(v: { url: string; title: string; spaceId: string; private: boolean; date?: Date }): void {
    if (!this.db.isOpen) return; // a page can still navigate during the exit
    this.req.note.run(v.url, v.spaceId, v.title, (v.date ?? new Date()).toISOString(), v.private ? 1 : 0);
  }

  /** The title often arrives after the navigation: it completes the visit without counting a new one. */
  updateTitle(url: string, spaceId: string, title: string): void {
    if (!this.db.isOpen) return;
    this.req.updateTitle.run(title, url, spaceId);
    this.req.updateTitleText.run(title, url, spaceId, title);
  }

  /** The space became private: all its already recorded visits become so, and their kept text is forgotten. */
  makePrivate(spaceId: string): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.req.makePrivate.run(spaceId);
      this.req.forgetSpaceTexts.run(spaceId);
    });
  }

  /** Keeps a page's text (truncated to TEXTE_MAX characters), replacing that of the previous visit. */
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

  /** Forgets text older than RETENTION_DAYS days, then the oldest while the total exceeds the cap. */
  purge(now = new Date()): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.req.purgeBefore.run(new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString());
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
   * Search for the agent, made of non-private visits only (within [depuis, jusqua]), one row per URL.
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
    const inPeriod = "v.prive = 0 AND v.derniere_visite >= :depuis AND v.derniere_visite <= :jusqua";
    const byTitleOrUrl = words.length
      ? words.map((_, i) => `plier(v.url) LIKE :m${i} ESCAPE '\\' OR plier(v.titre) LIKE :m${i} ESCAPE '\\'`).join(" OR ")
      : "1";
    const found = words.length
      ? `SELECT t.url, t.id, bm25(textes_fts) AS score FROM textes_fts
           JOIN textes t ON t.id = textes_fts.rowid
           JOIN visites v ON v.url = t.url AND v.espace_id = t.espace_id
           WHERE textes_fts MATCH :fts AND ${inPeriod}`
      : "SELECT NULL AS url, NULL AS id, NULL AS score WHERE 0";
    const lignes = this.db
      .prepare(`
        WITH trouves AS MATERIALIZED (${found}),
        candidates AS (
          SELECT url, MIN(score) AS score FROM (
            SELECT url, score FROM trouves
            UNION ALL SELECT v.url, NULL FROM visites v WHERE ${inPeriod} AND (${byTitleOrUrl})
          ) GROUP BY url
        )
        SELECT c.url, c.score,
          (SELECT id FROM trouves t WHERE t.url = c.url ORDER BY t.score LIMIT 1) AS id,
          (SELECT MAX(v.derniere_visite) FROM visites v WHERE v.url = c.url AND ${inPeriod}) AS recente
        FROM candidates c
        ORDER BY c.score IS NULL, c.score, recente DESC
        LIMIT :limite`)
      .all({ ...period, ...patterns, ...(words.length ? { fts } : {}), limit: limit }) as { url: string; id: number | null }[];
    return lignes.map(({ url, id }) => {
      const visits = this.req.visitesDe.all({ url, ...period }) as { title: string; date: string; visits: number }[];
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

  /** Substring insensitive to case and accents on the URL and title; `%`, `_` and `\` are literal. */
  search(text: string, limit = 50, distinct = false): Visit[] {
    if (!this.db.isOpen) return [];
    const pattern = `%${fold(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.lines(this.req[distinct ? "searchDistinct" : "search"].all(pattern, pattern, limit));
  }

  recents(limit = 100): Visit[] {
    if (!this.db.isOpen) return [];
    return this.lines(this.req.recents.all(limit));
  }

  private lines(raw: Record<string, unknown>[]): Visit[] {
    return raw.map((l) => ({ ...l, private: l.prive === 1, kept: l.retenu === 1 }) as unknown as Visit);
  }

  /** Erases the visits and kept text since `depuis` (everything without a date), and the text whose visit is erased. */
  erase(from?: Date): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      if (from) {
        this.req.eraseSince.run(from.toISOString());
        this.req.eraseTextsSince.run(from.toISOString());
        this.req.eraseOrphanTexts.run();
      } else {
        this.req.clearAll.run();
        this.req.clearAllTexts.run();
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
