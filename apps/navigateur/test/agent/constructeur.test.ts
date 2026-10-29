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
  expect(e).toMatchObject({ origine: "implicite", widget: { nom: "Météo", compte: ["a.test"] } });
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
