import type { DirectWidget, DirectState, Execution, ResumeExecution } from "@webaios/kernel";
import { beforeEach, expect, test } from "vitest";
import { Executions, forgetRunChoices, type Launcher, type SourceExecutions } from "../../ui/builder/executions.svelte";

const resume = (id: string, attempt = false): ResumeExecution => ({
  id,
  declencheur: attempt ? "rejeu" : "planifiee",
  ...(attempt ? { essai: { depart: "tri", origine: "a" } } : {}),
  debut: "2026-10-29T10:00:00.000Z",
  fin: "2026-10-29T10:00:01.000Z",
  statut: "reussie",
  blocs: [{ id: "tri", statut: "reussi", elements: 1 }],
});
const complete = (r: ResumeExecution): Execution =>
  ({ ...r, version: 1, proprietaire: { type: "widget", id: "w" }, blocs: r.blocs.map((b) => ({ ...b, type: "ia.trier", debut: null, fin: null, journal: [] })) }) as Execution;

function fake(list: ResumeExecution[]) {
  const state = { liste: list };
  const requests: string[] = [];
  const source: SourceExecutions = {
    executions: async () => structuredClone(state.liste),
    execution: async (_w, id) => {
      requests.push(id);
      const r = state.liste.find((x) => x.id === id);
      return r ? complete(r) : null;
    },
  };
  return { source, etat: state, demandes: requests };
}

