import { beforeEach, expect, test } from "vitest";
import type { Action } from "../src/commun/api";
import type { EtatNavigateur } from "../src/commun/modele";
import { appliquer } from "../src/main/etat/actions";
import { etatInitial } from "../src/main/etat/etat-initial";
import { ongletsParcourables } from "../src/commun/onglets-parcourables";

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

beforeEach(() => {
  n = 0;
  e = etatInitial(genId);
  F = e.fenetres[0]!.id;
});

test("ongletsParcourables : ordre de la barre, épinglé fermé absent, essentiel en tête, autre espace absent", () => {
  const a = ouvrir("https://a.fr");
  const b = ouvrir("https://b.fr");
  const c = ouvrir("https://c.fr");
  const p = ouvrir("https://p.fr");
  ag({ type: "epinglerOnglet", id: p });
  const q = ouvrir("https://q.fr");
  ag({ type: "epinglerOnglet", id: q });
  ag({ type: "fermerOnglet", id: q });
  const ess = ouvrir("https://ess.fr");
  ag({ type: "ajouterEssentiel", id: ess });
  expect(ongletsParcourables(e, F)).toEqual([ess, p, a, b, c]);

  const espace0 = e.fenetres[0]!.espaceActif;
  ag({ type: "creerEspace", nom: "Autre", icone: "x", prive: false, profil: "nouveau", fenetreId: F });
  const autre = e.fenetres[0]!.espaceActif;
  expect(autre).not.toBe(espace0);
  const z = ouvrir("https://z.fr");
  expect(ongletsParcourables(e, F)).toEqual([z]);
});
