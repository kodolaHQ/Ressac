import type { DirectWidget, EtatDirect, Execution, ResumeExecution } from "@webaios/noyau";
import { beforeEach, expect, test } from "vitest";
import { Executions, oublierChoixExecutions, type Lanceur, type SourceExecutions } from "../../src/renderer/constructeur/executions.svelte";

const resume = (id: string, essai = false): ResumeExecution => ({
  id,
  declencheur: essai ? "rejeu" : "planifiee",
  ...(essai ? { essai: { depart: "tri", origine: "a" } } : {}),
  debut: "2026-10-29T10:00:00.000Z",
  fin: "2026-10-29T10:00:01.000Z",
  statut: "reussie",
  blocs: [{ id: "tri", statut: "reussi", elements: 1 }],
});
const complete = (r: ResumeExecution): Execution =>
  ({ ...r, version: 1, proprietaire: { type: "widget", id: "w" }, blocs: r.blocs.map((b) => ({ ...b, type: "ia.trier", debut: null, fin: null, journal: [] })) }) as Execution;

function faux(liste: ResumeExecution[]) {
  const etat = { liste };
  const demandes: string[] = [];
  const source: SourceExecutions = {
    executions: async () => structuredClone(etat.liste),
    execution: async (_w, id) => {
      demandes.push(id);
      const r = etat.liste.find((x) => x.id === id);
      return r ? complete(r) : null;
    },
  };
  return { source, etat, demandes };
}

