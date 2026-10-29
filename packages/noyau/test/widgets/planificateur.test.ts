import { afterEach, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget } from "../../src/accueil/donnees.js";
import type { EtatWidget } from "../../src/accueil/schemas.js";
import type { EtatAtelier } from "../../src/conteneur/atelier.js";
import { PontFactice } from "../../src/mcp/pont-factice.js";
import { erreurDuNoyau, executerRecolte, type LanceurProcessus, type OptionsRecolte, type ResultatEssai } from "../../src/widgets/recolte.js";
import { ecrireExecution, idEssai, listerExecutions, type Execution } from "../../src/workflows/executions.js";
import { ecrireMemoire } from "../../src/workflows/memoire.js";
import { accorder, lireAccords } from "../../src/widgets/accords.js";
import {
  ERREUR_ATELIER_ARRETE,
  ERREUR_RECOLTE_INTERNE,
  PlanificateurWidgets,
  VOIE_LONGUE_MINUTES,
  voieDe,
  widgetDu,
  type EtatDirect,
  type OptionsPlanificateur,
} from "../../src/widgets/planificateur.js";
import { Menagement } from "../../src/workflows/menagement.js";
import { IA_ABANDONNEE } from "../../src/ia/repartiteur.js";
import { lireAccueil } from "../../src/accueil/lire.js";
import type { CheminsEspace } from "../../src/chemins.js";
import { declarationWidget, ecrireWidget } from "../aide/accueil.js";
import { dossierTemporaire } from "../aide/temporaire.js";

/** Lectures de l'accueil en cours : un test attend qu'il n'y en ait plus pour savoir ce qu'une demande a déjà lu. */
const lectures = vi.hoisted(() => ({ enVol: 0 }));
vi.mock("../../src/accueil/lire.js", async (original) => {
  const m = await original<typeof import("../../src/accueil/lire.js")>();
  return {
    ...m,
    lireAccueil: async (...a: Parameters<typeof m.lireAccueil>) => {
      lectures.enVol++;
      try {
        return await m.lireAccueil(...a);
      } finally {
        lectures.enVol--;
      }
    },
  };
});

const MIN = 60_000;
const DEBUT = new Date("2026-10-28T10:00:00.000Z");

let p: PlanificateurWidgets | undefined;
afterEach(async () => {
  await p?.arreter();
  p = undefined;
});

