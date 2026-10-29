import type { Execution, ResumeExecution } from "@webaios/noyau";
import { expect, test } from "vitest";
import { Executions, type SourceExecutions } from "../../src/renderer/constructeur/executions.svelte";

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
