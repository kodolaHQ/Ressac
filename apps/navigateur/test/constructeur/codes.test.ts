import { afterEach, expect, test } from "vitest";
import { MODELE_CODE } from "../../src/renderer/constructeur/ajout";
import { codesNonEnregistres, FichierCode, garderCodesDe, oublierCodes, type DepotCode } from "../../src/renderer/constructeur/codes.svelte";

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

afterEach(() => oublierCodes());

test("une frappe crée un brouillon non enregistré, rien n'est écrit ; Enregistrer l'écrit et l'efface", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
  await c.lire();
  expect(c.texte).toBe("v1");
  expect(c.nonEnregistre).toBe(false);
  c.saisir("v2");
  expect(c.texte).toBe("v2");
  expect(c.nonEnregistre).toBe(true);
  expect(codesNonEnregistres("w")).toEqual(["a.mjs"]);
  expect(f.ecritures).toEqual([]);
  await c.enregistrer();
  expect(f.ecritures).toEqual([{ nom: "a.mjs", texte: "v2" }]);
  expect(c.nonEnregistre).toBe(false);
  expect(codesNonEnregistres("w")).toEqual([]);
});

test("revenir au texte du disque efface le brouillon ; Enregistrer sans brouillon n'écrit rien", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  c.saisir("v1");
  expect(c.nonEnregistre).toBe(false);
  await c.enregistrer();
  expect(f.ecritures).toEqual([]);
});

test("le brouillon survit à l'éditeur (changement de bloc ou d'onglet) : un nouvel éditeur le reprend", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("mien");
  const d = new FichierCode("w", "a.mjs", f.depot);
  await d.lire();
  expect(d.texte).toBe("mien");
  expect(d.nonEnregistre).toBe(true);
  expect(codesNonEnregistres("autre")).toEqual([]);
});

test("fichier absent : le modèle s'affiche, non enregistré, sans brouillon tant qu'on ne tape rien", async () => {
  const f = faux();
  const c = new FichierCode("w", "neuf.mjs", f.depot);
  await c.lire();
  expect(c.texte).toBe(MODELE_CODE);
  expect(c.nonEnregistre).toBe(true);
  expect(codesNonEnregistres("w")).toEqual([]);
  await c.enregistrer();
  expect(f.ecritures).toEqual([{ nom: "neuf.mjs", texte: MODELE_CODE }]);
  expect(c.nonEnregistre).toBe(false);
});

test("le fichier change sur le disque pendant un brouillon : bandeau ; Recharger prend le disque", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
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

test("Garder le mien : le bandeau part, le brouillon reste et s'enregistre par-dessus", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
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

test("sans brouillon, un changement sur le disque s'affiche tel quel ; le disque égal au brouillon l'efface", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
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

test("écriture refusée : le brouillon reste avec l'erreur", async () => {
  const f = faux({ "a.mjs": "v1" });
  f.etat.refus = true;
  const c = new FichierCode("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  await c.enregistrer();
  expect(c.erreur).toBe("Écriture impossible");
  expect(c.nonEnregistre).toBe(true);
});

test("une frappe pendant l'enregistrement reste un brouillon", async () => {
  const f = faux({ "a.mjs": "v1" });
  const c = new FichierCode("w", "a.mjs", f.depot);
  await c.lire();
  c.saisir("v2");
  const p = c.enregistrer();
  c.saisir("v3");
  await p;
  expect(f.etat.fichiers["a.mjs"]).toBe("v2");
  expect(c.texte).toBe("v3");
  expect(c.nonEnregistre).toBe(true);
});

test("oublierCodes(widget) n'efface que les brouillons de ce widget", async () => {
  const f = faux({ "a.mjs": "v1" });
  const a = new FichierCode("w", "a.mjs", f.depot);
  const b = new FichierCode("x", "a.mjs", f.depot);
  await a.lire();
  await b.lire();
  a.saisir("1");
  b.saisir("2");
  oublierCodes("w");
  expect(codesNonEnregistres("w")).toEqual([]);
  expect(codesNonEnregistres("x")).toEqual(["a.mjs"]);
  expect(codesNonEnregistres()).toEqual(["x/a.mjs"]);
});

test("garderCodesDe abandonne les brouillons des widgets dont le constructeur n'est plus ouvert", async () => {
  const f = faux({ "a.mjs": "v1" });
  const a = new FichierCode("w", "a.mjs", f.depot);
  const b = new FichierCode("x", "a.mjs", f.depot);
  await a.lire();
  await b.lire();
  a.saisir("1");
  b.saisir("2");
  garderCodesDe(["x", "autre"]);
  expect(codesNonEnregistres()).toEqual(["x/a.mjs"]);
});