/** Un widget « actus » qui récolte toutes les 60 min ; la récolte factice réussit (ou rend `statut`). */
async function preparer(o: { atelier?: EtatAtelier; statut?: EtatWidget["statut"]; options?: Partial<OptionsPlanificateur> } = {}) {
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
  const essais: string[] = [];
  const recolterEssai = vi.fn(async (r: OptionsRecolte & { origine: string; depart: string }): Promise<ResultatEssai> => {
    essais.push(r.id);
    return { ok: true, execution: idEssai(horloge().toISOString()), statut: "reussie" };
  });
  const directs: EtatDirect[] = [];
  const atelier = { etat: async () => etatAtelier, commandeRecolte: () => ["docker"], supprimerRecolte: async (_id: string) => {} };
  p = new PlanificateurWidgets({
    chemins: c,
    dossierWidgets,
    moteur: "/moteur",
    atelier,
    pont: new PontFactice([], { actif: null, autoriser: false }),
    ia: null,
    horloge,
    intervalleMs: 60 * MIN, // la minuterie ne gêne pas : les tests appellent verifier eux-mêmes
    recolter,
    recolterEssai,
    surChange: changements,
    surDirect: (e) => directs.push(structuredClone(e)),
    ...o.options,
  });
  return {
    essais,
    recolterEssai,
    directs,
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

test("la récolte reçoit le widget, le dossier des données, le moteur et l'IA", async () => {
  const { p, recolter, dossierWidgets, c } = await preparer();
  await p.verifier({ auLancement: true });
  const o = recolter.mock.calls[0]![0];
  expect(o).toMatchObject({ id: "actus", dossierWidgets, moteur: "/moteur", ia: null });
  expect(o.widget).toMatchObject({ id: "actus", dossier: join(c.widgets, "actus") });
  // surChange suit chaque écriture faite par la récolte.
  expect(o.surChange).toBeTypeOf("function");
});

test("le ménagement et la base des recherches sont transmis à chaque récolte et à chaque essai ; absents, rien n'est transmis", async () => {
  const menagement = new Menagement();
  const { p, recolter, recolterEssai } = await preparer({ options: { menagement, urlRecherche: "http://127.0.0.1:9/html/" } });
  await p.verifier({ auLancement: true });
  await p.recolterMaintenant("actus");
  await p.rejouer("actus", "x", "recolte");
  for (const o of [recolter.mock.calls[0]![0], recolter.mock.calls[1]![0], recolterEssai.mock.calls[0]![0]]) {
    expect(o.menagement).toBe(menagement);
    expect(o.urlRecherche).toBe("http://127.0.0.1:9/html/");
  }
  await p.arreter();
  const sans = await preparer();
  await sans.p.verifier({ auLancement: true });
  expect(sans.recolter.mock.calls[0]![0]).not.toHaveProperty("menagement");
  expect(sans.recolter.mock.calls[0]![0]).not.toHaveProperty("urlRecherche");
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
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [], web: false }, recolte: { minutes: 60 } },
    etat: { statut: "en-cours" as const, derniereMaj: null, derniereTentative: DEBUT.toISOString() },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aWorkflow: false,
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

test("arreter pendant que la récolte vérifie l'atelier : elle ne démarre pas", async () => {
  const { p, recolter, atelier } = await preparer();
  let liberer!: () => void;
  const verifie = vi.fn();
  atelier.etat = async () => {
    verifie();
    await new Promise<void>((r) => (liberer = r));
    return "demarre";
  };
  const verif = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(verifie).toHaveBeenCalled());
  const arret = p.arreter();
  liberer();
  await arret;
  await verif;
  expect(recolter).not.toHaveBeenCalled();
});

test("arreter : une récolte qui dépasse l'attente voit son conteneur supprimé encore une fois", async () => {
  const { dossierWidgets, recolter, atelier, c } = await preparer();
  await p!.arreter();
  let lancee = false;
  let demarrer!: () => void;
  const premiereSuppression = new Promise<void>((r) => (demarrer = r));
  recolter.mockImplementation(async (o) => {
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: null });
    // Le conteneur démarre après la première suppression, et la récolte ne finit pas.
    await premiereSuppression;
    lancee = true;
    await new Promise(() => {});
    return { etat: { statut: "ok", derniereMaj: null, derniereTentative: null } };
  });
  const supprimees: { id: string; lancee: boolean }[] = [];
  atelier.supprimerRecolte = async (id) => {
    supprimees.push({ id, lancee });
    demarrer();
  };
  p = new PlanificateurWidgets({
    chemins: c,
    dossierWidgets,
    moteur: "/moteur",
    atelier,
    pont: new PontFactice([], { actif: null, autoriser: false }),
    ia: null,
    intervalleMs: 60 * MIN,
    recolter,
    attenteArretMs: 100,
  });
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(recolter).toHaveBeenCalled());
  await p.arreter();
  expect(supprimees).toEqual([
    { id: "actus", lancee: false },
    { id: "actus", lancee: true },
  ]);
});

test("la première vérification attend que l'atelier soit prêt : pas d'« atelier arrêté » au lancement", async () => {
  const { dossierWidgets, recolter, atelier, c, recoltes } = await preparer();
  await p!.arreter();
  let etat: EtatAtelier = "arrete";
  atelier.etat = async () => etat;
  let pret!: () => void;
  const changements = vi.fn();
  p = new PlanificateurWidgets({
    chemins: c,
    dossierWidgets,
    moteur: "/moteur",
    atelier,
    pont: new PontFactice([], { actif: null, autoriser: false }),
    ia: null,
    intervalleMs: 60 * MIN,
    recolter,
    surChange: changements,
    pret: new Promise<void>((r) => (pret = r)),
  });
  await p.demarrer();
  await new Promise((r) => setTimeout(r, 50));
  expect((await lireEtatWidget(dossierWidgets, "actus")).statut).not.toBe("atelier-arrete");
  expect(changements).not.toHaveBeenCalled();
  etat = "demarre";
  pret();
  await vi.waitFor(() => expect(recoltes).toEqual(["actus"]));
});

