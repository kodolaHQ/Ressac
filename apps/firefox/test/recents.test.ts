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
  ag({ type: "ouvrirOnglet", fenetreId: F, url });
  return Object.keys(e.onglets).at(-1)!;
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.fenetres[0]!.id;
});

test("ordreRecent: active first, history, then the rest; closed ignored", () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  const d = open("https://d.fr");
  ag({ type: "activerOnglet", id: b });
  expect(recentOrder(e, F, [c, a])).toEqual([b, c, a, d]);
  ag({ type: "fermerOnglet", id: c });
  expect(recentOrder(e, F, [c, a])).toEqual([b, a, d]);
});

test("noterUtilisation", () => {
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
  const p = { liste: ["a", "b", "c"], selection: 1 };
  expect(remove(p, "b")).toEqual({ liste: ["a", "c"], selection: 1 });
  expect(remove({ liste: ["a", "b", "c"], selection: 2 }, "c")).toEqual({ liste: ["a", "b"], selection: 1 });
  expect(remove({ liste: ["a", "b", "c"], selection: 2 }, "a")).toEqual({ liste: ["b", "c"], selection: 1 });
  expect(remove({ liste: ["a", "b"], selection: 1 }, "a")).toBeNull();
});

test("fenetreVisible", () => {
  const list = Array.from({ length: 10 }, (_, i) => String(i));
  expect(visibleWindow({ liste: list, selection: 0 })).toEqual({ debut: 0, fin: 7 });
  expect(visibleWindow({ liste: list, selection: 9 })).toEqual({ debut: 3, fin: 10 });
  expect(visibleWindow({ liste: list.slice(0, 4), selection: 2 })).toEqual({ debut: 0, fin: 4 });
});
