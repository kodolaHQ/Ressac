import { expect, test } from "vitest";
import type { DirectWidget, Execution } from "@webaios/noyau";
import { pastillesDe } from "../../ui/constructeur/pastilles";

const trace = (id: string, statut: string, elements: number | null) => ({ id, type: "code", statut, debut: null, fin: null, elements, journal: [] });
const exec = { version: 1, id: "e", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle", debut: "d", fin: null, statut: "reussie", blocs: [trace("a", "reussi", 3), trace("b", "pas-lance", null)] } as unknown as Execution;

test("pastillesDe : le direct remplace le statut de l'exécution choisie pour les blocs en cours", () => {
  const direct: DirectWidget = { widget: "w", genre: "execution", debut: "d", blocs: { b: { statut: "en-cours", elements: null } } };
  expect(pastillesDe(exec, direct)).toEqual({ a: { statut: "reussi", elements: 3 }, b: { statut: "en-cours", elements: null } });
});
test("pastillesDe : sans direct ou sans exécution", () => {
  expect(pastillesDe(exec, null).a).toEqual({ statut: "reussi", elements: 3 });
  expect(pastillesDe(null, null)).toEqual({});
  expect(pastillesDe(null, { widget: "w", genre: "essai", debut: "d", blocs: { x: { statut: "reussi", elements: 1 } } })).toEqual({ x: { statut: "reussi", elements: 1 } });
});
