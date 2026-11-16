import { expect, test } from "vitest";
import type { Space } from "../shared/model";
import { format } from "../shared/i18n";
import { choiceLosesConnections, deletionLosses, profileOptions, losesConnections, PROFILE_TO_CHOOSE } from "../ui/components/spaceProfiles";

const space = (id: string, name: string, profile: string): Space => ({ id, name: name, icon: "📁", pinned: [], folders: [], private: false, profile: profile, aura: "aube" });
const profiles = [{ id: "default" }, { id: "p1" }, { id: "p2" }];

test("new space: « Nouveau profil » creates one, then each used profile with all its spaces", () => {
  const spaces = [space("a", "Perso", "default"), space("b", "Travail", "p1"), space("c", "Clients", "p1")];
  expect(profileOptions(spaces, profiles.slice(0, 2), null, "fr")).toEqual([
    { value: "new", label: "Nouveau profil" },
    { value: "default", label: "Partagé avec « Perso »" },
    { value: "p1", label: "Partagé avec « Travail, Clients »" },
  ]);
});

test("settings: the space being set is not named, and a profile it alone has is not shared", () => {
  const spaces = [space("a", "Perso", "default"), space("b", "Travail", "p1"), space("c", "Banque", "p2")];
  expect(profileOptions(spaces, profiles, "c", "fr")).toEqual([
    { value: "p2", label: "Son propre profil" },
    { value: "default", label: "Partagé avec « Perso »" },
    { value: "p1", label: "Partagé avec « Travail »" },
  ]);
});

test("settings of a space that shares its profile: its own profile creates a new one", () => {
  const spaces = [space("a", "Perso", "default"), space("b", "Travail", "default")];
  expect(profileOptions(spaces, [{ id: "default" }], "b", "fr")).toEqual([
    { value: "new", label: "Son propre profil" },
    { value: "default", label: "Partagé avec « Perso »" },
  ]);
});

test("a profile that no space uses is not offered", () => {
  const spaces = [space("a", "Perso", "p1")];
  expect(profileOptions(spaces, [{ id: "default" }, { id: "p1" }], null, "fr")).toEqual([
    { value: "new", label: "Nouveau profil" },
    { value: "p1", label: "Partagé avec « Perso »" },
  ]);
});

test("sign-ins are lost with the last space of a non-default profile", () => {
  const spaces = [space("a", "Perso", "default"), space("b", "Travail", "p1"), space("c", "Clients", "p1"), space("d", "Banque", "p2")];
  expect(losesConnections(spaces, spaces[0]!)).toBe(false);
  expect(losesConnections(spaces, spaces[1]!)).toBe(false);
  expect(losesConnections(spaces, spaces[3]!)).toBe(true);
  expect(losesConnections([space("a", "Perso", "default")], space("a", "Perso", "default"))).toBe(false);
});

test("settings: leaving the last use of a non-default profile loses the sign-ins, keeping it does not", () => {
  const spaces = [space("a", "Perso", "default"), space("b", "Travail", "p1"), space("c", "Clients", "p1"), space("d", "Banque", "p2")];
  expect(choiceLosesConnections(spaces, "d", "p2")).toBe(false);
  expect(choiceLosesConnections(spaces, "d", "default")).toBe(true);
  expect(choiceLosesConnections(spaces, "d", "new")).toBe(true);
  // Shared profile: the other spaces keep it.
  expect(choiceLosesConnections(spaces, "b", "default")).toBe(false);
  // The default profile is never erased; a new space has nothing to lose.
  expect(choiceLosesConnections(spaces, "a", "p1")).toBe(false);
  expect(choiceLosesConnections(spaces, null, "default")).toBe(false);
});

test("new space: no preselected profile, and « à choisir » is never an option nor a loss", () => {
  const spaces = [space("a", "Perso", "default"), space("d", "Banque", "p2")];
  expect(PROFILE_TO_CHOOSE).toBe("");
  expect(profileOptions(spaces, profiles, null, "fr").map((o) => o.value)).not.toContain(PROFILE_TO_CHOOSE);
  expect(choiceLosesConnections(spaces, null, PROFILE_TO_CHOOSE)).toBe(false);
});

test("deleting a space with pinned sites or folders but no open tab asks first, and says how many", () => {
  const a = space("a", "Perso", "default");
  const b = { ...space("b", "Lectures", "default"), pinned: [{ id: "f1", url: "https://a.example/", title: "A", favicon: null, folder: "d1" }], folders: [{ id: "d1", name: "Presse", collapsed: false }] };
  expect(deletionLosses([a, b], b, 0)).toEqual({ tabs: 0, logins: false, pinned: 1, folders: 1 });
  expect(deletionLosses([a, b], a, 0)).toBeNull();
  expect(format("fr", "sidebar-space-delete-pinned", { pinned: 3, folders: 1 })).toBe("3 sites épinglés et 1 dossier seront perdus.");
  expect(format("en", "sidebar-space-delete-pinned", { pinned: 1, folders: 2 })).toBe("1 pinned site and 2 folders will be lost.");
});
