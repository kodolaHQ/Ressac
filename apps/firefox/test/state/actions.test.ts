import { beforeEach, expect, test } from "vitest";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import { SchemaAction, type Action } from "../../shared/api";
import { spaceKey, historyContext, privateTab, profilesInUse, tabProfile, hasView, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, URL_SETTINGS, urlAction, urlWorkflow, type BrowserState, type Tab } from "../../shared/model";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string; // window
let P: string; // space « Perso »
const ag = (a: Action) => (e = apply(e, a, genId));
const fen = () => e.windows.find((f) => f.id === F)!;
const order = (space = P) => fen().order[space] ?? [];
const active = (space = P) => fen().active[space] ?? null;
const open = (url: string, extra: Partial<Extract<Action, { type: "openTab" }>> = {}) => {
  ag({ type: "openTab", windowId: F, url, ...extra });
  return Object.keys(e.tabs).at(-1)!;
};

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

beforeEach(() => {
  n = 0;
  e = initialState(genId);
  F = e.windows[0]!.id;
  P = e.spaces[0]!.id;
});

test("initial state: one Perso space, one window, no tab, Google", () => {
  expect(e.version).toBe(3);
  expect(e.spaces).toEqual([{ id: P, name: "Perso", icon: "🏠", pinned: [], private: false, profile: "default", aura: "aube" }]);
  expect(e.profiles).toEqual([{ id: "default" }]);
  expect(e.windows).toHaveLength(1);
  expect(e.tabs).toEqual({});
  expect(e.settings.engine).toBe("google");
  expect(fen()).toMatchObject({ activeSpace: P, compact: false, agentPanelOpen: false, recentlyClosed: [] });
});

test("open three tabs then close the active middle one → the next becomes active", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  const c = open("https://c.test/", { activate: false });
  expect(order()).toEqual([a, b, c]);
  expect(active()).toBe(b);
  ag({ type: "closeTab", id: b });
  expect(order()).toEqual([a, c]);
  expect(active()).toBe(c);
  expect(e.tabs[b]).toBeUndefined();
});

test("closing the active tab at the end of the list → the previous becomes active", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  ag({ type: "closeTab", id: b });
  expect(active()).toBe(a);
});

test("closing the last tab of the space → active null", () => {
  const a = open("https://a.test/");
  ag({ type: "closeTab", id: a });
  expect(active()).toBeNull();
  expect(order()).toEqual([]);
});

test("closing an inactive tab does not change the active one", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  ag({ type: "closeTab", id: a });
  expect(active()).toBe(b);
});

test("openTab with apres inserts right after; a new tab has default values", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  const c = open("https://c.test/", { after: a });
  expect(order()).toEqual([a, c, b]);
  expect(e.tabs[c]).toEqual({
    id: c, windowId: F, spaceId: P, url: "https://c.test/", title: "https://c.test/", favicon: null, link: null,
    openedByAgent: false, loading: false, canGoBack: false, canGoForward: false, zoom: 1, crashed: false, error: null,
  });
});

