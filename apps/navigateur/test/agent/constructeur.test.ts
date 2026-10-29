import { expect, test } from "vitest";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import type { Action } from "../../src/commun/api";
import type { EtatNavigateur } from "../../src/commun/modele";
import { FileEcritures, workflowOuvertDe } from "../../src/main/agent/constructeur";

function preparer(url: string) {
  let n = 0;
  const g = () => `g${++n}`;
  let e: EtatNavigateur = etatInitial(g);
  const ag = (a: Action) => (e = appliquer(e, a, g));
  const F = e.fenetres[0]!.id;
  ag({ type: "ouvrirOnglet", fenetreId: F, url });
  return { e: () => e, F };
}

test("workflowOuvertDe rend le widget de l'onglet actif et le bloc sélectionné", () => {
  const { e, F } = preparer("webaios://workflow/gmail");
  const selections = new Map([[F, { widget: "gmail", bloc: "trier" }]]);
  expect(workflowOuvertDe(e(), selections, F)).toEqual({ widget: "gmail", bloc: "trier" });
});

test("onglet actif qui n'est pas un constructeur : null", () => {
  const { e, F } = preparer("https://a.test/");
  expect(workflowOuvertDe(e(), new Map([[F, { widget: "gmail", bloc: "x" }]]), F)).toBeNull();
  expect(workflowOuvertDe(e(), new Map(), "inconnue")).toBeNull();
});

test("URL de constructeur qui n'en est pas une (../x, #x, ?y) : null, comme pour le canevas", () => {
  for (const url of ["webaios://workflow/../x", "webaios://workflow/gmail#x", "webaios://workflow/gmail?y", "webaios://workflow/"]) {
    const { e, F } = preparer(url);
    expect(workflowOuvertDe(e(), new Map(), F), url).toBeNull();
  }
});

test("sélection d'un autre widget : bloc null", () => {
  const { e, F } = preparer("webaios://workflow/gmail");
  expect(workflowOuvertDe(e(), new Map([[F, { widget: "meteo", bloc: "x" }]]), F)).toEqual({ widget: "gmail", bloc: null });
  expect(workflowOuvertDe(e(), new Map(), F)).toEqual({ widget: "gmail", bloc: null });
});

test("FileEcritures : deux écritures du même widget ne se chevauchent pas, deux widgets si", async () => {
  const file = new FileEcritures();
  const journal: string[] = [];
  let libre!: () => void;
  const porte = new Promise<void>((r) => (libre = r));
  const a = file.enSerie("w1", async () => {
    journal.push("a-debut");
    await porte;
    journal.push("a-fin");
    return 1;
  });
  const b = file.enSerie("w1", async () => {
    journal.push("b-debut");
    return 2;
  });
  const c = file.enSerie("w2", async () => {
    journal.push("c");
    return 3;
  });
  expect(await c).toBe(3);
  await new Promise((r) => setTimeout(r, 5));
  expect(journal).toEqual(["a-debut", "c"]);
  libre();
  expect([await a, await b]).toEqual([1, 2]);
  expect(journal).toEqual(["a-debut", "c", "a-fin", "b-debut"]);
});

test("FileEcritures : une écriture en échec ne bloque pas la suivante", async () => {
  const file = new FileEcritures();
  const a = file.enSerie("w", async () => {
    throw new Error("non");
  });
  await expect(a).rejects.toThrow("non");
  expect(await file.enSerie("w", async () => 7)).toBe(7);
});

test("lireEdition et enregistrerEdition : widget sans récolte null, avertissements du workflow validé, rien d'écrit à la lecture", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cheminsEspace } = await import("@webaios/noyau");
  const { enregistrerEdition, lireEdition } = await import("../../src/main/agent/constructeur");
  const racine = mkdtempSync(join(tmpdir(), "constructeur-"));
  const chemins = cheminsEspace(join(racine, "espace"));
  const dossierWidgets = join(racine, "donnees");
  const dossier = join(chemins.widgets, "meteo");
  mkdirSync(dossier, { recursive: true });
  const decl = { nom: "Météo", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, sources: { compte: ["a.test"], publiques: [] } };
  writeFileSync(join(dossier, "widget.json"), JSON.stringify(decl));
  const c = { chemins, dossierWidgets };
  expect(await lireEdition(c, "meteo")).toBeNull(); // pas de récolte
  expect(await lireEdition(c, "absent")).toBeNull();
  writeFileSync(join(dossier, "recolte.mjs"), "export default 1");
  const e = await lireEdition(c, "meteo");
  expect(e).toMatchObject({ origine: "implicite", widget: { nom: "Météo", compte: ["a.test"], web: false, recolte: null } });
  expect(existsSync(join(dossier, "workflow.json"))).toBe(false);
  const brouillon = {
    version: 1,
    blocs: [
      { id: "page", type: "source.page", position: { x: 0, y: 0 }, parametres: { url: "https://autre.test/x", compte: true } },
      { id: "sortie", type: "sortie", position: { x: 1, y: 0 }, parametres: {} },
    ],
    liens: [{ de: "page", vers: "sortie" }],
  };
  const r = await enregistrerEdition(c, "meteo", brouillon);
  expect(r.ok).toBe(true);
  expect(r.avertissements).toEqual([{ bloc: "page", message: "domaine non déclaré : autre.test" }]);
  expect(existsSync(join(dossier, "workflow.json"))).toBe(true);
  const invalide = await enregistrerEdition(c, "meteo", { version: 1, blocs: [], liens: [] });
  expect(invalide.avertissements).toEqual([]);
});