test("une récolte qui lève une erreur après avoir écrit en-cours laisse un état erreur du noyau", async () => {
  const { p, recolter, dossierWidgets, changements } = await preparer();
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" });
  recolter.mockImplementation(async (o) => {
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: DEBUT.toISOString() });
    throw new Error("disque plein SECRET");
  });
  await expect(p.recolterMaintenant("actus")).resolves.toMatchObject({ statut: "erreur" });
  const etat = await lireEtatWidget(dossierWidgets, "actus");
  expect(etat).toEqual({
    statut: "erreur",
    derniereMaj: "2026-10-27T08:00:00.000Z",
    derniereTentative: DEBUT.toISOString(),
    erreur: ERREUR_RECOLTE_INTERNE,
    erreurNoyau: true,
  });
  expect(erreurDuNoyau(ERREUR_RECOLTE_INTERNE)).toBe(true);
  expect(changements).toHaveBeenCalled();
  // Pareil par la vérification de fond.
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "en-cours", derniereMaj: null, derniereTentative: null });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect((await lireEtatWidget(dossierWidgets, "actus")).statut).toBe("erreur");
});

test("à chaque vérification, accords et données d'un widget dont le dossier a disparu sont effacés", async () => {
  const { p, dossierWidgets, c } = await preparer();
  for (const id of ["actus", "parti"]) {
    await ecrireDonnees(dossierWidgets, id, { secret: id });
    await accorder(dossierWidgets, id, { domaines: ["x.fr"], publiques: [], profil: "defaut" });
  }
  // Un widget illisible garde ses données : son dossier existe.
  await ecrireWidget(c, "casse", "{", {});
  await ecrireDonnees(dossierWidgets, "casse", { secret: "casse" });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await lireAccords(dossierWidgets)).sort()).toEqual(["actus"]);
  expect(existsSync(join(dossierWidgets, "parti"))).toBe(false);
  expect(await lireDonnees(dossierWidgets, "casse")).toEqual({ secret: "casse" });
  expect(existsSync(join(dossierWidgets, "actus"))).toBe(true);
  // Sans dossier des widgets du tout (espace illisible), rien n'est effacé.
  await rm(c.widgets, { recursive: true, force: true });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await lireAccords(dossierWidgets))).toEqual(["actus"]);
});

test("un widget avec workflow.json sans recolte.mjs est récolté quand il est dû", async () => {
  const { p, c, recoltes } = await preparer();
  await ecrireWidget(c, "flux", declarationWidget(undefined, { recolte: { minutes: 60 } }), {
    "workflow.json": JSON.stringify({ version: 1, blocs: [{ id: "sortie", type: "sortie", parametres: { vers: "widget" } }] }),
  });
  expect((await p.verifier({ auLancement: true })).sort()).toEqual(["actus", "flux"]);
  expect(recoltes.sort()).toEqual(["actus", "flux"]);
});

test("déclencheur : planifiee pour la vérification, manuelle par défaut pour recolterMaintenant, sinon celui demandé", async () => {
  const { p, recolter } = await preparer();
  await p.verifier({ auLancement: true });
  await p.recolterMaintenant("actus");
  await p.recolterMaintenant("actus", "agent");
  expect(recolter.mock.calls.map(([o]) => o.declencheur)).toEqual(["planifiee", "manuelle", "agent"]);
  expect(recolter.mock.calls[0]![0].interrompue).toBeTypeOf("function");
});

