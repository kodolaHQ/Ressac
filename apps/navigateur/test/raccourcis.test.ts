import { beforeEach, expect, test } from "vitest";
import type { Action } from "../src/commun/api";
import type { EtatNavigateur } from "../src/commun/modele";
import { appliquer } from "../src/main/etat/actions";
import { etatInitial } from "../src/main/etat/etat-initial";
import { versNieme } from "../src/main/raccourcis";

let n = 0;
const genId = () => `g${++n}`;
let e: EtatNavigateur;
let F: string;
const ag = (a: Action | null) => {
  if (a) e = appliquer(e, a, genId);
};
const ouvrir = (url: string) => {
  ag({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};
const actif = () => {
  const f = e.fenetres[0]!;
  return f.actif[f.espaceActif];
};

beforeEach(() => {
  n = 0;
  e = etatInitial(genId);
  F = e.fenetres[0]!.id;
});

test("⌘1…⌘9 : les épinglés de l'espace passent avant les onglets, ouverts ou non", () => {
  const p = ouvrir("https://epingle.fr");
  ag({ type: "epinglerOnglet", id: p });
  const favori = e.espaces[0]!.epingles[0]!.id;
  ag({ type: "fermerOnglet", id: p }); // le favori reste, sans onglet
  const a = ouvrir("https://a.fr");
  expect(versNieme(e, F, 1)).toEqual({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favori });
  ag(versNieme(e, F, 1));
  expect(e.onglets[actif()!]?.lien?.id).toBe(favori);
  ag(versNieme(e, F, 2));
  expect(actif()).toBe(a);
});

test("⌘2 active le deuxième ; ⌘9 le dernier ; au-delà de la liste, rien", () => {
  const a = ouvrir("https://a.fr");
  const b = ouvrir("https://b.fr");
  const c = ouvrir("https://c.fr");
  ag(versNieme(e, F, 2));
  expect(actif()).toBe(b);
  ag(versNieme(e, F, 9));
  expect(actif()).toBe(c);
  expect(versNieme(e, F, 5)).toBeNull();
  ag({ type: "activerOnglet", id: a });
  expect(actif()).toBe(a);
});
