import type { Execution, ResumeExecution } from "@webaios/noyau";
import { expect, test } from "vitest";
import { donneesApercu } from "../../src/renderer/constructeur/apercu";

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

test("la sortie du bloc sortie de l'exécution choisie (un essai compris)", () => {
  const r = donneesApercu({ choisie: resume("e-essai", true), detail: detail("e-essai", { sortie: { essai: 1 } }), liste: [resume("e-essai", true), resume("a")], widget });
  expect(r).toEqual({ donnees: { essai: 1 }, mention: false });
});

test("sortie tronquée ou absente, dernière vraie exécution : les données du widget", () => {
  const liste = [resume("e-essai", true), resume("b"), resume("a")];
  expect(donneesApercu({ choisie: resume("b"), detail: detail("b", { sortie: '{"coupé', sortieTronquee: true }), liste, widget })).toEqual({
    donnees: { vraies: 1 },
    mention: false,
  });
  expect(donneesApercu({ choisie: resume("b"), detail: detail("b", null), liste, widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
});

test("sinon l'exemple, avec la mention", () => {
  const liste = [resume("b"), resume("a")];
  expect(donneesApercu({ choisie: resume("a"), detail: detail("a", null), liste, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Détail pas encore lu (ou d'une autre exécution) : pas la sortie d'une autre.
  expect(donneesApercu({ choisie: resume("a"), detail: detail("b", { sortie: { b: 1 } }), liste, widget })).toEqual({ donnees: { exemple: 1 }, mention: true });
  // Dernière vraie exécution sans données du widget : l'exemple aussi.
  expect(donneesApercu({ choisie: resume("b"), detail: null, liste, widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: true });
});

test("aucune exécution : les données du widget comme sur l'accueil, sans mention", () => {
  expect(donneesApercu({ choisie: null, detail: null, liste: [], widget })).toEqual({ donnees: { vraies: 1 }, mention: false });
  expect(donneesApercu({ choisie: null, detail: null, liste: [], widget: { donnees: null, exemple: { exemple: 1 } } })).toEqual({ donnees: { exemple: 1 }, mention: false });
});
