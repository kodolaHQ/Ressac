import { expect, test } from "vitest";
import type { Space } from "../shared/model";
import { warnings } from "../ui/components/spaceExtensions";

const space = (id: string, name: string, profile: string, isPrivate = false): Space => ({ id, name: name, icon: "📁", pinned: [], private: isPrivate, profile: profile }) as Space;
const spaces = [space("e1", "Perso", "defaut"), space("e2", "Lecture", "defaut"), space("e3", "Banque", "banque")];
const agent = { key: "agent:cacheur", name: "Cacheur", source: "agent" as const, profiles: ["defaut"] };
const store = { key: `store:${"a".repeat(32)}`, name: "Bloqueur", source: "store" as const, profiles: ["defaut"] };

test("private draft on a profile where an extension runs in another space: privePartage", () => {
  const a = warnings({ id: "e1", private: true, profile: "defaut" }, spaces, [store]);
  expect(a.sharedPrivate).toEqual(["Lecture"]);
  // A new private space (id null) on a shared profile: all the profile's spaces.
  expect(warnings({ id: null, private: true, profile: "defaut" }, spaces, [store]).sharedPrivate).toEqual(["Perso", "Lecture"]);
  // No extension in this profile, or own profile: nothing.
  expect(warnings({ id: "e1", private: true, profile: "defaut" }, spaces, [{ ...store, profiles: ["banque"] }]).sharedPrivate).toEqual([]);
  expect(warnings({ id: "e3", private: true, profile: "banque" }, spaces, [store]).sharedPrivate).toEqual([]);
});

test("draft turned private with an active agent extension: agentDesactivees", () => {
  const a = warnings({ id: "e1", private: true, profile: "defaut" }, spaces, [agent, store]);
  expect(a.agentDisabled).toEqual(["Cacheur"]);
  // An agent extension active in another profile is not concerned.
  expect(warnings({ id: "e1", private: true, profile: "defaut" }, spaces, [{ ...agent, profiles: ["banque"] }]).agentDisabled).toEqual([]);
});

test("non-private space: nothing", () => {
  expect(warnings({ id: "e1", private: false, profile: "defaut" }, spaces, [agent, store])).toEqual({ sharedPrivate: [], agentDisabled: [] });
});
