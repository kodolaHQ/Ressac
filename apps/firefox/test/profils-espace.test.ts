import { expect, test } from "vitest";
import type { Space } from "../shared/modele";
import { choiceLosesConnections, profileOptions, losesConnections, PROFILE_TO_CHOOSE } from "../ui/composants/profilsEspace";

const space = (id: string, name: string, profile: string): Space => ({ id, nom: name, icone: "📁", epingles: [], prive: false, profil: profile });
const profiles = [{ id: "defaut" }, { id: "p1" }, { id: "p2" }];

test("new space: « Nouveau profil » creates one, then each used profile with all its spaces", () => {
  const spaces = [space("a", "Perso", "defaut"), space("b", "Travail", "p1"), space("c", "Clients", "p1")];
  expect(profileOptions(spaces, profiles.slice(0, 2), null)).toEqual([
    { valeur: "nouveau", libelle: "Nouveau profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail, Clients »" },
  ]);
});

test("settings: the space being set is not named, and a profile it alone has is not shared", () => {
  const spaces = [space("a", "Perso", "defaut"), space("b", "Travail", "p1"), space("c", "Banque", "p2")];
  expect(profileOptions(spaces, profiles, "c")).toEqual([
    { valeur: "p2", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
    { valeur: "p1", libelle: "Partagé avec « Travail »" },
  ]);
});

test("settings of a space that shares its profile: its own profile creates a new one", () => {
  const spaces = [space("a", "Perso", "defaut"), space("b", "Travail", "defaut")];
  expect(profileOptions(spaces, [{ id: "defaut" }], "b")).toEqual([
    { valeur: "nouveau", libelle: "Son propre profil" },
    { valeur: "defaut", libelle: "Partagé avec « Perso »" },
  ]);
});

test("a profile that no space uses is not offered", () => {
  const spaces = [space("a", "Perso", "p1")];
  expect(profileOptions(spaces, [{ id: "defaut" }, { id: "p1" }], null)).toEqual([
    { valeur: "nouveau", libelle: "Nouveau profil" },
    { valeur: "p1", libelle: "Partagé avec « Perso »" },
  ]);
});

test("sign-ins are lost with the last space of a non-default profile", () => {
  const spaces = [space("a", "Perso", "defaut"), space("b", "Travail", "p1"), space("c", "Clients", "p1"), space("d", "Banque", "p2")];
  expect(losesConnections(spaces, spaces[0]!)).toBe(false);
  expect(losesConnections(spaces, spaces[1]!)).toBe(false);
  expect(losesConnections(spaces, spaces[3]!)).toBe(true);
  expect(losesConnections([space("a", "Perso", "defaut")], space("a", "Perso", "defaut"))).toBe(false);
});

test("settings: leaving the last use of a non-default profile loses the sign-ins, keeping it does not", () => {
  const spaces = [space("a", "Perso", "defaut"), space("b", "Travail", "p1"), space("c", "Clients", "p1"), space("d", "Banque", "p2")];
  expect(choiceLosesConnections(spaces, "d", "p2")).toBe(false);
  expect(choiceLosesConnections(spaces, "d", "defaut")).toBe(true);
  expect(choiceLosesConnections(spaces, "d", "nouveau")).toBe(true);
  // Shared profile: the other spaces keep it.
  expect(choiceLosesConnections(spaces, "b", "defaut")).toBe(false);
  // The default profile is never erased; a new space has nothing to lose.
  expect(choiceLosesConnections(spaces, "a", "p1")).toBe(false);
  expect(choiceLosesConnections(spaces, null, "defaut")).toBe(false);
});

test("new space: no preselected profile, and « à choisir » is never an option nor a loss", () => {
  const spaces = [space("a", "Perso", "defaut"), space("d", "Banque", "p2")];
  expect(PROFILE_TO_CHOOSE).toBe("");
  expect(profileOptions(spaces, profiles, null).map((o) => o.valeur)).not.toContain(PROFILE_TO_CHOOSE);
  expect(choiceLosesConnections(spaces, null, PROFILE_TO_CHOOSE)).toBe(false);
});