test("arrêt pendant l'exécution : exécution interrompue, état précédent restauré", async () => {
  const { p, recolter, dossierWidgets, atelier } = await preparer();
  const avant: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", avant);
  let tuer!: () => void;
  const lance = vi.fn();
  // Un conteneur qui ne répond jamais : seul l'arrêt le termine.
  const lancer: LanceurProcessus = () => {
    lance();
    const fin = new Promise<number | null>((r) => (tuer = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), tuer: () => tuer(), fin };
  };
  recolter.mockImplementation((o) => executerRecolte({ ...o, lancer }));
  atelier.supprimerRecolte = async () => tuer();
  const verif = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(lance).toHaveBeenCalled());
  await p.arreter();
  await verif;
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual(avant);
  expect((await listerExecutions(join(dossierWidgets, "actus"))).map((e) => e.statut)).toEqual(["interrompue"]);
});

test("le dossier disparu efface aussi exécutions et mémoire", async () => {
  const { p, dossierWidgets } = await preparer();
  const dossier = join(dossierWidgets, "parti");
  await ecrireDonnees(dossierWidgets, "parti", { secret: 1 });
  await ecrireExecution(dossier, {
    version: 1, id: "2026-10-27T08-00-00-000Z", proprietaire: { type: "widget", id: "parti" }, declencheur: "planifiee",
    debut: "2026-10-27T08:00:00.000Z", fin: null, statut: "reussie", blocs: [],
  });
  await ecrireMemoire(dossier, { a: { type: "liste.nouveaux", valeur: [] } });
  await p.verifier({ auLancement: false });
  expect(existsSync(dossier)).toBe(false);
});

/** Une promesse à résoudre de l'extérieur. */
function differe<T>() {
  let resoudre!: (v: T) => void;
  const promesse = new Promise<T>((ok) => (resoudre = ok));
  return { promesse, resoudre };
}

