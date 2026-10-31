import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({ session: {}, shell: {}, BrowserWindow: class {}, WebContentsView: class {}, screen: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { MemoireApplications } = await import("../../src/main/applications/service");

test("le fichier par défaut reste applications.json", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "memoire-apps-"));
  const m = new MemoireApplications(dossier, 10);
  m.noter("essai", { favicon: "data:x" });
  await m.vider();
  expect(JSON.parse(readFileSync(join(dossier, "applications.json"), "utf8"))).toEqual({ essai: { favicon: "data:x" } });
});

test("les applis de site ont leur propre fichier (sites.json), relu au démarrage", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "memoire-sites-"));
  writeFileSync(join(dossier, "applications.json"), JSON.stringify({ vidola: { favicon: "data:appli" } }));
  const m = new MemoireApplications(dossier, 10, "sites.json");
  expect(m.lire("vidola")).toEqual({});
  m.noter("vidola", { cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } });
  await m.vider();
  expect(JSON.parse(readFileSync(join(dossier, "sites.json"), "utf8"))).toEqual({ vidola: { cadre: { x: 1, y: 2, largeur: 3, hauteur: 4 } } });
  expect(JSON.parse(readFileSync(join(dossier, "applications.json"), "utf8"))).toEqual({ vidola: { favicon: "data:appli" } });
  expect(new MemoireApplications(dossier, 10, "sites.json").lire("vidola").cadre).toEqual({ x: 1, y: 2, largeur: 3, hauteur: 4 });
  expect(existsSync(join(dossier, "sites.json"))).toBe(true);
});

test("une appli nommée « constructor » n'hérite de rien", () => {
  const dossier = mkdtempSync(join(tmpdir(), "memoire-proto-"));
  expect(new MemoireApplications(dossier, 10, "sites.json").lire("constructor")).toEqual({});
});
