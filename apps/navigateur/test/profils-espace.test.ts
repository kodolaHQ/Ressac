import { expect, test } from "vitest";
import type { Espace } from "../src/commun/modele";
import { optionsProfil, perdConnexions } from "../src/renderer/composants/profilsEspace";

const espace = (id: string, nom: string, profil: string): Espace => ({ id, nom, icone: "📁", epingles: [], prive: false, profil });
const profils = [{ id: "defaut" }, { id: "p1" }, { id: "p2" }];

test("nouvel espace : son propre profil en crée un, puis chaque profil utilisé avec tous ses espaces", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1")];
  expect(optionsProfil(espaces, profils.slice(0, 2), null)).toEqual([
    { valeur: "nouveau", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail, Clients »" },
  ]);
});

test("réglages : l'espace réglé n'est pas nommé, et un profil dont il est seul ne se partage pas", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Banque", "p2")];
  expect(optionsProfil(espaces, profils, "c")).toEqual([
    { valeur: "p2", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail »" },
  ]);
});

test("réglages d'un espace qui partage son profil : son propre profil en crée un nouveau", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "defaut")];
  expect(optionsProfil(espaces, [{ id: "defaut" }], "b")).toEqual([
    { valeur: "nouveau", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
  ]);
});

test("un profil qu'aucun espace n'utilise n'est pas proposé", () => {
  const espaces = [espace("a", "Perso", "p1")];
  expect(optionsProfil(espaces, [{ id: "defaut" }, { id: "p1" }], null)).toEqual([
    { valeur: "nouveau", libelle: "Son propre profil" },
    { valeur: "p1", libelle: "Partagé avec « Perso »" },
  ]);
});

test("les connexions se perdent avec le dernier espace d'un profil autre que celui par défaut", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1"), espace("d", "Banque", "p2")];
  expect(perdConnexions(espaces, espaces[0]!)).toBe(false);
  expect(perdConnexions(espaces, espaces[1]!)).toBe(false);
  expect(perdConnexions(espaces, espaces[3]!)).toBe(true);
  expect(perdConnexions([espace("a", "Perso", "defaut")], espace("a", "Perso", "defaut"))).toBe(false);
});
