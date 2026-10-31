import { ACTION_INCONNUE as ACTION_INCONNUE_NOYAU, AUCUN_RESULTAT as AUCUN_RESULTAT_NOYAU, MENTION_SECOURS as MENTION_SECOURS_NOYAU } from "@webaios/noyau";
import { expect, test } from "vitest";
import { ACTION_INCONNUE, AUCUN_RESULTAT, MENTION_SECOURS } from "../../src/commun/actions";
import { trierLignes } from "../../src/renderer/action/tri";

const lignes = (...v: string[]) => v.map((x) => ({ c: x }));
const valeurs = (l: Record<string, string>[]) => l.map((x) => x.c);

test("« 10 » après « 9 »", () => {
  expect(valeurs(trierLignes(lignes("10", "9", "100"), "c", "asc"))).toEqual(["9", "10", "100"]);
  // Nombres affichés en fr-FR (espace fine insécable des milliers, virgule décimale).
  expect(valeurs(trierLignes(lignes("1 200", "950", "2,5"), "c", "asc"))).toEqual(["2,5", "950", "1 200"]);
  expect(valeurs(trierLignes(lignes("9", "10"), "c", "desc"))).toEqual(["10", "9"]);
});

test("« école » entre « abri » et « zèbre »", () => {
  expect(valeurs(trierLignes(lignes("zèbre", "école", "abri"), "c", "asc"))).toEqual(["abri", "école", "zèbre"]);
});

test("vides à la fin dans les deux sens", () => {
  expect(valeurs(trierLignes(lignes("", "b", "a", ""), "c", "asc"))).toEqual(["a", "b", "", ""]);
  expect(valeurs(trierLignes(lignes("", "b", "a", ""), "c", "desc"))).toEqual(["b", "a", "", ""]);
  // Un champ absent de la ligne compte comme vide.
  expect(trierLignes([{}, { c: "x" }], "c", "asc")).toEqual([{ c: "x" }, {}]);
});

test("ne modifie pas la liste donnée", () => {
  const l = lignes("b", "a");
  trierLignes(l, "c", "asc");
  expect(valeurs(l)).toEqual(["b", "a"]);
});

test("les messages de la page sont ceux du noyau", () => {
  expect(MENTION_SECOURS).toBe(MENTION_SECOURS_NOYAU);
  expect(ACTION_INCONNUE).toBe(ACTION_INCONNUE_NOYAU);
  expect(AUCUN_RESULTAT).toBe(AUCUN_RESULTAT_NOYAU);
});
