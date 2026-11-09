import { afterEach, expect, test } from "vitest";
import { CODE_MODEL } from "../../ui/constructeur/ajout";
import { unsavedCodes, CodeFile, keepCodesOf, forgetCodes, type DepotCode } from "../../ui/constructeur/codes.svelte";

function faux(fichiers: Record<string, string> = {}) {
  const etat = { fichiers: { ...fichiers }, refus: false };
  const ecritures: { nom: string; texte: string }[] = [];
  const depot: DepotCode = {
    lireCode: async (_id, nom) => (nom in etat.fichiers ? { texte: etat.fichiers[nom]! } : { absent: true }),
    enregistrerCode: async (_id, nom, texte) => {
      if (etat.refus) return { ok: false, erreur: "Écriture impossible" };
      ecritures.push({ nom, texte });
      etat.fichiers[nom] = texte;
      return { ok: true };
    },
  };
  return { depot, etat, ecritures };
}

afterEach(() => forgetCodes());

test("a keystroke creates an unsaved draft, nothing is written; Enregistrer writes it and clears it", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  expect(c.texte).toBe("v1");
  expect(c.nonEnregistre).toBe(false);
  c.saisir("v2");
  expect(c.texte).toBe("v2");
  expect(c.nonEnregistre).toBe(true);
  expect(unsavedCodes("w")).toEqual(["a.mjs"]);
  expect(f.ecritures).toEqual([]);
  await c.enregistrer();
  expect(f.ecritures).toEqual([{ nom: "a.mjs", texte: "v2" }]);
  expect(c.nonEnregistre).toBe(false);
  expect(unsavedCodes("w")).toEqual([]);
});

test("going back to the disk's text clears the draft; Enregistrer without a draft writes nothing", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  c.saisir("v1");
  expect(c.nonEnregistre).toBe(false);
  await c.enregistrer();
  expect(f.ecritures).toEqual([]);
});

test("the draft outlives the editor (block or tab change): a new editor picks it up", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("mien");
  const d = new CodeFile("w", "a.mjs", f.depot);
  await d.lire();
  expect(d.texte).toBe("mien");
  expect(d.nonEnregistre).toBe(true);
  expect(unsavedCodes("autre")).toEqual([]);
});

test("missing file: the template is shown, unsaved, without a draft until something is typed", async () => {
  const f = faux();
  const c = new CodeFile("w", "neuf.mjs", f.depot);
  await c.lire();
  expect(c.texte).toBe(CODE_MODEL);
  expect(c.nonEnregistre).toBe(true);
  expect(unsavedCodes("w")).toEqual([]);
  await c.enregistrer();
  expect(f.ecritures).toEqual([{ nom: "neuf.mjs", texte: CODE_MODEL }]);
  expect(c.nonEnregistre).toBe(false);
});

test("the file changes on disk during a draft: banner; Recharger takes the disk", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("mien");
  await c.lire();
  expect(c.changeSurDisque).toBe(false);
  f.etat.fichiers["a.mjs"] = "agent";
  await c.lire();
  expect(c.changeSurDisque).toBe(true);
  expect(c.texte).toBe("mien");
  c.recharger();
  expect(c.texte).toBe("agent");
  expect(c.changeSurDisque).toBe(false);
  expect(c.nonEnregistre).toBe(false);
});

test("Garder le mien: the banner goes, the draft stays and is saved over it", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("mien");
  f.etat.fichiers["a.mjs"] = "agent";
  await c.lire();
  c.garderLeMien();
  expect(c.changeSurDisque).toBe(false);
  await c.lire();
  expect(c.changeSurDisque).toBe(false);
  expect(c.texte).toBe("mien");
  await c.enregistrer();
  expect(f.etat.fichiers["a.mjs"]).toBe("mien");
});

test("without a draft, a change on disk is shown as is; a disk equal to the draft clears it", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  f.etat.fichiers["a.mjs"] = "agent";
  await c.lire();
  expect(c.texte).toBe("agent");
  c.saisir("pareil");
  f.etat.fichiers["a.mjs"] = "pareil";
  await c.lire();
  expect(c.nonEnregistre).toBe(false);
  expect(c.changeSurDisque).toBe(false);
});

test("write refused: the draft stays with the error", async () => {
  const f = faux({ "a.mjs": "v1" });
  f.etat.refus = true;
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  await c.enregistrer();
  expect(c.erreur).toBe("Écriture impossible");
  expect(c.nonEnregistre).toBe(true);
});

test("a keystroke during the save stays a draft", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new CodeFile("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  const p = c.enregistrer();
  c.saisir("v3");
  await p;
  expect(f.etat.fichiers["a.mjs"]).toBe("v2");
  expect(c.texte).toBe("v3");
  expect(c.nonEnregistre).toBe(true);
});

test("oublierCodes(widget) only clears that widget's drafts", async () => {
  const f = faux({ "a.mjs": "v1" });
  const a = new CodeFile("w", "a.mjs", f.depot);
  const b = new CodeFile("x", "a.mjs", f.depot);
  await a.lire();
  await b.lire();
  a.saisir("1");
  b.saisir("2");
  forgetCodes("w");
  expect(unsavedCodes("w")).toEqual([]);
  expect(unsavedCodes("x")).toEqual(["a.mjs"]);
  expect(unsavedCodes()).toEqual(["x/a.mjs"]);
});

test("garderCodesDe drops the drafts of widgets whose builder is no longer open", async () => {
  const f = faux({ "a.mjs": "v1" });
  const a = new CodeFile("w", "a.mjs", f.depot);
  const b = new CodeFile("x", "a.mjs", f.depot);
  await a.lire();
  await b.lire();
  a.saisir("1");
  b.saisir("2");
  keepCodesOf(["x", "autre"]);
  expect(unsavedCodes()).toEqual(["x/a.mjs"]);
});

test("a saved code signals it (the workflow blocked on that file restarts); a refusal signals nothing", async () => {
  const f = faux();
  const signales: string[] = [];
  const c = new CodeFile("w", "b.mjs", f.depot, (nom) => signales.push(nom));
  await c.lire();
  f.etat.refus = true;
  await c.enregistrer();
  expect(signales).toEqual([]);
  f.etat.refus = false;
  await c.enregistrer();
  expect(signales).toEqual(["b.mjs"]);
});
