import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { cheminsEspace } from "../../src/chemins.js";
import { ecrireDonnees, ecrireEtatWidget, lireDonnees, lireEtatWidget, supprimerDonnees } from "../../src/accueil/donnees.js";
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
import { creneauCourant } from "../../src/widgets/heures.js";
import { IA_ABANDONNEE } from "../../src/ia/repartiteur.js";
import type { NotificationWidget } from "../../src/widgets/nouveautes.js";
import { lireAccueil } from "../../src/accueil/lire.js";
import type { CheminsEspace } from "../../src/chemins.js";
import { declarationWidget, ecrireWidget } from "../aide/accueil.js";
import { dossierTemporaire } from "../aide/temporaire.js";

/** Home reads in progress: a test waits until there are none left to know what a request has already read. */
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

/** A widget « actus » that harvests every 60 min; the fake harvest succeeds (or returns `statut`). */
async function preparer(o: { atelier?: EtatAtelier; statut?: EtatWidget["statut"]; options?: Partial<OptionsPlanificateur> } = {}) {
  const racine = await dossierTemporaire();
  const c = cheminsEspace(racine);
  const dossierWidgets = join(await dossierTemporaire(), "widgets");
  await ecrireWidget(c, "actus", declarationWidget(undefined, { recolte: { minutes: 60 } }), { "recolte.mjs": "export default () => 1" });
  // A widget without a harvest is never launched.
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
  const options = (): OptionsPlanificateur => ({
    chemins: c,
    dossierWidgets,
    moteur: "/moteur",
    atelier,
    pont: new PontFactice([], { actif: null, autoriser: false }),
    ia: null,
    horloge,
    intervalleMs: 60 * MIN, // the timer does not interfere: the tests call verifier themselves
    recolter,
    recolterEssai,
    surChange: changements,
    surDirect: (e) => directs.push(structuredClone(e)),
    ...o.options,
  });
  p = new PlanificateurWidgets(options());
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
    fixer: (d: Date) => (maintenant = d),
    horloge,
    /** A new scheduler on the same folders (WebAiOs relaunched); the caller stopped the previous one. */
    relancer: () => (p = new PlanificateurWidgets(options())),
  };
}