test("link opened from a tab of a background space: it stays in that space; from a displayed essential, in the displayed space", () => {
  const a = open("https://a.test/");
  const g = open("https://mail.google.com/");
  ag({ type: "addEssential", id: g });
  ag({ type: "createSpace", name: "Privé", icon: "🔒", private: true, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  const c = open("https://c.test/", { after: a });
  expect(e.tabs[c]!.spaceId).toBe(P);
  expect(order(P)).toEqual([a, c]);
  expect(order(B)).toEqual([]);
  expect(fen().activeSpace).toBe(B);
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const D = e.spaces[2]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  const m = open("https://m.test/", { after: g });
  expect(e.tabs[m]!.spaceId).toBe(D);
});

test("tab opened by the agent: openedByAgent true", () => {
  const a = open("http://localhost:5280/", { openedByAgent: true });
  expect(e.tabs[a]!.openedByAgent).toBe(true);
});

test("moveTab reorders (clamped index)", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  const c = open("https://c.test/");
  ag({ type: "moveTab", id: c, index: 0 });
  expect(order()).toEqual([c, a, b]);
  ag({ type: "moveTab", id: c, index: 99 });
  expect(order()).toEqual([a, b, c]);
});

test("reopenClosedTab reopens the most recent one and removes it from the stack; stack limited to 20", () => {
  for (let i = 0; i < 25; i++) ag({ type: "closeTab", id: open(`https://${i}.test/`) });
  expect(fen().recentlyClosed).toHaveLength(20);
  expect(fen().recentlyClosed[0]).toEqual({ url: "https://24.test/", spaceId: P });
  ag({ type: "reopenClosedTab", windowId: F });
  expect(e.tabs[active()!]!.url).toBe("https://24.test/");
  expect(fen().recentlyClosed[0]!.url).toBe("https://23.test/");
});

test("reopenClosedTab with an empty stack changes nothing", () => {
  const before = e;
  ag({ type: "reopenClosedTab", windowId: F });
  expect(e).toBe(before);
});

test("pinning a tab creates a favorite in the space and the tab leaves ordre", () => {
  const a = open("https://a.test/");
  ag({ type: "updateTab", id: a, fields: { title: "A", favicon: "https://a.test/f.ico" } });
  ag({ type: "pinTab", id: a });
  const [fav] = e.spaces[0]!.pinned;
  expect(fav).toMatchObject({ url: "https://a.test/", title: "A", favicon: "https://a.test/f.ico" });
  expect(e.tabs[a]!.link).toEqual({ type: "pinned", id: fav!.id });
  expect(order()).toEqual([]);
  expect(active()).toBe(a);
});

test("closing a pinned tab: the favorite stays, nothing enters recentlyClosed", () => {
  const a = open("https://a.test/");
  ag({ type: "pinTab", id: a });
  ag({ type: "closeTab", id: a });
  expect(e.spaces[0]!.pinned).toHaveLength(1);
  expect(fen().recentlyClosed).toEqual([]);
  expect(active()).toBeNull();
});

test("openFavorite creates the linked tab then reuses it", () => {
  const a = open("https://a.test/");
  ag({ type: "pinTab", id: a });
  const favId = e.spaces[0]!.pinned[0]!.id;
  ag({ type: "closeTab", id: a });
  ag({ type: "openFavorite", windowId: F, kind: "pinned", id: favId });
  const fresh = active()!;
  expect(e.tabs[fresh]).toMatchObject({ url: "https://a.test/", link: { type: "pinned", id: favId } });
  open("https://b.test/");
  ag({ type: "openFavorite", windowId: F, kind: "pinned", id: favId });
  expect(active()).toBe(fresh);
  expect(Object.keys(e.tabs)).toHaveLength(2);
});

test("unpinning: the favorite disappears, the linked tab becomes normal again", () => {
  const a = open("https://a.test/");
  ag({ type: "pinTab", id: a });
  ag({ type: "unpin", spaceId: P, favoriteId: e.spaces[0]!.pinned[0]!.id });
  expect(e.spaces[0]!.pinned).toEqual([]);
  expect(e.tabs[a]!.link).toBeNull();
  expect(order()).toEqual([a]);
});

test("essentials shared by all spaces; removing an essential", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  expect(e.essentials).toHaveLength(1);
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  expect(fen().activeSpace).toBe(B);
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  // One tab per window for an essential: the same Gmail, without reloading, in every space.
  expect(active(B)).toBe(a);
  expect(Object.keys(e.tabs)).toEqual([a]);
  ag({ type: "removeEssential", favoriteId: e.essentials[0]!.id });
  expect(e.essentials).toEqual([]);
  // Back to a normal tab of « Perso », it is no longer displayed in « Boulot ».
  expect(order(P)).toEqual([a]);
  expect(active(B)).toBeNull();
});

test("closing an essential displayed in two spaces: no space keeps a vanished active tab", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  ag({ type: "closeTab", id: a });
  expect(active(P)).toBeNull();
  expect(active(B)).toBeNull();
});

test("deleting the origin space of an essential open elsewhere: the other space no longer points to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  ag({ type: "deleteSpace", id: P });
  const remaining = active(B);
  expect(remaining === null || !!e.tabs[remaining]).toBe(true);
});

test("activateSpace keeps each space's own active tab", () => {
  const a = open("https://a.test/");
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" });
  const B = e.spaces[1]!.id;
  expect(fen().activeSpace).toBe(P);
  ag({ type: "activateSpace", windowId: F, id: B });
  const b = open("https://b.test/");
  expect(e.tabs[b]!.spaceId).toBe(B);
  ag({ type: "activateSpace", windowId: F, id: P });
  expect(active()).toBe(a);
  expect(active(B)).toBe(b);
});

