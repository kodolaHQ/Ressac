import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Action, PanneauOnglets } from "../shared/api";
import type { EtatNavigateur } from "../shared/modele";
import { appliquer } from "../core/etat/actions";
import { etatInitial } from "../core/etat/etat-initial";
import { ParcoursOnglets } from "../core/parcours-onglets";

let n = 0;
const genId = () => `g${++n}`;
let e: EtatNavigateur;
let F: string;
let p: ParcoursOnglets;
let envoyer: ReturnType<typeof vi.fn<(f: string, panneau: PanneauOnglets | null) => void>>;
let capturer: ReturnType<typeof vi.fn<(f: string) => Promise<void>>>;
let rendreFocus: ReturnType<typeof vi.fn<(f: string) => void>>;
/** Active tab at the moment focus is returned (it must be after the tab change). */
let actifAuFocus: (string | null | undefined)[];
let focalisee: boolean;

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
  actifAuFocus = [];
  rendreFocus = vi.fn(() => void actifAuFocus.push(actif()));
  focalisee = true;
  p = new ParcoursOnglets({ etat: () => e, agir, envoyer, apercu: (id) => (id === "sans" ? null : `apercu-${id}`), capturer, rendreFocus, estFocalisee: () => focalisee });
  p.surEtat(e);
});
afterEach(() => vi.useRealTimers());

/** a, b, c opened then activated in that order: c active, then b, then a in the history. */
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

test("short press: back to the previous tab, no panel", () => {
  const { b } = troisOnglets();
  p.parcourir(F, 1);
  expect(capturer).toHaveBeenCalledWith(F);
  vi.advanceTimersByTime(50);
  p.toucheRelachee(F);
  expect(actif()).toBe(b);
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
});

test("long walk: panel after 200 ms, advance, release activates the selection and closes", () => {
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
  expect(actif()).toBe(c); // nothing changes during the walk
  p.toucheRelachee(F);
  expect(actif()).toBe(a);
  expect(dernierEnvoi()).toBeNull();
});

test("⌃⇧Tab first: selection on the oldest", () => {
  const { a } = troisOnglets();
  p.parcourir(F, -1);
  vi.advanceTimersByTime(250);
  expect(dernierEnvoi()!.selection).toBe(2);
  p.toucheRelachee(F);
  expect(actif()).toBe(a);
});

test("cancel: panel closed, active tab unchanged", () => {
  const { c } = troisOnglets();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.annuler(F);
  expect(dernierEnvoi()).toBeNull();
  expect(actif()).toBe(c);
  p.toucheRelachee(F);
  expect(actif()).toBe(c);
});

test("cancel before 200 ms: nothing is sent, the timer is cleared", () => {
  troisOnglets();
  p.parcourir(F, 1);
  p.annuler(F);
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
});

