import { describe, expect, it } from "vitest";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";

let n = 0;
const genId = () => `id-${++n}`;
const run = (s: BrowserState, ...actions: Action[]) => actions.reduce((x, a) => apply(x, a, genId), s);

/** Two spaces, three tabs in the first (the last one active). */
function start() {
  let s = initialState(genId);
  const w = s.windows[0]!.id;
  const a = s.spaces[0]!.id;
  s = run(s, { type: "createSpace", name: "Travail", icon: "📁", private: false, profile: "default" });
  const b = s.spaces[1]!.id;
  for (const url of ["https://1.example.com/", "https://2.example.com/", "https://3.example.com/"]) s = run(s, { type: "openTab", windowId: w, url, spaceId: a });
  const tabs = s.windows[0]!.order[a]!.slice(-3);
  return { s, w, a, b, tabs };
}

describe("moveTabToSpace", () => {
  it("moves a tab to the end of the other space, in the background; the old space shows a neighbour", () => {
    const { s, a, b, tabs } = start();
    const after = run(s, { type: "moveTabToSpace", id: tabs[2]!, spaceId: b });
    const f = after.windows[0]!;
    expect(after.tabs[tabs[2]!]!.spaceId).toBe(b);
    expect(f.order[a]).not.toContain(tabs[2]);
    expect(f.order[b]).toEqual([tabs[2]]);
    expect(f.active[a]).toBe(tabs[1]);
    // The empty space shows it; the window stays on its space.
    expect(f.active[b]).toBe(tabs[2]);
    expect(f.activeSpace).toBe(a);
    // A second one lands behind without taking the place.
    const again = run(after, { type: "moveTabToSpace", id: tabs[0]!, spaceId: b });
    expect(again.windows[0]!.order[b]).toEqual([tabs[2], tabs[0]]);
    expect(again.windows[0]!.active[b]).toBe(tabs[2]);
  });

  it("refuses the same space, an unknown space, and a pinned tab", () => {
    const { s, a, b, tabs } = start();
    expect(run(s, { type: "moveTabToSpace", id: tabs[0]!, spaceId: a })).toBe(s);
    expect(run(s, { type: "moveTabToSpace", id: tabs[0]!, spaceId: "nope" })).toBe(s);
    const pinned = run(s, { type: "pinTab", id: tabs[0]! });
    expect(run(pinned, { type: "moveTabToSpace", id: tabs[0]!, spaceId: b })).toBe(pinned);
  });
});

describe("folders of pinned tabs", () => {
  it("creates a folder around a pinned tab, pins straight into it, moves in and out, renames, collapses", () => {
    const { s: s0, a, tabs } = start();
    let s = run(s0, { type: "pinTab", id: tabs[0]! });
    const first = s.spaces[0]!.pinned[0]!.id;
    s = run(s, { type: "createFolder", spaceId: a, name: "Docs", favoriteId: first });
    const folder = s.spaces[0]!.folders[0]!;
    expect(folder).toMatchObject({ name: "Docs", collapsed: false });
    expect(s.spaces[0]!.pinned[0]!.folder).toBe(folder.id);
    s = run(s, { type: "pinTab", id: tabs[1]!, folderId: folder.id });
    expect(s.spaces[0]!.pinned.map((f) => f.folder)).toEqual([folder.id, folder.id]);
    s = run(s, { type: "moveToFolder", spaceId: a, favoriteId: first, folderId: null });
    expect(s.spaces[0]!.pinned.map((f) => f.folder)).toEqual([undefined, folder.id]);
    s = run(s, { type: "moveToFolder", spaceId: a, favoriteId: first, folderId: folder.id }, { type: "renameFolder", spaceId: a, id: folder.id, name: "Lecture" }, { type: "toggleFolder", spaceId: a, id: folder.id });
    expect(s.spaces[0]!.folders).toEqual([{ id: folder.id, name: "Lecture", collapsed: true }]);
  });

  it("deleting a folder keeps its pinned tabs, outside any folder", () => {
    const { s: s0, a, tabs } = start();
    let s = run(s0, { type: "createFolder", spaceId: a, name: "Docs" });
    const folder = s.spaces[0]!.folders[0]!.id;
    s = run(s, { type: "pinTab", id: tabs[0]!, folderId: folder }, { type: "deleteFolder", spaceId: a, id: folder });
    expect(s.spaces[0]!.folders).toEqual([]);
    expect(s.spaces[0]!.pinned).toHaveLength(1);
    expect(s.spaces[0]!.pinned[0]!.folder).toBeUndefined();
  });

  it("refuses an unknown folder or pinned tab", () => {
    const { s, a, tabs } = start();
    expect(run(s, { type: "pinTab", id: tabs[0]!, folderId: "nope" })).toBe(s);
    expect(run(s, { type: "createFolder", spaceId: a, name: "X", favoriteId: "nope" })).toBe(s);
    expect(run(s, { type: "moveToFolder", spaceId: a, favoriteId: "nope", folderId: null })).toBe(s);
    expect(run(s, { type: "deleteFolder", spaceId: a, id: "nope" })).toBe(s);
  });
});

describe("renameFavorite", () => {
  it("renames a pinned tab; the same name or an unknown favorite changes nothing", () => {
    const { s, a, tabs } = start();
    const pinned = run(s, { type: "pinTab", id: tabs[0]! });
    const f = pinned.spaces[0]!.pinned[0]!;
    const after = run(pinned, { type: "renameFavorite", spaceId: a, favoriteId: f.id, title: "Mon site" });
    expect(after.spaces[0]!.pinned[0]!.title).toBe("Mon site");
    expect(run(after, { type: "renameFavorite", spaceId: a, favoriteId: f.id, title: "Mon site" })).toBe(after);
    expect(run(after, { type: "renameFavorite", spaceId: a, favoriteId: "nope", title: "X" })).toBe(after);
  });
});