test("une exécution planifiée due pendant un essai attend sa fin", async () => {
  const { p, recolter, recolterEssai } = await preparer();
  const journal: string[] = [];
  const fin = differe<ResultatEssai>();
  recolterEssai.mockImplementation(async (o) => {
    journal.push(`essai ${o.id} ${o.origine} ${o.depart}`);
    const r = await fin.promesse;
    journal.push("fin de l'essai");
    return r;
  });
  recolter.mockImplementation(async (o) => {
    journal.push(`récolte ${o.id} ${o.declencheur}`);
    return { etat: { statut: "ok", derniereMaj: DEBUT.toISOString(), derniereTentative: DEBUT.toISOString() } };
  });
  const essai = p.rejouer("actus", "2026-10-28T09-00-00-000Z", "liste");
  await vi.waitFor(() => expect(journal).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste"]));
  const verification = p.verifier({ auLancement: true });
  await new Promise((r) => setTimeout(r, 30));
  expect(journal).toHaveLength(1);
  fin.resoudre({ ok: true, execution: "x-essai", statut: "reussie" });
  expect(await essai).toEqual({ ok: true, execution: "x-essai", statut: "reussie" });
  expect(await verification).toEqual(["actus"]);
  expect(journal).toEqual(["essai actus 2026-10-28T09-00-00-000Z liste", "fin de l'essai", "récolte actus planifiee"]);
});

test("deux rejouer demandés coup sur coup s'exécutent l'un après l'autre", async () => {
  const { p, recolterEssai } = await preparer();
  const journal: string[] = [];
  const fins = [differe<void>(), differe<void>()];
  let n = 0;
  recolterEssai.mockImplementation(async (o) => {
    const i = n++;
    journal.push(`début ${i} ${o.depart}`);
    await fins[i]!.promesse;
    journal.push(`fin ${i}`);
    return { ok: true, execution: `e${i}-essai`, statut: "reussie" };
  });
  const a = p.rejouer("actus", "o", "a");
  const b = p.rejouer("actus", "o", "b");
  await vi.waitFor(() => expect(journal).toEqual(["début 0 a"]));
  await new Promise((r) => setTimeout(r, 20));
  expect(journal).toEqual(["début 0 a"]);
  fins[0]!.resoudre();
  await vi.waitFor(() => expect(journal).toEqual(["début 0 a", "fin 0", "début 1 b"]));
  fins[1]!.resoudre();
  expect(await a).toMatchObject({ execution: "e0-essai" });
  expect(await b).toMatchObject({ execution: "e1-essai" });
});

test("direct() montre le widget en cours, son genre et ses blocs au fil des traces, puis plus rien", async () => {
  const { p, recolterEssai, directs, dossierWidgets } = await preparer();
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  const vus: EtatDirect[] = [];
  recolterEssai.mockImplementation(async (o) => {
    o.surTrace!({ bloc: "liste", etape: "debut" });
    vus.push(structuredClone(p.direct()));
    o.surTrace!({ bloc: "liste", etape: "fin", statut: "reussi", elements: 3 });
    // Commencé, sans fin : seule l'exécution finale dit qu'il a échoué.
    o.surTrace!({ bloc: "sortie", etape: "debut" });
    vus.push(structuredClone(p.direct()));
    const e: Execution = {
      version: 1, id: idEssai(DEBUT.toISOString()), proprietaire: { type: "widget", id: o.id }, declencheur: "rejeu",
      essai: { depart: o.depart, origine: o.origine }, debut: DEBUT.toISOString(), fin: DEBUT.toISOString(), statut: "echouee",
      blocs: [
        { id: "liste", type: "code", statut: "reussi", debut: "x", fin: "x", elements: 3, journal: [] },
        { id: "sortie", type: "sortie", statut: "echoue", debut: "x", fin: null, elements: null, journal: [] },
      ],
    };
    await ecrireExecution(join(dossierWidgets, o.id), e);
    return { ok: true, execution: e.id, statut: e.statut };
  });
  await p.rejouer("actus", "o", "liste");
  const debut = DEBUT.toISOString();
  expect(vus[0]).toEqual({
    courants: [{ widget: "actus", genre: "essai", debut, blocs: { liste: { statut: "en-cours", elements: null } } }],
    enAttente: [],
  });
  expect(vus[1]!.courants[0]!.blocs).toEqual({ liste: { statut: "reussi", elements: 3 }, sortie: { statut: "en-cours", elements: null } });
  // Fin : resynchronisé sur l'exécution écrite, puis plus rien en cours.
  expect(directs.at(-2)!.courants[0]!.blocs).toEqual({ liste: { statut: "reussi", elements: 3 }, sortie: { statut: "echoue", elements: null } });
  expect(directs.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  // Une vraie exécution se suit de la même façon, genre « execution ».
  await p.recolterMaintenant("actus");
  expect(directs.some((d) => d.courants.some((x) => x.genre === "execution" && x.widget === "actus"))).toBe(true);
  expect(p.direct().courants).toEqual([]);
});

test("enAttente liste un widget demandé pendant qu'un autre tourne", async () => {
  const { p, recolterEssai, recoltes } = await preparer();
  const fin = differe<void>();
  recolterEssai.mockImplementation(async () => {
    await fin.promesse;
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  const essai = p.rejouer("actus", "o", "liste");
  await vi.waitFor(() => expect(p.direct().courants[0]?.widget).toBe("actus"));
  const autre = p.recolterMaintenant("fixe");
  await vi.waitFor(() => expect(p.direct().enAttente).toEqual(["fixe"]));
  expect(recoltes).toEqual([]);
  fin.resoudre();
  await essai;
  await autre;
  expect(recoltes).toEqual(["fixe"]);
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
});

test("atelier arrêté : rejouer refuse sans changer l'état", async () => {
  const { p, recolterEssai, dossierWidgets, changements } = await preparer({ atelier: "arrete" });
  const etat: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", etat);
  expect(await p.rejouer("actus", "o", "liste")).toEqual({ ok: false, erreur: ERREUR_ATELIER_ARRETE });
  expect(recolterEssai).not.toHaveBeenCalled();
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual(etat);
  expect(changements).not.toHaveBeenCalled();
});

test("widgetDu : un widget à heures sans minutes n'est jamais dû par la fréquence", () => {
  const w = {
    id: "a",
    dossier: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [], web: false }, recolte: { heures: ["07:00"] } },
    etat: { statut: "ok" as const, derniereMaj: null, derniereTentative: null },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aWorkflow: false,
    aAffichage: true,
  };
  expect(widgetDu(w, DEBUT, { auLancement: true })).toBe(false);
  expect(widgetDu({ ...w, etat: { ...w.etat, statut: "erreur" as const } }, DEBUT, { auLancement: false })).toBe(false);
});

// --- Deux voies : les veilles (dureeMaxMinutes > 3) tournent à part ---

/** Un widget qui récolte toutes les 60 min, avec la durée maximale donnée. */
async function ecrireVeille(c: CheminsEspace, id: string, dureeMaxMinutes: number) {
  await ecrireWidget(c, id, declarationWidget(undefined, { recolte: { minutes: 60, dureeMaxMinutes } }), { "recolte.mjs": "export default () => 1" });
}

/** Les récoltes des widgets `retenus` attendent `liberer(id)` ; toutes passent ensuite par la récolte factice de base. */
function retenir(recolter: Awaited<ReturnType<typeof preparer>>["recolter"], retenus: string[]) {
  const base = recolter.getMockImplementation()!;
  const journal: string[] = [];
  const fins = new Map<string, (() => void)[]>();
  recolter.mockImplementation(async (o) => {
    journal.push(`début ${o.id}`);
    if (retenus.includes(o.id)) {
      const d = differe<void>();
      fins.set(o.id, [...(fins.get(o.id) ?? []), d.resoudre]);
      await d.promesse;
    }
    try {
      return await base(o);
    } finally {
      journal.push(`fin ${o.id}`);
    }
  });
  return {
    journal,
    liberer: (id: string) => {
      const f = fins.get(id)?.shift();
      if (!f) throw new Error(`rien à libérer pour ${id}`);
      f();
    },
  };
}

test("voieDe : longue au-delà de VOIE_LONGUE_MINUTES (3), courte sinon", async () => {
  expect(VOIE_LONGUE_MINUTES).toBe(3);
  const { c, dossierWidgets } = await preparer();
  await ecrireVeille(c, "trois", 3);
  await ecrireVeille(c, "quatre", 4);
  const widgets = (await lireAccueil(c, dossierWidgets)).widgets;
  const voie = (id: string) => voieDe(widgets.find((w) => w.id === id)!);
  expect([voie("actus"), voie("trois"), voie("quatre"), voie("fixe")]).toEqual(["courte", "courte", "longue", "courte"]);
});

test("une exécution longue (dureeMaxMinutes 30) n'empêche pas un widget court de tourner", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  // La vérification lance la veille sans l'attendre, et récolte « actus » pendant qu'elle tourne.
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect(r.journal).toContain("fin actus");
  await vi.waitFor(() => expect(r.journal).toContain("début veille"));
  expect(r.journal).not.toContain("fin veille");
  // Une demande manuelle d'un widget court passe aussi.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("deux widgets longs : l'un après l'autre", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille-a", 30);
  await ecrireVeille(c, "veille-b", 20);
  const r = retenir(recolter, ["veille-a", "veille-b"]);
  await p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal.filter((l) => l.startsWith("début veille"))).toHaveLength(1));
  await new Promise((ok) => setImmediate(ok));
  const premiere = r.journal.find((l) => l.startsWith("début veille"))!.slice("début ".length);
  const seconde = premiere === "veille-a" ? "veille-b" : "veille-a";
  expect(r.journal).not.toContain(`début ${seconde}`);
  r.liberer(premiere);
  await vi.waitFor(() => expect(r.journal).toContain(`début ${seconde}`));
  expect(r.journal.indexOf(`fin ${premiere}`)).toBeLessThan(r.journal.indexOf(`début ${seconde}`));
  r.liberer(seconde);
  await vi.waitFor(() => expect(r.journal).toContain(`fin ${seconde}`));
});

