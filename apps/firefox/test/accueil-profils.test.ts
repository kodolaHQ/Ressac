import { expect, test } from "vitest";
import type { Espace, EtatFenetre, EtatNavigateur, IdEspace, IdProfil } from "../shared/modele";
import { profilsPourAccord, urlOuvrable } from "../ui/accueil-profils";

const espace = (id: string, nom: string, profil: IdProfil, prive = false): Espace => ({
  id,
  nom,
  icone: "",
  epingles: [],
  prive,
  profil,
});

const fenetre = (id: string, espaceActif: IdEspace): EtatFenetre => ({
  id,
  espaceActif,
  ordre: {},
  actif: {},
  compact: false,
  panneauAgentOuvert: false,
  fermesRecemment: [],
  cadre: null,
});

const etat = (espaces: Espace[], profils: IdProfil[], fenetres: EtatFenetre[]) =>
  ({ espaces, profils: profils.map((id) => ({ id })), fenetres }) as Pick<EtatNavigateur, "profils" | "espaces" | "fenetres">;

test("un profil utilisé par un espace privé est exclu, même partagé avec un espace non privé", () => {
  const s = etat(
    [espace("e1", "Perso", "perso"), espace("e2", "Privé", "prive", true), espace("e3", "Boulot", "perso", true)],
    ["defaut", "perso", "prive"],
    [fenetre("f1", "e1")],
  );
  expect(profilsPourAccord(s, "f1").map((p) => p.id)).toEqual(["defaut"]);
});

test("le profil de l'espace actif de la fenêtre est coché par défaut, s'il est lisible", () => {
  const s = etat(
    [espace("e1", "Perso", "perso"), espace("e2", "Boulot", "defaut"), espace("e3", "Privé", "prive", true)],
    ["defaut", "perso", "prive"],
    [fenetre("f1", "e1"), fenetre("f2", "e3")],
  );
  expect(profilsPourAccord(s, "f1")).toEqual([
    { id: "defaut", libelle: "Profil de « Boulot »", parDefaut: false },
    { id: "perso", libelle: "Profil de « Perso »", parDefaut: true },
  ]);
  // L'espace actif est privé : son profil est exclu, donc rien n'est coché.
  expect(profilsPourAccord(s, "f2").every((p) => !p.parDefaut)).toBe(true);
});

test("un profil sans espace garde un libellé neutre", () => {
  const s = etat([espace("e1", "Perso", "perso")], ["perso", "autre"], [fenetre("f1", "e1")]);
  expect(profilsPourAccord(s, "f1")).toContainEqual({ id: "autre", libelle: "Profil « autre »", parDefaut: false });
});

test("un lien de widget : http(s) seulement, jamais la machine ni le réseau local", () => {
  expect(urlOuvrable("https://exemple.test/article")).toBe(true);
  expect(urlOuvrable("http://exemple.test/")).toBe(true);
  expect(urlOuvrable("javascript:alert(1)")).toBe(false);
  expect(urlOuvrable("file:///etc/hosts")).toBe(false);
  expect(urlOuvrable("https://localhost/")).toBe(false);
  expect(urlOuvrable("http://127.0.0.1:5300/")).toBe(false);
  expect(urlOuvrable("http://[::1]/")).toBe(false);
  expect(urlOuvrable("http://10.1.2.3/")).toBe(false);
  expect(urlOuvrable("http://192.168.1.4/")).toBe(false);
  expect(urlOuvrable("http://machine.local/")).toBe(false);
  expect(urlOuvrable("pas une url")).toBe(false);
});
