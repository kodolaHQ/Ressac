import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheminsEspace, type EtatAccueil } from "@webaios/noyau";
import type { EtatNavigateur } from "../../src/commun/modele";
import {
  CSP_WIDGET,
  permissionInterface,
  placerWidgets,
  profilsPourAccord,
  repondreWidget,
  retirerWidget,
  urlOuvrable,
  versWidgetsAffiches,
  navigationCadrePermise,
  widgetDuCadre,
} from "../../src/main/agent/accueil";

function espace(ids: string[]) {
  const c = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-")));
  for (const id of ids) {
    mkdirSync(join(c.widgets, id), { recursive: true });
    writeFileSync(join(c.widgets, id, "widget.json"), `{"nom":"${id}"}`);
  }
  return c;
}
const dispositionLue = (c: ReturnType<typeof espace>) => JSON.parse(readFileSync(c.disposition, "utf8"));

test("webaios-widget sert affichage.html avec la CSP sans réseau, refuse tout autre chemin et les liens symboliques sortants", async () => {
  const c = espace(["meteo", "lien", "dossier-lien"]);
  writeFileSync(join(c.widgets, "meteo", "affichage.html"), "<p>météo</p>");
  writeFileSync(join(c.widgets, "meteo", "recolte.mjs"), "export default 1");

  const ok = await repondreWidget(c.widgets, "webaios-widget://meteo/affichage.html?v=12");
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("<p>météo</p>"); // pas de <base> : les liens passent par postMessage
  expect(ok.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(ok.headers.get("Content-Security-Policy")).toBe(CSP_WIDGET);
  expect(CSP_WIDGET).toBe(
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'",
  );

  for (const url of [
    "webaios-widget://meteo/recolte.mjs",
    "webaios-widget://meteo/widget.json",
    "webaios-widget://meteo/../meteo/affichage.html/x",
    "webaios-widget://Meteo_X/affichage.html",
    "webaios-widget://../affichage.html",
    "webaios-bloc://meteo/affichage.html",
    "https://meteo/affichage.html",
    "pas une url",
  ]) {
    expect((await repondreWidget(c.widgets, url)).status, url).toBe(404);
  }

  // Lien symbolique vers un fichier du Mac, ou dossier de widget qui est un lien vers l'extérieur.
  const dehors = mkdtempSync(join(tmpdir(), "webaios-secret-"));
  writeFileSync(join(dehors, "affichage.html"), "secret");
  symlinkSync(join(dehors, "affichage.html"), join(c.widgets, "lien", "affichage.html"));
  symlinkSync(dehors, join(c.widgets, "sortant"));
  for (const url of ["webaios-widget://lien/affichage.html", "webaios-widget://sortant/affichage.html", "webaios-widget://dossier-lien/affichage.html"]) {
    const r = await repondreWidget(c.widgets, url);
    expect(r.status, url).toBe(404);
    expect(await r.text()).not.toContain("secret");
  }
  // Le dossier des widgets lui-même est un lien vers l'extérieur : rien n'est servi.
  const c2 = cheminsEspace(mkdtempSync(join(tmpdir(), "webaios-accueil-")));
  mkdirSync(join(dehors, "w", "x"), { recursive: true });
  writeFileSync(join(dehors, "w", "x", "affichage.html"), "secret");
  mkdirSync(c2.accueil, { recursive: true });
  symlinkSync(join(dehors, "w"), c2.widgets);
  expect((await repondreWidget(c2.widgets, "webaios-widget://x/affichage.html")).status).toBe(404);
  // Noyau pas prêt : rien n'est servi.
  expect((await repondreWidget(null, "webaios-widget://meteo/affichage.html")).status).toBe(404);
});

test("placer refuse un placement hors grille ou un id inconnu", async () => {
  const c = espace(["a", "b"]);
  await placerWidgets(c, [
    { id: "a", x: 0, y: 0, l: 4, h: 2 },
    { id: "b", x: 4, y: 0, l: 8, h: 3 },
  ]);
  const attendu = { version: 2, widgets: [{ id: "a", x: 0, y: 0, l: 4, h: 2 }, { id: "b", x: 4, y: 0, l: 8, h: 3 }] };
  expect(dispositionLue(c)).toEqual(attendu);
  expect(readdirSync(c.accueil).filter((f) => f.endsWith(".tmp"))).toEqual([]);

  const refuses: unknown[][] = [
    [{ id: "a", x: 9, y: 0, l: 4, h: 2 }], // déborde des 12 colonnes
    [{ id: "a", x: -1, y: 0, l: 4, h: 2 }],
    [{ id: "a", x: 0, y: 0, l: 13, h: 2 }],
    [{ id: "a", x: 0, y: 0, l: 0, h: 2 }],
    [{ id: "a", x: 0.5, y: 0, l: 4, h: 2 }],
    [{ id: "a", x: 0, y: 0, l: 4, h: 2 }, { id: "a", x: 4, y: 0, l: 4, h: 2 }], // doublon
    [{ id: "inconnu", x: 0, y: 0, l: 4, h: 2 }],
    [{ id: "../x", x: 0, y: 0, l: 4, h: 2 }],
    [{ id: "a", x: 0, y: 0, l: 4 }],
  ];
  for (const p of refuses) await expect(placerWidgets(c, p as never), JSON.stringify(p)).rejects.toThrow();
  expect(dispositionLue(c)).toEqual(attendu);
});

test("retirer met le widget dans .corbeille, intact, le retire de la disposition et oublie son accord", async () => {
  const c = espace(["a", "b"]);
  await placerWidgets(c, [
    { id: "a", x: 0, y: 0, l: 4, h: 2 },
    { id: "b", x: 4, y: 0, l: 4, h: 2 },
  ]);
  const oublies: string[] = [];
  await retirerWidget(c, "b", async (id) => void oublies.push(id));
  expect(existsSync(join(c.widgets, "b"))).toBe(false);
  const [range] = readdirSync(join(c.accueil, ".corbeille"));
  expect(range).toMatch(/^b-\d+$/);
  expect(readFileSync(join(c.accueil, ".corbeille", range!, "widget.json"), "utf8")).toBe('{"nom":"b"}');
  expect(dispositionLue(c).widgets).toEqual([{ id: "a", x: 0, y: 0, l: 4, h: 2 }]);
  expect(oublies).toEqual(["b"]);
  await expect(retirerWidget(c, "../a", async () => {})).rejects.toThrow();
  expect(existsSync(join(c.widgets, "a"))).toBe(true);
});

test("placer et retirer en même temps : chaque écriture aboutit, dans l'ordre des demandes", async () => {
  const c = espace(["a", "b"]);
  const p = (id: string, x: number) => ({ id, x, y: 0, l: 2, h: 2 });
  await Promise.all([placerWidgets(c, [p("a", 0), p("b", 2)]), placerWidgets(c, [p("a", 4), p("b", 6)]), retirerWidget(c, "b", async () => {})]);
  expect(dispositionLue(c).widgets).toEqual([p("a", 4)]);
});

test("profilsPourAccord n'offre pas un profil d'espace privé et coche celui de l'espace actif", () => {
  const etat = {
    profils: [{ id: "defaut" }, { id: "travail" }, { id: "secret" }, { id: "mixte" }, { id: "seul" }],
    espaces: [
      { id: "e1", nom: "Perso", profil: "defaut", prive: false },
      { id: "e2", nom: "Travail", profil: "travail", prive: false },
      { id: "e3", nom: "Clients", profil: "travail", prive: false },
      { id: "e4", nom: "Secret", profil: "secret", prive: true },
      { id: "e5", nom: "Ouvert", profil: "mixte", prive: false },
      { id: "e6", nom: "Caché", profil: "mixte", prive: true },
    ],
    fenetres: [
      { id: "f1", espaceActif: "e3" },
      { id: "f2", espaceActif: "e4" },
    ],
  } as unknown as EtatNavigateur;
  expect(profilsPourAccord(etat, "f1")).toEqual([
    { id: "defaut", libelle: "Profil de « Perso »", parDefaut: false },
    { id: "travail", libelle: "Profil de « Travail, Clients »", parDefaut: true },
    { id: "seul", libelle: "Profil « seul »", parDefaut: false },
  ]);
  // Espace actif privé : son profil n'est pas offert, rien n'est coché.
  expect(profilsPourAccord(etat, "f2").map((p) => p.parDefaut)).toEqual([false, false, false]);
  expect(profilsPourAccord(etat, undefined).some((p) => p.parDefaut)).toBe(false);
});

test("ouvrir refuse javascript: et file:", () => {
  expect(urlOuvrable("https://news.ycombinator.com/item?id=1")).toBe(true);
  expect(urlOuvrable("http://exemple.test/")).toBe(true);
  // Ni la machine ni le réseau local : l'agent y écoute (ports des applis), un lien porterait les données jusqu'à lui.
  for (const url of ["http://127.0.0.1:5280/?d=x", "http://localhost:5280/", "http://[::1]/", "http://192.168.1.2/", "http://10.0.0.1/", "http://0.0.0.0:8008/"]) {
    expect(urlOuvrable(url), url).toBe(false);
  }
  for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", "file:///etc/passwd", "data:text/html,x", "webaios-widget://a/affichage.html", "about:blank", "pas une url", ""]) {
    expect(urlOuvrable(url), url).toBe(false);
  }
});

