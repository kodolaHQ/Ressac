import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Action, TabsPanel } from "../shared/api";
import type { BrowserState } from "../shared/modele";
import { apply } from "../core/etat/actions";
import { initialState } from "../core/etat/etat-initial";
import { TabCycle } from "../core/parcours-onglets";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
let p: TabCycle;
let send: ReturnType<typeof vi.fn<(f: string, panel: TabsPanel | null) => void>>;
let capturer: ReturnType<typeof vi.fn<(f: string) => Promise<void>>>;
let returnFocus: ReturnType<typeof vi.fn<(f: string) => void>>;
/** Active tab at the moment focus is returned (it must be after the tab change). */
let activeOnFocus: (string | null | undefined)[];
let focused: boolean;

const act = (a: Action) => {
  e = apply(e, a, genId);
  p.surEtat(e);
};
const open = (url: string) => {
  act({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};
const active = () => {
  const f = e.fenetres[0]!;
  return f.actif[f.espaceActif];
};
const lastSend = () => send.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  e = initialState(genId);
  F = e.fenetres[0]!.id;
  send = vi.fn();
  capturer = vi.fn(async () => {});
  activeOnFocus = [];
  returnFocus = vi.fn(() => void activeOnFocus.push(active()));
  focused = true;
  p = new TabCycle({ etat: () => e, agir: act, envoyer: send, apercu: (id) => (id === "sans" ? null : `apercu-${id}`), capturer, rendreFocus: returnFocus, estFocalisee: () => focused });
  p.surEtat(e);
});
afterEach(() => vi.useRealTimers());

/** a, b, c opened then activated in that order: c active, then b, then a in the history. */
const threeTabs = () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  act({ type: "activerOnglet", id: a });
  act({ type: "activerOnglet", id: b });
  act({ type: "activerOnglet", id: c });
  vi.runAllTimers();
  capturer.mockClear();
  return { a, b, c };
};

