import { beforeEach, expect, test } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { walkableTabs } from "../shared/walkable-tabs";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
const ag = (a: Action | null) => {
  if (a) e = apply(e, a, genId);
};
const open = (url: string) => {
  ag({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.fenetres[0]!.id;
});

test("walkableTabs: bar order, closed pinned absent, essential first, other space absent", () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  const p = open("https://p.fr");
  ag({ type: "epinglerOnglet", id: p });
  const q = open("https://q.fr");
  ag({ type: "epinglerOnglet", id: q });
  ag({ type: "fermerOnglet", id: q });
  const ess = open("https://ess.fr");
  ag({ type: "ajouterEssentiel", id: ess });
  expect(walkableTabs(e, F)).toEqual([ess, p, a, b, c]);

  const espace0 = e.fenetres[0]!.espaceActif;
  ag({ type: "creerEspace", nom: "Autre", icone: "x", prive: false, profil: "nouveau", fenetreId: F });
  const other = e.fenetres[0]!.espaceActif;
  expect(other).not.toBe(espace0);
  const z = open("https://z.fr");
  expect(walkableTabs(e, F)).toEqual([z]);
});
