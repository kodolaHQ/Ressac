import { expect, test } from "vitest";
import { SchemaActionApplication } from "../../shared/api";

const valide = (dossier: string, action: string) => SchemaActionApplication.safeParse({ dossier, action }).success;

test("Supprimer, Déboguer, Afficher le dossier: any single-segment folder name", () => {
  for (const action of ["supprimer", "deboguer", "dossier"]) {
    expect(valide("Mon Projet", action)).toBe(true);
    expect(valide("_tmp", action)).toBe(true);
    for (const d of ["", ".", "..", "a/b", "a\\b", "a\0b"]) expect(valide(d, action)).toBe(false);
  }
});

test("lancer and the other actions keep the launchable folder name", () => {
  for (const action of ["lancer", "relancer", "arreter", "ouvrir", "promouvoir"]) {
    expect(valide("essai", action)).toBe(true);
    expect(valide("Mon Projet", action)).toBe(false);
  }
});