test("versWidgetsAffiches : placement, src versionnée, données, exemple, état et domaines du compte ; widget illisible placé quand même", () => {
  const etat: EtatAccueil = {
    disposition: [{ id: "meteo", x: 0, y: 0, l: 3, h: 2 }],
    widgets: [
      {
        id: "meteo",
        dossier: "/w/meteo",
        declaration: {
          nom: "Météo",
          description: "",
          tailles: { min: { l: 2, h: 2 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } },
          sources: { compte: ["mail.exemple.test"], publiques: ["meteo.exemple.test"] },
        },
        etat: { statut: "ok", derniereMaj: "2026-10-28T08:00:00.000Z", derniereTentative: null },
        donnees: { t: 12 },
        exemple: { t: 0 },
        aRecolte: true,
        aAffichage: true,
      },
      {
        id: "vide",
        dossier: "/w/vide",
        declaration: {
          nom: "Vide",
          description: "",
          tailles: { min: { l: 2, h: 2 }, max: { l: 6, h: 4 }, defaut: { l: 2, h: 2 } },
          sources: { compte: [], publiques: [] },
        },
        etat: { statut: "ok", derniereMaj: null, derniereTentative: null },
        donnees: null,
        exemple: null,
        aRecolte: false,
        aAffichage: false,
      },
      { id: "casse", dossier: "/w/casse", erreur: "widget.json invalide : x" },
    ],
  };
  const affiches = versWidgetsAffiches(etat, { meteo: 42 });
  expect(affiches[0]).toEqual({
    id: "meteo",
    nom: "Météo",
    placement: { id: "meteo", x: 0, y: 0, l: 3, h: 2 },
    tailles: { min: { l: 2, h: 2 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } },
    src: "webaios-widget://meteo/affichage.html?v=42",
    donnees: { t: 12 },
    exemple: { t: 0 },
    etat: { statut: "ok", derniereMaj: "2026-10-28T08:00:00.000Z", derniereTentative: null },
    compte: ["mail.exemple.test"],
    publiques: ["meteo.exemple.test"],
  });
  expect(affiches.find((w) => w.id === "vide")).toMatchObject({ src: null, donnees: null, exemple: null });
  const casse = affiches.find((w) => w.id === "casse");
  expect(casse).toMatchObject({ erreur: "widget.json invalide : x" });
  expect(casse?.placement).toMatchObject({ id: "casse" });
  // Aucun chevauchement entre les placements rendus.
  const ps = affiches.map((w) => w.placement);
  for (const a of ps) for (const b of ps) if (a !== b) expect(a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
});

test("permissionInterface : rien pour un affichage de widget ni pour un cadre de l'interface ; la page de l'interface garde ses droits", () => {
  expect(permissionInterface({ requestingUrl: "webaios-widget://meteo/affichage.html", isMainFrame: false })).toBe(false);
  expect(permissionInterface({ requestingUrl: "webaios-widget://meteo/affichage.html", isMainFrame: true })).toBe(false);
  expect(permissionInterface({ requestingUrl: "about:srcdoc", isMainFrame: false })).toBe(false);
  expect(permissionInterface({ requestingUrl: "file:///app/out/renderer/index.html", isMainFrame: true })).toBe(true);
  expect(permissionInterface({ requestingUrl: "http://localhost:5173/", isMainFrame: true })).toBe(true);
  expect(permissionInterface({ requestingUrl: "", isMainFrame: undefined })).toBe(false);
});

test("widgetDuCadre : seul l'affichage d'un widget donne son id", () => {
  expect(widgetDuCadre("webaios-widget://meteo/affichage.html?v=12")).toBe("meteo");
  expect(widgetDuCadre("webaios-widget://meteo/autre.html")).toBeNull();
  expect(widgetDuCadre("webaios-widget://Meteo_1/affichage.html")).toBeNull();
  expect(widgetDuCadre("https://meteo/affichage.html")).toBeNull();
  expect(widgetDuCadre("chrome-error://chromewebdata/")).toBeNull();
  expect(widgetDuCadre("pas une url")).toBeNull();
});

test("navigationCadrePermise : un cadre ne va que vers l'affichage de son propre widget", () => {
  const meteo = "webaios-widget://meteo/affichage.html?v=1";
  expect(navigationCadrePermise("", meteo)).toBe(true);
  expect(navigationCadrePermise("about:blank", meteo)).toBe(true);
  expect(navigationCadrePermise("webaios-widget://meteo/affichage.html?v=0", meteo)).toBe(true);
  expect(navigationCadrePermise("chrome-error://chromewebdata/", meteo)).toBe(true);
  expect(navigationCadrePermise("webaios-widget://actus/affichage.html?v=0", meteo)).toBe(false);
  expect(navigationCadrePermise("webaios-widget://meteo/affichage.html", "https://exemple.test/")).toBe(false);
  expect(navigationCadrePermise("", "data:text/html,x")).toBe(false);
  expect(navigationCadrePermise("", "webaios-widget://meteo/autre.html")).toBe(false);
});
