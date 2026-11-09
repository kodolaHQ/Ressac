import { beforeEach, expect, test } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { advance, start, visibleWindow, noteUsage, recentOrder, remove } from "../core/recents";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string;
const ag = (a: Action | null) => {
  if (a) e = apply(e, a, genId);
};
const open = (url: string) => {
  ag({ type: "ouvrirOnglet", windowId: F, url });
  return Object.keys(e.tabs).at(-1)!;
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.windows[0]!.id;
});

test("recentOrder: active first, history, then the rest; closed ignored", () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  const d = open("https://d.fr");
  ag({ type: "activerOnglet", id: b });
  expect(recentOrder(e, F, [c, a])).toEqual([b, c, a, d]);
  ag({ type: "fermerOnglet", id: c });
  expect(recentOrder(e, F, [c, a])).toEqual([b, a, d]);
});

test("noteUsage", () => {
  expect(noteUsage(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  expect(noteUsage(["a"], "z")).toEqual(["z", "a"]);
});

test("demarrer", () => {
  expect(start(["a"], 1)).toBeNull();
  expect(start(["a", "b", "c"], 1)!.selection).toBe(1);
  expect(start(["a", "b", "c"], -1)!.selection).toBe(2);
});

test("avancer boucle", () => {
  const p = start(["a", "b", "c"], 1)!;
  expect(advance(advance(p, 1), 1).selection).toBe(0);
  expect(advance(advance(p, -1), -1).selection).toBe(2);
});

test("retirer", () => {
  const p = { list: ["a", "b", "c"], selection: 1 };
  expect(remove(p, "b")).toEqual({ list: ["a", "c"], selection: 1 });
  expect(remove({ list: ["a", "b", "c"], selection: 2 }, "c")).toEqual({ list: ["a", "b"], selection: 1 });
  expect(remove({ list: ["a", "b", "c"], selection: 2 }, "a")).toEqual({ list: ["b", "c"], selection: 1 });
  expect(remove({ list: ["a", "b"], selection: 1 }, "a")).toBeNull();
});

test("visibleWindow", () => {
  const list = Array.from({ length: 10 }, (_, i) => String(i));
  expect(visibleWindow({ list: list, selection: 0 })).toEqual({ start: 0, end: 7 });
  expect(visibleWindow({ list: list, selection: 9 })).toEqual({ start: 3, end: 10 });
  expect(visibleWindow({ list: list.slice(0, 4), selection: 2 })).toEqual({ start: 0, end: 4 });
});
