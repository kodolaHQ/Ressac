import { beforeEach, expect, test } from "vitest";
import type { Action } from "../src/commun/api";
import type { EtatNavigateur } from "../src/commun/modele";
import { appliquer } from "../src/main/etat/actions";
import { etatInitial } from "../src/main/etat/etat-initial";
import { avancer, demarrer, fenetreVisible, noterUtilisation, ongletsParcourables, ordreRecent, retirer } from "../src/main/recents";

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

test("ordreRecent : actif en tête, historique, puis le reste ; fermés ignorés", () => {
  const a = ouvrir("https://a.fr");
  const b = ouvrir("https://b.fr");
  const c = ouvrir("https://c.fr");
  const d = ouvrir("https://d.fr");
  ag({ type: "activerOnglet", id: b });
  expect(ordreRecent(e, F, [c, a])).toEqual([b, c, a, d]);
  ag({ type: "fermerOnglet", id: c });
  expect(ordreRecent(e, F, [c, a])).toEqual([b, a, d]);
});

test("noterUtilisation", () => {
  expect(noterUtilisation(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  expect(noterUtilisation(["a"], "z")).toEqual(["z", "a"]);
});

test("demarrer", () => {
  expect(demarrer(["a"], 1)).toBeNull();
  expect(demarrer(["a", "b", "c"], 1)!.selection).toBe(1);
  expect(demarrer(["a", "b", "c"], -1)!.selection).toBe(2);
});

test("avancer boucle", () => {
  const p = demarrer(["a", "b", "c"], 1)!;
  expect(avancer(avancer(p, 1), 1).selection).toBe(0);
  expect(avancer(avancer(p, -1), -1).selection).toBe(2);
});

test("retirer", () => {
  const p = { liste: ["a", "b", "c"], selection: 1 };
  expect(retirer(p, "b")).toEqual({ liste: ["a", "c"], selection: 1 });
  expect(retirer({ liste: ["a", "b", "c"], selection: 2 }, "c")).toEqual({ liste: ["a", "b"], selection: 1 });
  expect(retirer({ liste: ["a", "b", "c"], selection: 2 }, "a")).toEqual({ liste: ["b", "c"], selection: 1 });
  expect(retirer({ liste: ["a", "b"], selection: 1 }, "a")).toBeNull();
});

test("fenetreVisible", () => {
  const liste = Array.from({ length: 10 }, (_, i) => String(i));
  expect(fenetreVisible({ liste, selection: 0 })).toEqual({ debut: 0, fin: 7 });
  expect(fenetreVisible({ liste, selection: 9 })).toEqual({ debut: 3, fin: 10 });
  expect(fenetreVisible({ liste: liste.slice(0, 4), selection: 2 })).toEqual({ debut: 0, fin: 4 });
});