test("activateTab of another space switches the active space", () => {
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "activateSpace", windowId: F, id: P });
  ag({ type: "activateTab", id: b });
  expect(fen().activeSpace).toBe(B);
});

test("activateTab keepSpace: the tab becomes its space's, the window stays on its own", () => {
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  const b1 = open("https://b1.test/");
  open("https://b2.test/");
  ag({ type: "activateSpace", windowId: F, id: P });
  ag({ type: "activateTab", id: b1, keepSpace: true });
  expect(fen().activeSpace).toBe(P);
  expect(active(B)).toBe(b1);
});

test("updateSpace changes the name and the icon", () => {
  ag({ type: "updateSpace", id: P, name: "Maison", icon: "🏡", private: false, profile: "default" });
  expect(e.spaces[0]).toMatchObject({ name: "Maison", icon: "🏡", private: false, profile: "default" });
});

test("updateSpace with no change leaves the state unchanged", () => {
  const before = e;
  ag({ type: "updateSpace", id: P, name: "Perso", icon: "🏠", private: false, profile: "default" });
  expect(e).toBe(before);
});

test("createSpace with a new sign-in profile: a fresh profile; with an existing profile: it is reused", () => {
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new" });
  const bank = e.spaces[1]!;
  expect(bank).toMatchObject({ name: "Banque", private: true });
  expect(bank.profile).not.toBe("default");
  expect(bank.profile).not.toBe("new");
  expect(e.profiles).toEqual([{ id: "default" }, { id: bank.profile }]);
  ag({ type: "createSpace", name: "Comptes", icon: "📒", private: false, profile: bank.profile });
  expect(e.spaces[2]!.profile).toBe(bank.profile);
  expect(e.profiles).toHaveLength(2);
});

test("createSpace on an unknown sign-in profile is refused", () => {
  const before = e;
  ag({ type: "createSpace", name: "X", icon: "❓", private: false, profile: "inconnu" });
  expect(e).toBe(before);
});

test("updateSpace that leaves a sign-in profile unused removes it, including the default profile", () => {
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: false, profile: "new" });
  const bank = e.spaces[1]!;
  ag({ type: "updateSpace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: "default" });
  expect(e.profiles).toEqual([{ id: "default" }]);
  ag({ type: "updateSpace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: "new" });
  const fresh = e.spaces[1]!.profile;
  ag({ type: "updateSpace", id: P, name: "Perso", icon: "🏠", private: false, profile: fresh });
  expect(e.profiles).toEqual([{ id: fresh }]);
  expect(e.spaces.every((x) => x.profile === fresh)).toBe(true);
});

test("deleteSpace removes the sign-in profile it was the only one using", () => {
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: false, profile: "new" });
  const bank = e.spaces[1]!;
  ag({ type: "deleteSpace", id: bank.id });
  expect(e.profiles).toEqual([{ id: "default" }]);
});

test("essential opened in a space with another key (private or other profile): a second tab, never the same", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  const essential = e.essentials[0]!.id;
  ag({ type: "createSpace", name: "Privé", icon: "🔒", private: true, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: essential });
  const b = active(B)!;
  expect(b).not.toBe(a);
  expect(e.tabs[b]).toMatchObject({ spaceId: B, link: { type: "essential", id: essential } });
  expect(active(P)).toBe(a);
  // Same key (not private, default profile): Perso's tab is reused.
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const C = e.spaces[2]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: essential });
  expect(active(C)).toBe(a);
  // Same key as the private space: its tab is reused.
  ag({ type: "createSpace", name: "Privé 2", icon: "🔐", private: true, profile: "default", windowId: F });
  const D = e.spaces[3]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: essential });
  expect(active(D)).toBe(b);
  expect(Object.keys(e.tabs)).toHaveLength(2);
});

test("updateSpace that changes a space's key: the tab that a space of the old key displays comes back to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  expect(active(B)).toBe(a);
  ag({ type: "updateSpace", id: P, name: "Perso", icon: "🏠", private: true, profile: "default" });
  expect(e.tabs[a]!.spaceId).toBe(B);
  expect(active(B)).toBe(a);
  expect(active(P)).toBeNull();
});