test("by default, the last real run (not a trial) and its detail", async () => {
  const f = fake([resume("c-essai", true), resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  expect(x.choisie?.id).toBe("b");
  expect(x.detail?.id).toBe("b");
});

test("no real run: nothing chosen", async () => {
  const f = fake([resume("c-essai", true)]);
  const x = new Executions("w", f.source);
  await x.charger();
  expect(x.choisie).toBeNull();
  expect(x.detail).toBeNull();
});

test("choosing a run loads its detail; vanished, we go back to the last real one", async () => {
  const f = fake([resume("c"), resume("b"), resume("a")]);
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

test("a new real run becomes the default choice; an explicit choice stays", async () => {
  const f = fake([resume("b"), resume("a")]);
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

test("relire without a change does not ask for the detail again", async () => {
  const f = fake([resume("b")]);
  const x = new Executions("w", f.source);
  await x.charger();
  await x.charger();
  expect(f.demandes).toEqual(["b"]);
});

test("detail not found (evicted between the list and the detail): reported, the list is reread once", async () => {
  const f = fake([resume("b"), resume("a")]);
  let lists = 0;
  const source: SourceExecutions = {
    executions: async () => {
      lists++;
      return f.source.executions("w");
    },
    execution: async (_w, id) => (id === "b" ? null : f.source.execution("w", id)),
  };
  const x = new Executions("w", source);
  await x.charger();
  expect(x.introuvable).toBe(true);
  expect(x.detail).toBeNull();
  expect(lists).toBe(2);
  await x.choisir("a");
  expect(x.introuvable).toBe(false);
  expect(x.detail?.id).toBe("a");
});

test("detail in error: not found, no endless wait", async () => {
  const f = fake([resume("b")]);
  const x = new Executions("w", { ...f.source, execution: async () => Promise.reject(new Error("canal")) });
  await x.charger();
  expect(x.introuvable).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live, « Lancer » and « Rejouer » (task 11).

type Rappel = (e: DirectState) => void;
function falseLauncher(f: ReturnType<typeof fake>) {
  const calls: string[] = [];
  const rappels: Rappel[] = [];
  let finish: (() => void) | null = null;
  const launcher: Launcher = {
    direct: async () => ({ courants: [], enAttente: [] }),
    surDirect: (r) => {
      rappels.push(r);
      return () => rappels.splice(rappels.indexOf(r), 1);
    },
    lancer: async (id) => {
      calls.push(`lancer ${id}`);
      await new Promise<void>((ok) => (finish = ok));
      f.etat.liste = [resume("nouvelle"), ...f.etat.liste];
      return { execution: "nouvelle" };
    },
    rejouer: async (id, execution, bloc) => {
      calls.push(`rejouer ${id} ${execution} ${bloc}`);
      if (bloc === "page") return { ok: false, erreur: "Rejeu impossible : la sortie de « liens » a été tronquée dans cette exécution" };
      f.etat.liste = [resume("e-essai", true), ...f.etat.liste];
      return { ok: true, execution: "e-essai", statut: "reussie" };
    },
  };
  return { lanceur: launcher, appels: calls, emettre: (e: DirectState) => rappels.forEach((r) => r(e)), rappels, finir: () => finish?.() };
}
const directDe = (widget: string, blocs: DirectWidget["blocs"] = {}, debut = "d1"): DirectState => ({
  courants: [{ widget, genre: "execution", debut, blocs }],
  enAttente: [],
});
const waitUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => forgetRunChoices([]));

test("busy when a run of this widget is running or waiting; not for another widget", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  const fin = x.suivre();
  await x.charger();
  expect(x.occupe).toBe(false);
  l.emettre(directDe("autre"));
  expect(x.occupe).toBe(false);
  expect(x.enDirect).toBeNull();
  l.emettre({ courants: [], enAttente: ["w"] });
  expect(x.occupe).toBe(true);
  l.emettre(directDe("w", { tri: { statut: "en-cours", elements: null } }));
  expect(x.occupe).toBe(true);
  expect(x.enDirect?.blocs.tri?.statut).toBe("en-cours");
  fin();
  expect(l.rappels).toHaveLength(0);
});

test("occupe when the widget is among the current or waiting ones", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  const fin = x.suivre();
  await x.charger();
  const watch: DirectWidget = { widget: "veille", genre: "execution", debut: "d0", blocs: {} };
  l.emettre({ courants: [watch], enAttente: [] });
  expect(x.occupe).toBe(false);
  expect(x.enDirect).toBeNull();
  // Two runs at the same time (short lane and long lane): this widget is the second.
  l.emettre({ courants: [watch, { widget: "w", genre: "essai", debut: "d1", blocs: { tri: { statut: "reussi", elements: 2 } } }], enAttente: [] });
  expect(x.occupe).toBe(true);
  expect(x.enDirect).toMatchObject({ widget: "w", genre: "essai", debut: "d1" });
  l.emettre({ courants: [watch], enAttente: ["autre", "w"] });
  expect(x.occupe).toBe(true);
  expect(x.enDirect).toBeNull();
  l.emettre({ courants: [watch], enAttente: ["autre"] });
  expect(x.occupe).toBe(false);
  fin();
});

test("end of the run followed live: list and detail reread, no more stale live", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  l.emettre(directDe("w", { tri: { statut: "en-cours", elements: null } }));
  // The scheduled run is written, the live one stops (unfinished blocks are not relayed at the end).
  f.etat.liste = [resume("c"), resume("b")];
  l.emettre({ courants: [], enAttente: [] });
  expect(x.enDirect).toBeNull();
  await waitUntil(() => x.detail?.id === "c");
  expect(x.choisie?.id).toBe("c");
  expect(x.detail?.id).toBe("c");
});

test("two runs in a row without a pause in the live: reread too", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  l.emettre(directDe("w", {}, "d1"));
  f.etat.liste = [resume("c"), resume("b")];
  l.emettre(directDe("w", {}, "d2"));
  await waitUntil(() => x.detail?.id === "c");
  expect(x.detail?.id).toBe("c");
});

test("▶ Lancer: busy during the request (a double click does not relaunch), then the new run is chosen", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.choisir("a");
  const p = x.lancer();
  expect(x.occupe).toBe(true);
  void x.lancer();
  await waitUntil(() => l.appels.length > 0);
  l.finir();
  await p;
  expect(l.appels).toEqual(["lancer w"]);
  expect(x.occupe).toBe(false);
  expect(x.choisie?.id).toBe("nouvelle");
  expect(x.detail?.id).toBe("nouvelle");
});

test("▶ Lancer without a returned run ({}): the choice stays", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
  l.lanceur.lancer = async () => ({});
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.choisir("a");
  await x.lancer();
  expect(x.choisie?.id).toBe("a");
});

test("Rejouer from a block: the returned trial is chosen; refused, the message stays and nothing changes", async () => {
  const f = fake([resume("b"), resume("a")]);
  const l = falseLauncher(f);
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

test("Rejouer without a chosen run or during a run: no request", async () => {
  const f = fake([]);
  const l = falseLauncher(f);
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  await x.charger();
  await x.rejouer("tri");
  f.etat.liste = [resume("b")];
  await x.charger();
  l.emettre({ courants: [], enAttente: ["w"] });
  await x.rejouer("tri");
  expect(l.appels).toEqual([]);
});

test("the choice of a run is kept per widget in the window (switching tabs does not lose it)", async () => {
  const f = fake([resume("b"), resume("a")]);
  const x = new Executions("w", f.source);
  await x.charger();
  await x.choisir("a");
  const y = new Executions("w", f.source);
  await y.charger();
  expect(y.choisie?.id).toBe("a");
  expect(new Executions("v", f.source).voulue).toBeNull();
  forgetRunChoices(["v"]);
  expect(new Executions("w", f.source).voulue).toBeNull();
});

// Review of task 11.

test("the initial read of the live does not overwrite a more recent pushed event", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  let render: (e: DirectState) => void = () => {};
  l.lanceur.direct = () => new Promise((ok) => (render = ok));
  const x = new Executions("w", f.source, l.lanceur);
  x.suivre();
  l.emettre({ courants: [], enAttente: [] });
  render(directDe("w"));
  await waitUntil(() => false);
  expect(x.occupe).toBe(false);
  expect(x.enDirect).toBeNull();
});

test("Rejouer that fails on the way (channel): the denial says so", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.lanceur.rejouer = () => Promise.reject(new Error("canal fermé"));
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.rejouer("tri");
  expect(x.refus).toBe("Rejeu impossible : canal fermé");
  expect(x.occupe).toBe(false);
});

test("▶ Lancer that fails on the way: nothing wrongly chosen, no longer busy", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.lanceur.lancer = () => Promise.reject(new Error("canal fermé"));
  const error = console.error;
  console.error = () => {};
  try {
    const x = new Executions("w", f.source, l.lanceur);
    await x.charger();
    await x.lancer();
    expect(x.occupe).toBe(false);
    expect(x.choisie?.id).toBe("b");
  } finally {
    console.error = error;
  }
});

test("▶ Lancer that returns the last real run: the default choice resumes, the following ones follow it", async () => {
  const f = fake([resume("b")]);
  const l = falseLauncher(f);
  l.lanceur.lancer = async () => {
    f.etat.liste = [resume("nouvelle"), ...f.etat.liste];
    return { execution: "nouvelle" };
  };
  const x = new Executions("w", f.source, l.lanceur);
  await x.charger();
  await x.lancer();
  expect(x.choisie?.id).toBe("nouvelle");
  expect(x.voulue).toBeNull();
  f.etat.liste = [resume("planifiee"), ...f.etat.liste];
  await x.charger();
  expect(x.choisie?.id).toBe("planifiee");
});

test("a choice made by another builder of the widget (tab left during Lancer) is picked up again on reload", async () => {
  const f = fake([resume("b"), resume("a")]);
  const y = new Executions("w", f.source);
  await y.charger();
  const x = new Executions("w", f.source);
  await x.choisir("a");
  await y.charger();
  expect(y.choisie?.id).toBe("a");
});
