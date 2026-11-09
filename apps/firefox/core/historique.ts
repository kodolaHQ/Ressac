import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { HistoryResult } from "@webaios/noyau";
import type { Visite } from "../shared/modele";

export type { HistoryResult as ResultatHistorique, Visite };

const COLONNES = `url, titre, derniere_visite AS derniereVisite, visites, espace_id AS espaceId, prive,
  EXISTS (SELECT 1 FROM textes t WHERE t.url = visites.url AND t.espace_id = visites.espace_id) AS retenu`;

/** Limits of the browsing memory (spec §6.3). */
export const TEXTE_MAX = 20_000; // characters per page
export const RETENTION_JOURS = 183;
export const PLAFOND_OCTETS = 1_000_000_000; // UTF-8 de `texte`, toutes pages confondues
const LIMITE_AGENT = { defaut: 20, max: 50 };
/** Words of the excerpt returned to the agent (64 at most for FTS5): about 300 characters. */
const MOTS_EXTRAIT = 54;

/** Lowercase without accents: « Été » and « ete » find each other (SQLite's LIKE only folds ASCII). */
const plier = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Browsing history: one row per URL and per space, in `<profile>/historique.sqlite`. */
export class Historique {
  private db: DatabaseSync;
  private req: Record<
    | "noter" | "majTitre" | "rechercher" | "rechercherDistinctes" | "recents" | "effacerDepuis" | "toutEffacer" | "rendrePrive"
    | "retenir" | "majTitreTexte" | "estPrive" | "oublierTexte" | "oublierTextesEspace" | "effacerTextesDepuis"
    | "effacerTextesOrphelins" | "toutEffacerTextes" | "purgerAvant" | "totalOctets" | "textesAnciens" | "oublierTexteId"
    | "texteRetenu" | "visitesDe" | "extrait",
    StatementSync
  >;
  private plafondOctets: number;

  constructor(chemin: string, options: { plafondOctets?: number } = {}) {
    this.plafondOctets = options.plafondOctets ?? PLAFOND_OCTETS;
    mkdirSync(dirname(chemin), { recursive: true });
    this.db = new DatabaseSync(chemin);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrer();
    this.db.function("plier", { deterministic: true }, (s) => plier(String(s)));
    this.req = {
      noter: this.db.prepare(`
        INSERT INTO visites (url, espace_id, titre, derniere_visite, prive) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (url, espace_id) DO UPDATE SET titre = excluded.titre, derniere_visite = excluded.derniere_visite,
          visites = CASE WHEN prive = 1 AND excluded.prive = 0 THEN 1 ELSE visites + 1 END, prive = excluded.prive`),
      majTitre: this.db.prepare("UPDATE visites SET titre = ? WHERE url = ? AND espace_id = ?"),
      rechercher: this.db.prepare(`
        SELECT ${COLONNES} FROM visites
        WHERE plier(url) LIKE ? ESCAPE '\\' OR plier(titre) LIKE ? ESCAPE '\\'
        ORDER BY visites DESC, derniere_visite DESC LIMIT ?`),
      // A single row per URL, the best ranked, chosen in SQL so that the LIMIT counts URLs.
      rechercherDistinctes: this.db.prepare(`
        SELECT ${COLONNES} FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY url ORDER BY visites DESC, derniere_visite DESC) AS rang FROM visites
          WHERE plier(url) LIKE ? ESCAPE '\\' OR plier(titre) LIKE ? ESCAPE '\\'
        ) AS visites
        WHERE rang = 1
        ORDER BY visites DESC, derniere_visite DESC LIMIT ?`),
      recents: this.db.prepare(`SELECT ${COLONNES} FROM visites ORDER BY derniere_visite DESC LIMIT ?`),
      effacerDepuis: this.db.prepare("DELETE FROM visites WHERE derniere_visite >= ?"),
      toutEffacer: this.db.prepare("DELETE FROM visites"),
      rendrePrive: this.db.prepare("UPDATE visites SET prive = 1 WHERE espace_id = ?"),
      retenir: this.db.prepare(`
        INSERT INTO textes (url, espace_id, titre, date, texte, octets) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (url, espace_id) DO UPDATE SET titre = excluded.titre, date = excluded.date, texte = excluded.texte,
          octets = excluded.octets`),
      majTitreTexte: this.db.prepare("UPDATE textes SET titre = ? WHERE url = ? AND espace_id = ? AND titre <> ?"),
      estPrive: this.db.prepare("SELECT 1 FROM visites WHERE url = ? AND espace_id = ? AND prive = 1"),
      oublierTexte: this.db.prepare("DELETE FROM textes WHERE url = ? AND espace_id = ?"),
      oublierTextesEspace: this.db.prepare("DELETE FROM textes WHERE espace_id = ?"),
      effacerTextesDepuis: this.db.prepare("DELETE FROM textes WHERE date >= ?"),
      effacerTextesOrphelins: this.db.prepare(
        "DELETE FROM textes WHERE NOT EXISTS (SELECT 1 FROM visites v WHERE v.url = textes.url AND v.espace_id = textes.espace_id)",
      ),
      toutEffacerTextes: this.db.prepare("DELETE FROM textes"),
      purgerAvant: this.db.prepare("DELETE FROM textes WHERE date < ?"),
      totalOctets: this.db.prepare("SELECT COALESCE(SUM(octets), 0) AS total FROM textes"),
      textesAnciens: this.db.prepare("SELECT id, octets FROM textes ORDER BY date, id"),
      oublierTexteId: this.db.prepare("DELETE FROM textes WHERE id = ?"),
      texteRetenu: this.db.prepare(`
        SELECT t.url, t.titre, t.date, t.texte FROM textes t
        JOIN visites v ON v.url = t.url AND v.espace_id = t.espace_id AND v.prive = 0
        WHERE t.url = ? ORDER BY t.date DESC LIMIT 1`),
      visitesDe: this.db.prepare(`
        SELECT titre, derniere_visite AS date, visites FROM visites
        WHERE url = :url AND prive = 0 AND derniere_visite >= :depuis AND derniere_visite <= :jusqua
        ORDER BY derniere_visite DESC`),
      extrait: this.db.prepare(
        `SELECT snippet(textes_fts, 2, '', '', '…', ${MOTS_EXTRAIT}) AS extrait FROM textes_fts WHERE textes_fts MATCH ? AND rowid = ?`,
      ),
    };
  }

