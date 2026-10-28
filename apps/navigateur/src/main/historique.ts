import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Visite } from "../commun/modele";

export type { Visite };

const COLONNES = "url, titre, derniere_visite AS derniereVisite, visites, espace_id AS espaceId, prive, 0 AS retenu";

/** Minuscules sans accents : « Été » et « ete » se retrouvent (LIKE de SQLite ne plie que l'ASCII). */
const plier = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Historique de navigation : une ligne par URL et par espace, dans `<profil>/historique.sqlite`. */
export class Historique {
  private db: DatabaseSync;
  private req: Record<"noter" | "majTitre" | "rechercher" | "recents" | "effacerDepuis" | "toutEffacer" | "rendrePrive", StatementSync>;

  constructor(chemin: string) {
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
      recents: this.db.prepare(`SELECT ${COLONNES} FROM visites ORDER BY derniere_visite DESC LIMIT ?`),
      effacerDepuis: this.db.prepare("DELETE FROM visites WHERE derniere_visite >= ?"),
      toutEffacer: this.db.prepare("DELETE FROM visites"),
      rendrePrive: this.db.prepare("UPDATE visites SET prive = 1 WHERE espace_id = ?"),
    };
  }

  /** Crée la table, ou migre l'ancienne (clé `url` seule) : lignes gardées, espace `""` (aucun), non privées. */
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
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  noter(v: { url: string; titre: string; espaceId: string; prive: boolean; date?: Date }): void {
    if (!this.db.isOpen) return; // une page peut encore naviguer pendant la sortie
    this.req.noter.run(v.url, v.espaceId, v.titre, (v.date ?? new Date()).toISOString(), v.prive ? 1 : 0);
  }

  /** Le titre arrive souvent après la navigation : il complète la visite sans en compter une nouvelle. */
  majTitre(url: string, espaceId: string, titre: string): void {
    if (!this.db.isOpen) return;
    this.req.majTitre.run(titre, url, espaceId);
  }

  /** L'espace est devenu privé : toutes ses visites déjà notées le deviennent. */
  rendrePrive(espaceId: string): void {
    if (!this.db.isOpen) return;
    this.req.rendrePrive.run(espaceId);
  }

  /** Sous-chaîne insensible à la casse et aux accents sur l'URL et le titre ; `%`, `_` et `\` sont littéraux. */
  rechercher(texte: string, limite = 50, distinctes = false): Visite[] {
    if (!this.db.isOpen) return [];
    const motif = `%${plier(texte).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (!distinctes) return this.lignes(this.req.rechercher.all(motif, motif, limite));
    // Une seule ligne par URL (la mieux classée) : le LIMIT SQL compterait les doublons d'espaces.
    const vues = new Set<string>();
    return this.lignes(this.req.rechercher.all(motif, motif, -1))
      .filter((v) => !vues.has(v.url) && vues.add(v.url))
      .slice(0, limite);
  }

  recents(limite = 100): Visite[] {
    if (!this.db.isOpen) return [];
    return this.lignes(this.req.recents.all(limite));
  }

  private lignes(brutes: Record<string, unknown>[]): Visite[] {
    return brutes.map((l) => ({ ...l, prive: l.prive === 1, retenu: false }) as unknown as Visite);
  }

  effacer(depuis?: Date): void {
    if (!this.db.isOpen) return;
    if (depuis) this.req.effacerDepuis.run(depuis.toISOString());
    else this.req.toutEffacer.run();
  }

  fermer(): void {
    if (this.db.isOpen) this.db.close();
  }
}