test("un widget long et son essai : jamais en même temps", async () => {
  const { p, c, recolter, recolterEssai } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  recolterEssai.mockImplementation(async (o) => {
    r.journal.push(`essai ${o.id}`);
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  const execution = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  const essai = p.rejouer("veille", "o", "liste");
  await vi.waitFor(() => expect(p.direct().enAttente).toEqual(["veille"]));
  // Un widget court tourne pendant ce temps : l'essai qui attend ne bloque pas sa voie.
  await p.recolterMaintenant("actus");
  expect(r.journal).not.toContain("essai veille");
  r.liberer("veille");
  await execution;
  expect(await essai).toMatchObject({ ok: true });
  expect(r.journal.indexOf("fin veille")).toBeLessThan(r.journal.indexOf("essai veille"));
});

test("dureeMaxMinutes passé de 30 à 2 pendant l'exécution : la nouvelle demande attend la fin de la première", async () => {
  const { p, c, recolter, recoltes } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  const premiere = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  await ecrireVeille(c, "veille", 2);
  const seconde = p.recolterMaintenant("veille");
  // La voie courte reste libre pour les autres widgets, et une vérification n'attend pas ce widget occupé.
  await p.recolterMaintenant("actus");
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  expect(r.journal.filter((l) => l === "début veille")).toHaveLength(1);
  r.liberer("veille");
  await premiere;
  await vi.waitFor(() => expect(r.journal.filter((l) => l === "début veille")).toHaveLength(2));
  expect(r.journal.indexOf("fin veille")).toBeLessThan(r.journal.lastIndexOf("début veille"));
  expect(recoltes).toEqual(["actus", "veille"]);
  r.liberer("veille");
  expect((await seconde).statut).toBe("ok");
});

test("une vérification ne reste pas bloquée par une exécution longue : un widget court dû plus tard est récolté", async () => {
  const { p, c, recolter, avancer } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  avancer(61 * MIN);
  // « actus » est de nouveau dû ; la veille aussi d'après ses données, mais elle tourne encore : pas relancée.
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  avancer(61 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(r.journal.filter((l) => l === "début veille")).toHaveLength(1);
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("direct().courants liste les deux exécutions", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille", "actus"]);
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal).toEqual(expect.arrayContaining(["début veille", "début actus"])));
  await vi.waitFor(() =>
    expect(
      p
        .direct()
        .courants.map((x) => x.widget)
        .sort(),
    ).toEqual(["actus", "veille"]),
  );
  expect(p.direct().courants.every((x) => x.genre === "execution")).toBe(true);
  r.liberer("actus");
  await vi.waitFor(() => expect(p.direct().courants.map((x) => x.widget)).toEqual(["veille"]));
  r.liberer("veille");
  await vi.waitFor(() => expect(p.direct()).toEqual({ courants: [], enAttente: [] }));
});

test("arreter supprime les deux conteneurs et attend les deux voies", async () => {
  const { p, c, recolter, atelier } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille", "actus"]);
  const supprimees: string[] = [];
  const tour = () => new Promise((ok) => setImmediate(ok));
  atelier.supprimerRecolte = async (id) => {
    supprimees.push(id);
    if (id === "actus") return void setImmediate(() => r.liberer(id));
    // La veille tuée finit bien après la courte (elle écrit encore sa mémoire et son exécution « interrompue »).
    void (async () => {
      while (!r.journal.includes("fin actus")) await tour();
      for (let i = 0; i < 5; i++) await tour();
      r.liberer(id);
    })();
  };
  void p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(p.direct().courants).toHaveLength(2));
  await p.arreter();
  expect(supprimees.sort()).toEqual(["actus", "veille"]);
  expect(r.journal).toEqual(expect.arrayContaining(["fin actus", "fin veille"]));
});

test("arreter : une exécution longue qui ne finit pas est attendue de façon bornée, son conteneur supprimé deux fois", async () => {
  const { p, c, recolter, atelier } = await preparer({
    options: { attenteArretMs: 1 },
  });
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  const supprimees: string[] = [];
  atelier.supprimerRecolte = async (id) => void supprimees.push(id);
  await p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(r.journal).toContain("début veille"));
  await p.arreter();
  expect(supprimees).toEqual(["veille", "veille"]);
  r.liberer("veille");
});

