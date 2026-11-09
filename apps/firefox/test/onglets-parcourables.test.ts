import { beforeEach, expect, test } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/modele";
import { apply } from "../core/etat/actions";
import { initialState } from "../core/etat/etat-initial";
import { walkableTabs } from "../shared/onglets-parcourables";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
const ag = (a: Action | null) => {
  if (a) e = apply(e, a, genId);
};
const ouvrir = (url: string) => {
  ag({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.fenetres[0]!.id;
});

test("ongletsParcourables: bar order, closed pinned absent, essential first, other space absent", () => {
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
  expect(walkableTabs(e, F)).toEqual([ess, p, a, b, c]);

  const espace0 = e.fenetres[0]!.espaceActif;
  ag({ type: "creerEspace", nom: "Autre", icone: "x", prive: false, profil: "nouveau", fenetreId: F });
  const autre = e.fenetres[0]!.espaceActif;
  expect(autre).not.toBe(espace0);
  const z = ouvrir("https://z.fr");
  expect(walkableTabs(e, F)).toEqual([z]);
});
