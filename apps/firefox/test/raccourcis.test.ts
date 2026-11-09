import { beforeEach, expect, test } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/modele";
import { apply } from "../core/etat/actions";
import { initialState } from "../core/etat/etat-initial";
import { toNth } from "../core/raccourcis";

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
const active = () => {
  const f = e.fenetres[0]!;
  return f.actif[f.espaceActif];
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.fenetres[0]!.id;
});

test("⌘1…⌘9: the space's pinned come before the tabs, open or not", () => {
  const p = open("https://epingle.fr");
  ag({ type: "epinglerOnglet", id: p });
  const favorite = e.espaces[0]!.epingles[0]!.id;
  ag({ type: "fermerOnglet", id: p }); // the favorite stays, without a tab
  const a = open("https://a.fr");
  expect(toNth(e, F, 1)).toEqual({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favorite });
  ag(toNth(e, F, 1));
  expect(e.onglets[active()!]?.lien?.id).toBe(favorite);
  ag(toNth(e, F, 2));
  expect(active()).toBe(a);
});

test("⌘2 activates the second; ⌘9 the last; beyond the list, nothing", () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  ag(toNth(e, F, 2));
  expect(active()).toBe(b);
  ag(toNth(e, F, 9));
  expect(active()).toBe(c);
  expect(toNth(e, F, 5)).toBeNull();
  ag({ type: "activerOnglet", id: a });
  expect(active()).toBe(a);
});