async function monter(avecRecolte = true) {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cheminsEspace } = await import("@webaios/noyau");
  const racine = mkdtempSync(join(tmpdir(), "constructeur-"));
  const chemins = cheminsEspace(join(racine, "espace"));
  const dossier = join(chemins.widgets, "meteo");
  mkdirSync(dossier, { recursive: true });
  const decl = { nom: "Météo", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, sources: { compte: [], publiques: [] }, config: { ville: "Lyon" } };
  writeFileSync(join(dossier, "widget.json"), JSON.stringify(decl));
  if (avecRecolte) writeFileSync(join(dossier, "recolte.mjs"), "export default 1");
  return { racine, chemins, dossier, c: { chemins, dossierWidgets: join(racine, "donnees") }, join };
}
const page = (extra: object = {}) => ({ id: "page", type: "source.page", position: { x: 0, y: 0 }, parametres: { url: "https://{config.absente}/x" }, ...extra });
const sortie = { id: "sortie", type: "sortie", position: { x: 1, y: 0 }, parametres: {} };

test("lireEdition : workflow.json invalide gardé tel quel, JSON coupé : brut null, config par défaut null, avertissement de config", async () => {
  const { writeFileSync } = await import("node:fs");
  const { lireEdition } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  writeFileSync(m.join(m.dossier, "workflow.json"), '{"version":1,"blocs":[{"id":"a"');
  const coupe = await lireEdition(m.c, "meteo");
  expect(coupe).toMatchObject({ origine: "fichier", brut: null, avertissements: [], validation: { ok: false } });
  const valide = { version: 1, blocs: [page(), sortie], liens: [{ de: "page", vers: "sortie" }] };
  writeFileSync(m.join(m.dossier, "workflow.json"), JSON.stringify(valide));
  const e = await lireEdition(m.c, "meteo");
  expect(e?.avertissements).toEqual([{ bloc: "page", message: "config.absente absent de la configuration du widget" }]);
  expect(e?.widget.config).toEqual({ ville: "Lyon" });
});

test("lireEdition et enregistrerEdition valident selon le widget (durée maximale) et signalent une sortie au fil de l'eau sans chaîne", async () => {
  const { writeFileSync } = await import("node:fs");
  const { AVERTISSEMENT_FIL_DE_L_EAU } = await import("@webaios/noyau");
  const { enregistrerEdition, lireEdition } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  const flux = { id: "flux", type: "source.flux", position: { x: 0, y: 0 }, parametres: { urls: ["https://x.test/rss"] } };
  const fiche = { id: "fiche", type: "source.page", position: { x: 1, y: 0 }, parametres: { url: "https://x.test/{url}", parElement: true, budgetSecondes: 600 } };
  const fil = { id: "sortie", type: "sortie", position: { x: 2, y: 0 }, parametres: { auFilDeLEau: true } };
  const long = { version: 1, blocs: [flux, fiche, fil], liens: [{ de: "flux", vers: "fiche" }, { de: "fiche", vers: "sortie" }] };
  // Sans durée maximale déclarée : 170 s au plus.
  expect(await enregistrerEdition(m.c, "meteo", long)).toMatchObject({ ok: false, bloc: "fiche", erreur: expect.stringContaining("fiche.budgetSecondes : 170 au plus") });

  const decl = { nom: "Météo", tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } }, recolte: { minutes: 60, dureeMaxMinutes: 30 } };
  writeFileSync(m.join(m.dossier, "widget.json"), JSON.stringify(decl));
  expect(await enregistrerEdition(m.c, "meteo", long)).toEqual({ ok: true, ecrit: true, memoireEffacee: [], avertissements: [] });
  expect(await lireEdition(m.c, "meteo")).toMatchObject({ validation: { ok: true }, avertissements: [] });

  const sansChaine = { version: 1, blocs: [flux, fil], liens: [{ de: "flux", vers: "sortie" }] };
  const r = await enregistrerEdition(m.c, "meteo", sansChaine);
  expect(r).toMatchObject({ ok: true, avertissements: [{ bloc: "sortie", message: AVERTISSEMENT_FIL_DE_L_EAU }] });
  expect((await lireEdition(m.c, "meteo"))?.avertissements).toEqual([{ bloc: "sortie", message: AVERTISSEMENT_FIL_DE_L_EAU }]);
});

