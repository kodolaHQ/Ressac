import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArcSidebar, parseZenSpaces, planSpaceImport, planTabImport, type ImportedSpaces } from "../chrome/store/import/spaces";
import { summary } from "../chrome/store/import/importer";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import type { BrowserState } from "../shared/model";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures/import", name), "utf8"));
const arc = () => parseArcSidebar(fixture("arc-StorableSidebar.json"))!;
const zen = () => parseZenSpaces(fixture("zen-sessions.json"))!;

let n = 0;
const genId = () => `id-${++n}`;
const run = (state: BrowserState, imported: ImportedSpaces) => planSpaceImport(state, imported).reduce((s, a) => apply(s, a, genId), state);
const view = (s: BrowserState) => ({
  spaces: s.spaces.map((e) => ({ name: e.name, private: e.private, pinned: e.pinned.map((f) => f.url) })),
  essentials: s.essentials.map((f) => f.url),
});

describe("parsing another browser's sidebar", () => {
  it("reads Arc's spaces, pinned tabs (folders flattened, http only), open tabs and favorites", () => {
    expect(arc()).toEqual({
      spaces: [
        { name: "Travail", pinned: [{ url: "https://docs.example.com/projet", title: "Projet" }, { url: "https://tickets.example.com/", title: "Tickets" }], tabs: [{ url: "https://ephemere.example.com/", title: "Onglet du jour" }] },
        { name: "Maison", pinned: [{ url: "https://recettes.example.com/", title: "Recettes" }], tabs: [] },
      ],
      essentials: [{ url: "https://mail.example.com/", title: "Courrier" }, { url: "https://agenda.example.com/", title: "Agenda" }],
    });
  });

  it("reads Zen's workspaces, pinned tabs at their pinned address, and essentials; open tabs at their current address; no glance", () => {
    expect(zen()).toEqual({
      spaces: [
        { name: "Travail", pinned: [{ url: "https://docs.example.com/projet", title: "Projet" }], tabs: [{ url: "https://ephemere.example.com/", title: "Onglet du jour" }] },
        { name: "Maison", pinned: [{ url: "https://recettes.example.com/", title: "Recettes" }], tabs: [] },
      ],
      essentials: [{ url: "https://mail.example.com/", title: "Courrier" }],
    });
  });

  it("an unknown shape is null", () => {
    for (const bad of [null, 1, {}, { sidebar: {} }, { sidebar: { containers: [{ spaces: [], items: [] }] } }]) expect(parseArcSidebar(bad)).toBeNull();
    for (const bad of [null, [], { spaces: [] }, { tabs: [] }]) expect(parseZenSpaces(bad)).toBeNull();
  });
});