test("tab closed during the walk: selection within bounds, then end when one is left", () => {
  const { a, b, c } = troisOnglets();
  p.parcourir(F, -1); // selection on a, the last one
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

test("release outside a walk: nothing", () => {
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

  // An id outside the list is ignored.
  p.parcourir(F, 1);
  p.message(F, { type: "choisir", id: "inconnu" });
  expect(actif()).toBe(b);
  p.message(F, { type: "annuler" });
});

test("active tab change: capture scheduled 1 s later, without waiting", () => {
  const a = ouvrir("https://a.fr");
  ouvrir("https://b.fr");
  vi.runAllTimers();
  capturer.mockClear();
  agir({ type: "activerOnglet", id: a });
  expect(capturer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(capturer).toHaveBeenCalledWith(F);
});

test("sliding panel: 7 cards at most, relative selection", () => {
  const ids = Array.from({ length: 9 }, (_, i) => ouvrir(`https://${i}.fr`));
  for (const id of ids) agir({ type: "activerOnglet", id });
  p.parcourir(F, -1); // the oldest, index 8
  vi.advanceTimersByTime(250);
  const panneau = dernierEnvoi()!;
  expect(panneau.cartes).toHaveLength(7);
  expect(panneau.cartes[panneau.selection]!.id).toBe(ids[0]);
});

test("essential of a sibling space (same key): confirmed without changing space", () => {
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

test("card without a preview: apercu null", () => {
  const a = ouvrir("https://a.fr");
  ouvrir("https://b.fr");
  p = new ParcoursOnglets({ etat: () => e, agir, envoyer, apercu: (id) => (id === a ? null : `apercu-${id}`), capturer, rendreFocus, estFocalisee: () => true });
  p.surEtat(e);
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  const carte = dernierEnvoi()!.cartes.find((c) => c.id === a)!;
  expect(carte.apercu).toBeNull();
  expect(carte.favicon).toBe(e.onglets[a]!.favicon);
});

test("focus returned to the displayed page after a walk with a panel (confirmed or cancelled), never without a panel", () => {
  const { a, b, c } = troisOnglets();
  // Short press: no panel, the interface never took focus.
  p.parcourir(F, 1);
  p.toucheRelachee(F);
  expect(actif()).toBe(b);
  expect(rendreFocus).not.toHaveBeenCalled();
  // Cancelled before the panel: nothing either.
  p.parcourir(F, 1);
  p.annuler(F);
  expect(rendreFocus).not.toHaveBeenCalled();

  // Confirmed with a panel: focus returned after the selection is activated.
  p.parcourir(F, 1); // order b, c, a: selection on c
  vi.advanceTimersByTime(250);
  p.toucheRelachee(F);
  expect(rendreFocus).toHaveBeenCalledTimes(1);
  expect(rendreFocus).toHaveBeenLastCalledWith(F);
  expect(actifAuFocus).toEqual([c]);

  // Cancelled (Esc) with a panel: focus returned to the tab that stayed displayed.
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "annuler" });
  expect(rendreFocus).toHaveBeenCalledTimes(2);
  expect(actifAuFocus).toEqual([c, c]);

  // Choisi d'un clic : pareil.
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: a });
  expect(actifAuFocus).toEqual([c, c, a]);
});

test("window left during the walk: panel closed, focus not taken back", () => {
  const { c } = troisOnglets();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.fenetreQuittee(F);
  expect(dernierEnvoi()).toBeNull();
  expect(actif()).toBe(c);
  expect(rendreFocus).not.toHaveBeenCalled();
});

test("window without focus (devtools…): immediate switch, no walk nor timer", () => {
  const { a, b } = troisOnglets();
  focalisee = false;
  p.parcourir(F, 1);
  expect(actif()).toBe(b);
  // Only the capture of the newly displayed tab is scheduled (surEtat), no panel timer.
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(envoyer).not.toHaveBeenCalled();
  // No walk in progress: the release does nothing more.
  p.toucheRelachee(F);
  expect(actif()).toBe(b);
  // ⌃⇧Tab: the oldest, like a short press.
  p.parcourir(F, -1);
  expect(actif()).toBe(a);
  expect(rendreFocus).not.toHaveBeenCalled();
});

test("window without focus: an essential of a sibling space opens through its favorite", () => {
  const ess = ouvrir("https://ess.fr");
  agir({ type: "ajouterEssentiel", id: ess });
  const espaceA = e.fenetres[0]!.espaceActif;
  const a = e.espaces.find((x) => x.id === espaceA)!;
  agir({ type: "creerEspace", nom: "B", icone: "b", prive: a.prive, profil: a.profil, fenetreId: F });
  const espaceB = e.fenetres[0]!.espaceActif;
  ouvrir("https://x.fr");
  focalisee = false;
  p.parcourir(F, 1);
  expect(e.fenetres[0]!.espaceActif).toBe(espaceB);
  expect(e.fenetres[0]!.actif[espaceB]).toBe(ess);
});
