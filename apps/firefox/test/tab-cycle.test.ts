import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Action, TabsPanel } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { TabCycle } from "../core/tab-cycle";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
let p: TabCycle;
let send: ReturnType<typeof vi.fn<(f: string, panel: TabsPanel | null) => void>>;
let capture: ReturnType<typeof vi.fn<(f: string) => Promise<void>>>;
let returnFocus: ReturnType<typeof vi.fn<(f: string) => void>>;
/** Active tab at the moment focus is returned (it must be after the tab change). */
let activeOnFocus: (string | null | undefined)[];
let focused: boolean;

const act = (a: Action) => {
  e = apply(e, a, genId);
  p.onState(e);
};
const open = (url: string) => {
  act({ type: "ouvrirOnglet", windowId: F, url });
  return Object.keys(e.tabs).at(-1)!;
};
const active = () => {
  const f = e.windows[0]!;
  return f.active[f.activeSpace];
};
const lastSend = () => send.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  n = 0;
  e = initialState(genId);
  F = e.windows[0]!.id;
  send = vi.fn();
  capture = vi.fn(async () => {});
  activeOnFocus = [];
  returnFocus = vi.fn(() => void activeOnFocus.push(active()));
  focused = true;
  p = new TabCycle({ state: () => e, dispatch: act, send: send, preview: (id) => (id === "sans" ? null : `apercu-${id}`), capture, restoreFocus: returnFocus, isFocused: () => focused });
  p.onState(e);
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
  capture.mockClear();
  return { a, b, c };
};

test("short press: back to the previous tab, no panel", () => {
  const { b } = threeTabs();
  p.browse(F, 1);
  expect(capture).toHaveBeenCalledWith(F);
  vi.advanceTimersByTime(50);
  p.keyReleased(F);
  expect(active()).toBe(b);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("long walk: panel after 200 ms, advance, release activates the selection and closes", () => {
  const { a, b, c } = threeTabs();
  p.browse(F, 1);
  vi.advanceTimersByTime(199);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(51);
  expect(send).toHaveBeenCalledTimes(1);
  const panel = lastSend()!;
  expect(panel.selection).toBe(1);
  expect(panel.cards.map((x) => x.id)).toEqual([c, b, a]);
  expect(panel.cards[0]).toEqual({ id: c, title: e.tabs[c]!.title, favicon: e.tabs[c]!.favicon, preview: `apercu-${c}` });
  expect(send.mock.calls[0]![0]).toBe(F);
  p.browse(F, 1);
  expect(lastSend()!.selection).toBe(2);
  expect(active()).toBe(c); // nothing changes during the walk
  p.keyReleased(F);
  expect(active()).toBe(a);
  expect(lastSend()).toBeNull();
});

test("⌃⇧Tab first: selection on the oldest", () => {
  const { a } = threeTabs();
  p.browse(F, -1);
  vi.advanceTimersByTime(250);
  expect(lastSend()!.selection).toBe(2);
  p.keyReleased(F);
  expect(active()).toBe(a);
});

test("cancel: panel closed, active tab unchanged", () => {
  const { c } = threeTabs();
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.cancel(F);
  expect(lastSend()).toBeNull();
  expect(active()).toBe(c);
  p.keyReleased(F);
  expect(active()).toBe(c);
});

test("cancel before 200 ms: nothing is sent, the timer is cleared", () => {
  threeTabs();
  p.browse(F, 1);
  p.cancel(F);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("tab closed during the walk: selection within bounds, then end when one is left", () => {
  const { a, b, c } = threeTabs();
  p.browse(F, -1); // selection on a, the last one
  vi.advanceTimersByTime(250);
  act({ type: "fermerOnglet", id: a });
  const panel = lastSend()!;
  expect(panel.cards.map((x) => x.id)).toEqual([c, b]);
  expect(panel.selection).toBe(1);
  act({ type: "fermerOnglet", id: b });
  expect(lastSend()).toBeNull();
  send.mockClear();
  p.keyReleased(F);
  expect(send).not.toHaveBeenCalled();
  expect(active()).toBe(c);
});

test("0 or 1 tab: parcourir does nothing", () => {
  p.browse(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  open("https://a.fr");
  vi.runAllTimers();
  capture.mockClear();
  p.browse(F, 1);
  expect(vi.getTimerCount()).toBe(0);
  expect(capture).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
});

test("release outside a walk: nothing", () => {
  const { c } = threeTabs();
  p.keyReleased(F);
  expect(active()).toBe(c);
  expect(send).not.toHaveBeenCalled();
});

test("interface messages: hover, choose, advance, confirm", () => {
  const { a, b, c } = threeTabs();
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "survoler", id: a });
  expect(lastSend()!.selection).toBe(2);
  p.message(F, { type: "avancer", delta: 1 });
  expect(lastSend()!.selection).toBe(0);
  p.message(F, { type: "valider" });
  expect(active()).toBe(c);
  expect(lastSend()).toBeNull();

  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: b });
  expect(active()).toBe(b);
  expect(lastSend()).toBeNull();

  // An id outside the list is ignored.
  p.browse(F, 1);
  p.message(F, { type: "choisir", id: "inconnu" });
  expect(active()).toBe(b);
  p.message(F, { type: "annuler" });
});

test("active tab change: capture scheduled 1 s later, without waiting", () => {
  const a = open("https://a.fr");
  open("https://b.fr");
  vi.runAllTimers();
  capture.mockClear();
  act({ type: "activerOnglet", id: a });
  expect(capture).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(capture).toHaveBeenCalledWith(F);
});

test("sliding panel: 7 cards at most, relative selection", () => {
  const ids = Array.from({ length: 9 }, (_, i) => open(`https://${i}.fr`));
  for (const id of ids) act({ type: "activerOnglet", id });
  p.browse(F, -1); // the oldest, index 8
  vi.advanceTimersByTime(250);
  const panel = lastSend()!;
  expect(panel.cards).toHaveLength(7);
  expect(panel.cards[panel.selection]!.id).toBe(ids[0]);
});

test("essential of a sibling space (same key): confirmed without changing space", () => {
  const ess = open("https://ess.fr");
  act({ type: "ajouterEssentiel", id: ess });
  const spaceA = e.windows[0]!.activeSpace;
  const a = e.spaces.find((x) => x.id === spaceA)!;
  act({ type: "creerEspace", name: "B", icon: "b", private: a.private, profile: a.profile, windowId: F });
  const spaceB = e.windows[0]!.activeSpace;
  expect(spaceB).not.toBe(spaceA);
  const x = open("https://x.fr");
  expect(active()).toBe(x);
  p.browse(F, 1);
  p.keyReleased(F);
  expect(e.windows[0]!.activeSpace).toBe(spaceB);
  expect(e.windows[0]!.active[spaceB]).toBe(ess);
});

test("card without a preview: apercu null", () => {
  const a = open("https://a.fr");
  open("https://b.fr");
  p = new TabCycle({ state: () => e, dispatch: act, send: send, preview: (id) => (id === a ? null : `apercu-${id}`), capture, restoreFocus: returnFocus, isFocused: () => true });
  p.onState(e);
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  const card = lastSend()!.cards.find((c) => c.id === a)!;
  expect(card.preview).toBeNull();
  expect(card.favicon).toBe(e.tabs[a]!.favicon);
});

test("focus returned to the displayed page after a walk with a panel (confirmed or cancelled), never without a panel", () => {
  const { a, b, c } = threeTabs();
  // Short press: no panel, the interface never took focus.
  p.browse(F, 1);
  p.keyReleased(F);
  expect(active()).toBe(b);
  expect(returnFocus).not.toHaveBeenCalled();
  // Cancelled before the panel: nothing either.
  p.browse(F, 1);
  p.cancel(F);
  expect(returnFocus).not.toHaveBeenCalled();

  // Confirmed with a panel: focus returned after the selection is activated.
  p.browse(F, 1); // order b, c, a: selection on c
  vi.advanceTimersByTime(250);
  p.keyReleased(F);
  expect(returnFocus).toHaveBeenCalledTimes(1);
  expect(returnFocus).toHaveBeenLastCalledWith(F);
  expect(activeOnFocus).toEqual([c]);

  // Cancelled (Esc) with a panel: focus returned to the tab that stayed displayed.
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "annuler" });
  expect(returnFocus).toHaveBeenCalledTimes(2);
  expect(activeOnFocus).toEqual([c, c]);

  // Chosen by a click: same.
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.message(F, { type: "choisir", id: a });
  expect(activeOnFocus).toEqual([c, c, a]);
});