describe("planSpaceImport", () => {
  it("creates the spaces with their pinned tabs, adds the essentials, and a re-plan does nothing", () => {
    const start = initialState(genId);
    const after = run(start, arc());
    expect(view(after)).toEqual({
      spaces: [
        { name: "Perso", private: false, pinned: [] },
        { name: "Travail", private: false, pinned: ["https://docs.example.com/projet", "https://tickets.example.com/"] },
        { name: "Maison", private: false, pinned: ["https://recettes.example.com/"] },
      ],
      essentials: ["https://mail.example.com/", "https://agenda.example.com/"],
    });
    // The new spaces share the normal space's login profile and keep the window on its space.
    expect(after.spaces.map((e) => e.profile)).toEqual(["default", "default", "default"]);
    expect(after.windows[0]!.activeSpace).toBe(start.spaces[0]!.id);
    expect(planSpaceImport(after, arc())).toEqual([]);
    // Zen's same spaces, by name in any case: only what is missing.
    const lower = { ...zen(), spaces: zen().spaces.map((s) => ({ ...s, name: s.name.toLowerCase() })) };
    expect(planSpaceImport(after, lower)).toEqual([]);
  });

  it("adds only the missing pinned tabs to a space of the same name", () => {
    const s = run(initialState(genId), { spaces: [{ name: "travail", pinned: [{ url: "https://docs.example.com/projet", title: "Projet" }], tabs: [] }], essentials: [] });
    expect(planSpaceImport(s, arc())).toContainEqual({ type: "addFavorites", spaceId: s.spaces[1]!.id, favorites: [{ url: "https://tickets.example.com/", title: "Tickets" }] });
  });

  it("never writes into a private space: one named like an Arc space stays untouched, a normal one is created", () => {
    let s = initialState(genId);
    s = apply(s, { type: "createSpace", name: "Travail", icon: "🔒", private: true, profile: "new", windowId: s.windows[0]!.id }, genId);
    const privateSpace = s.spaces[1]!;
    expect(s.windows[0]!.activeSpace).toBe(privateSpace.id);
    const after = run(s, arc());
    expect(after.spaces.find((e) => e.id === privateSpace.id)).toEqual(privateSpace);
    expect(after.spaces.filter((e) => e.name === "Travail" && !e.private)).toHaveLength(1);
    expect(after.windows[0]!.activeSpace).toBe(privateSpace.id);
    // The reducer refuses favorites aimed at a private space.
    expect(apply(after, { type: "addFavorites", spaceId: privateSpace.id, favorites: [{ url: "https://x.example.com/", title: "x" }] })).toBe(after);
  });

  it("only private spaces: the new spaces share one new login profile, over two passes", () => {
    let s = initialState(genId);
    s = { ...s, spaces: s.spaces.map((e) => ({ ...e, private: true })) };
    const first = planSpaceImport(s, arc());
    expect(first.filter((a) => a.type === "createSpace").map((a) => a.type === "createSpace" && a.profile)).toEqual(["new"]);
    s = run(run(s, arc()), arc());
    const created = s.spaces.filter((e) => !e.private);
    expect(created.map((e) => e.name)).toEqual(["Travail", "Maison"]);
    expect(new Set(created.map((e) => e.profile)).size).toBe(1);
    expect(planSpaceImport(s, arc())).toEqual([]);
  });

  it("the reducer keeps only http(s) addresses, once each, in a new space and in the essentials", () => {
    const links = [{ url: "https://a.example.com/", title: "A" }, { url: "javascript:alert(1)", title: "x" }, { url: "https://a.example.com/", title: "A bis" }];
    let s = apply(initialState(genId), { type: "createSpace", name: "N", icon: "📁", private: false, profile: "default", pinned: links }, genId);
    s = apply(s, { type: "addFavorites", favorites: links }, genId);
    expect(view(s).spaces[1]!.pinned).toEqual(["https://a.example.com/"]);
    expect(view(s).essentials).toEqual(["https://a.example.com/"]);
  });

  it("opens the open tabs in their space, in the background and unloaded, once; a space with nothing is not created", () => {
    const start = initialState(genId);
    const w = start.windows[0]!;
    const imported: ImportedSpaces = { spaces: [...arc().spaces, { name: "Vide", pinned: [], tabs: [] }, { name: "Onglets", pinned: [], tabs: [{ url: "https://a.example.com/", title: "A" }] }], essentials: [] };
    const withSpaces = run(start, imported);
    expect(withSpaces.spaces.map((e) => e.name)).toEqual(["Perso", "Travail", "Maison", "Onglets"]);
    const after = planTabImport(withSpaces, imported, w.id).reduce((s, a) => apply(s, a, genId), withSpaces);
    const tabs = Object.values(after.tabs).filter((t) => !(t.id in start.tabs));
    expect(tabs.map((t) => [after.spaces.find((e) => e.id === t.spaceId)!.name, t.url, t.title, t.loading])).toEqual([
      ["Travail", "https://ephemere.example.com/", "Onglet du jour", false],
      ["Onglets", "https://a.example.com/", "A", false],
    ]);
    // The window stays where it was, on its tab.
    expect([after.windows[0]!.activeSpace, after.windows[0]!.active[w.activeSpace]]).toEqual([w.activeSpace, w.active[w.activeSpace]]);
    expect(planTabImport(after, imported, w.id)).toEqual([]);
  });

  it("the end notification names spaces and favorites together", () => {
    expect(summary({ source: "arc", done: true, counts: { spaces: 3 }, failed: {} }, "fr").text).toBe("3 éléments de barre latérale");
    expect(summary({ source: "arc", done: true, counts: { spaces: 1, tabs: 2 }, failed: {} }, "fr").text).toBe("1 élément de barre latérale, 2 onglets ouverts");
  });
});
