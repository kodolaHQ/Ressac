import { expect, test } from "vitest";
import type { Espace } from "../shared/modele";
import { choixPerdConnexions, optionsProfil, perdConnexions, PROFIL_A_CHOISIR } from "../ui/composants/profilsEspace";

const espace = (id: string, nom: string, profil: string): Espace => ({ id, nom, icone: "📁", epingles: [], prive: false, profil });
const profils = [{ id: "defaut" }, { id: "p1" }, { id: "p2" }];

test("nouvel espace : « Nouveau profil » en crée un, puis chaque profil utilisé avec tous ses espaces", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1")];
  expect(optionsProfil(espaces, profils.slice(0, 2), null)).toEqual([
    { valeur: "nouveau", libelle: "Nouveau profil" },
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
    { valeur: "nouveau", libelle: "Nouveau profil" },
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

test("réglages : quitter le dernier usage d'un profil autre que celui par défaut perd les connexions, le garder non", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("b", "Travail", "p1"), espace("c", "Clients", "p1"), espace("d", "Banque", "p2")];
  expect(choixPerdConnexions(espaces, "d", "p2")).toBe(false);
  expect(choixPerdConnexions(espaces, "d", "defaut")).toBe(true);
  expect(choixPerdConnexions(espaces, "d", "nouveau")).toBe(true);
  // Profil partagé : les autres espaces le gardent.
  expect(choixPerdConnexions(espaces, "b", "defaut")).toBe(false);
  // Le profil par défaut n'est jamais effacé ; un nouvel espace n'a rien à perdre.
  expect(choixPerdConnexions(espaces, "a", "p1")).toBe(false);
  expect(choixPerdConnexions(espaces, null, "defaut")).toBe(false);
});

test("nouvel espace : aucun profil présélectionné, et « à choisir » n'est jamais une option ni une perte", () => {
  const espaces = [espace("a", "Perso", "defaut"), espace("d", "Banque", "p2")];
  expect(PROFIL_A_CHOISIR).toBe("");
  expect(optionsProfil(espaces, profils, null).map((o) => o.valeur)).not.toContain(PROFIL_A_CHOISIR);
  expect(choixPerdConnexions(espaces, null, PROFIL_A_CHOISIR)).toBe(false);
});
