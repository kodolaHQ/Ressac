import { expect, test } from "vitest";
import type { Space, WindowState, BrowserState, SpaceId, ProfileId } from "../shared/modele";
import { profilesForGrant, openableUrl } from "../ui/accueil-profils";

const space = (id: string, name: string, profile: ProfileId, isPrivate = false): Space => ({
  id,
  nom: name,
  icone: "",
  epingles: [],
  prive: isPrivate,
  profil: profile,
});

const win = (id: string, activeSpace: SpaceId): WindowState => ({
  id,
  espaceActif: activeSpace,
  ordre: {},
  actif: {},
  compact: false,
  panneauAgentOuvert: false,
  fermesRecemment: [],
  cadre: null,
});

const state = (spaces: Space[], profiles: ProfileId[], windows: WindowState[]) =>
  ({ espaces: spaces, profils: profiles.map((id) => ({ id })), fenetres: windows }) as Pick<BrowserState, "profils" | "espaces" | "fenetres">;

test("a profile used by a private space is excluded, even shared with a non-private space", () => {
  const s = state(
    [space("e1", "Perso", "perso"), space("e2", "Privé", "prive", true), space("e3", "Boulot", "perso", true)],
    ["defaut", "perso", "prive"],
    [win("f1", "e1")],
  );
  expect(profilesForGrant(s, "f1").map((p) => p.id)).toEqual(["defaut"]);
});

test("the window's active space's profile is ticked by default, if it is readable", () => {
  const s = state(
    [space("e1", "Perso", "perso"), space("e2", "Boulot", "defaut"), space("e3", "Privé", "prive", true)],
    ["defaut", "perso", "prive"],
    [win("f1", "e1"), win("f2", "e3")],
  );
  expect(profilesForGrant(s, "f1")).toEqual([
    { id: "defaut", libelle: "Profil de « Boulot »", parDefaut: false },
    { id: "perso", libelle: "Profil de « Perso »", parDefaut: true },
  ]);
  // The active space is private: its profile is excluded, so nothing is ticked.
  expect(profilesForGrant(s, "f2").every((p) => !p.parDefaut)).toBe(true);
});

test("a profile without a space keeps a neutral label", () => {
  const s = state([space("e1", "Perso", "perso")], ["perso", "autre"], [win("f1", "e1")]);
  expect(profilesForGrant(s, "f1")).toContainEqual({ id: "autre", libelle: "Profil « autre »", parDefaut: false });
});

test("a widget link: http(s) only, never the machine nor the local network", () => {
  expect(openableUrl("https://exemple.test/article")).toBe(true);
  expect(openableUrl("http://exemple.test/")).toBe(true);
  expect(openableUrl("javascript:alert(1)")).toBe(false);
  expect(openableUrl("file:///etc/hosts")).toBe(false);
  expect(openableUrl("https://localhost/")).toBe(false);
  expect(openableUrl("http://127.0.0.1:5300/")).toBe(false);
  expect(openableUrl("http://[::1]/")).toBe(false);
  expect(openableUrl("http://10.1.2.3/")).toBe(false);
  expect(openableUrl("http://192.168.1.4/")).toBe(false);
  expect(openableUrl("http://machine.local/")).toBe(false);
  expect(openableUrl("pas une url")).toBe(false);
});