test("l'IA passe par le répartiteur : chaque exécution a sa vue, les appels arrivent à l'IA donnée, refusés après sa fin", async () => {
  const appels: string[] = [];
  const ia = { kev: async () => "k", gemma: async (o: { prompt: string }) => (appels.push(o.prompt), "g") };
  const { p, c, recolter, recolterEssai } = await preparer({ options: { ia } });
  await ecrireVeille(c, "veille", 30);
  const reponses: unknown[] = [];
  const base = recolter.getMockImplementation()!;
  recolter.mockImplementation(async (o) => {
    reponses.push(await o.ia!.gemma({ prompt: o.id }));
    return base(o);
  });
  recolterEssai.mockImplementation(async (o) => {
    reponses.push(await o.ia!.gemma({ prompt: `essai ${o.id}` }));
    return { ok: true, execution: "e-essai", statut: "reussie" };
  });
  await p.recolterMaintenant("actus");
  await p.recolterMaintenant("veille");
  await p.rejouer("actus", "o", "liste");
  const vues = [recolter.mock.calls[0]![0].ia, recolter.mock.calls[1]![0].ia, recolterEssai.mock.calls[0]![0].ia];
  expect(new Set(vues).size).toBe(3);
  for (const v of vues) expect(v).not.toBe(ia);
  expect(reponses).toEqual(["g", "g", "g"]);
  expect(appels).toEqual(["actus", "veille", "essai actus"]);
  // L'exécution finie, sa vue refuse : un appel tardif ne part plus vers l'IA.
  await expect(vues[0]!.gemma({ prompt: "tard" })).rejects.toThrow(IA_ABANDONNEE);
  expect(appels).toHaveLength(3);
});