test("a due widget is harvested at startup then according to its frequency (fake clock)", async () => {
  const { p, recoltes, recolter, avancer } = await preparer();
  await p.demarrer();
  await vi.waitFor(() => expect(recoltes).toEqual(["actus"]));
  // The launch check finishes (otherwise the next one would be skipped without checking anything).
  await vi.waitFor(() => expect(recolter.mock.settledResults).toHaveLength(1));
  await new Promise((r) => setTimeout(r, 20));
  avancer(59 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  avancer(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(recoltes).toEqual(["actus", "actus"]);
});

test("the harvest receives the widget, the data folder, the engine and the AI", async () => {
  const { p, recolter, dossierWidgets, c } = await preparer();
  await p.verifier({ auLancement: true });
  const o = recolter.mock.calls[0]![0];
  expect(o).toMatchObject({ id: "actus", dossierWidgets, moteur: "/moteur", ia: null });
  expect(o.widget).toMatchObject({ id: "actus", dossier: join(c.widgets, "actus") });
  // surChange follows every write made by the harvest.
  expect(o.surChange).toBeTypeOf("function");
});

test("with a given dispatcher, the harvests use it", async () => {
  const cles: string[] = [];
  const acces = { kev: vi.fn(), gemma: vi.fn(), oublier: vi.fn() };
  const repartiteur = { pour: (cle: string) => (cles.push(cle), acces) };
  const { p, recolter } = await preparer({ options: { repartiteur } });
  await p.verifier({ auLancement: true });
  expect(recolter.mock.calls[0]![0].ia).toBe(acces);
  expect(cles).toEqual([`actus:${DEBUT.toISOString()}`]);
  expect(acces.oublier).toHaveBeenCalledTimes(1);
});

test("the throttle and the search base are passed to each harvest and each trial; absent, nothing is passed", async () => {
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

test("accord-requis is never retried on its own", async () => {
  const { p, recoltes, dossierWidgets, avancer } = await preparer();
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "accord-requis", derniereMaj: null, derniereTentative: null, erreur: "Accord requis" });
  expect(await p.verifier({ auLancement: true })).toEqual([]);
  avancer(24 * 60 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  expect(recoltes).toEqual([]);
  // An explicit request, however, goes through (the harvest checks the grant itself).
  await p.recolterMaintenant("actus");
  expect(recoltes).toEqual(["actus"]);
});

test("workshop stopped: status atelier-arrete, data kept", async () => {
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
  // Not rewritten every minute.
  await p.verifier({ auLancement: false });
  expect(changements).toHaveBeenCalledTimes(1);
  // recolterMaintenant launches nothing either.
  expect((await p.recolterMaintenant("actus")).statut).toBe("atelier-arrete");
  expect(recoltes).toEqual([]);
  // The workshop comes back: the harvest resumes at the next check.
  fixerAtelier("demarre");
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
});

test("an error is retried after 15 min, not before", async () => {
  const { p, recoltes, avancer } = await preparer({ statut: "erreur" });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  avancer(14 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  avancer(2 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(recoltes).toEqual(["actus", "actus"]);
});

test("in-progress is relaunched at launch only", () => {
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

test("recolterMaintenant waits for the harvest in progress: only one at a time", async () => {
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

test("recolterMaintenant on an unknown widget throws an error", async () => {
  const { p } = await preparer();
  await expect(p.recolterMaintenant("absent")).rejects.toThrow(/inconnu/);
});

test("arreter: the harvest in progress is removed and its previous state restored", async () => {
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

test("arreter while the harvest checks the workshop: it does not start", async () => {
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

test("arreter: a harvest that exceeds the wait sees its container removed once more", async () => {
  const { dossierWidgets, recolter, atelier, c } = await preparer();
  await p!.arreter();
  let lancee = false;
  let demarrer!: () => void;
  const premiereSuppression = new Promise<void>((r) => (demarrer = r));
  recolter.mockImplementation(async (o) => {
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: null });
    // The container starts after the first removal, and the harvest does not finish.
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

test("the first check waits for the workshop to be ready: no « atelier arrêté » at launch", async () => {
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

test("a harvest that throws an error after writing in-progress leaves a core error state", async () => {
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
  // Same through the background check.
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "en-cours", derniereMaj: null, derniereTentative: null });
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect((await lireEtatWidget(dossierWidgets, "actus")).statut).toBe("erreur");
});

test("at each check, grants and data of a widget whose folder disappeared are erased", async () => {
  const { p, dossierWidgets, c } = await preparer();
  for (const id of ["actus", "parti"]) {
    await ecrireDonnees(dossierWidgets, id, { secret: id });
    await accorder(dossierWidgets, id, { domaines: ["x.fr"], publiques: [], profil: "defaut" });
  }
  // An unreadable widget keeps its data: its folder exists.
  await ecrireWidget(c, "casse", "{", {});
  await ecrireDonnees(dossierWidgets, "casse", { secret: "casse" });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await lireAccords(dossierWidgets)).sort()).toEqual(["actus"]);
  expect(existsSync(join(dossierWidgets, "parti"))).toBe(false);
  expect(await lireDonnees(dossierWidgets, "casse")).toEqual({ secret: "casse" });
  expect(existsSync(join(dossierWidgets, "actus"))).toBe(true);
  // Without a widgets folder at all (unreadable space), nothing is erased.
  await rm(c.widgets, { recursive: true, force: true });
  await p.verifier({ auLancement: false });
  expect(Object.keys(await lireAccords(dossierWidgets))).toEqual(["actus"]);
});

test("a widget with workflow.json without recolte.mjs is harvested when it is due", async () => {
  const { p, c, recoltes } = await preparer();
  await ecrireWidget(c, "flux", declarationWidget(undefined, { recolte: { minutes: 60 } }), {
    "workflow.json": JSON.stringify({ version: 1, blocs: [{ id: "sortie", type: "sortie", parametres: { vers: "widget" } }] }),
  });
  expect((await p.verifier({ auLancement: true })).sort()).toEqual(["actus", "flux"]);
  expect(recoltes.sort()).toEqual(["actus", "flux"]);
});

test("trigger: planifiee for the check, manuelle by default for recolterMaintenant, otherwise the requested one", async () => {
  const { p, recolter } = await preparer();
  await p.verifier({ auLancement: true });
  await p.recolterMaintenant("actus");
  await p.recolterMaintenant("actus", "agent");
  expect(recolter.mock.calls.map(([o]) => o.declencheur)).toEqual(["planifiee", "manuelle", "agent"]);
  expect(recolter.mock.calls[0]![0].interrompue).toBeTypeOf("function");
});

test("stop during the run: run interrupted, previous state restored", async () => {
  const { p, recolter, dossierWidgets, atelier } = await preparer();
  const avant: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", avant);
  let tuer!: () => void;
  const lance = vi.fn();
  // A container that never answers: only the stop ends it.
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

test("the vanished folder also erases runs and memory", async () => {
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

/** A promise to resolve from the outside. */
function differe<T>() {
  let resoudre!: (v: T) => void;
  const promesse = new Promise<T>((ok) => (resoudre = ok));
  return { promesse, resoudre };
}

test("a scheduled run due during a trial waits for its end", async () => {
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

test("two rejouer requested back to back run one after the other", async () => {
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

test("an avancement or lecture trace does not change a widget's live tracking", async () => {
  const { p, recolterEssai, directs } = await preparer();
  const vus: { avant: EtatDirect; apres: EtatDirect; signales: number }[] = [];
  recolterEssai.mockImplementation(async (o) => {
    o.surTrace!({ bloc: "liste", etape: "debut" });
    const avant = structuredClone(p.direct());
    const signales = directs.length;
    o.surTrace!({ bloc: "liste", etape: "avancement", faits: 2, total: 5 });
    o.surTrace!({ bloc: "liste", etape: "lecture", hote: "gitlab.com" });
    o.surTrace!({ bloc: "autre", etape: "lecture", hote: "gitlab.com" });
    vus.push({ avant, apres: structuredClone(p.direct()), signales: directs.length - signales });
    return { ok: true, execution: idEssai(DEBUT.toISOString()), statut: "reussie" };
  });
  await p.rejouer("actus", "o", "liste");
  expect(vus[0]!.apres).toEqual(vus[0]!.avant);
  expect(vus[0]!.apres.courants[0]!.blocs).toEqual({ liste: { statut: "en-cours", elements: null } });
  expect(vus[0]!.signales).toBe(0);
});

test("direct() shows the running widget, its kind and its blocks as traces come, then nothing", async () => {
  const { p, recolterEssai, directs, dossierWidgets } = await preparer();
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  const vus: EtatDirect[] = [];
  recolterEssai.mockImplementation(async (o) => {
    o.surTrace!({ bloc: "liste", etape: "debut" });
    vus.push(structuredClone(p.direct()));
    o.surTrace!({ bloc: "liste", etape: "fin", statut: "reussi", elements: 3 });
    // Started, without an end: only the final run says it failed.
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
  // End: resynchronized on the written run, then nothing in progress.
  expect(directs.at(-2)!.courants[0]!.blocs).toEqual({ liste: { statut: "reussi", elements: 3 }, sortie: { statut: "echoue", elements: null } });
  expect(directs.at(-1)).toEqual({ courants: [], enAttente: [] });
  expect(p.direct()).toEqual({ courants: [], enAttente: [] });
  // A real run is tracked the same way, kind « execution ».
  await p.recolterMaintenant("actus");
  expect(directs.some((d) => d.courants.some((x) => x.genre === "execution" && x.widget === "actus"))).toBe(true);
  expect(p.direct().courants).toEqual([]);
});

test("enAttente lists a widget requested while another runs", async () => {
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

test("workshop stopped: rejouer refuses without changing the state", async () => {
  const { p, recolterEssai, dossierWidgets, changements } = await preparer({ atelier: "arrete" });
  const etat: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", etat);
  expect(await p.rejouer("actus", "o", "liste")).toEqual({ ok: false, erreur: ERREUR_ATELIER_ARRETE });
  expect(recolterEssai).not.toHaveBeenCalled();
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual(etat);
  expect(changements).not.toHaveBeenCalled();
});

test("widgetDu: a widget with hours without minutes is never due by frequency", () => {
  const w = {
    id: "a",
    dossier: "/a",
    declaration: { ...declarationWidget(), description: "", sources: { compte: [], publiques: [], web: false }, recolte: { heures: ["07:00"] } },
    // The time of day is already done: only the frequency could make it due.
    etat: { statut: "ok" as const, derniereMaj: null, derniereTentative: null, heures: { faite: creneauCourant(["07:00"], DEBUT), echecs: null } },
    donnees: null,
    exemple: null,
    aRecolte: true,
    aWorkflow: false,
    aAffichage: true,
  };
  expect(widgetDu(w, DEBUT, { auLancement: true })).toBe(false);
  expect(widgetDu({ ...w, etat: { ...w.etat, statut: "erreur" as const } }, DEBUT, { auLancement: false })).toBe(false);
});

// --- Two lanes: watches (dureeMaxMinutes > 3) run apart ---

/** A widget that harvests every 60 min, with the given maximum duration. */
async function ecrireVeille(c: CheminsEspace, id: string, dureeMaxMinutes: number) {
  await ecrireWidget(c, id, declarationWidget(undefined, { recolte: { minutes: 60, dureeMaxMinutes } }), { "recolte.mjs": "export default () => 1" });
}

/** The harvests of the `retenus` widgets wait for `liberer(id)`; all then go through the base fake harvest. */
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

test("voieDe: long beyond VOIE_LONGUE_MINUTES (3), short otherwise", async () => {
  expect(VOIE_LONGUE_MINUTES).toBe(3);
  const { c, dossierWidgets } = await preparer();
  await ecrireVeille(c, "trois", 3);
  await ecrireVeille(c, "quatre", 4);
  const widgets = (await lireAccueil(c, dossierWidgets)).widgets;
  const voie = (id: string) => voieDe(widgets.find((w) => w.id === id)!);
  expect([voie("actus"), voie("trois"), voie("quatre"), voie("fixe")]).toEqual(["courte", "courte", "longue", "courte"]);
});

test("a long run (dureeMaxMinutes 30) does not prevent a short widget from running", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  // The check launches the watch without waiting for it, and harvests « actus » while it runs.
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  expect(r.journal).toContain("fin actus");
  await vi.waitFor(() => expect(r.journal).toContain("début veille"));
  expect(r.journal).not.toContain("fin veille");
  // A manual request for a short widget goes through too.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("two long widgets: one after the other", async () => {
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

test("a long widget and its trial: never at the same time", async () => {
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
  // A short widget runs in the meantime: the waiting trial does not block its lane.
  await p.recolterMaintenant("actus");
  expect(r.journal).not.toContain("essai veille");
  r.liberer("veille");
  await execution;
  expect(await essai).toMatchObject({ ok: true });
  expect(r.journal.indexOf("fin veille")).toBeLessThan(r.journal.indexOf("essai veille"));
});

test("dureeMaxMinutes changed from 30 to 2 during the run: the new request waits for the first to end", async () => {
  const { p, c, recolter, recoltes } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  const premiere = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  await ecrireVeille(c, "veille", 2);
  const seconde = p.recolterMaintenant("veille");
  // The short lane stays free for the other widgets, and a check does not wait for this busy widget.
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

test("a check is not stuck by a long run: a short widget due later is harvested", async () => {
  const { p, c, recolter, avancer } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille"]);
  expect(await p.verifier({ auLancement: true })).toEqual(["actus"]);
  avancer(61 * MIN);
  // « actus » is due again; the watch too according to its data, but it is still running: not relaunched.
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  avancer(61 * MIN);
  expect(await p.verifier({ auLancement: false })).toEqual(["actus"]);
  expect(r.journal.filter((l) => l === "début veille")).toHaveLength(1);
  r.liberer("veille");
  await vi.waitFor(() => expect(r.journal).toContain("fin veille"));
});

test("direct().courants lists both runs", async () => {
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

test("arreter removes both containers and waits for both lanes", async () => {
  const { p, c, recolter, atelier } = await preparer();
  await ecrireVeille(c, "veille", 30);
  const r = retenir(recolter, ["veille", "actus"]);
  const supprimees: string[] = [];
  const tour = () => new Promise((ok) => setImmediate(ok));
  atelier.supprimerRecolte = async (id) => {
    supprimees.push(id);
    if (id === "actus") return void setImmediate(() => r.liberer(id));
    // The killed watch ends well after the short one (it still writes its memory and its « interrompue » run).
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

test("arreter: a long run that does not finish is awaited in a bounded way, its container removed twice", async () => {
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

test("the AI goes through the dispatcher: each run has its view, calls reach the given AI, refused after its end", async () => {
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
  // The run finished, its view refuses: a late call no longer goes to the AI.
  await expect(vues[0]!.gemma({ prompt: "tard" })).rejects.toThrow(IA_ABANDONNEE);
  expect(appels).toHaveLength(3);
});

test("dureeMaxMinutes changed from 2 to 30 while a request waits: it goes into the long lane", async () => {
  const { p, c, recolter } = await preparer();
  await ecrireVeille(c, "veille", 2);
  const r = retenir(recolter, ["veille"]);
  const premiere = p.recolterMaintenant("veille");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille"]));
  const seconde = p.recolterMaintenant("veille");
  // Every read the request would do right away (lane choice on request) is finished before the change.
  await new Promise((ok) => setImmediate(ok));
  await vi.waitFor(() => expect(lectures.enVol).toBe(0));
  await ecrireVeille(c, "veille", 30);
  r.liberer("veille");
  await premiere;
  await vi.waitFor(() => expect(r.journal.filter((l) => l === "début veille")).toHaveLength(2));
  // The second runs in the long lane: the short lane and the check stay free.
  expect((await p.recolterMaintenant("actus")).statut).toBe("ok");
  expect(await p.verifier({ auLancement: false })).toEqual([]);
  r.liberer("veille");
  expect((await seconde).statut).toBe("ok");
});

test("widget changed from 30 to 2 just before a trial: the trial goes through during another widget's watch", async () => {
  const { p, c, recolter, recolterEssai } = await preparer();
  await ecrireVeille(c, "veille-a", 30);
  await ecrireVeille(c, "veille-b", 30);
  const r = retenir(recolter, ["veille-a"]);
  // Watch A runs in the long lane; the scheduler read B at 30 in the meantime.
  const a = p.recolterMaintenant("veille-a");
  await vi.waitFor(() => expect(r.journal).toEqual(["début veille-a"]));
  await ecrireVeille(c, "veille-b", 2);
  expect(await p.rejouer("veille-b", "o", "liste")).toMatchObject({ ok: true });
  expect(recolterEssai.mock.calls.map((x) => x[0].id)).toEqual(["veille-b"]);
  expect(r.journal).not.toContain("fin veille-a");
  r.liberer("veille-a");
  await a;
});

// --- Heures fixes ---

/** Local time of October 29, 2026 (or of the given day). */
const le = (h: number, m: number, jour = 29) => new Date(2026, 9, jour, h, m);

/** A widget « matin » at fixed hours (and at a frequency if `minutes`). */
async function ecrireMatin(c: CheminsEspace, recolte: { heures: string[]; minutes?: number }, extra: Record<string, unknown> = {}) {
  await ecrireWidget(c, "matin", declarationWidget(undefined, { recolte, ...extra }), { "recolte.mjs": "export default () => 1" });
}

const duMatin = (recoltes: string[]) => recoltes.filter((x) => x === "matin").length;

test("hours and minutes: both apply", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { minutes: 120, heures: ["07:00"] });
  fixer(le(6, 0));
  await p.verifier({ auLancement: true });
  expect(duMatin(recoltes)).toBe(1); // by frequency (never harvested)
  // Before the first hour of the day: no effect on the tracking.
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toBeUndefined();
  fixer(le(6, 30));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
  fixer(le(7, 0));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(2); // by the hour, the data is only an hour old
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  for (const [h, m] of [[7, 1], [8, 59]] as const) {
    fixer(le(h, m));
    await p.verifier({ auLancement: false });
  }
  expect(duMatin(recoltes)).toBe(2);
  fixer(le(9, 0));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(3); // by frequency, 2 h after 07:00
});

test("interrupted: caught up at the next launch the same day", async () => {
  const { p, c, recoltes, recolter, fixer, dossierWidgets, atelier, relancer } = await preparer();
  await ecrireMatin(c, { heures: ["07:00"] });
  const base = recolter.getMockImplementation()!;
  let tuer: (() => void) | undefined;
  recolter.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    recoltes.push(o.id);
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: le(7, 0).toISOString() });
    await new Promise<void>((r) => (tuer = r));
    return { etat: { statut: "erreur", derniereMaj: null, derniereTentative: le(7, 0).toISOString(), erreur: "Interrompue" } };
  });
  atelier.supprimerRecolte = async () => tuer?.();
  fixer(le(7, 0));
  const verif = p.verifier({ auLancement: true });
  await vi.waitFor(() => expect(duMatin(recoltes)).toBe(1));
  // `tuer` is only set after the in-progress state is written: without it, arreter() would wait 15 s (F5).
  await vi.waitFor(() => expect(tuer).toBeDefined());
  await p.arreter();
  await verif;
  // Interrupted: no effect on the tracking, the earlier state is restored.
  expect(await lireEtatWidget(dossierWidgets, "matin")).toEqual({ statut: "ok", derniereMaj: null, derniereTentative: null });
  recolter.mockImplementation(base);
  fixer(le(7, 30));
  const p2 = relancer();
  await p2.verifier({ auLancement: true });
  expect(duMatin(recoltes)).toBe(2);
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: "2026-10-29T07:00", echecs: null });
  fixer(le(7, 31));
  await p2.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(2);
});

test("abrupt stop (in-progress at launch): the missed hour is caught up once", async () => {
  const { p, c, recoltes, recolter, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00", "12:00"] });
  await ecrireEtatWidget(dossierWidgets, "matin", {
    statut: "en-cours", derniereMaj: null, derniereTentative: le(12, 0).toISOString(), progression: { faits: 7, total: 12 },
    heures: { faite: "2026-10-29T07:00", echecs: null },
  });
  fixer(le(14, 0));
  await p.demarrer();
  await vi.waitFor(() => expect(recolter.mock.settledResults.filter((r) => r.type === "fulfilled")).toHaveLength(2));
  expect(duMatin(recoltes)).toBe(1);
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: "2026-10-29T12:00", echecs: null });
  fixer(le(14, 1));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
});

test("in-progress at launch of an hours widget already done today: not relaunched, its state restored", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00"] });
  const heures = { faite: "2026-10-29T07:00", echecs: null };
  await ecrireEtatWidget(dossierWidgets, "matin", {
    statut: "en-cours", derniereMaj: le(7, 5).toISOString(), derniereTentative: le(8, 0).toISOString(), progression: { faits: 7, total: 12 }, heures,
  });
  fixer(le(9, 0));
  await p.verifier({ auLancement: true });
  expect(duMatin(recoltes)).toBe(0);
  // No frozen « 7 / 12 ».
  expect(await lireEtatWidget(dossierWidgets, "matin")).toEqual({ statut: "ok", derniereMaj: le(7, 5).toISOString(), derniereTentative: le(8, 0).toISOString(), heures });
});

test("in-progress at launch while a trial waits: the state is restored before any run, the widget relaunched afterwards", async () => {
  const { p, recoltes, recolterEssai, dossierWidgets } = await preparer();
  // Fresh data: only the abrupt stop makes it due at launch.
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "en-cours", derniereMaj: DEBUT.toISOString(), derniereTentative: DEBUT.toISOString(), progression: { faits: 7, total: 12 } });
  const fin = differe<ResultatEssai>();
  const commence = differe<void>();
  recolterEssai.mockImplementation(async () => {
    commence.resoudre();
    return fin.promesse;
  });
  const essai = p.rejouer("actus", "o", "liste");
  await commence.promesse;
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual({ statut: "ok", derniereMaj: DEBUT.toISOString(), derniereTentative: DEBUT.toISOString() });
  const verification = p.verifier({ auLancement: true });
  fin.resoudre({ ok: true, execution: "x-essai", statut: "reussie" });
  await essai;
  expect(await verification).toEqual(["actus"]);
  expect(recoltes).toEqual(["actus"]);
});

test("a trial does not count for the hour", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00"] });
  fixer(le(7, 0));
  expect(await p.rejouer("matin", "o", "liste")).toMatchObject({ ok: true });
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toBeUndefined();
  fixer(le(7, 1));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
});

test("Mac asleep over several hours: a single catch-up on wake", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00", "09:00", "12:00"] });
  fixer(le(6, 0));
  await p.verifier({ auLancement: true });
  expect(duMatin(recoltes)).toBe(0);
  // Wake at 3 pm: 07:00, 09:00 and 12:00 missed, a single run.
  for (let t = le(15, 0).getTime(); t <= le(23, 59).getTime(); t += 30 * MIN) {
    fixer(new Date(t));
    await p.verifier({ auLancement: false });
  }
  expect(duMatin(recoltes)).toBe(1);
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: "2026-10-29T12:00", echecs: null });
});

test("midnight: the hour missed the day before is not caught up, the next day's is", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00", "22:00"] });
  // 22:00 missed on the 29th (WebAiOs closed); reopened after midnight.
  await ecrireEtatWidget(dossierWidgets, "matin", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: { faite: "2026-10-29T07:00", echecs: null } });
  for (const [h, m] of [[0, 0], [0, 1], [3, 0], [6, 59]] as const) {
    fixer(le(h, m, 30));
    await p.verifier({ auLancement: h === 0 && m === 0 });
  }
  expect(duMatin(recoltes)).toBe(0);
  fixer(le(7, 0, 30));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: "2026-10-30T07:00", echecs: null });
});

test("failures: retried 15 min later, 3 times at most, then nothing until the next hour", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer({ statut: "erreur" });
  await ecrireMatin(c, { heures: ["07:00", "12:00"] });
  const tentatives: string[] = [];
  for (let t = le(7, 0).getTime(); t <= le(12, 0).getTime(); t += MIN) {
    fixer(new Date(t));
    const avant = duMatin(recoltes);
    await p.verifier({ auLancement: false });
    if (duMatin(recoltes) > avant) tentatives.push(`${new Date(t).getHours()}:${String(new Date(t).getMinutes()).padStart(2, "0")}`);
  }
  expect(tentatives).toEqual(["7:00", "7:15", "7:30", "7:45", "12:00"]);
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual({ faite: null, echecs: { heure: "2026-10-29T12:00", nombre: 1, fin: le(12, 0).toISOString() } });
});

test("a manual run before the first hour does not erase the previous day's tracking; one at 07:10 counts for 07:00", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  await ecrireMatin(c, { heures: ["07:00"] });
  const veille = { faite: "2026-10-28T07:00", echecs: null };
  await ecrireEtatWidget(dossierWidgets, "matin", { statut: "ok", derniereMaj: null, derniereTentative: null, heures: veille });
  fixer(le(6, 50));
  expect(await p.recolterMaintenant("matin")).toMatchObject({ statut: "ok" });
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual(veille);
  fixer(le(7, 10));
  expect(await p.recolterMaintenant("matin", "agent")).toMatchObject({ statut: "ok", heures: { faite: "2026-10-29T07:00", echecs: null } });
  fixer(le(7, 11));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(2);
});

test("the hours tracking survives a grant removed then granted again", async () => {
  const { p, c, recoltes, fixer, dossierWidgets } = await preparer();
  const sources = { compte: ["mail.example.com"], publiques: [] };
  await ecrireMatin(c, { heures: ["07:00"] }, { sources });
  await accorder(dossierWidgets, "matin", { domaines: ["mail.example.com"], publiques: [], profil: "defaut" });
  fixer(le(7, 0));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
  const faite = { faite: "2026-10-29T07:00", echecs: null };
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual(faite);
  // Like refuserAccord: data erased, state waiting for a grant.
  await supprimerDonnees(dossierWidgets, "matin");
  const avant = await lireEtatWidget(dossierWidgets, "matin");
  await ecrireEtatWidget(dossierWidgets, "matin", { statut: "accord-requis", derniereMaj: avant.derniereMaj, derniereTentative: avant.derniereTentative, erreur: "accord", erreurNoyau: true });
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual(faite);
  fixer(le(7, 5));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(1);
  // Granted again: the harvest that follows the grant counts, and the hour is not redone.
  await accorder(dossierWidgets, "matin", { domaines: ["mail.example.com"], publiques: [], profil: "defaut" });
  await p.recolterMaintenant("matin");
  expect((await lireEtatWidget(dossierWidgets, "matin")).heures).toEqual(faite);
  fixer(le(7, 30));
  await p.verifier({ auLancement: false });
  expect(duMatin(recoltes)).toBe(2);
});

test("watch failing after 30 min: the retry starts at the earliest 15 min after the failure ends", async () => {
  const { p, c, recolter, fixer, horloge, avancer, dossierWidgets } = await preparer({ statut: "erreur" });
  await ecrireMatin(c, { heures: ["07:00", "12:00"] });
  const base = recolter.getMockImplementation()!;
  const departs: string[] = [];
  recolter.mockImplementation(async (o) => {
    if (o.id !== "matin") return base(o);
    const debut = horloge();
    departs.push(`${debut.getHours()}:${String(debut.getMinutes()).padStart(2, "0")}`);
    // derniereTentative = the start, like the real harvest; the failure comes 30 min later.
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "en-cours", derniereMaj: null, derniereTentative: debut.toISOString() });
    avancer(30 * MIN);
    await ecrireEtatWidget(o.dossierWidgets, o.id, { statut: "erreur", derniereMaj: null, derniereTentative: debut.toISOString(), erreur: "délai" });
    return { etat: { statut: "erreur", derniereMaj: null, derniereTentative: debut.toISOString(), erreur: "délai" } };
  });
  fixer(le(7, 0));
  while (horloge() < le(11, 59)) {
    await p.verifier({ auLancement: false });
    avancer(MIN);
  }
  expect(departs).toEqual(["7:00", "7:45", "8:30", "9:15"]);
  const { heures } = await lireEtatWidget(dossierWidgets, "matin");
  expect(heures?.echecs).toMatchObject({ heure: "2026-10-29T07:00", nombre: 4 });
});

test("abrupt stop: the state from before the run (error) is restored; clean stop: nothing of the run remains", async () => {
  const { p, c, recolter, fixer, dossierWidgets, atelier, recoltes } = await preparer();
  await ecrireMatin(c, { heures: ["07:00"] });
  const heures = { faite: "2026-10-29T07:00", echecs: null };
  await ecrireEtatWidget(dossierWidgets, "matin", {
    statut: "en-cours", derniereMaj: null, derniereTentative: le(8, 0).toISOString(), progression: { faits: 7, total: 12 }, heures,
    avant: { statut: "erreur", erreur: "Sélecteur introuvable", erreurNoyau: true },
  });
  fixer(le(9, 0));
  await p.verifier({ auLancement: true });
  expect(duMatin(recoltes)).toBe(0);
  expect(await lireEtatWidget(dossierWidgets, "matin")).toEqual({
    statut: "erreur", derniereMaj: null, derniereTentative: le(8, 0).toISOString(), erreur: "Sélecteur introuvable", erreurNoyau: true, heures,
  });
  // Clean stop during a real harvest: the earlier state comes back without the avant field.
  const avant: EtatWidget = { statut: "ok", derniereMaj: "2026-10-27T08:00:00.000Z", derniereTentative: "2026-10-27T08:00:00.000Z" };
  await ecrireEtatWidget(dossierWidgets, "actus", avant);
  let tuer!: () => void;
  const lance = vi.fn();
  const lancer: LanceurProcessus = () => {
    lance();
    const fin = new Promise<number | null>((r) => (tuer = () => r(null)));
    return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), tuer: () => tuer(), fin };
  };
  recolter.mockImplementation((o) => executerRecolte({ ...o, lancer }));
  atelier.supprimerRecolte = async () => tuer?.();
  const maintenant = p.recolterMaintenant("actus");
  await vi.waitFor(() => expect(lance).toHaveBeenCalled());
  expect((await lireEtatWidget(dossierWidgets, "actus")).avant).toEqual({ statut: "ok" });
  await p.arreter();
  await maintenant;
  expect(await lireEtatWidget(dossierWidgets, "actus")).toEqual(avant);
});

test("a surChange callback that throws during the startup restore does not block the runs", async () => {
  const { dossierWidgets, recoltes, relancer, p: premier } = await preparer({ options: { surChange: () => { throw new Error("rappel"); } } });
  await premier.arreter();
  await ecrireEtatWidget(dossierWidgets, "actus", { statut: "en-cours", derniereMaj: null, derniereTentative: null });
  const p2 = relancer();
  const erreurs = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await p2.recolterMaintenant("actus").catch(() => {});
    await expect(p2.verifier({ auLancement: true })).resolves.toEqual(expect.any(Array));
  } finally {
    erreurs.mockRestore();
  }
  expect(recoltes.length).toBeGreaterThan(0);
});

describe("notification de fin de veille", () => {
  /** A « veille » widget that notifies, and a spy notifier; the fake harvest returns `nouveaux` (and `statut`). */
  async function preparerVeille(o: { notifier?: boolean; nouveaux?: number; statut?: EtatWidget["statut"]; sansRappel?: boolean } = {}) {
    const notifications: NotificationWidget[] = [];
    const notifier = vi.fn((n: NotificationWidget) => void notifications.push(n));
    const t = await preparer({ options: o.sansRappel ? {} : { notifier } });
    await ecrireWidget(
      t.c,
      "veille",
      declarationWidget(undefined, { nom: "Vélos d'occasion", recolte: { minutes: 60, ...(o.notifier === false ? {} : { notifier: true }) } }),
      { "recolte.mjs": "export default () => 1" },
    );
    t.recolter.mockImplementation(async (r) => {
      const statut = o.statut ?? "ok";
      const etat: EtatWidget = { statut, derniereMaj: DEBUT.toISOString(), derniereTentative: DEBUT.toISOString(), ...(statut === "erreur" ? { erreur: "boum" } : {}) };
      if (statut === "ok") await ecrireDonnees(r.dossierWidgets, r.id, [{ titre: "PIÈGE annonce", url: "https://x.test/1" }]);
      await ecrireEtatWidget(r.dossierWidgets, r.id, etat);
      return { etat, ...(o.nouveaux !== undefined ? { nouveaux: o.nouveaux } : {}) };
    });
    return { ...t, notifier, notifications };
  }

  test("3 new items: one notification, title = widget name, text « 3 nouveaux éléments »", async () => {
    const { p, notifications } = await preparerVeille({ nouveaux: 3 });
    await p.recolterMaintenant("veille");
    expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "3 nouveaux éléments" }]);
  });

  test("1 new item: singular text", async () => {
    const { p, notifications } = await preparerVeille({ nouveaux: 1 });
    await p.recolterMaintenant("veille");
    expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "1 nouvel élément" }]);
  });

  test("zero new, failure, trial, widget without notifier: none", async () => {
    const zero = await preparerVeille({ nouveaux: 0 });
    await zero.p.recolterMaintenant("veille");
    await zero.p.recolterMaintenant("veille", "planifiee");
    expect(zero.notifier).not.toHaveBeenCalled();
    await zero.p.arreter();

    const echec = await preparerVeille({ nouveaux: 2, statut: "erreur" });
    await echec.p.recolterMaintenant("veille");
    expect(echec.notifier).not.toHaveBeenCalled();
    await echec.p.arreter();

    const essai = await preparerVeille({ nouveaux: 2 });
    expect(await essai.p.rejouer("veille", "2026-10-28T09-00-00-000Z", "liste")).toMatchObject({ ok: true });
    expect(essai.recolterEssai).toHaveBeenCalledTimes(1);
    expect(essai.notifier).not.toHaveBeenCalled();
    await essai.p.arreter();

    // The widget does not declare `notifier`: even if the harvest returned a count, nothing.
    const sans = await preparerVeille({ nouveaux: 2, notifier: false });
    await sans.p.recolterMaintenant("veille");
    expect(sans.notifier).not.toHaveBeenCalled();
    await sans.p.arreter();

    // No callback given to the scheduler: the harvest ends as before.
    const sansRappel = await preparerVeille({ nouveaux: 2, sansRappel: true });
    expect((await sansRappel.p.recolterMaintenant("veille")).statut).toBe("ok");
  });

  test("the text contains nothing from the data (trapped listing title)", async () => {
    const { p, notifications, dossierWidgets } = await preparerVeille({ nouveaux: 1 });
    await p.recolterMaintenant("veille");
    expect(await lireDonnees(dossierWidgets, "veille")).toEqual([{ titre: "PIÈGE annonce", url: "https://x.test/1" }]);
    expect(notifications).toHaveLength(1);
    expect(JSON.stringify(notifications)).not.toMatch(/PIÈGE|x\.test/);
    expect(notifications[0]!.texte).toBe("1 nouvel élément");
  });

  test("a notifier that throws does not prevent the run from finishing", async () => {
    const erreurs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { p, notifier, dossierWidgets } = await preparerVeille({ nouveaux: 3 });
      notifier.mockImplementation(() => {
        throw new Error("Notification impossible");
      });
      const etat = await p.recolterMaintenant("veille");
      expect(notifier).toHaveBeenCalledTimes(1);
      expect(etat.statut).toBe("ok");
      expect((await lireEtatWidget(dossierWidgets, "veille")).statut).toBe("ok");
      expect(erreurs).toHaveBeenCalledWith(expect.stringContaining("notification du widget veille"), expect.any(Error));
    } finally {
      erreurs.mockRestore();
    }
  });
});

test("notification: the widget name is cleaned (controls and invisible characters replaced, on one line)", async () => {
  const notifications: NotificationWidget[] = [];
  const { p, c, recolter } = await preparer({ options: { notifier: (n) => void notifications.push(n) } });
  await ecrireWidget(c, "veille", declarationWidget(undefined, { nom: "‮Vélos\n\nd'occasion​\t ", recolte: { minutes: 60, notifier: true } }), {
    "recolte.mjs": "export default () => 1",
  });
  recolter.mockImplementation(async () => ({ etat: { statut: "ok", derniereMaj: DEBUT.toISOString(), derniereTentative: DEBUT.toISOString() }, nouveaux: 2 }));
  await p.recolterMaintenant("veille");
  expect(notifications).toEqual([{ widget: "veille", titre: "Vélos d'occasion", texte: "2 nouveaux éléments" }]);
});