test("short press: back to the previous tab, no panel", () => {
  const { b } = threeTabs();
  p.parcourir(F, 1);
  expect(capturer).toHaveBeenCalledWith(F);
  vi.advanceTimersByTime(50);
  p.toucheRelachee(F);
  expect(active()).toBe(b);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("long walk: panel after 200 ms, advance, release activates the selection and closes", () => {
  const { a, b, c } = threeTabs();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(199);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(51);
  expect(send).toHaveBeenCalledTimes(1);
  const panel = lastSend()!;
  expect(panel.selection).toBe(1);
  expect(panel.cartes.map((x) => x.id)).toEqual([c, b, a]);
  expect(panel.cartes[0]).toEqual({ id: c, titre: e.onglets[c]!.titre, favicon: e.onglets[c]!.favicon, apercu: `apercu-${c}` });
  expect(send.mock.calls[0]![0]).toBe(F);
  p.parcourir(F, 1);
  expect(lastSend()!.selection).toBe(2);
  expect(active()).toBe(c); // nothing changes during the walk
  p.toucheRelachee(F);
  expect(active()).toBe(a);
  expect(lastSend()).toBeNull();
});

test("⌃⇧Tab first: selection on the oldest", () => {
  const { a } = threeTabs();
  p.parcourir(F, -1);
  vi.advanceTimersByTime(250);
  expect(lastSend()!.selection).toBe(2);
  p.toucheRelachee(F);
  expect(active()).toBe(a);
});

test("cancel: panel closed, active tab unchanged", () => {
  const { c } = threeTabs();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.annuler(F);
  expect(lastSend()).toBeNull();
  expect(active()).toBe(c);
  p.toucheRelachee(F);
  expect(active()).toBe(c);
});

test("cancel before 200 ms: nothing is sent, the timer is cleared", () => {
  threeTabs();
  p.parcourir(F, 1);
  p.annuler(F);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("tab closed during the walk: selection within bounds, then end when one is left", () => {
  const { a, b, c } = threeTabs();
  p.parcourir(F, -1); // selection on a, the last one
  vi.advanceTimersByTime(250);
  act({ type: "fermerOnglet", id: a });
  const panel = lastSend()!;
  expect(panel.cartes.map((x) => x.id)).toEqual([c, b]);
  expect(panel.selection).toBe(1);
  act({ type: "fermerOnglet", id: b });
  expect(lastSend()).toBeNull();
  send.mockClear();
  p.toucheRelachee(F);
  expect(send).not.toHaveBeenCalled();
  expect(active()).toBe(c);
});

test("0 or 1 tab: parcourir does nothing", () => {
  p.parcourir(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  open("https://a.fr");
  vi.runAllTimers();
  capturer.mockClear();
  p.parcourir(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  expect(capturer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("release outside a walk: nothing", () => {
  const { c } = threeTabs();
  p.toucheRelachee(F);
  expect(active()).toBe(c);
  expect(send).not.toHaveBeenCalled();
});

test("interface messages: hover, choose, advance, confirm", () => {
  const { a, b, c } = threeTabs();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "survoler", id: a });
  expect(lastSend()!.selection).toBe(2);
  p.message(F, { type: "avancer", delta: 1 });
  expect(lastSend()!.selection).toBe(0);
  p.message(F, { type: "valider" });
  expect(active()).toBe(c);
  expect(lastSend()).toBeNull();

  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: b });
  expect(active()).toBe(b);
  expect(lastSend()).toBeNull();

  // An id outside the list is ignored.
  p.parcourir(F, 1);
  p.message(F, { type: "choisir", id: "inconnu" });
  expect(active()).toBe(b);
  p.message(F, { type: "annuler" });
});

test("active tab change: capture scheduled 1 s later, without waiting", () => {
  const a = open("https://a.fr");
  open("https://b.fr");
  vi.runAllTimers();
  capturer.mockClear();
  act({ type: "activerOnglet", id: a });
  expect(capturer).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(capturer).toHaveBeenCalledWith(F);
});

test("sliding panel: 7 cards at most, relative selection", () => {
  const ids = Array.from({ length: 9 }, (_, i) => open(`https://${i}.fr`));
  for (const id of ids) act({ type: "activerOnglet", id });
  p.parcourir(F, -1); // the oldest, index 8
  vi.advanceTimersByTime(250);
  const panel = lastSend()!;
  expect(panel.cartes).toHaveLength(7);
  expect(panel.cartes[panel.selection]!.id).toBe(ids[0]);
});

test("essential of a sibling space (same key): confirmed without changing space", () => {
  const ess = open("https://ess.fr");
  act({ type: "ajouterEssentiel", id: ess });
  const spaceA = e.fenetres[0]!.espaceActif;
  const a = e.espaces.find((x) => x.id === spaceA)!;
  act({ type: "creerEspace", nom: "B", icone: "b", prive: a.prive, profil: a.profil, fenetreId: F });
  const spaceB = e.fenetres[0]!.espaceActif;
  expect(spaceB).not.toBe(spaceA);
  const x = open("https://x.fr");
  expect(active()).toBe(x);
  p.parcourir(F, 1);
  p.toucheRelachee(F);
  expect(e.fenetres[0]!.espaceActif).toBe(spaceB);
  expect(e.fenetres[0]!.actif[spaceB]).toBe(ess);
});

test("card without a preview: apercu null", () => {
  const a = open("https://a.fr");
  open("https://b.fr");
  p = new TabCycle({ etat: () => e, agir: act, envoyer: send, apercu: (id) => (id === a ? null : `apercu-${id}`), capturer, rendreFocus: returnFocus, estFocalisee: () => true });
  p.surEtat(e);
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  const carte = lastSend()!.cartes.find((c) => c.id === a)!;
  expect(carte.apercu).toBeNull();
  expect(carte.favicon).toBe(e.onglets[a]!.favicon);
});

test("focus returned to the displayed page after a walk with a panel (confirmed or cancelled), never without a panel", () => {
  const { a, b, c } = threeTabs();
  // Short press: no panel, the interface never took focus.
  p.parcourir(F, 1);
  p.toucheRelachee(F);
  expect(active()).toBe(b);
  expect(returnFocus).not.toHaveBeenCalled();
  // Cancelled before the panel: nothing either.
  p.parcourir(F, 1);
  p.annuler(F);
  expect(returnFocus).not.toHaveBeenCalled();

  // Confirmed with a panel: focus returned after the selection is activated.
  p.parcourir(F, 1); // order b, c, a: selection on c
  vi.advanceTimersByTime(250);
  p.toucheRelachee(F);
  expect(returnFocus).toHaveBeenCalledTimes(1);
  expect(returnFocus).toHaveBeenLastCalledWith(F);
  expect(activeOnFocus).toEqual([c]);

  // Cancelled (Esc) with a panel: focus returned to the tab that stayed displayed.
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "annuler" });
  expect(returnFocus).toHaveBeenCalledTimes(2);
  expect(activeOnFocus).toEqual([c, c]);

  // Chosen by a click: same.
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: a });
  expect(activeOnFocus).toEqual([c, c, a]);
});

test("window left during the walk: panel closed, focus not taken back", () => {
  const { c } = threeTabs();
  p.parcourir(F, 1);
  vi.advanceTimersByTime(250);
  p.fenetreQuittee(F);
  expect(lastSend()).toBeNull();
  expect(active()).toBe(c);
  expect(returnFocus).not.toHaveBeenCalled();
});

test("window without focus (devtools…): immediate switch, no walk nor timer", () => {
  const { a, b } = threeTabs();
  focused = false;
  p.parcourir(F, 1);
  expect(active()).toBe(b);
  // Only the capture of the newly displayed tab is scheduled (surEtat), no panel timer.
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
  // No walk in progress: the release does nothing more.
  p.toucheRelachee(F);
  expect(active()).toBe(b);
  // ⌃⇧Tab: the oldest, like a short press.
  p.parcourir(F, -1);
  expect(active()).toBe(a);
  expect(returnFocus).not.toHaveBeenCalled();
});

test("window without focus: an essential of a sibling space opens through its favorite", () => {
  const ess = open("https://ess.fr");
  act({ type: "ajouterEssentiel", id: ess });
  const spaceA = e.fenetres[0]!.espaceActif;
  const a = e.espaces.find((x) => x.id === spaceA)!;
  act({ type: "creerEspace", nom: "B", icone: "b", prive: a.prive, profil: a.profil, fenetreId: F });
  const spaceB = e.fenetres[0]!.espaceActif;
  open("https://x.fr");
  focused = false;
  p.parcourir(F, 1);
  expect(e.fenetres[0]!.espaceActif).toBe(spaceB);
  expect(e.fenetres[0]!.actif[spaceB]).toBe(ess);
});
