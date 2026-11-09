import type { Execution, ResumeExecution } from "@webaios/kernel";
import { expect, test } from "vitest";
import { previewData } from "../../ui/builder/preview";

const resume = (id: string, attempt = false): ResumeExecution => ({
  id,
  declencheur: attempt ? "rejeu" : "manuelle",
  ...(attempt ? { essai: { depart: "tri", origine: "a" } } : {}),
  debut: "d",
  fin: "f",
  statut: "reussie",
  blocs: [],
});
const detail = (id: string, output: { sortie?: unknown; sortieTronquee?: true } | null): Execution =>
  ({
    id,
    version: 1,
    proprietaire: { type: "widget", id: "w" },
    declencheur: "manuelle",
    debut: "d",
    fin: "f",
    statut: "reussie",
    blocs: [
      { id: "tri", type: "ia.trier", statut: "reussi", debut: null, fin: null, elements: 1, journal: [], sortie: ["x"] },
      ...(output ? [{ id: "fin", type: "sortie", statut: "reussi", debut: null, fin: null, elements: 1, journal: [], ...output }] : []),
    ],
  }) as Execution;
const widget = { donnees: { vraies: 1 }, exemple: { exemple: 1 } };

test("the output of the chosen run's output block (a trial included)", () => {
  const r = previewData({ choisie: resume("e-essai", true), detail: detail("e-essai", { sortie: { essai: 1 } }), liste: [resume("e-essai", true), resume("a")], widget });
  expect(r).toEqual({ donnees: { essai: 1 }, mention: false });
});

test("truncated or missing output, last real run: the widget's data", () => {
  const list = [resume("e-essai", true), resume("b"), resume("a")];
  expect(previewData({ choisie: resume("b"), detail: detail("b", { sortie: '{"coupé', sortieTronquee: true }), liste: list, widget })).toEqual({
    donnees: { vraies: 1 },
    mention: false,
  });
  expect(previewData({ choisie: resume("b"), detail: detail("b", null), liste: list, widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
});

test("otherwise the example, with the mention", () => {
  const list = [resume("b"), resume("a")];
  expect(previewData({ choisie: resume("a"), detail: detail("a", null), liste: list, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Detail not read yet (or from another run): not another run's output.
  expect(previewData({ choisie: resume("a"), detail: detail("b", { sortie: { b: 1 } }), liste: list, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Last real run without widget data: the example too.
  expect(previewData({ choisie: resume("b"), detail: null, liste: list, widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: true });
});

test("no run: the widget's data as on the home, without a mention", () => {
  expect(previewData({ choisie: null, detail: null, liste: [], widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
  expect(previewData({ choisie: null, detail: null, liste: [], widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: false });
});

test("last real run that did not succeed: the widget's data, with the mention", () => {
  const failed = { ...resume("b"), statut: "echouee" as const };
  expect(previewData({ choisie: failed, detail: detail("b", null), liste: [failed, resume("a")], widget })).toEqual({ donnees: { vraies: 1 }, mention: true });
  const partial = { ...resume("b"), statut: "partielle" as const };
  expect(previewData({ choisie: partial, detail: null, liste: [partial], widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
});
