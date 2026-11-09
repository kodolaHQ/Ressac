import { expect, test } from "vitest";
import type { DirectWidget, Execution } from "@webaios/kernel";
import { badgesOf } from "../../ui/builder/badges";

const trace = (id: string, status: string, elements: number | null) => ({ id, type: "code", statut: status, debut: null, fin: null, elements, journal: [] });
const exec = { version: 1, id: "e", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle", debut: "d", fin: null, statut: "reussie", blocs: [trace("a", "reussi", 3), trace("b", "pas-lance", null)] } as unknown as Execution;

test("pastillesDe: the live replaces the status of the chosen run for the blocks in progress", () => {
  const direct: DirectWidget = { widget: "w", genre: "execution", debut: "d", blocs: { b: { statut: "en-cours", elements: null } } };
  expect(badgesOf(exec, direct)).toEqual({ a: { statut: "reussi", elements: 3 }, b: { statut: "en-cours", elements: null } });
});
test("pastillesDe: without live or without a run", () => {
  expect(badgesOf(exec, null).a).toEqual({ statut: "reussi", elements: 3 });
  expect(badgesOf(null, null)).toEqual({});
  expect(badgesOf(null, { widget: "w", genre: "essai", debut: "d", blocs: { x: { statut: "reussi", elements: 1 } } })).toEqual({ x: { statut: "reussi", elements: 1 } });
});
