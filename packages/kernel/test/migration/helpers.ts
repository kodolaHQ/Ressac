import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DockerRunner } from "../../src/migration/index.js";
import { tempFolder } from "../helpers/temp.js";

export const FIXTURE = join(import.meta.dirname, "fixtures", "v1");

/** The old browsing history (schema of before the English formats), with its FTS index and triggers. */
export function oldHistory(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE visites (url TEXT NOT NULL, espace_id TEXT NOT NULL, titre TEXT NOT NULL, derniere_visite TEXT NOT NULL,
      visites INTEGER NOT NULL DEFAULT 1, prive INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (url, espace_id));
    CREATE INDEX visites_date ON visites (derniere_visite);
    CREATE TABLE textes (id INTEGER PRIMARY KEY, url TEXT NOT NULL, espace_id TEXT NOT NULL, titre TEXT NOT NULL,
      date TEXT NOT NULL, texte TEXT NOT NULL, octets INTEGER NOT NULL, UNIQUE (url, espace_id));
    CREATE INDEX textes_date ON textes (date);
    CREATE INDEX textes_espace ON textes (espace_id);
    CREATE VIRTUAL TABLE textes_fts USING fts5(titre, url, texte, content = 'textes', content_rowid = 'id', tokenize = "unicode61 remove_diacritics 2");
    CREATE TRIGGER textes_ajout AFTER INSERT ON textes BEGIN
      INSERT INTO textes_fts (rowid, titre, url, texte) VALUES (new.id, new.titre, new.url, new.texte);
    END;
    CREATE TRIGGER textes_retrait AFTER DELETE ON textes BEGIN
      INSERT INTO textes_fts (textes_fts, rowid, titre, url, texte) VALUES ('delete', old.id, old.titre, old.url, old.texte);
    END;
    CREATE TRIGGER textes_maj AFTER UPDATE ON textes BEGIN
      INSERT INTO textes_fts (textes_fts, rowid, titre, url, texte) VALUES ('delete', old.id, old.titre, old.url, old.texte);
      INSERT INTO textes_fts (rowid, titre, url, texte) VALUES (new.id, new.titre, new.url, new.texte);
    END;
    INSERT INTO visites VALUES ('https://un.test/', 'perso', 'Page un', '2026-11-01T00:00:00.000Z', 3, 0);
    INSERT INTO visites VALUES ('https://deux.test/', '', 'Page deux', '2026-11-02T00:00:00.000Z', 1, 1);
    INSERT INTO textes (url, espace_id, titre, date, texte, octets) VALUES ('https://un.test/', 'perso', 'Page un', '2026-11-01T00:00:00.000Z', 'Le contenu secret de la page avec des crêpes', 44);`);
  db.close();
}

/** A data folder in old formats inside a fresh root (`root/data`), next to a file the migration must never touch. */
export async function oldDataDir(marker: object | null = { store: 2, kernel: 1 }): Promise<{ root: string; dataDir: string }> {
  const root = await tempFolder();
  const dataDir = join(root, "data");
  cpSync(FIXTURE, dataDir, { recursive: true });
  oldHistory(join(dataDir, "historique.sqlite"));
  // Outside the data folder, in an old format, reachable only through a link.
  writeFileSync(join(root, "outside.json"), JSON.stringify({ nom: "dehors", adresse: "https://dehors.test/" }));
  mkdirSync(join(dataDir, "espace", "sites", "lien"), { recursive: true });
  symlinkSync(join(root, "outside.json"), join(dataDir, "espace", "sites", "lien", "site.json"));
  if (marker) writeFileSync(join(dataDir, ".format-version"), JSON.stringify(marker));
  return { root, dataDir };
}

/** Fake docker: the Firefox workshop container and the old image exist until removed. */
export function fakeDocker(o: { fail?: boolean } = {}): DockerRunner & { calls: string[] } {
  const present = new Set(["webaios-atelier-firefox", "webaios-atelier:1"]);
  const calls: string[] = [];
  const run = (async (args: string[]) => {
    calls.push(args.join(" "));
    const name = args[args.length - 1]!;
    if (args[1] === "inspect") return present.has(name) ? { code: 0, stdout: "[]", stderr: "" } : { code: 1, stdout: "", stderr: `Error: No such object: ${name}` };
    if (o.fail) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    present.delete(name);
    return { code: 0, stdout: "", stderr: "" };
  }) as DockerRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

function sqliteDump(file: string): string {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '%fts_%' ORDER BY name").all();
    const rows = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%fts%'").all() as { name: string }[]).map((t) =>
      db.prepare(`SELECT * FROM ${t.name} ORDER BY 1, 2`).all(),
    );
    return JSON.stringify({ objects, rows });
  } finally {
    db.close();
  }
}

/** Every path under `folder` with a digest of its content (a link: its target; a database: its schema and rows). */
export function snapshot(folder: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(folder, prefix)).sort()) {
    const rel = join(prefix, name);
    const p = join(folder, rel);
    const s = lstatSync(p);
    if (s.isSymbolicLink()) out[rel] = `link:${readlinkSync(p).split("/").pop()}`;
    else if (s.isDirectory()) Object.assign(out, { [rel + "/"]: "dir" }, snapshot(folder, rel));
    else if (name.endsWith(".sqlite")) out[rel] = sqliteDump(p);
    else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
  }
  return out;
}

export const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
