import type { Execution, ResumeExecution } from "@webaios/noyau";
import { expect, test } from "vitest";
import { donneesApercu } from "../../ui/constructeur/apercu";

const resume = (id: string, essai = false): ResumeExecution => ({
  id,
  declencheur: essai ? "rejeu" : "manuelle",
  ...(essai ? { essai: { depart: "tri", origine: "a" } } : {}),
  debut: "d",
  fin: "f",
  statut: "reussie",
  blocs: [],
});
const detail = (id: string, sortie: { sortie?: unknown; sortieTronquee?: true } | null): Execution =>
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
      ...(sortie ? [{ id: "fin", type: "sortie", statut: "reussi", debut: null, fin: null, elements: 1, journal: [], ...sortie }] : []),
    ],
  }) as Execution;
const widget = { donnees: { vraies: 1 }, exemple: { exemple: 1 } };

test("the output of the chosen run's output block (a trial included)", () => {
  const r = donneesApercu({ choisie: resume("e-essai", true), detail: detail("e-essai", { sortie: { essai: 1 } }), liste: [resume("e-essai", true), resume("a")], widget });
  expect(r).toEqual({ donnees: { essai: 1 }, mention: false });
});

test("truncated or missing output, last real run: the widget's data", () => {
  const liste = [resume("e-essai", true), resume("b"), resume("a")];
  expect(donneesApercu({ choisie: resume("b"), detail: detail("b", { sortie: '{"coupé', sortieTronquee: true }), liste, widget })).toEqual({
    donnees: { vraies: 1 },
    mention: false,
  });
  expect(donneesApercu({ choisie: resume("b"), detail: detail("b", null), liste, widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
});

test("otherwise the example, with the mention", () => {
  const liste = [resume("b"), resume("a")];
  expect(donneesApercu({ choisie: resume("a"), detail: detail("a", null), liste, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Detail not read yet (or from another run): not another run's output.
  expect(donneesApercu({ choisie: resume("a"), detail: detail("b", { sortie: { b: 1 } }), liste, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Last real run without widget data: the example too.
  expect(donneesApercu({ choisie: resume("b"), detail: null, liste, widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: true });
});

test("no run: the widget's data as on the home, without a mention", () => {
  expect(donneesApercu({ choisie: null, detail: null, liste: [], widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
  expect(donneesApercu({ choisie: null, detail: null, liste: [], widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: false });
});

test("last real run that did not succeed: the widget's data, with the mention", () => {
  const echouee = { ...resume("b"), statut: "echouee" as const };
  expect(donneesApercu({ choisie: echouee, detail: detail("b", null), liste: [echouee, resume("a")], widget })).toEqual({ donnees: { vraies: 1 }, mention: true });
  const partielle = { ...resume("b"), statut: "partielle" as const };
  expect(donneesApercu({ choisie: partielle, detail: null, liste: [partielle], widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
});
