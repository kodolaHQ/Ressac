import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Action, PanneauOnglets } from "../src/commun/api";
import type { EtatNavigateur } from "../src/commun/modele";
import { appliquer } from "../src/main/etat/actions";
import { etatInitial } from "../src/main/etat/etat-initial";
import { ParcoursOnglets } from "../src/main/parcours-onglets";

let n = 0;
const genId = () => `g${++n}`;
let e: EtatNavigateur;
let F: string;
let p: ParcoursOnglets;
let envoyer: ReturnType<typeof vi.fn<(f: string, panneau: PanneauOnglets | null) => void>>;
let capturer: ReturnType<typeof vi.fn<(f: string) => Promise<void>>>;

const agir = (a: Action) => {
  e = appliquer(e, a, genId);
  p.surEtat(e);
};
const ouvrir = (url: string) => {
  agir({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};
const actif = () => {
  const f = e.fenetres[0]!;
  return f.actif[f.espaceActif];
};
const dernierEnvoi = () => envoyer.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  e = etatInitial(genId);
  F = e.fenetres[0]!.id;
  envoyer = vi.fn();
  capturer = vi.fn(async () => {});
  p = new ParcoursOnglets({ etat: () => e, agir, envoyer, apercu: (id) => (id === "sans" ? null : `apercu-${id}`), capturer });
  p.surEtat(e);
});
afterEach(() => vi.useRealTimers());

/** a, b, c ouverts puis activés dans cet ordre : c actif, puis b, puis a dans l'historique. */
const troisOnglets = () => {
  const a = ouvrir("https://a.fr");
  const b = ouvrir("https://b.fr");
  const c = ouvrir("https://c.fr");
  agir({ type: "activerOnglet", id: a });
  agir({ type: "activerOnglet", id: b });
  agir({ type: "activerOnglet", id: c });
  vi.runAllTimers();
  capturer.mockClear();
  return { a, b, c };
};

test("appui bref : retour à l'onglet d'avant, aucun panneau", () => {
  const { b } = troisOnglets();
  p.parcourir(F, 1);
  expect(capturer).toHaveBeenCalledWith(F);
  vi.advanceTimersByTime(50);
  p.toucheRelachee(F);
  expect(actif()).toBe(b);
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
});

test("parcours long : panneau après 200 ms, avance, relâchement active la sélection et ferme", () => {
  const { a, b, c } = troisOnglets();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(199);
  expect(envoyer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(51);
  expect(envoyer).toHaveBeenCalledTimes(1);
  const panneau = dernierEnvoi()!;
  expect(panneau.selection).toBe(1);
  expect(panneau.cartes.map((x) => x.id)).toEqual([c, b, a]);
  expect(panneau.cartes[0]).toEqual({ id: c, titre: e.onglets[c]!.titre, favicon: e.onglets[c]!.favicon, apercu: `apercu-${c}` });
  expect(envoyer.mock.calls[0]![0]).toBe(F);
  p.parcourir(F, 1);
  expect(dernierEnvoi()!.selection).toBe(2);
  expect(actif()).toBe(c); // rien ne change pendant le parcours
  p.toucheRelachee(F);
  expect(actif()).toBe(a);
  expect(dernierEnvoi()).toBeNull();
});

test("⌃⇧Tab d'abord : sélection sur le plus ancien", () => {
  const { a } = troisOnglets();
  p.parcourir(F, -1);
  vi.advanceTimersByTime(250);
  expect(dernierEnvoi()!.selection).toBe(2);
  p.toucheRelachee(F);
  expect(actif()).toBe(a);
});

test("annuler : panneau fermé, onglet actif inchangé", () => {
  const { c } = troisOnglets();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.annuler(F);
  expect(dernierEnvoi()).toBeNull();
  expect(actif()).toBe(c);
  p.toucheRelachee(F);
  expect(actif()).toBe(c);
});

test("annuler avant 200 ms : rien n'est envoyé, le minuteur est coupé", () => {
  troisOnglets();
  p.parcourir(F, 1);
  p.annuler(F);
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
});

test("onglet fermé pendant le parcours : sélection dans les bornes, puis fin quand il en reste un", () => {
  const { a, b, c } = troisOnglets();
  p.parcourir(F, -1); // sélection sur a, la dernière
  vi.advanceTimersByTime(250);
  agir({ type: "fermerOnglet", id: a });
  const panneau = dernierEnvoi()!;
  expect(panneau.cartes.map((x) => x.id)).toEqual([c, b]);
  expect(panneau.selection).toBe(1);
  agir({ type: "fermerOnglet", id: b });
  expect(dernierEnvoi()).toBeNull();
  envoyer.mockClear();
  p.toucheRelachee(F);
  expect(envoyer).not.toHaveBeenCalled();
  expect(actif()).toBe(c);
});

test("0 ou 1 onglet : parcourir ne fait rien", () => {
  p.parcourir(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  ouvrir("https://a.fr");
  vi.runAllTimers();
  capturer.mockClear();
  p.parcourir(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  expect(capturer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
});

test("relâchement hors parcours : rien", () => {
  const { c } = troisOnglets();
  p.toucheRelachee(F);
  expect(actif()).toBe(c);
  expect(envoyer).not.toHaveBeenCalled();
});

test("messages de l'interface : survoler, choisir, avancer, valider", () => {
  const { a, b, c } = troisOnglets();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "survoler", id: a });
  expect(dernierEnvoi()!.selection).toBe(2);
  p.message(F, { type: "avancer", delta: 1 });
  expect(dernierEnvoi()!.selection).toBe(0);
  p.message(F, { type: "valider" });
  expect(actif()).toBe(c);
  expect(dernierEnvoi()).toBeNull();

  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: b });
  expect(actif()).toBe(b);
  expect(dernierEnvoi()).toBeNull();

  // Un id hors de la liste est ignoré.
  p.parcourir(F, 1);
  p.message(F, { type: "choisir", id: "inconnu" });
  expect(actif()).toBe(b);
  p.message(F, { type: "annuler" });
});