test("updateSpace that changes a space's key: a tab that no other space displays stays with it, the others let go of it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "createSpace", name: "Coffre", icon: "🔒", private: true, profile: "default", windowId: F });
  const C = e.spaces[2]!.id;
  // C (other key) cannot display it; B, with the same key as P, does not display it.
  ag({ type: "updateSpace", id: P, name: "Perso", icon: "🏠", private: true, profile: "default" });
  expect(e.tabs[a]!.spaceId).toBe(P);
  expect(active(P)).toBe(a);
  expect(active(B)).toBeNull();
  expect(active(C)).toBeNull();
});

test("updateSpace: pointers of other spaces that stayed compatible are kept", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "addEssential", id: a });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  ag({ type: "updateSpace", id: P, name: "Maison", icon: "🏡", private: false, profile: "default" });
  expect(active(B)).toBe(a);
});

test("updateSpace: an essential shared by two private spaces stays private when its owner no longer is", () => {
  // « Banque » and « Banque pro », private on the same profile; the Gmail tab belongs to Banque, also displayed in Banque pro.
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new", windowId: F });
  const bank = e.spaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "addEssential", id: g });
  ag({ type: "createSpace", name: "Banque pro", icon: "💳", private: true, profile: bank.profile, windowId: F });
  const pro = e.spaces[2]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  expect(active(pro)).toBe(g);
  expect(e.tabs[g]!.spaceId).toBe(bank.id);
  ag({ type: "updateSpace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: bank.profile });
  // The tab goes to Banque pro (still private); Banque, now non-private, lets go of it.
  expect(e.tabs[g]!.spaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(bank.id)).toBeNull();
  expect(privateTab(e, e.tabs[g]!)).toBe(true);
  // No tab is displayed under a key different from its owner's.
  for (const [space, id] of Object.entries(fen().active))
    if (id) expect(spaceKey(e, space)).toBe(spaceKey(e, e.tabs[id]!.spaceId));
});

test("updateSpace: several spaces display the tab under the old key, the first in space order takes it back", () => {
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new", windowId: F });
  const bank = e.spaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "addEssential", id: g });
  const essential = e.essentials[0]!.id;
  ag({ type: "createSpace", name: "Banque pro", icon: "💳", private: true, profile: bank.profile, windowId: F });
  const pro = e.spaces[2]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: essential });
  ag({ type: "createSpace", name: "Impôts", icon: "🧾", private: true, profile: bank.profile, windowId: F });
  const taxes = e.spaces[3]!.id;
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: essential });
  ag({ type: "updateSpace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: bank.profile });
  expect(e.tabs[g]!.spaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(taxes)).toBe(g);
  expect(active(bank.id)).toBeNull();
});

test("historyContext: a shared essential counts in the space that displays it, otherwise in its own; unknown: private", () => {
  const g = open("https://mail.google.com/");
  ag({ type: "addEssential", id: g });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  expect(historyContext(e, g)).toEqual({ spaceId: P, private: false });
  ag({ type: "openFavorite", windowId: F, kind: "essential", id: e.essentials[0]!.id });
  expect(e.tabs[g]!.spaceId).toBe(P);
  expect(historyContext(e, g)).toEqual({ spaceId: B, private: false });
  // Back in Perso, which also displays it: the visit returns there.
  ag({ type: "activateSpace", windowId: F, id: P });
  expect(historyContext(e, g)).toEqual({ spaceId: P, private: false });
  // Displayed in an unknown space: private, to be safe.
  const bizarre = structuredClone(e);
  const f = bizarre.windows[0]!;
  f.activeSpace = "disparu";
  f.active["disparu"] = g;
  expect(historyContext(bizarre, g)).toEqual({ spaceId: "disparu", private: true });
  expect(historyContext(e, "inexistant")).toBeNull();
});

test("spaceKey, privateTab, tabProfile", () => {
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new" });
  const bank = e.spaces[1]!;
  expect(spaceKey(e, P)).toBe("default|false");
  expect(spaceKey(e, bank.id)).toBe(`${bank.profile}|true`);
  expect(spaceKey(e, "inconnu")).not.toBe(spaceKey(e, P));
  ag({ type: "activateSpace", windowId: F, id: bank.id });
  const idO = open("https://banque.test/");
  const o = e.tabs[idO]!;
  expect(privateTab(e, o)).toBe(true);
  expect(tabProfile(e, o)).toBe(bank.profile);
  ag({ type: "activateSpace", windowId: F, id: P });
  const idP = open("https://a.test/");
  const p = e.tabs[idP]!;
  expect(privateTab(e, p)).toBe(false);
  expect(tabProfile(e, p)).toBe("default");
  const orphan: Tab = { ...p, spaceId: "disparu" };
  expect(privateTab(e, orphan)).toBe(true);
});