test("dureeMaxMinutes passé de 2 à 30 pendant qu'une demande attend : elle part dans la voie longue", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille", 2);
  const r = retenir(recolter, ["veille"]);
  const premiere = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  const seconde = p.recolterMaintenant("veille");
  // Toute lecture que la demande ferait tout de suite (choix de la voie à la demande) est finie avant le changement.
  await new Promise((ok) => setImmediate(ok));
  await vi.waitFor(() => expect(lectures.enVol).toBe(0));
  await ecrireVeille(c, "veille", 30);
  r.liberer("veille");
  await premiere;
  await vi.waitFor(() => expect(r.journal.filter((l) => l === "début veille")).toHaveLength(2));
  // La seconde tourne dans la voie longue : la voie courte et la vérification restent libres.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  r.liberer("veille");
  expect((await seconde).statut).toBe("ok");
});

test("widget passé de 30 à 2 juste avant un essai : l'essai passe pendant la veille d'un autre widget", async () => {
  const { p, c, recolter, recolterEssai } = await preparer();
  await ecrireVeille(c, "veille-a", 30);
  await ecrireVeille(c, "veille-b", 30);
  const r = retenir(recolter, ["veille-a"]);
  // La veille A tourne dans la voie longue ; le planificateur a lu B à 30 pendant ce temps.
  const a = p.recolterMaintenant("veille-a");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille-a"]));
  await ecrireVeille(c, "veille-b", 2);
  expect(await p.rejouer("veille-b", "o", "liste")).toMatchObject({ ok: true });
  expect(recolterEssai.mock.calls.map((x) => x[0].id)).toEqual(["veille-b"]);
  expect(r.journal).not.toContain("fin veille-a");
  r.liberer("veille-a");
  await a;
});