test("changement d'onglet actif : capture planifiée 1 s après, sans attendre", () => {
  const a = ouvrir("https://a.fr");
  ouvrir("https://b.fr");
  vi.runAllTimers();
  capturer.mockClear();
  agir({ type: "activerOnglet", id: a });
  expect(capturer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(capturer).toHaveBeenCalledWith(F);
});

test("panneau glissant : 7 cartes au plus, sélection relative", () => {
  const ids = Array.from({ length: 9 }, (_, i) => ouvrir(`https://${i}.fr`));
  for (const id of ids) agir({ type: "activerOnglet", id });
  p.parcourir(F, -1); // le plus ancien, indice 8
  vi.advanceTimersByTime(250);
  const panneau = dernierEnvoi()!;
  expect(panneau.cartes).toHaveLength(7);
  expect(panneau.cartes[panneau.selection]!.id).toBe(ids[0]);
});

test("essentiel d'un espace frère (même clé) : validé sans changer d'espace", () => {
  const ess = ouvrir("https://ess.fr");
  agir({ type: "ajouterEssentiel", id: ess });
  const espaceA = e.fenetres[0]!.espaceActif;
  const a = e.espaces.find((x) => x.id === espaceA)!;
  agir({ type: "creerEspace", nom: "B", icone: "b", prive: a.prive, profil: a.profil, fenetreId: F });
  const espaceB = e.fenetres[0]!.espaceActif;
  expect(espaceB).not.toBe(espaceA);
  const x = ouvrir("https://x.fr");
  expect(actif()).toBe(x);
  p.parcourir(F, 1);
  p.toucheRelachee(F);
  expect(e.fenetres[0]!.espaceActif).toBe(espaceB);
  expect(e.fenetres[0]!.actif[espaceB]).toBe(ess);
});

test("carte sans aperçu : apercu null", () => {
  const a = ouvrir("https://a.fr");
  ouvrir("https://b.fr");
  p = new ParcoursOnglets({ etat: () => e, agir, envoyer, apercu: (id) => (id === a ? null : `apercu-${id}`), capturer });
  p.surEtat(e);
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  const carte = dernierEnvoi()!.cartes.find((c) => c.id === a)!;
  expect(carte.apercu).toBeNull();
  expect(carte.favicon).toBe(e.onglets[a]!.favicon);
});
