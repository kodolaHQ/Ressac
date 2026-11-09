import { expect, test } from "vitest";
import type { Space, WindowState, BrowserState, SpaceId, ProfileId } from "../shared/model";
import { profilesForGrant, openableUrl } from "../ui/home-profiles";

const space = (id: string, name: string, profile: ProfileId, isPrivate = false): Space => ({
  id,
  name: name,
  icon: "",
  pinned: [],
  private: isPrivate,
  profile: profile,
});

const win = (id: string, activeSpace: SpaceId): WindowState => ({
  id,
  activeSpace: activeSpace,
  order: {},
  active: {},
  compact: false,
  agentPanelOpen: false,
  recentlyClosed: [],
  frame: null,
});

const state = (spaces: Space[], profiles: ProfileId[], windows: WindowState[]) =>
  ({ spaces: spaces, profiles: profiles.map((id) => ({ id })), windows: windows }) as Pick<BrowserState, "profiles" | "spaces" | "windows">;

test("a profile used by a private space is excluded, even shared with a non-private space", () => {
  const s = state(
    [space("e1", "Perso", "perso"), space("e2", "Privé", "prive", true), space("e3", "Boulot", "perso", true)],
    ["default", "perso", "prive"],
    [win("f1", "e1")],
  );
  expect(profilesForGrant(s, "f1").map((p) => p.id)).toEqual(["default"]);
});

test("the window's active space's profile is ticked by default, if it is readable", () => {
  const s = state(
    [space("e1", "Perso", "perso"), space("e2", "Boulot", "default"), space("e3", "Privé", "prive", true)],
    ["default", "perso", "prive"],
    [win("f1", "e1"), win("f2", "e3")],
  );
  expect(profilesForGrant(s, "f1")).toEqual([
    { id: "default", label: "Profil de « Boulot »", isDefault: false },
    { id: "perso", label: "Profil de « Perso »", isDefault: true },
  ]);
  // The active space is private: its profile is excluded, so nothing is ticked.
  expect(profilesForGrant(s, "f2").every((p) => !p.isDefault)).toBe(true);
});

test("a profile without a space keeps a neutral label", () => {
  const s = state([space("e1", "Perso", "perso")], ["perso", "autre"], [win("f1", "e1")]);
  expect(profilesForGrant(s, "f1")).toContainEqual({ id: "autre", label: "Profil « autre »", isDefault: false });
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