test("lireEdition : accès au web et récolte du widget ; web.chercher sans durée maximale avertit", async () => {
  const { writeFileSync } = await import("node:fs");
  const { AVERTISSEMENT_WEB_SANS_DUREE } = await import("@webaios/noyau");
  const { enregistrerEdition, lireEdition } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  const tailles = { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } };
  const ecrireDecl = (recolte: object) => writeFileSync(m.join(m.dossier, "widget.json"), JSON.stringify({ nom: "Météo", tailles, sources: { web: true }, recolte }));
  ecrireDecl({ heures: ["07:00", "19:00"], notifier: true });
  const chercher = { id: "chercher", type: "web.chercher", position: { x: 0, y: 0 }, parametres: { requete: "voitures" } };
  const wf = { version: 1, blocs: [chercher, sortie], liens: [{ de: "chercher", vers: "sortie" }] };
  const r = await enregistrerEdition(m.c, "meteo", wf);
  expect(r).toMatchObject({ ok: true, avertissements: [{ bloc: "chercher", message: AVERTISSEMENT_WEB_SANS_DUREE }] });
  expect(await lireEdition(m.c, "meteo")).toMatchObject({
    widget: { web: true, recolte: { minutes: null, heures: ["07:00", "19:00"], dureeMaxMinutes: null, notifier: true } },
    avertissements: [{ bloc: "chercher", message: AVERTISSEMENT_WEB_SANS_DUREE }],
  });
  ecrireDecl({ minutes: 60, dureeMaxMinutes: 30 });
  expect(await lireEdition(m.c, "meteo")).toMatchObject({
    widget: { web: true, recolte: { minutes: 60, heures: [], dureeMaxMinutes: 30, notifier: false } },
    avertissements: [],
  });
});

test("enregistrerEdition : widget inconnu et widget.json invalide refusés, widget.json du workflow intact", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { enregistrerEdition } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  const inconnu = await enregistrerEdition(m.c, "absent", { version: 1, blocs: [], liens: [] });
  expect(inconnu).toMatchObject({ ok: false, erreur: "Widget introuvable" });
  const avant = JSON.stringify({ version: 1, blocs: [page({ parametres: {} }), sortie], liens: [{ de: "page", vers: "sortie" }] });
  writeFileSync(m.join(m.dossier, "workflow.json"), avant);
  const invalide = await enregistrerEdition(m.c, "meteo", { version: 1, blocs: [], liens: [] });
  expect(invalide.ok).toBe(false);
  expect(invalide.avertissements).toEqual([]);
  expect(readFileSync(m.join(m.dossier, "workflow.json"), "utf8")).toBe(avant);
  writeFileSync(m.join(m.dossier, "widget.json"), "{pas du json");
  expect(await enregistrerEdition(m.c, "meteo", { version: 1, blocs: [], liens: [] })).toMatchObject({ ok: false, erreur: expect.stringContaining("widget.json invalide") });
});

test("dossier de widget qui est un lien : rien n'est lu ni écrit hors de l'espace", async () => {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { enregistrerCodeSur, enregistrerEdition, lireCodeSur, lireEdition } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  const dehors = mkdtempSync(m.join(tmpdir(), "dehors-"));
  const copie = m.join(dehors, "copie");
  mkdirSync(copie);
  for (const f of ["widget.json", "recolte.mjs"]) writeFileSync(m.join(copie, f), readFileSync(m.join(m.dossier, f)));
  writeFileSync(m.join(copie, "trier.mjs"), "secret");
  renameSync(m.dossier, m.join(m.chemins.widgets, "ancien"));
  symlinkSync(copie, m.dossier);
  expect(await lireCodeSur(m.chemins, "meteo", "trier.mjs")).toEqual({ erreur: "Widget introuvable" });
  expect(await enregistrerCodeSur(m.chemins, "meteo", "trier.mjs", "pwned")).toMatchObject({ ok: false });
  expect(await enregistrerCodeSur(m.chemins, "meteo", "neuf.mjs", "pwned")).toMatchObject({ ok: false });
  expect(readFileSync(m.join(copie, "trier.mjs"), "utf8")).toBe("secret");
  expect(existsSync(m.join(copie, "neuf.mjs"))).toBe(false);
  expect(await lireEdition(m.c, "meteo")).toBeNull();
  expect(await enregistrerEdition(m.c, "meteo", { version: 1, blocs: [page({ parametres: {} }), sortie], liens: [{ de: "page", vers: "sortie" }] })).toMatchObject({ ok: false });
  expect(existsSync(m.join(copie, "workflow.json"))).toBe(false);
});

test("dossier des widgets qui est un lien : refusé", async () => {
  const { renameSync, symlinkSync } = await import("node:fs");
  const { lireCodeSur } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  renameSync(m.chemins.widgets, m.join(m.racine, "vrais"));
  symlinkSync(m.join(m.racine, "vrais"), m.chemins.widgets);
  expect(await lireCodeSur(m.chemins, "meteo", "x.mjs")).toEqual({ erreur: "Widget introuvable" });
});

test("code d'un widget normal : écrit et relu", async () => {
  const { enregistrerCodeSur, lireCodeSur } = await import("../../src/main/agent/constructeur");
  const m = await monter();
  expect(await enregistrerCodeSur(m.chemins, "meteo", "trier.mjs", "ok")).toEqual({ ok: true });
  expect(await lireCodeSur(m.chemins, "meteo", "trier.mjs")).toEqual({ texte: "ok" });
});
