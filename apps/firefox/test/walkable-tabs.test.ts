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
  ag({ type: "openTab", windowId: F, url });
  return Object.keys(e.tabs).at(-1)!;
};

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.windows[0]!.id;
});

test("walkableTabs: bar order, closed pinned absent, essential first, other space absent", () => {
  const a = open("https://a.fr");
  const b = open("https://b.fr");
  const c = open("https://c.fr");
  const p = open("https://p.fr");
  ag({ type: "pinTab", id: p });
  const q = open("https://q.fr");
  ag({ type: "pinTab", id: q });
  ag({ type: "closeTab", id: q });
  const ess = open("https://ess.fr");
  ag({ type: "addEssential", id: ess });
  expect(walkableTabs(e, F)).toEqual([ess, p, a, b, c]);

  const firstSpace = e.windows[0]!.activeSpace;
  ag({ type: "createSpace", name: "Autre", icon: "x", private: false, profile: "new", windowId: F });
  const other = e.windows[0]!.activeSpace;
  expect(other).not.toBe(firstSpace);
  const z = open("https://z.fr");
  // The essential keeps a tab of its own for this other login profile.
  const essHere = Object.values(e.tabs).find((o) => o.link && o.spaceId === other)!.id;
  expect(essHere).not.toBe(ess);
  expect(walkableTabs(e, F)).toEqual([essHere, z]);
});
