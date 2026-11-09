import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { kind, rel, type Ctx } from "./json.js";
import { SQLITE } from "./names.js";

const COLUMNS: Record<string, string[]> = {
  visites: ["espace_id", "titre", "derniere_visite", "visites", "prive"],
  textes: ["espace_id", "titre", "texte", "octets"],
};

// The external-content FTS table and its triggers name the old table and columns: they are dropped, then made again
// on the new names (same schema as core/history.ts) and the index rebuilt from `texts`.
const FTS = `
  CREATE INDEX IF NOT EXISTS texts_date ON texts (date);
  CREATE INDEX IF NOT EXISTS texts_space ON texts (space_id);
  CREATE VIRTUAL TABLE texts_fts USING fts5(
    title, url, text, content = 'texts', content_rowid = 'id', tokenize = "unicode61 remove_diacritics 2"
  );
  CREATE TRIGGER texts_insert AFTER INSERT ON texts BEGIN
    INSERT INTO texts_fts (rowid, title, url, text) VALUES (new.id, new.title, new.url, new.text);
  END;
  CREATE TRIGGER texts_delete AFTER DELETE ON texts BEGIN
    INSERT INTO texts_fts (texts_fts, rowid, title, url, text) VALUES ('delete', old.id, old.title, old.url, old.text);
  END;
  CREATE TRIGGER texts_update AFTER UPDATE ON texts BEGIN
    INSERT INTO texts_fts (texts_fts, rowid, title, url, text) VALUES ('delete', old.id, old.title, old.url, old.text);
    INSERT INTO texts_fts (rowid, title, url, text) VALUES (new.id, new.title, new.url, new.text);
  END;
  INSERT INTO texts_fts (texts_fts) VALUES ('rebuild');`;

/** Tables, columns, indexes, FTS and triggers renamed in one transaction; the state is read from `sqlite_master`. */
function migrateSchema(db: DatabaseSync): void {
  const has = (type: string, name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;
  if (!has("table", "visites") && !has("table", "textes")) return;
  db.exec("BEGIN");
  try {
    for (const t of ["textes_ajout", "textes_retrait", "textes_maj"]) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
    for (const i of ["visites_date", "textes_date", "textes_espace"]) db.exec(`DROP INDEX IF EXISTS ${i}`);
    db.exec("DROP TABLE IF EXISTS textes_fts");
    for (const [table, columns] of Object.entries(COLUMNS)) {
      if (!has("table", table)) continue;
      const present = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      db.exec(`ALTER TABLE ${table} RENAME TO ${SQLITE[table]}`);
      for (const c of columns) if (present.has(c)) db.exec(`ALTER TABLE ${SQLITE[table]} RENAME COLUMN ${c} TO ${SQLITE[c]}`);
    }
    if (has("table", "visits") && (db.prepare("PRAGMA table_info(visits)").all() as { name: string }[]).some((c) => c.name === "last_visit")) {
      db.exec("CREATE INDEX IF NOT EXISTS visits_date ON visits (last_visit)");
    }
    if (has("table", "texts")) db.exec(FTS);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * `historique.sqlite` → `history.sqlite`. The schema is migrated in place first (WAL folded back into the file), then
 * the file renamed. A database that does not open or migrate is left and listed; one already at the new name too.
 */
export async function migrateHistory(ctx: Ctx): Promise<void> {
  const old = join(ctx.dataDir, "historique.sqlite");
  const fresh = join(ctx.dataDir, "history.sqlite");
  if ((await kind(old)) === null) return;
  if ((await kind(old)) !== "file") return void ctx.unreadable.push(rel(ctx, old));
  if ((await kind(fresh)) !== null) return void ctx.conflicts.push(rel(ctx, old));
  try {
    const db = new DatabaseSync(old);
    try {
      migrateSchema(db);
      db.exec("PRAGMA journal_mode = DELETE");
    } finally {
      db.close();
    }
  } catch {
    return void ctx.unreadable.push(rel(ctx, old));
  }
  await ctx.checkpoint("history schema");
  await rename(old, fresh);
  for (const s of ["-wal", "-shm", "-journal"]) await rm(old + s, { force: true });
  ctx.changed++;
  await ctx.checkpoint(fresh);
}