  /** Creates the table, or migrates the old one (`url` key alone): rows kept, space `""` (none), non-private. */
  private migrer(): void {
    const colonnes = (this.db.prepare("PRAGMA table_info(visites)").all() as { name: string }[]).map((c) => c.name);
    const nouvelle = `(
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
      if (colonnes.length === 0) this.db.exec(`CREATE TABLE visites ${nouvelle}`);
      else if (!colonnes.includes("espace_id")) {
        this.db.exec(`
          CREATE TABLE visites_v2 ${nouvelle};
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

  noter(v: { url: string; titre: string; espaceId: string; prive: boolean; date?: Date }): void {
    if (!this.db.isOpen) return; // a page can still navigate during the exit
    this.req.noter.run(v.url, v.espaceId, v.titre, (v.date ?? new Date()).toISOString(), v.prive ? 1 : 0);
  }

  /** The title often arrives after the navigation: it completes the visit without counting a new one. */
  majTitre(url: string, espaceId: string, titre: string): void {
    if (!this.db.isOpen) return;
    this.req.majTitre.run(titre, url, espaceId);
    this.req.majTitreTexte.run(titre, url, espaceId, titre);
  }

  /** The space became private: all its already recorded visits become so, and their kept text is forgotten. */
  rendrePrive(espaceId: string): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.req.rendrePrive.run(espaceId);
      this.req.oublierTextesEspace.run(espaceId);
    });
  }

  /** Keeps a page's text (truncated to TEXTE_MAX characters), replacing that of the previous visit. */
  retenir(r: { url: string; espaceId: string; titre: string; texte: string; date?: Date }): void {
    if (!this.db.isOpen) return;
    if (this.req.estPrive.get(r.url, r.espaceId)) return; // defense: nothing is kept from a private visit
    let texte = r.texte.slice(0, TEXTE_MAX);
    if (/[\uD800-\uDBFF]$/.test(texte)) texte = texte.slice(0, -1); // no half character
    const date = (r.date ?? new Date()).toISOString();
    this.req.retenir.run(r.url, r.espaceId, r.titre, date, texte, Buffer.byteLength(texte, "utf8"));
  }

  /** Forgets a visit's text without erasing the visit. */
  oublierTexte(url: string, espaceId: string): void {
    if (!this.db.isOpen) return;
    this.req.oublierTexte.run(url, espaceId);
  }

  /** Forgets text older than RETENTION_JOURS days, then the oldest while the total exceeds the cap. */
  purger(maintenant = new Date()): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      this.req.purgerAvant.run(new Date(maintenant.getTime() - RETENTION_JOURS * 86_400_000).toISOString());
      let total = Number((this.req.totalOctets.get() as { total: number }).total);
      if (total <= this.plafondOctets) return;
      const aOublier: number[] = [];
      for (const l of this.req.textesAnciens.iterate() as Iterable<{ id: number; octets: number }>) {
        if (total <= this.plafondOctets) break;
        aOublier.push(l.id);
        total -= l.octets;
      }
      for (const id of aOublier) this.req.oublierTexteId.run(id);
    });
  }

  /** The most recent kept text of this URL, excluding private visits. */
  texteRetenu(url: string): { url: string; titre: string; date: string; texte: string } | null {
    if (!this.db.isOpen) return null;
    return (this.req.texteRetenu.get(url) as { url: string; titre: string; date: string; texte: string } | undefined) ?? null;
  }

  /**
   * Search for the agent, made of non-private visits only (within [depuis, jusqua]), one row per URL.
   * Each word of the query is searched separately (OR): in the kept text, the title and the URL through the full-text
   * index, and as a folded substring in the title and URL of any visit (a visit without text is found too).
   * Ranking: pages found by the index first (bm25, then the most recent), then those found by their
   * title or URL alone, from most to least recent. An empty query returns the most recent.
   */
  rechercherPourAgent(q: { requete: string; depuis?: Date; jusqua?: Date; limite?: number }): HistoryResult[] {
    if (!this.db.isOpen) return [];
    const limite = Math.max(1, Math.min(LIMITE_AGENT.max, Math.floor(q.limite ?? LIMITE_AGENT.defaut)));
    const periode = { depuis: q.depuis?.toISOString() ?? "", jusqua: q.jusqua?.toISOString() ?? "\uffff" };
    const mots = q.requete.split(/\s+/).filter(Boolean);
    // Each word is a quoted FTS phrase: no query operator is interpreted.
    const fts = mots.map((m) => `"${m.replaceAll('"', '""')}"`).join(" OR ");
    const motifs = Object.fromEntries(mots.map((m, i) => [`m${i}`, `%${plier(m).replace(/[\\%_]/g, (c) => `\\${c}`)}%`]));
    const dansPeriode = "v.prive = 0 AND v.derniere_visite >= :depuis AND v.derniere_visite <= :jusqua";
    const parTitreOuUrl = mots.length
      ? mots.map((_, i) => `plier(v.url) LIKE :m${i} ESCAPE '\\' OR plier(v.titre) LIKE :m${i} ESCAPE '\\'`).join(" OR ")
      : "1";
    const trouves = mots.length
      ? `SELECT t.url, t.id, bm25(textes_fts) AS score FROM textes_fts
           JOIN textes t ON t.id = textes_fts.rowid
           JOIN visites v ON v.url = t.url AND v.espace_id = t.espace_id
           WHERE textes_fts MATCH :fts AND ${dansPeriode}`
      : "SELECT NULL AS url, NULL AS id, NULL AS score WHERE 0";
    const lignes = this.db
      .prepare(`
        WITH trouves AS MATERIALIZED (${trouves}),
        candidates AS (
          SELECT url, MIN(score) AS score FROM (
            SELECT url, score FROM trouves
            UNION ALL SELECT v.url, NULL FROM visites v WHERE ${dansPeriode} AND (${parTitreOuUrl})
          ) GROUP BY url
        )
        SELECT c.url, c.score,
          (SELECT id FROM trouves t WHERE t.url = c.url ORDER BY t.score LIMIT 1) AS id,
          (SELECT MAX(v.derniere_visite) FROM visites v WHERE v.url = c.url AND ${dansPeriode}) AS recente
        FROM candidates c
        ORDER BY c.score IS NULL, c.score, recente DESC
        LIMIT :limite`)
      .all({ ...periode, ...motifs, ...(mots.length ? { fts } : {}), limite }) as { url: string; id: number | null }[];
    return lignes.map(({ url, id }) => {
      const visites = this.req.visitesDe.all({ url, ...periode }) as { titre: string; date: string; visites: number }[];
      const extrait = id === null ? undefined : (this.req.extrait.get(fts, id) as { extrait: string } | undefined);
      return {
        url,
        titre: visites[0]!.titre,
        derniereVisite: visites[0]!.date,
        visites: visites.reduce((n, v) => n + v.visites, 0),
        extrait: extrait?.extrait ?? "",
      };
    });
  }

  /** Substring insensitive to case and accents on the URL and title; `%`, `_` and `\` are literal. */
  rechercher(texte: string, limite = 50, distinctes = false): Visite[] {
    if (!this.db.isOpen) return [];
    const motif = `%${plier(texte).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.lignes(this.req[distinctes ? "rechercherDistinctes" : "rechercher"].all(motif, motif, limite));
  }

  recents(limite = 100): Visite[] {
    if (!this.db.isOpen) return [];
    return this.lignes(this.req.recents.all(limite));
  }

  private lignes(brutes: Record<string, unknown>[]): Visite[] {
    return brutes.map((l) => ({ ...l, prive: l.prive === 1, retenu: l.retenu === 1 }) as unknown as Visite);
  }

  /** Erases the visits and kept text since `depuis` (everything without a date), and the text whose visit is erased. */
  effacer(depuis?: Date): void {
    if (!this.db.isOpen) return;
    this.transaction(() => {
      if (depuis) {
        this.req.effacerDepuis.run(depuis.toISOString());
        this.req.effacerTextesDepuis.run(depuis.toISOString());
        this.req.effacerTextesOrphelins.run();
      } else {
        this.req.toutEffacer.run();
        this.req.toutEffacerTextes.run();
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

  fermer(): void {
    if (this.db.isOpen) this.db.close();
  }
}