test("window left during the walk: panel closed, focus not taken back", () => {
  const { c } = threeTabs();
  p.browse(F, 1);
  vi.advanceTimersByTime(250);
  p.windowLeft(F);
  expect(lastSend()).toBeNull();
  expect(active()).toBe(c);
  expect(returnFocus).not.toHaveBeenCalled();
});

test("window without focus (devtools…): immediate switch, no walk nor timer", () => {
  const { a, b } = threeTabs();
  focused = false;
  p.browse(F, 1);
  expect(active()).toBe(b);
  // Only the capture of the newly displayed tab is scheduled (surEtat), no panel timer.
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1000);
  expect(send).not.toHaveBeenCalled();
  // No walk in progress: the release does nothing more.
  p.keyReleased(F);
  expect(active()).toBe(b);
  // ⌃⇧Tab: the oldest, like a short press.
  p.browse(F, -1);
  expect(active()).toBe(a);
  expect(returnFocus).not.toHaveBeenCalled();
});

test("window without focus: an essential of a sibling space opens through its favorite", () => {
  const ess = open("https://ess.fr");
  act({ type: "ajouterEssentiel", id: ess });
  const spaceA = e.windows[0]!.activeSpace;
  const a = e.spaces.find((x) => x.id === spaceA)!;
  act({ type: "creerEspace", name: "B", icon: "b", private: a.private, profile: a.profile, windowId: F });
  const spaceB = e.windows[0]!.activeSpace;
  open("https://x.fr");
  focused = false;
  p.browse(F, 1);
  expect(e.windows[0]!.activeSpace).toBe(spaceB);
  expect(e.windows[0]!.active[spaceB]).toBe(ess);
});
