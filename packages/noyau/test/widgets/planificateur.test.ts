import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget } from "../../src/accueil/donnees.js";
import type { EtatWidget } from "../../src/accueil/schemas.js";
import type { EtatAtelier } from "../../src/conteneur/atelier.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import type { OptionsRecolte } from "../../src/widgets/recolte.js";
import { PlanificateurWidgets, widgetDu } from "../../src/widgets/planificateur.js";
import { declarationWidget, ecrireWidget } from "../aide/accueil.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const MIN = 60_000;
const DEBUT = new Date("2026-10-28T10:00:00.000Z");

let p: PlanificateurWidgets | undefined;
afterEach(async () => {
  await p?.arreter();
  p = undefined;
});

/** Un widget « actus » qui récolte toutes les 60 min ; la récolte factice réussit (ou rend `statut`). */
async function preparer(o: { atelier?: EtatAtelier; statut?: EtatWidget["statut"] } = {}) {
  const racine = await dossierTemporaire();
  const c = cheminsEspace(racine);
  const dossierWidgets = join(await dossierTemporaire(), "widgets");
  await ecrireWidget(c, "actus", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
  // Un widget sans récolte n'est jamais lancé.
  await ecrireWidget(c, "fixe", declarationWidget(), {});
  let maintenant = DEBUT;
  const horloge = () => maintenant;
  const recoltes: string[] = [];
  let etatAtelier: EtatAtelier = o.atelier ?? "demarre";
  const changements = vi.fn();
  const recolter = vi.fn(async (r: OptionsRecolte) => {
    recoltes.push(r.id);
    const statut = o.statut ?? "ok";
    const avant = await lireEtatWidget(r.dossierWidgets, r.id);
    const etat: EtatWidget = {
      statut,
      derniereMaj: statut === "ok" ? horloge().toISOString() : avant.derniereMaj,
      derniereTentative: horloge().toISOString(),
      ...(statut === "erreur" ? { erreur: "boum" } : {}),
    };
    if (statut === "ok") await ecrireDonnees(r.dossierWidgets, r.id, { n: recoltes.length });
    await ecrireEtatWidget(r.dossierWidgets, r.id, etat);
    return { etat };
  });
  const atelier = { etat: async () => etatAtelier, commandeRecolte: () => ["docker"], supprimerRecolte: async (_id: string) => {} };
  p = new PlanificateurWidgets({
    chemins: c,
    dossierWidgets,
    recolteur: "/recolteur.mjs",
    atelier,
    pont: new PontFactice([], { actif: null, autoriser: false }),
    ia: null,
    horloge,
    intervalleMs: 60 * MIN, // la minuterie ne gêne pas : les tests appellent verifier eux-mêmes
    recolter,
    surChange: changements,
  });
  return {
    p,
    c,
    dossierWidgets,
    recoltes,
    recolter,
    changements,
    atelier,
    avancer: (ms: number) => (maintenant = new Date(maintenant.getTime() + ms)),
    fixerAtelier: (e: EtatAtelier) => (etatAtelier = e),
  };
}

test("un widget dû est récolté au démarrage puis selon sa fréquence (horloge factice)", async () => {
  const { p, recoltes, recolter, avancer } = await preparer();
  await p.demarrer();
  await vi.waitFor(() => expect(recoltes).toEqual(["actus"]));
  // La vérification de lancement se termine (sinon la suivante serait ignorée sans rien vérifier).
  await vi.waitFor(() => expect(recolter.mock.settledResults).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  avancer(59 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  avancer(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(recoltes).toEqual(["actus", "actus"]);
});

test("la récolte reçoit le widget, le dossier des données, le récolteur et l'IA", async () => {
  const { p, recolter, dossierWidgets, c } = await preparer();
  await p.verifier({ auLancement: true });
  const o = recolter.mock.calls[0]![0];
  expect(o).toMatchObject({ id: "actus", dossierWidgets, recolteur: "/recolteur.mjs", ia: null });
  expect(o.widget).toMatchObject({ id: "actus", dossier: join(c.widgets, "actus") });
  // surChange suit chaque écriture faite par la récolte.
  expect(o.surChange).toBeTypeOf("function");
});

test("accord-requis n'est jamais relancé tout seul", async () => {
  const { p, recoltes, dossierWidgets, avancer } = await preparer();
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "accord-requis", derniereMaj: null, derniereTentative: null, erreur: "Accord requis" });
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  avancer(24 * 60 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  expect(recoltes).toEqual([]);
  // Une demande explicite, elle, passe (la récolte vérifie l'accord elle-même).
  await p.recolterMaintenant("actus");
  expect(recoltes).toEqual(["actus"]);
});

test("atelier arrêté : statut atelier-arrete, données gardées", async () => {
  const { p, recoltes, dossierWidgets, changements, fixerAtelier } = await preparer({ atelier: "arrete" });
  await ecrireDonnees(dossierWidgets, "actus", { vieux: true });
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  expect(recoltes).toEqual([]);
  expect(await lireEtatWidget(dossierWidgets, "actus")).toMatchObject({
    statut: "atelier-arrete",
    derniereMaj: "2026-10-27T08:00:00.000Z",
    erreur: "Mise à jour impossible : atelier arrêté",
  });
  expect(await lireDonnees(dossierWidgets, "actus")).toEqual({ vieux: true });
  expect(changements).toHaveBeenCalledTimes(1);
  // Pas réécrit à chaque minute.
  await p.verifier({ auLancement: false });
  expect(changements).toHaveBeenCalledTimes(1);
  // recolterMaintenant ne lance rien non plus.
  expect((await p.recolterMaintenant("actus")).statut).toBe("atelier-arrete");
  expect(recoltes).toEqual([]);
  // L'atelier revient : la récolte reprend à la vérification suivante.
  fixerAtelier("demarre");
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
});

test("une erreur est retentée après 15 min, pas avant", async () => {
  const { p, recoltes, avancer } = await preparer({ statut: "erreur" });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  avancer(14 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  avancer(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(recoltes).toEqual(["actus", "actus"]);
});

test("en-cours est relancé au lancement seulement", () => {
  const w = {
    id: "a",
    dossier: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [] }, recolte: { minutes: 60 } },
    etat: { statut: "en-cours" as const, derniereMaj: null, derniereTentative: DEBUT.toISOString() },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aAffichage: true,
  };
  expect(widgetDu(w, DEBUT, { auLancement: true })).toBe(true);
  expect(widgetDu(w, DEBUT, { auLancement: false })).toBe(false);
  expect(widgetDu({ ...w, aRecolte: false, etat: { ...w.etat, statut: "ok" } }, DEBUT, { auLancement: true })).toBe(false);
});

test("recolterMaintenant attend la récolte en cours : une seule à la fois", async () => {
  const { p, recolter } = await preparer();
  let enVol = 0;
  let max = 0;
  const base = recolter.getMockImplementation()!;
  recolter.mockImplementation(async (o) => {
    max = Math.max(max, ++enVol);
    await new Promise((r) => setTimeout(r, 20));
    try {
      return await base(o);
    } finally {
      enVol--;
    }
  });
  const verif = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(recolter).toHaveBeenCalledTimes(1));
  const etat = await p.recolterMaintenant("actus");
  await verif;
  expect(max).toBe(1);
  expect(etat.statut).toBe("ok");
  expect(recolter).toHaveBeenCalledTimes(2);
});

test("recolterMaintenant sur un widget inconnu lève une erreur", async () => {
  const { p } = await preparer();
  await expect(p.recolterMaintenant("absent")).rejects.toThrow(/inconnu/);
});

test("arreter : la récolte en cours est supprimée et son état précédent remis", async () => {
  const { p, recolter, dossierWidgets, atelier } = await preparer();
  const avant: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", avant);
  let tuer!: () => void;
  recolter.mockImplementation(async (o) => {
    await ecrireEtatWidget(o.dossierWidgets, o.id, { ...avant, statut: "en-cours" });
    await new Promise<void>((r) => (tuer = r));
    const etat: EtatWidget = { ...avant, statut: "erreur", erreur: "La récolte s'est arrêtée sans résultat" };
    await ecrireEtatWidget(o.dossierWidgets, o.id, etat);
    return { etat };
  });
  const supprimees: string[] = [];
  atelier.supprimerRecolte = async (id) => {
    supprimees.push(id);
    tuer();
  };
  const verif = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(recolter).toHaveBeenCalled());
  await p.arreter();
  await verif;
  expect(supprimees).toEqual(["actus"]);
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual(avant);
});