test("deleteSpace closes its tabs and switches the windows", () => {
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const B = e.spaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "deleteSpace", id: B });
  expect(e.spaces.map((x) => x.id)).toEqual([P]);
  expect(e.tabs[b]).toBeUndefined();
  expect(fen().activeSpace).toBe(P);
  expect(fen().order[B]).toBeUndefined();
});

test("deleting the last space is refused", () => {
  const before = e;
  ag({ type: "deleteSpace", id: P });
  expect(e).toBe(before);
});

test("openWindow on a given space; closeWindow deletes its tabs", () => {
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" });
  const B = e.spaces[1]!.id;
  ag({ type: "openWindow", id: "f2", spaceId: B });
  const f2 = e.windows.find((f) => f.id === "f2")!;
  expect(f2).toMatchObject({ activeSpace: B, order: { [P]: [], [B]: [] }, active: { [P]: null, [B]: null } });
  ag({ type: "openTab", windowId: "f2", url: "https://x.test/" });
  const x = Object.keys(e.tabs).at(-1)!;
  ag({ type: "closeWindow", id: "f2" });
  expect(e.windows).toHaveLength(1);
  expect(e.tabs[x]).toBeUndefined();
});

test("closing the last window does not change the state", () => {
  const before = e;
  ag({ type: "closeWindow", id: F });
  expect(e).toBe(before);
});

test("toggleCompact, toggleAgentPanel, chooseEngine", () => {
  ag({ type: "toggleCompact", windowId: F });
  ag({ type: "toggleAgentPanel", windowId: F });
  ag({ type: "chooseEngine", engine: "qwant" });
  expect(fen()).toMatchObject({ compact: true, agentPanelOpen: true });
  expect(e.settings.engine).toBe("qwant");
});

test("frameWindow keeps the size and position; unknown window → same reference", () => {
  expect(fen().frame).toBeNull();
  ag({ type: "frameWindow", id: F, frame: { x: 10, y: 20, width: 800, height: 600 } });
  expect(fen().frame).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  const before = e;
  expect(apply(e, { type: "frameWindow", id: "inconnue", frame: { x: 0, y: 0, width: 1, height: 1 } }, genId)).toBe(before);
});

test("updateTab with no change → same reference (nothing to rebroadcast)", () => {
  const a = open("https://a.test/");
  ag({ type: "updateTab", id: a, fields: { title: "A", loading: true } });
  const before = e;
  expect(apply(e, { type: "updateTab", id: a, fields: { title: "A", loading: true } }, genId)).toBe(before);
});

test("updateTab only touches the given fields; unknown id → same reference", () => {
  const a = open("https://a.test/");
  ag({ type: "updateTab", id: a, fields: { title: "A", loading: true } });
  expect(e.tabs[a]).toMatchObject({ title: "A", loading: true, url: "https://a.test/" });
  for (const action of [
    { type: "updateTab", id: "inconnu", fields: { title: "x" } },
    { type: "closeTab", id: "inconnu" },
    { type: "activateTab", id: "inconnu" },
    { type: "openTab", windowId: "inconnue", url: "https://x.test/" },
    { type: "activateSpace", windowId: F, id: "inconnu" },
    { type: "openFavorite", windowId: F, kind: "essential", id: "inconnu" },
  ] as Action[]) {
    const before = e;
    ag(action);
    expect(e, action.type).toBe(before);
  }
});

test("appliquer never mutates the input state", () => {
  const a = open("https://a.test/");
  deepFreeze(e);
  expect(() => {
    ag({ type: "openTab", windowId: F, url: "https://b.test/" });
    ag({ type: "pinTab", id: a });
    ag({ type: "createSpace", name: "B", icon: "💼", private: false, profile: "default", windowId: F });
    ag({ type: "closeTab", id: a });
  }).not.toThrow();
});

test("showBlankPage: the space no longer has an active tab, its tabs remain", () => {
  const a = open("https://a.fr");
  ag({ type: "showBlankPage", windowId: F });
  expect(active()).toBeNull();
  expect(order()).toEqual([a]);
});

