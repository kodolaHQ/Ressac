import { expect, test } from "vitest";
import type { Space } from "../shared/modele";
import { choixPerdConnexions, optionsProfil, perdConnexions, PROFIL_A_CHOISIR } from "../ui/composants/profilsEspace";

const espace = (id: string, nom: string, profil: string): Space => ({ id, nom, icone: "📁", epingles: [], prive: false, profil });
const profils = [{ id: "defaut" }, { id: "p1" }, { id: "p2" }];

test("new space: « Nouveau profil » creates one, then each used profile with all its spaces", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1")];
  expect(optionsProfil(espaces, profils.slice(0, 2), null)).toEqual([
    { valeur: "nouveau", libelle: "Nouveau profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail, Clients »" },
  ]);
});

test("settings: the space being set is not named, and a profile it alone has is not shared", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Banque", "p2")];
  expect(optionsProfil(espaces, profils, "c")).toEqual([
    { valeur: "p2", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail »" },
  ]);
});

test("settings of a space that shares its profile: its own profile creates a new one", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "defaut")];
  expect(optionsProfil(espaces, [{ id: "defaut" }], "b")).toEqual([
    { valeur: "nouveau", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
  ]);
});

test("a profile that no space uses is not offered", () => {
  const espaces = [espace("a", "Perso", "p1")];
  expect(optionsProfil(espaces, [{ id: "defaut" }, { id: "p1" }], null)).toEqual([
    { valeur: "nouveau", libelle: "Nouveau profil" },
    { valeur: "p1", libelle: "Partagé avec « Perso »" },
  ]);
});

test("sign-ins are lost with the last space of a non-default profile", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1"), espace("d", "Banque", "p2")];
  expect(perdConnexions(espaces, espaces[0]!)).toBe(false);
  expect(perdConnexions(espaces, espaces[1]!)).toBe(false);
  expect(perdConnexions(espaces, espaces[3]!)).toBe(true);
  expect(perdConnexions([espace("a", "Perso", "defaut")], espace("a", "Perso", "defaut"))).toBe(false);
});

test("settings: leaving the last use of a non-default profile loses the sign-ins, keeping it does not", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1"), espace("d", "Banque", "p2")];
  expect(choixPerdConnexions(espaces, "d", "p2")).toBe(false);
  expect(choixPerdConnexions(espaces, "d", "defaut")).toBe(true);
  expect(choixPerdConnexions(espaces, "d", "nouveau")).toBe(true);
  // Shared profile: the other spaces keep it.
  expect(choixPerdConnexions(espaces, "b", "defaut")).toBe(false);
  // The default profile is never erased; a new space has nothing to lose.
  expect(choixPerdConnexions(espaces, "a", "p1")).toBe(false);
  expect(choixPerdConnexions(espaces, null, "defaut")).toBe(false);
});

test("new space: no preselected profile, and « à choisir » is never an option nor a loss", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("d", "Banque", "p2")];
  expect(PROFIL_A_CHOISIR).toBe("");
  expect(optionsProfil(espaces, profils, null).map((o) => o.valeur)).not.toContain(PROFIL_A_CHOISIR);
  expect(choixPerdConnexions(espaces, null, PROFIL_A_CHOISIR)).toBe(false);
});
