import { beforeEach, expect, test } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { toNeighbour, toNextSpace, toNth } from "../core/shortcuts";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
const ag = (a: Action | null) => {
  if (a) e = apply(e, a, genId);
};
const open = (url: string) => {
  ag({ type: "openTab", windowId: F, url });
  return Object.keys(e.tabs).at(-1)!;
};
const active = () => {
  const f = e.windows[0]!;
  return f.active[f.activeSpace];
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.windows[0]!.id;
});

test("⌘1…⌘9: the space's pinned come before the tabs, open or not", () => {
  const p = open("https://epingle.fr");
  ag({ type: "pinTab", id: p });
  const favorite = e.spaces[0]!.pinned[0]!.id;
  ag({ type: "closeTab", id: p }); // the favorite stays, without a tab
  const a = open("https://a.fr");
  expect(toNth(e, F, 1)).toEqual({ type: "openFavorite", windowId: F, kind: "pinned", id: favorite });
  ag(toNth(e, F, 1));
  expect(e.tabs[active()!]?.link?.id).toBe(favorite);
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
  ag({ type: "activateTab", id: a });
  expect(active()).toBe(a);
});

test("vim J / K: the sidebar's neighbour, pinned first, wrapping", () => {
  const p = open("https://epingle.fr");
  ag({ type: "pinTab", id: p });
  const favorite = e.spaces[0]!.pinned[0]!.id;
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  ag(toNeighbour(e, F, -1));
  expect(active()).toBe(a);
  ag(toNeighbour(e, F, 1));
  expect(active()).toBe(b);
  // From the last, the first: the pinned favorite.
  expect(toNeighbour(e, F, 1)).toEqual({ type: "openFavorite", windowId: F, kind: "pinned", id: favorite });
});

test("vim gs / gS: the next / previous space, wrapping; one space, nothing", () => {
  expect(toNextSpace(e, F, 1)).toBeNull();
  const first = e.spaces[0]!.id;
  ag({ type: "createSpace", name: "B", icon: "b", private: false, profile: "default", windowId: F });
  const second = e.spaces[1]!.id;
  expect(e.windows[0]!.activeSpace).toBe(second);
  expect(toNextSpace(e, F, 1)).toEqual({ type: "activateSpace", windowId: F, id: first });
  expect(toNextSpace(e, F, -1)).toEqual({ type: "activateSpace", windowId: F, id: first });
  ag(toNextSpace(e, F, 1));
  expect(toNextSpace(e, F, -1)).toEqual({ type: "activateSpace", windowId: F, id: second });
});
