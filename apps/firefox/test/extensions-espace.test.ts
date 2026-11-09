import { expect, test } from "vitest";
import type { Espace } from "../shared/modele";
import { avertissements } from "../ui/composants/extensionsEspace";

const espace = (id: string, nom: string, profil: string, prive = false): Espace => ({ id, nom, icone: "📁", epingles: [], prive, profil }) as Espace;
const espaces = [espace("e1", "Perso", "defaut"), espace("e2", "Lecture", "defaut"), espace("e3", "Banque", "banque")];
const agent = { cle: "agent:cacheur", nom: "Cacheur", source: "agent" as const, profils: ["defaut"] };
const store = { cle: `store:${"a".repeat(32)}`, nom: "Bloqueur", source: "store" as const, profils: ["defaut"] };

test("brouillon privé sur un profil où une extension tourne dans un autre espace : privePartage", () => {
  const a = avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [store]);
  expect(a.privePartage).toEqual(["Lecture"]);
  // Un nouvel espace privé (id null) sur un profil partagé : tous les espaces du profil.
  expect(avertissements({ id: null, prive: true, profil: "defaut" }, espaces, [store]).privePartage).toEqual(["Perso", "Lecture"]);
  // Aucune extension dans ce profil, ou profil propre : rien.
  expect(avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [{ ...store, profils: ["banque"] }]).privePartage).toEqual([]);
  expect(avertissements({ id: "e3", prive: true, profil: "banque" }, espaces, [store]).privePartage).toEqual([]);
});

test("brouillon devenu privé avec une extension de l'agent active : agentDesactivees", () => {
  const a = avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [agent, store]);
  expect(a.agentDesactivees).toEqual(["Cacheur"]);
  // Une extension de l'agent active dans un autre profil n'est pas concernée.
  expect(avertissements({ id: "e1", prive: true, profil: "defaut" }, espaces, [{ ...agent, profils: ["banque"] }]).agentDesactivees).toEqual([]);
});

test("espace non privé : rien", () => {
  expect(avertissements({ id: "e1", prive: false, profil: "defaut" }, espaces, [agent, store])).toEqual({ privePartage: [], agentDesactivees: [] });
});
