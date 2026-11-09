import { expect, test } from "vitest";
import type { Space } from "../shared/model";
import { warnings } from "../ui/components/spaceExtensions";

const space = (id: string, name: string, profile: string, isPrivate = false): Space => ({ id, nom: name, icone: "📁", epingles: [], prive: isPrivate, profil: profile }) as Space;
const spaces = [space("e1", "Perso", "defaut"), space("e2", "Lecture", "defaut"), space("e3", "Banque", "banque")];
const agent = { cle: "agent:cacheur", nom: "Cacheur", source: "agent" as const, profils: ["defaut"] };
const store = { cle: `store:${"a".repeat(32)}`, nom: "Bloqueur", source: "store" as const, profils: ["defaut"] };

test("private draft on a profile where an extension runs in another space: privePartage", () => {
  const a = warnings({ id: "e1", prive: true, profil: "defaut" }, spaces, [store]);
  expect(a.privePartage).toEqual(["Lecture"]);
  // A new private space (id null) on a shared profile: all the profile's spaces.
  expect(warnings({ id: null, prive: true, profil: "defaut" }, spaces, [store]).privePartage).toEqual(["Perso", "Lecture"]);
  // No extension in this profile, or own profile: nothing.
  expect(warnings({ id: "e1", prive: true, profil: "defaut" }, spaces, [{ ...store, profils: ["banque"] }]).privePartage).toEqual([]);
  expect(warnings({ id: "e3", prive: true, profil: "banque" }, spaces, [store]).privePartage).toEqual([]);
});

test("draft turned private with an active agent extension: agentDesactivees", () => {
  const a = warnings({ id: "e1", prive: true, profil: "defaut" }, spaces, [agent, store]);
  expect(a.agentDesactivees).toEqual(["Cacheur"]);
  // An agent extension active in another profile is not concerned.
  expect(warnings({ id: "e1", prive: true, profil: "defaut" }, spaces, [{ ...agent, profils: ["banque"] }]).agentDesactivees).toEqual([]);
});

test("non-private space: nothing", () => {
  expect(warnings({ id: "e1", prive: false, profil: "defaut" }, spaces, [agent, store])).toEqual({ privePartage: [], agentDesactivees: [] });
});