test("closeWindow: its tabs (all spaces) go into the remaining window's recently closed, ⇧⌘T reopens them", () => {
  ag({ type: "openWindow", id: "F2" });
  ag({ type: "openTab", windowId: "F2", url: "https://x.fr" });
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: "F2" });
  ag({ type: "openTab", windowId: "F2", url: "https://y.fr" });
  ag({ type: "closeWindow", id: "F2" });
  expect(fen().recentlyClosed.map((x) => x.url)).toEqual(["https://y.fr", "https://x.fr"]);
  ag({ type: "reopenClosedTab", windowId: F });
  expect(Object.values(e.tabs).map((o) => o.url)).toEqual(["https://y.fr"]);
});

test("chooseAgentProfile changes the setting (claude by default)", () => {
  expect(e.settings.agentProfile).toBe("claude");
  ag({ type: "chooseAgentProfile", profile: "autre" });
  expect(e.settings.agentProfile).toBe("autre");
});

test("homeAgentPanel: opens only on the home page (otherwise the tab would be given to the agent); always closes", () => {
  open("https://a.test/");
  const before = e;
  ag({ type: "homeAgentPanel", windowId: F, open: true });
  expect(e).toBe(before);
  ag({ type: "showBlankPage", windowId: F });
  ag({ type: "homeAgentPanel", windowId: F, open: true });
  expect(fen().agentPanelOpen).toBe(true);
  ag({ type: "homeAgentPanel", windowId: F, open: true });
  expect(fen().agentPanelOpen).toBe(true);
  open("https://b.test/");
  ag({ type: "homeAgentPanel", windowId: F, open: false });
  expect(fen().agentPanelOpen).toBe(false);
});

test("agentPanelWidth: 420 by default, kept, clamped between 280 and 1000", () => {
  expect(e.settings.agentPanelWidth).toBe(420);
  ag({ type: "agentPanelWidth", width: 612.4 });
  expect(e.settings.agentPanelWidth).toBe(612);
  ag({ type: "agentPanelWidth", width: 50 });
  expect(e.settings.agentPanelWidth).toBe(280);
  ag({ type: "agentPanelWidth", width: 5000 });
  expect(e.settings.agentPanelWidth).toBe(1000);
});

test("openApps reuses the window's existing tab", () => {
  open("https://a.test/");
  ag({ type: "openApps", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_APPLICATIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ title: "Applications", spaceId: P });
  expect(active()).toBe(page.id);
  // Already displayed: nothing changes.
  const before = e;
  ag({ type: "openApps", windowId: F });
  expect(e).toBe(before);
  // Another tab in front: go back to the page instead of opening a second one.
  open("https://b.test/");
  ag({ type: "openApps", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // Open in space A, active space B: a new tab in B, the window stays in B.
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const b = fen().activeSpace;
  expect(b).not.toBe(P);
  ag({ type: "openApps", windowId: F });
  expect(pages()).toHaveLength(2);
  expect(fen().activeSpace).toBe(b);
  expect(e.tabs[active(b)!]).toMatchObject({ url: URL_APPLICATIONS, spaceId: b });
});

test("openExtensions opens or activates the page, like openApps", () => {
  expect(URL_EXTENSIONS).toBe("webaios://extensions");
  expect(hasView(URL_EXTENSIONS)).toBe(false);
  open("https://a.test/");
  ag({ type: "openExtensions", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_EXTENSIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ title: "Extensions", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "openExtensions", windowId: F });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "openExtensions", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  ag({ type: "openExtensions", windowId: F });
  expect(pages()).toHaveLength(2);
  expect(fen().activeSpace).not.toBe(P);
});

test("openSettings opens or activates the Réglages page, once for the window", () => {
  expect(URL_SETTINGS).toBe("webaios://settings");
  open("https://a.test/");
  ag({ type: "openSettings", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_SETTINGS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ title: "Réglages", spaceId: P });
  expect(active()).toBe(page.id);
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  ag({ type: "openSettings", windowId: F });
  expect(pages()).toHaveLength(2);
  expect(fen().activeSpace).not.toBe(P);
});

test("chooseDecisionModel changes the setting; the same model again changes nothing", () => {
  expect(e.settings.decisionModel).toBe("pplx-decider-flash");
  ag({ type: "chooseDecisionModel", model: "kev" });
  expect(e.settings.decisionModel).toBe("kev");
  const before = e;
  ag({ type: "chooseDecisionModel", model: "kev" });
  expect(e).toBe(before);
});

test("chooseCodexEngine changes the setting; the same engine again changes nothing; a bad model is refused by the schema", () => {
  const api = { ...e.settings.codexEngine, kind: "api" as const };
  ag({ type: "chooseCodexEngine", engine: api });
  expect(e.settings.codexEngine.kind).toBe("api");
  const before = e;
  ag({ type: "chooseCodexEngine", engine: { ...api } });
  expect(e).toBe(before);
  expect(SchemaAction.safeParse({ type: "chooseCodexEngine", engine: { ...api, apiModel: "a b" } }).success).toBe(false);
});

test("openWorkflow opens a titled webaios://workflow/<id> tab, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "openWorkflow", windowId: F, id: "meteo", name: "Météo" });
  const pages = (id = "meteo") => Object.values(e.tabs).filter((o) => o.url === urlWorkflow(id) && o.spaceId === P);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: "webaios://workflow/meteo", title: "Workflow — Météo", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "openWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "openWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // From another space: its own page there, the window stays in that space.
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  ag({ type: "openWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(Object.values(e.tabs).filter((o) => o.url === urlWorkflow("meteo"))).toHaveLength(2);
  expect(fen().activeSpace).not.toBe(P);
  ag({ type: "activateSpace", windowId: F, id: P });
  // Another widget: its own page.
  ag({ type: "openWorkflow", windowId: F, id: "actus", name: "Actus" });
  expect(pages("actus")).toHaveLength(1);
  expect(pages()).toHaveLength(1);
  // The widget renamed: back to the same page, and its title follows.
  ag({ type: "openWorkflow", windowId: F, id: "meteo", name: "Météo de Lyon" });
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ id: page.id, title: "Workflow — Météo de Lyon" });
});

test("openAction opens a webaios://action/<id> tab titled with the name, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  const pages = () => Object.values(e.tabs).filter((o) => o.url.startsWith("webaios://action/gitlab"));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: urlAction("gitlab"), title: "GitLab", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // Another action: its own page.
  ag({ type: "openAction", windowId: F, id: "meteo", name: "Météo" });
  expect(Object.values(e.tabs).filter((o) => o.url === urlAction("meteo"))).toHaveLength(1);
});

