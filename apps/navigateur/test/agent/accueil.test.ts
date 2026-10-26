import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheminsEspace, type EtatAccueil } from "@webaios/noyau";
import { avecBase, cheminBloc, lireHtmlBloc, ordonnerBlocs, protegerWebviews, retirerBloc, versBlocsAffiches } from "../../src/main/agent/accueil";

function espace(ids: string[]) {
  const c = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-")));
  for (const id of ids) {
    mkdirSync(join(c.blocs, id), { recursive: true });
    writeFileSync(join(c.blocs, id, "bloc.json"), `{"id":"${id}"}`);
  }
  return c;
}
const ordreLu = (c: ReturnType<typeof espace>) => JSON.parse(readFileSync(c.disposition, "utf8")).ordre;

const etat: EtatAccueil = {
  ordre: ["app", "veille", "vide", "casse"],
  blocs: [
    { id: "veille", dossier: "/b/veille", config: { titre: "Veille", type: "agent", consigne: "c" }, etat: { derniereMaj: "2026-10-26T08:00:00.000Z", derniereTentative: null, statut: "erreur", erreur: "délai" }, cheminHtml: "/b/veille/index.html" },
    { id: "app", dossier: "/b/app", config: { titre: "daily.dev", type: "app", url: "https://app.daily.dev" }, etat: { derniereMaj: null, derniereTentative: null, statut: "ok" }, cheminHtml: null },
    { id: "vide", dossier: "/b/vide", config: { titre: "Vide", type: "agent", consigne: "c" }, etat: { derniereMaj: null, derniereTentative: null, statut: "en-cours" }, cheminHtml: null },
    { id: "casse", dossier: "/b/casse", erreur: "bloc.json invalide : x" },
  ],
};

test("versBlocsAffiches : ordre de disposition, src versionnée, statuts, bloc illisible", () => {
  expect(versBlocsAffiches(etat, { veille: 42 })).toEqual([
    { id: "app", titre: "daily.dev", type: "app", url: "https://app.daily.dev" },
    { id: "veille", titre: "Veille", type: "agent", src: "webaios-bloc://veille/index.html?v=42", statut: "erreur", derniereMaj: "2026-10-26T08:00:00.000Z", derniereTentative: null, erreur: "délai" },
    { id: "vide", titre: "Vide", type: "agent", src: null, statut: "en-cours", derniereMaj: null, derniereTentative: null },
    { id: "casse", erreur: "bloc.json invalide : x" },
  ]);
});

test("cheminBloc : seulement <blocs>/<id>/index.html, id en kebab-case", () => {
  expect(cheminBloc("/b", "webaios-bloc://veille/index.html?v=1")).toBe("/b/veille/index.html");
  expect(cheminBloc("/b", "webaios-bloc://../index.html")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://veille/bloc.json")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://Veille_X/index.html")).toBeNull();
  expect(cheminBloc("/b", "webaios-bloc://veille/../../etc/index.html")).toBeNull();
  expect(cheminBloc("/b", "https://veille/index.html")).toBeNull();
});

test("avecBase : les liens du bloc visent une nouvelle fenêtre, sans casser le doctype", () => {
  expect(avecBase('<html><head lang="fr"><title>x</title></head></html>')).toBe('<html><head lang="fr"><base target="_blank"><title>x</title></head></html>');
  expect(avecBase("<!doctype html><p>a</p>")).toBe('<!doctype html><base target="_blank"><p>a</p>');
  expect(avecBase("<p>a</p>")).toBe('<base target="_blank"><p>a</p>');
});

test("ordonnerBlocs écrit l'ordre et ignore un id inconnu", async () => {
  const c = espace(["a", "b"]);
  await ordonnerBlocs(c, ["b", "inconnu", "a"]);
  expect(ordreLu(c)).toEqual(["b", "a"]);
  expect(readdirSync(c.accueil).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("retirerBloc déplace le dossier dans .corbeille, intact, et le retire de la disposition", async () => {
  const c = espace(["a", "b"]);
  await ordonnerBlocs(c, ["b", "a"]);
  await retirerBloc(c, "b");
  expect(existsSync(join(c.blocs, "b"))).toBe(false);
  const [range] = readdirSync(join(c.accueil, ".corbeille"));
  expect(range).toMatch(/^b-\d+$/);
  expect(readFileSync(join(c.accueil, ".corbeille", range!, "bloc.json"), "utf8")).toBe('{"id":"b"}');
  expect(ordreLu(c)).toEqual(["a"]);
});

test("retirerBloc refuse un id invalide", async () => {
  const c = espace(["a"]);
  await expect(retirerBloc(c, "../x")).rejects.toThrow();
  expect(existsSync(join(c.blocs, "a"))).toBe(true);
});

test("lireHtmlBloc : le HTML du bloc avec sa base ; rien pour un lien symbolique qui sort du dossier des blocs", async () => {
  const c = espace(["a", "b", "c"]);
  writeFileSync(join(c.blocs, "a", "index.html"), "<p>a</p>");
  expect(await lireHtmlBloc(c.blocs, "webaios-bloc://a/index.html?v=1")).toBe('<base target="_blank"><p>a</p>');
  const dehors = join(mkdtempSync(join(tmpdir(), "webaios-secret-")), "secret.txt");
  writeFileSync(dehors, "secret");
  symlinkSync(dehors, join(c.blocs, "b", "index.html"));
  expect(await lireHtmlBloc(c.blocs, "webaios-bloc://b/index.html")).toBeNull();
  symlinkSync(join(dehors, ".."), join(c.blocs, "d"));
  writeFileSync(join(dehors, "..", "index.html"), "secret");
  expect(await lireHtmlBloc(c.blocs, "webaios-bloc://d/index.html")).toBeNull();
  expect(await lireHtmlBloc(c.blocs, "webaios-bloc://c/index.html")).toBeNull(); // pas encore de HTML
});

test("ordonner et retirer en même temps : chaque écriture aboutit, dans l'ordre des demandes", async () => {
  const c = espace(["a", "b", "c"]);
  await Promise.all([ordonnerBlocs(c, ["a", "b", "c"]), ordonnerBlocs(c, ["c", "b", "a"]), retirerBloc(c, "b")]);
  expect(ordreLu(c)).toEqual(["c", "a"]);
  expect(readdirSync(c.accueil).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("protegerWebviews : une vue d'app n'a ni preload, ni Node, ni sécurité web désactivée", () => {
  const ui = new EventEmitter();
  protegerWebviews(ui as unknown as WebContents, () => {});
  const prefs: Record<string, unknown> = { preload: "/x.js", nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true };
  let refusee = false;
  ui.emit("will-attach-webview", { preventDefault: () => (refusee = true) }, prefs, { src: "https://app.daily.dev", partition: "persist:webaios" });
  expect(refusee).toBe(false);
  expect(prefs).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false });
});
