import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Visite } from "../commun/modele";

export type { Visite };

const COLONNES = "url, titre, derniere_visite AS derniereVisite, visites";

/** Minuscules sans accents : « Été » et « ete » se retrouvent (LIKE de SQLite ne plie que l'ASCII). */
const plier = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Historique de navigation : une ligne par URL, dans `<profil>/historique.sqlite`. */
export class Historique {
  private db: DatabaseSync;
  private req: Record<"noter" | "majTitre" | "rechercher" | "recents" | "effacerDepuis" | "toutEffacer", StatementSync>;

  constructor(chemin: string) {
    mkdirSync(dirname(chemin), { recursive: true });
    this.db = new DatabaseSync(chemin);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS visites (
        url TEXT PRIMARY KEY,
        titre TEXT NOT NULL,
        derniere_visite TEXT NOT NULL,
        visites INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS visites_date ON visites (derniere_visite);
    `);
    this.db.function("plier", { deterministic: true }, (s) => plier(String(s)));
    this.req = {
      noter: this.db.prepare(`
        INSERT INTO visites (url, titre, derniere_visite) VALUES (?, ?, ?)
        ON CONFLICT (url) DO UPDATE SET titre = excluded.titre, derniere_visite = excluded.derniere_visite, visites = visites + 1`),
      majTitre: this.db.prepare("UPDATE visites SET titre = ? WHERE url = ?"),
      rechercher: this.db.prepare(`
        SELECT ${COLONNES} FROM visites
        WHERE plier(url) LIKE ? ESCAPE '\\' OR plier(titre) LIKE ? ESCAPE '\\'
        ORDER BY visites DESC, derniere_visite DESC LIMIT ?`),
      recents: this.db.prepare(`SELECT ${COLONNES} FROM visites ORDER BY derniere_visite DESC LIMIT ?`),
      effacerDepuis: this.db.prepare("DELETE FROM visites WHERE derniere_visite >= ?"),
      toutEffacer: this.db.prepare("DELETE FROM visites"),
    };
  }

  noter(v: { url: string; titre: string; date?: Date }): void {
    if (!this.db.isOpen) return; // une page peut encore naviguer pendant la sortie
    this.req.noter.run(v.url, v.titre, (v.date ?? new Date()).toISOString());
  }

  /** Le titre arrive souvent après la navigation : il complète la visite sans en compter une nouvelle. */
  majTitre(url: string, titre: string): void {
    if (!this.db.isOpen) return;
    this.req.majTitre.run(titre, url);
  }

  /** Sous-chaîne insensible à la casse et aux accents sur l'URL et le titre ; `%`, `_` et `\` sont littéraux. */
  rechercher(texte: string, limite = 50): Visite[] {
    if (!this.db.isOpen) return [];
    const motif = `%${plier(texte).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.req.rechercher.all(motif, motif, limite) as unknown as Visite[];
  }

  recents(limite = 100): Visite[] {
    if (!this.db.isOpen) return [];
    return this.req.recents.all(limite) as unknown as Visite[];
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