test("openAction looks only in the active space; with execution, changes its URL", () => {
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  const page = Object.keys(e.tabs).at(-1)!;
  // Open in space A, active space B: a new tab in B, the window stays in B.
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: F });
  const b = fen().activeSpace;
  expect(b).not.toBe(P);
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(Object.keys(e.tabs)).toHaveLength(2);
  expect(fen().activeSpace).toBe(b);
  expect(e.tabs[active(b)!]).toMatchObject({ url: urlAction("gitlab"), spaceId: b });
  ag({ type: "activateSpace", windowId: F, id: P });
  open("https://b.test/");
  const ex = "2026-10-31T10-00-00-000Z";
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab", run: ex });
  expect(Object.values(e.tabs).filter((o) => o.spaceId === P && o.url.startsWith("webaios://action/"))).toHaveLength(1);
  expect(fen().activeSpace).toBe(P);
  expect(active()).toBe(page);
  expect(e.tabs[page]).toMatchObject({ url: urlAction("gitlab", ex), title: "GitLab" });
  // The tab shows a specific run: it stays the action's tab (same id), the name follows.
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "Mes tickets" });
  expect(Object.values(e.tabs).filter((o) => o.spaceId === P && o.url.startsWith("webaios://action/"))).toHaveLength(1);
  expect(e.tabs[page]).toMatchObject({ url: urlAction("gitlab", ex), title: "Mes tickets" });
  // Invalid run: refused by the schema, never a URL.
  expect(SchemaAction.safeParse({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab", run: "./" }).success).toBe(false);
  expect(SchemaAction.safeParse({ type: "openAction", windowId: F, id: "../x", name: "GitLab" }).success).toBe(false);
});

test("openAction neither opens nor finds anything in a private space, and never leaves it", () => {
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  ag({ type: "createSpace", name: "Banque", icon: "🏦", private: true, profile: "new", windowId: F });
  const before = e;
  ag({ type: "openAction", windowId: F, id: "gitlab", name: "GitLab" });
  ag({ type: "openAction", windowId: F, id: "meteo", name: "Météo" });
  expect(e).toBe(before);
});

test("openActions opens the single « Actions » page, then returns to it", () => {
  ag({ type: "openActions", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_ACTIONS);
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ title: "Actions" });
  open("https://b.test/");
  ag({ type: "openActions", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
});

test("openWorkflow of an action opens webaios://workflow/action/<id>", () => {
  ag({ type: "openWorkflow", windowId: F, id: "gitlab", name: "GitLab", owner: "action" });
  expect(Object.values(e.tabs)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", title: "Workflow — GitLab" });
  ag({ type: "openWorkflow", windowId: F, id: "gitlab", name: "GitLab" });
  expect(Object.values(e.tabs).map((o) => o.url)).toEqual(["webaios://workflow/action/gitlab", urlWorkflow("gitlab")]);
});

test("profilesInUse: by identifier, spaces included", () => {
  const copy = structuredClone(e);
  copy.spaces[0]!.profile = "autre";
  expect(profilesInUse(copy)).toEqual(new Set(["default", "autre"]));
});

// Plan 17, task 11: a project's review page.
test("openReview opens webaios://review/app-essai titled « Relecture — Essai »; a second call returns to the same tab", async () => {
  const { reviewUrl } = await import("../../shared/model");
  ag({ type: "openReview", windowId: F, project: "app-essai", name: "Essai" });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === "webaios://review/app-essai");
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ title: "Relecture — Essai" });
  expect(reviewUrl("app-essai")).toBe("webaios://review/app-essai");
  open("https://b.test/");
  ag({ type: "openReview", windowId: F, project: "app-essai", name: "Essai" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
  expect(SchemaAction.safeParse({ type: "openReview", windowId: F, project: "../x", name: "x" }).success).toBe(false);
});

test("reviewUrlProject refuses webaios://review/../x and webaios://review/app-", async () => {
  const { reviewUrlProject } = await import("../../shared/model");
  const { PROJECT_ID } = await import("@webaios/kernel");
  expect(reviewUrlProject("webaios://review/../x")).toBeNull();
  expect(reviewUrlProject("webaios://review/app-")).toBeNull();
  expect(reviewUrlProject("webaios://review/app-essai/x")).toBeNull();
  expect(reviewUrlProject("webaios://apps")).toBeNull();
  expect(reviewUrlProject("webaios://review/app-essai")).toBe("app-essai");
  expect(reviewUrlProject("webaios://review/ext-0123456789abcdef")).toBe("ext-0123456789abcdef");
  // The UI copies follow the kernel.
  const { NOT_DISPLAYABLE } = await import("../../shared/model");
  const { BINARY_FILE, FILE_TOO_BIG } = await import("@webaios/kernel");
  expect(NOT_DISPLAYABLE).toEqual({ binary: BINARY_FILE, "too-big": FILE_TOO_BIG });
  const { PAGE_LINE_CHANGED } = await import("../../shared/model");
  const { LINE_CHANGED } = await import("@webaios/kernel");
  expect(PAGE_LINE_CHANGED).toBe(LINE_CHANGED);
  for (const p of ["app-essai", "app-.x", "ext-0123456789abcdef", "ext-0123", "demo-15283", "demo-", "app-a/b", "site-tuning", "site-", "site-A", "site-../x"])
    expect(reviewUrlProject(`webaios://review/${p}`) !== null).toBe(PROJECT_ID.test(p));
});

test("createSpace without aura gives aube; updateSpace of the aura alone is a change", () => {
  ag({ type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default" });
  const id = e.spaces[1]!.id;
  expect(e.spaces[1]!.aura).toBe("aube");
  const before = e;
  ag({ type: "updateSpace", id, name: "Boulot", icon: "💼", private: false, profile: "default", aura: "braise" });
  expect(e).not.toBe(before);
  expect(e.spaces[1]!.aura).toBe("braise");
});

test("updateSpace without aura keeps a non-default aura; the same aura again changes nothing", () => {
  ag({ type: "updateSpace", id: P, name: "Perso", icon: "🏠", private: false, profile: "default", aura: "lagon" });
  ag({ type: "updateSpace", id: P, name: "Maison", icon: "🏠", private: false, profile: "default" });
  expect(e.spaces[0]).toMatchObject({ name: "Maison", aura: "lagon" });
  const before = e;
  ag({ type: "updateSpace", id: P, name: "Maison", icon: "🏠", private: false, profile: "default", aura: "lagon" });
  expect(e).toBe(before);
});