test("par défaut, la dernière vraie exécution (pas un essai) et son détail", async () => {
  const f = faux([resume("c-essai", true), resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  expect(x.choisie?.id).toBe("b");
  expect(x.detail?.id).toBe("b");
});

test("aucune vraie exécution : rien de choisi", async () => {
  const f = faux([resume("c-essai", true)]);
  const x = new Executions("w", f.source);
  await x.charger();
  expect(x.choisie).toBeNull();
  expect(x.detail).toBeNull();
});

test("choisir une exécution charge son détail ; disparue, on revient à la dernière vraie", async () => {
  const f = faux([resume("c"), resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  await x.choisir("a");
  expect(x.choisie?.id).toBe("a");
  expect(x.detail?.id).toBe("a");
  f.etat.liste = [resume("d"), resume("c")];
  await x.charger();
  expect(x.choisie?.id).toBe("d");
  expect(x.detail?.id).toBe("d");
});

test("une nouvelle vraie exécution devient le choix par défaut ; un choix explicite reste", async () => {
  const f = faux([resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  f.etat.liste = [resume("c"), resume("b"), resume("a")];
  await x.charger();
  expect(x.choisie?.id).toBe("c");
  await x.choisir("b");
  f.etat.liste = [resume("d"), resume("c"), resume("b"), resume("a")];
  await x.charger();
  expect(x.choisie?.id).toBe("b");
});

test("relire sans changement ne redemande pas le détail", async () => {
  const f = faux([resume("b")]);
  const x = new Executions("w", f.source);
  await x.charger();
  await x.charger();
  expect(f.demandes).toEqual(["b"]);
});

test("détail introuvable (chassé entre la liste et le détail) : signalé, la liste est relue une fois", async () => {
  const f = faux([resume("b"), resume("a")]);
  let listes = 0;
  const source: SourceExecutions = {
    executions: async () => {
      listes++;
      return f.source.executions("w");
    },
    execution: async (_w, id) => (id === "b" ? null : f.source.execution("w", id)),
  };
  const x = new Executions("w", source);
  await x.charger();
  expect(x.introuvable).toBe(true);
  expect(x.detail).toBeNull();
  expect(listes).toBe(2);
  await x.choisir("a");
  expect(x.introuvable).toBe(false);
  expect(x.detail?.id).toBe("a");
});

test("détail en erreur : introuvable, pas d'attente sans fin", async () => {
  const f = faux([resume("b")]);
  const x = new Executions("w", { ...f.source, execution: async () => Promise.reject(new Error("canal")) });
  await x.charger();
  expect(x.introuvable).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Direct, « Lancer » et « Rejouer » (tâche 11).

type Rappel = (e: EtatDirect) => void;
function lanceurFaux(f: ReturnType<typeof faux>) {
  const appels: string[] = [];
  const rappels: Rappel[] = [];
  let finir: (() => void) | null = null;
  const lanceur: Lanceur = {
    direct: async () => ({ courant: null, enAttente: [] }),
    surDirect: (r) => {
      rappels.push(r);
      return () => rappels.splice(rappels.indexOf(r), 1);
    },
    lancer: async (id) => {
      appels.push(`lancer ${id}`);
      await new Promise<void>((ok) => (finir = ok));
      f.etat.liste = [resume("nouvelle"), ...f.etat.liste];
      return { execution: "nouvelle" };
    },
    rejouer: async (id, execution, bloc) => {
      appels.push(`rejouer ${id} ${execution} ${bloc}`);
      if (bloc === "page") return { ok: false, erreur: "Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution" };
      f.etat.liste = [resume("e-essai", true), ...f.etat.liste];
      return { ok: true, execution: "e-essai", statut: "reussie" };
    },
  };
  return { lanceur, appels, emettre: (e: EtatDirect) => rappels.forEach((r) => r(e)), rappels, finir: () => finir?.() };
}
const directDe = (widget: string, blocs: DirectWidget["blocs"] = {}, debut = "d1"): EtatDirect => ({
  courant: { widget, genre: "execution", debut, blocs },
  enAttente: [],
});
const attendreQue = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => oublierChoixExecutions([]));

test("occupé quand une exécution de ce widget tourne ou attend ; pas pour un autre widget", async () => {
  const f = faux([resume("b")]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  const fin = x.suivre();
  await x.charger();
  expect(x.occupe).toBe(false);
  l.emettre(directDe("autre"));
  expect(x.occupe).toBe(false);
  expect(x.enDirect).toBeNull();
  l.emettre({ courant: null, enAttente: ["w"] });
  expect(x.occupe).toBe(true);
  l.emettre(directDe("w", { tri: { statut: "en-cours", elements: null } }));
  expect(x.occupe).toBe(true);
  expect(x.enDirect?.blocs.tri?.statut).toBe("en-cours");
  fin();
  expect(l.rappels).toHaveLength(0);
});

test("fin de l'exécution suivie en direct : liste et détail relus, plus de direct périmé", async () => {
  const f = faux([resume("b")]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  l.emettre(directDe("w", { tri: { statut: "en-cours", elements: null } }));
  // L'exécution planifiée s'écrit, le direct s'arrête (les blocs non finis ne sont pas relayés à la fin).
  f.etat.liste = [resume("c"), resume("b")];
  l.emettre({ courant: null, enAttente: [] });
  expect(x.enDirect).toBeNull();
  await attendreQue(() => x.detail?.id === "c");
  expect(x.choisie?.id).toBe("c");
  expect(x.detail?.id).toBe("c");
});

test("deux exécutions de suite sans pause dans le direct : relu aussi", async () => {
  const f = faux([resume("b")]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  l.emettre(directDe("w", {}, "d1"));
  f.etat.liste = [resume("c"), resume("b")];
  l.emettre(directDe("w", {}, "d2"));
  await attendreQue(() => x.detail?.id === "c");
  expect(x.detail?.id).toBe("c");
});

test("▶ Lancer : occupé pendant la demande (un double clic ne relance pas), puis la nouvelle exécution est choisie", async () => {
  const f = faux([resume("b"), resume("a")]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.choisir("a");
  const p = x.lancer();
  expect(x.occupe).toBe(true);
  void x.lancer();
  await attendreQue(() => l.appels.length > 0);
  l.finir();
  await p;
  expect(l.appels).toEqual(["lancer w"]);
  expect(x.occupe).toBe(false);
  expect(x.choisie?.id).toBe("nouvelle");
  expect(x.detail?.id).toBe("nouvelle");
});

test("▶ Lancer sans exécution rendue ({}) : le choix reste", async () => {
  const f = faux([resume("b"), resume("a")]);
  const l = lanceurFaux(f);
  l.lanceur.lancer = async () => ({});
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.choisir("a");
  await x.lancer();
  expect(x.choisie?.id).toBe("a");
});

test("Rejouer depuis un bloc : l'essai rendu est choisi ; refusé, le message reste et rien ne change", async () => {
  const f = faux([resume("b"), resume("a")]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.choisir("a");
  await x.rejouer("page");
  expect(l.appels).toEqual(["rejouer w a page"]);
  expect(x.refus).toBe("Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution");
  expect(x.choisie?.id).toBe("a");
  await x.rejouer("tri");
  expect(l.appels.at(-1)).toBe("rejouer w a tri");
  expect(x.refus).toBeNull();
  expect(x.choisie?.id).toBe("e-essai");
  expect(x.detail?.id).toBe("e-essai");
});

test("Rejouer sans exécution choisie ou pendant une exécution : aucune demande", async () => {
  const f = faux([]);
  const l = lanceurFaux(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  await x.rejouer("tri");
  f.etat.liste = [resume("b")];
  await x.charger();
  l.emettre({ courant: null, enAttente: ["w"] });
  await x.rejouer("tri");
  expect(l.appels).toEqual([]);
});

test("le choix d'une exécution est gardé par widget dans la fenêtre (changer d'onglet ne le perd pas)", async () => {
  const f = faux([resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  await x.choisir("a");
  const y = new Executions("w", f.source);
  await y.charger();
  expect(y.choisie?.id).toBe("a");
  expect(new Executions("v", f.source).voulue).toBeNull();
  oublierChoixExecutions(["v"]);
  expect(new Executions("w", f.source).voulue).toBeNull();
});
