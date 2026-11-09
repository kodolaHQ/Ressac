import { expect, test } from "vitest";
import type { Espace } from "../shared/modele";
import { avertissements } from "../ui/composants/extensionsEspace";

const espace = (id: string, nom: string, profil: string, prive = false): Espace => ({ id, nom, icone: "📁", epingles: [], prive, profil }) as Espace;
const espaces = [espace("e1", "Perso", "defaut"), espace("e2", "Lecture", "defaut"), espace("e3", "Banque", "banque")];
const agent = { cle: "agent:cacheur", nom: "Cacheur", source: "agent" as const, profils: ["defaut"] };
const store = { cle: `store:${"a".repeat(32)}`, nom: "Bloqueur", source: "store" as const, profils: ["defaut"] };

test("private draft on a profile where an extension runs in another space: privePartage", () => {
  const a = avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [store]);
  expect(a.privePartage).toEqual(["Lecture"]);
  // A new private space (id null) on a shared profile: all the profile's spaces.
  expect(avertissements({ id: null, prive: true, profil: "defaut" }, espaces, [store]).privePartage).toEqual(["Perso", "Lecture"]);
  // No extension in this profile, or own profile: nothing.
  expect(avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [{ ...store, profils: ["banque"] }]).privePartage).toEqual([]);
  expect(avertissements({ id: "e3", prive: true, profil: "banque" }, espaces, [store]).privePartage).toEqual([]);
});

test("draft turned private with an active agent extension: agentDesactivees", () => {
  const a = avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [agent, store]);
  expect(a.agentDesactivees).toEqual(["Cacheur"]);
  // An agent extension active in another profile is not concerned.
  expect(avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [{ ...agent, profils: ["banque"] }]).agentDesactivees).toEqual([]);
});

test("non-private space: nothing", () => {
  expect(avertissements({ id: "e1", prive: false, profil: "defaut" }, espaces, [agent, store])).toEqual({ privePartage: [], agentDesactivees: [] });
});
