import { beforeEach, expect, test } from "vitest";
import { apply } from "../../core/state/actions";
import { initialState } from "../../core/state/initial-state";
import { SchemaAction, type Action } from "../../shared/api";
import { spaceKey, historyContext, privateTab, profilesInUse, tabProfile, hasView, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, urlAction, urlWorkflow, type BrowserState, type Tab } from "../../shared/model";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string; // window
let P: string; // space « Perso »
const ag = (a: Action) => (e = apply(e, a, genId));
const fen = () => e.windows.find((f) => f.id === F)!;
const order = (space = P) => fen().order[space] ?? [];
const active = (space = P) => fen().active[space] ?? null;
const open = (url: string, extra: Partial<Extract<Action, { type: "ouvrirOnglet" }>> = {}) => {
  ag({ type: "ouvrirOnglet", windowId: F, url, ...extra });
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
  expect(e.version).toBe(2);
  expect(e.spaces).toEqual([{ id: P, name: "Perso", icon: "🏠", pinned: [], private: false, profile: "defaut" }]);
  expect(e.profiles).toEqual([{ id: "defaut" }]);
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
  ag({ type: "fermerOnglet", id: b });
  expect(order()).toEqual([a, c]);
  expect(active()).toBe(c);
  expect(e.tabs[b]).toBeUndefined();
});

test("closing the active tab at the end of the list → the previous becomes active", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  ag({ type: "fermerOnglet", id: b });
  expect(active()).toBe(a);
});

test("closing the last tab of the space → active null", () => {
  const a = open("https://a.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(active()).toBeNull();
  expect(order()).toEqual([]);
});

test("closing an inactive tab does not change the active one", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(active()).toBe(b);
});

test("ouvrirOnglet with apres inserts right after; a new tab has default values", () => {
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
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", name: "Privé", icon: "🔒", private: true, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  const c = open("https://c.test/", { after: a });
  expect(e.tabs[c]!.spaceId).toBe(P);
  expect(order(P)).toEqual([a, c]);
  expect(order(B)).toEqual([]);
  expect(fen().activeSpace).toBe(B);
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const D = e.spaces[2]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  const m = open("https://m.test/", { after: g });
  expect(e.tabs[m]!.spaceId).toBe(D);
});

test("tab opened by the agent: ouvertParAgent true", () => {
  const a = open("http://localhost:5280/", { openedByAgent: true });
  expect(e.tabs[a]!.openedByAgent).toBe(true);
});

test("deplacerOnglet reorders (clamped index)", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  const c = open("https://c.test/");
  ag({ type: "deplacerOnglet", id: c, index: 0 });
  expect(order()).toEqual([c, a, b]);
  ag({ type: "deplacerOnglet", id: c, index: 99 });
  expect(order()).toEqual([a, b, c]);
});

test("rouvrirOngletFerme reopens the most recent one and removes it from the stack; stack limited to 20", () => {
  for (let i = 0; i < 25; i++) ag({ type: "fermerOnglet", id: open(`https://${i}.test/`) });
  expect(fen().recentlyClosed).toHaveLength(20);
  expect(fen().recentlyClosed[0]).toEqual({ url: "https://24.test/", spaceId: P });
  ag({ type: "rouvrirOngletFerme", windowId: F });
  expect(e.tabs[active()!]!.url).toBe("https://24.test/");
  expect(fen().recentlyClosed[0]!.url).toBe("https://23.test/");
});

test("rouvrirOngletFerme with an empty stack changes nothing", () => {
  const before = e;
  ag({ type: "rouvrirOngletFerme", windowId: F });
  expect(e).toBe(before);
});

test("pinning a tab creates a favorite in the space and the tab leaves ordre", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, fields: { title: "A", favicon: "https://a.test/f.ico" } });
  ag({ type: "epinglerOnglet", id: a });
  const [fav] = e.spaces[0]!.pinned;
  expect(fav).toMatchObject({ url: "https://a.test/", title: "A", favicon: "https://a.test/f.ico" });
  expect(e.tabs[a]!.link).toEqual({ type: "epingle", id: fav!.id });
  expect(order()).toEqual([]);
  expect(active()).toBe(a);
});

test("closing a pinned tab: the favorite stays, nothing enters fermesRecemment", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "fermerOnglet", id: a });
  expect(e.spaces[0]!.pinned).toHaveLength(1);
  expect(fen().recentlyClosed).toEqual([]);
  expect(active()).toBeNull();
});

test("ouvrirFavori creates the linked tab then reuses it", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  const favId = e.spaces[0]!.pinned[0]!.id;
  ag({ type: "fermerOnglet", id: a });
  ag({ type: "ouvrirFavori", windowId: F, kind: "epingle", id: favId });
  const fresh = active()!;
  expect(e.tabs[fresh]).toMatchObject({ url: "https://a.test/", link: { type: "epingle", id: favId } });
  open("https://b.test/");
  ag({ type: "ouvrirFavori", windowId: F, kind: "epingle", id: favId });
  expect(active()).toBe(fresh);
  expect(Object.keys(e.tabs)).toHaveLength(2);
});

test("unpinning: the favorite disappears, the linked tab becomes normal again", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "desepingler", spaceId: P, favoriteId: e.spaces[0]!.pinned[0]!.id });
  expect(e.spaces[0]!.pinned).toEqual([]);
  expect(e.tabs[a]!.link).toBeNull();
  expect(order()).toEqual([a]);
});

test("essentials shared by all spaces; removing an essential", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  expect(e.essentials).toHaveLength(1);
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  expect(fen().activeSpace).toBe(B);
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  // One tab per window for an essential: the same Gmail, without reloading, in every space.
  expect(active(B)).toBe(a);
  expect(Object.keys(e.tabs)).toEqual([a]);
  ag({ type: "retirerEssentiel", favoriteId: e.essentials[0]!.id });
  expect(e.essentials).toEqual([]);
  // Back to a normal tab of « Perso », it is no longer displayed in « Boulot ».
  expect(order(P)).toEqual([a]);
  expect(active(B)).toBeNull();
});

test("closing an essential displayed in two spaces: no space keeps a vanished active tab", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  ag({ type: "fermerOnglet", id: a });
  expect(active(P)).toBeNull();
  expect(active(B)).toBeNull();
});

test("deleting the origin space of an essential open elsewhere: the other space no longer points to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  ag({ type: "supprimerEspace", id: P });
  const remaining = active(B);
  expect(remaining === null || !!e.tabs[remaining]).toBe(true);
});

test("activerEspace keeps each space's own active tab", () => {
  const a = open("https://a.test/");
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut" });
  const B = e.spaces[1]!.id;
  expect(fen().activeSpace).toBe(P);
  ag({ type: "activerEspace", windowId: F, id: B });
  const b = open("https://b.test/");
  expect(e.tabs[b]!.spaceId).toBe(B);
  ag({ type: "activerEspace", windowId: F, id: P });
  expect(active()).toBe(a);
  expect(active(B)).toBe(b);
});

test("activerOnglet of another space switches the active space", () => {
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "activerEspace", windowId: F, id: P });
  ag({ type: "activerOnglet", id: b });
  expect(fen().activeSpace).toBe(B);
});

test("activerOnglet garderEspace: the tab becomes its space's, the window stays on its own", () => {
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  const b1 = open("https://b1.test/");
  open("https://b2.test/");
  ag({ type: "activerEspace", windowId: F, id: P });
  ag({ type: "activerOnglet", id: b1, keepSpace: true });
  expect(fen().activeSpace).toBe(P);
  expect(active(B)).toBe(b1);
});

test("reglerEspace changes the name and the icon", () => {
  ag({ type: "reglerEspace", id: P, name: "Maison", icon: "🏡", private: false, profile: "defaut" });
  expect(e.spaces[0]).toMatchObject({ name: "Maison", icon: "🏡", private: false, profile: "defaut" });
});

test("reglerEspace with no change leaves the state unchanged", () => {
  const before = e;
  ag({ type: "reglerEspace", id: P, name: "Perso", icon: "🏠", private: false, profile: "defaut" });
  expect(e).toBe(before);
});

test("creerEspace with a new sign-in profile: a fresh profile; with an existing profile: it is reused", () => {
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau" });
  const bank = e.spaces[1]!;
  expect(bank).toMatchObject({ name: "Banque", private: true });
  expect(bank.profile).not.toBe("defaut");
  expect(bank.profile).not.toBe("nouveau");
  expect(e.profiles).toEqual([{ id: "defaut" }, { id: bank.profile }]);
  ag({ type: "creerEspace", name: "Comptes", icon: "📒", private: false, profile: bank.profile });
  expect(e.spaces[2]!.profile).toBe(bank.profile);
  expect(e.profiles).toHaveLength(2);
});

test("creerEspace on an unknown sign-in profile is refused", () => {
  const before = e;
  ag({ type: "creerEspace", name: "X", icon: "❓", private: false, profile: "inconnu" });
  expect(e).toBe(before);
});

test("reglerEspace that leaves a sign-in profile unused removes it, including the default profile", () => {
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: false, profile: "nouveau" });
  const bank = e.spaces[1]!;
  ag({ type: "reglerEspace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: "defaut" });
  expect(e.profiles).toEqual([{ id: "defaut" }]);
  ag({ type: "reglerEspace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: "nouveau" });
  const fresh = e.spaces[1]!.profile;
  ag({ type: "reglerEspace", id: P, name: "Perso", icon: "🏠", private: false, profile: fresh });
  expect(e.profiles).toEqual([{ id: fresh }]);
  expect(e.spaces.every((x) => x.profile === fresh)).toBe(true);
});

test("supprimerEspace removes the sign-in profile it was the only one using", () => {
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: false, profile: "nouveau" });
  const bank = e.spaces[1]!;
  ag({ type: "supprimerEspace", id: bank.id });
  expect(e.profiles).toEqual([{ id: "defaut" }]);
});

test("essential opened in a space with another key (private or other profile): a second tab, never the same", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  const essential = e.essentials[0]!.id;
  ag({ type: "creerEspace", name: "Privé", icon: "🔒", private: true, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: essential });
  const b = active(B)!;
  expect(b).not.toBe(a);
  expect(e.tabs[b]).toMatchObject({ spaceId: B, link: { type: "essentiel", id: essential } });
  expect(active(P)).toBe(a);
  // Same key (not private, default profile): Perso's tab is reused.
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const C = e.spaces[2]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: essential });
  expect(active(C)).toBe(a);
  // Same key as the private space: its tab is reused.
  ag({ type: "creerEspace", name: "Privé 2", icon: "🔐", private: true, profile: "defaut", windowId: F });
  const D = e.spaces[3]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: essential });
  expect(active(D)).toBe(b);
  expect(Object.keys(e.tabs)).toHaveLength(2);
});

test("reglerEspace that changes a space's key: the tab that a space of the old key displays comes back to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  expect(active(B)).toBe(a);
  ag({ type: "reglerEspace", id: P, name: "Perso", icon: "🏠", private: true, profile: "defaut" });
  expect(e.tabs[a]!.spaceId).toBe(B);
  expect(active(B)).toBe(a);
  expect(active(P)).toBeNull();
});

test("reglerEspace that changes a space's key: a tab that no other space displays stays with it, the others let go of it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "creerEspace", name: "Coffre", icon: "🔒", private: true, profile: "defaut", windowId: F });
  const C = e.spaces[2]!.id;
  // C (other key) cannot display it; B, with the same key as P, does not display it.
  ag({ type: "reglerEspace", id: P, name: "Perso", icon: "🏠", private: true, profile: "defaut" });
  expect(e.tabs[a]!.spaceId).toBe(P);
  expect(active(P)).toBe(a);
  expect(active(B)).toBeNull();
  expect(active(C)).toBeNull();
});

test("reglerEspace: pointers of other spaces that stayed compatible are kept", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  ag({ type: "reglerEspace", id: P, name: "Maison", icon: "🏡", private: false, profile: "defaut" });
  expect(active(B)).toBe(a);
});

test("reglerEspace: an essential shared by two private spaces stays private when its owner no longer is", () => {
  // « Banque » and « Banque pro », private on the same profile; the Gmail tab belongs to Banque, also displayed in Banque pro.
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau", windowId: F });
  const bank = e.spaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", name: "Banque pro", icon: "💳", private: true, profile: bank.profile, windowId: F });
  const pro = e.spaces[2]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  expect(active(pro)).toBe(g);
  expect(e.tabs[g]!.spaceId).toBe(bank.id);
  ag({ type: "reglerEspace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: bank.profile });
  // The tab goes to Banque pro (still private); Banque, now non-private, lets go of it.
  expect(e.tabs[g]!.spaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(bank.id)).toBeNull();
  expect(privateTab(e, e.tabs[g]!)).toBe(true);
  // No tab is displayed under a key different from its owner's.
  for (const [space, id] of Object.entries(fen().active))
    if (id) expect(spaceKey(e, space)).toBe(spaceKey(e, e.tabs[id]!.spaceId));
});

test("reglerEspace: several spaces display the tab under the old key, the first in space order takes it back", () => {
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau", windowId: F });
  const bank = e.spaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  const essential = e.essentials[0]!.id;
  ag({ type: "creerEspace", name: "Banque pro", icon: "💳", private: true, profile: bank.profile, windowId: F });
  const pro = e.spaces[2]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: essential });
  ag({ type: "creerEspace", name: "Impôts", icon: "🧾", private: true, profile: bank.profile, windowId: F });
  const taxes = e.spaces[3]!.id;
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: essential });
  ag({ type: "reglerEspace", id: bank.id, name: "Banque", icon: "🏦", private: false, profile: bank.profile });
  expect(e.tabs[g]!.spaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(taxes)).toBe(g);
  expect(active(bank.id)).toBeNull();
});

test("historyContext: a shared essential counts in the space that displays it, otherwise in its own; unknown: private", () => {
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  expect(historyContext(e, g)).toEqual({ spaceId: P, private: false });
  ag({ type: "ouvrirFavori", windowId: F, kind: "essentiel", id: e.essentials[0]!.id });
  expect(e.tabs[g]!.spaceId).toBe(P);
  expect(historyContext(e, g)).toEqual({ spaceId: B, private: false });
  // Back in Perso, which also displays it: the visit returns there.
  ag({ type: "activerEspace", windowId: F, id: P });
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
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau" });
  const bank = e.spaces[1]!;
  expect(spaceKey(e, P)).toBe("defaut|false");
  expect(spaceKey(e, bank.id)).toBe(`${bank.profile}|true`);
  expect(spaceKey(e, "inconnu")).not.toBe(spaceKey(e, P));
  ag({ type: "activerEspace", windowId: F, id: bank.id });
  const idO = open("https://banque.test/");
  const o = e.tabs[idO]!;
  expect(privateTab(e, o)).toBe(true);
  expect(tabProfile(e, o)).toBe(bank.profile);
  ag({ type: "activerEspace", windowId: F, id: P });
  const idP = open("https://a.test/");
  const p = e.tabs[idP]!;
  expect(privateTab(e, p)).toBe(false);
  expect(tabProfile(e, p)).toBe("defaut");
  const orphan: Tab = { ...p, spaceId: "disparu" };
  expect(privateTab(e, orphan)).toBe(true);
});

test("supprimerEspace closes its tabs and switches the windows", () => {
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  const B = e.spaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "supprimerEspace", id: B });
  expect(e.spaces.map((x) => x.id)).toEqual([P]);
  expect(e.tabs[b]).toBeUndefined();
  expect(fen().activeSpace).toBe(P);
  expect(fen().order[B]).toBeUndefined();
});

test("deleting the last space is refused", () => {
  const before = e;
  ag({ type: "supprimerEspace", id: P });
  expect(e).toBe(before);
});

test("ouvrirFenetre on a given space; fermerFenetre deletes its tabs", () => {
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut" });
  const B = e.spaces[1]!.id;
  ag({ type: "ouvrirFenetre", id: "f2", spaceId: B });
  const f2 = e.windows.find((f) => f.id === "f2")!;
  expect(f2).toMatchObject({ activeSpace: B, order: { [P]: [], [B]: [] }, active: { [P]: null, [B]: null } });
  ag({ type: "ouvrirOnglet", windowId: "f2", url: "https://x.test/" });
  const x = Object.keys(e.tabs).at(-1)!;
  ag({ type: "fermerFenetre", id: "f2" });
  expect(e.windows).toHaveLength(1);
  expect(e.tabs[x]).toBeUndefined();
});

test("closing the last window does not change the state", () => {
  const before = e;
  ag({ type: "fermerFenetre", id: F });
  expect(e).toBe(before);
});

test("basculerCompact, basculerPanneauAgent, choisirMoteur", () => {
  ag({ type: "basculerCompact", windowId: F });
  ag({ type: "basculerPanneauAgent", windowId: F });
  ag({ type: "choisirMoteur", engine: "qwant" });
  expect(fen()).toMatchObject({ compact: true, agentPanelOpen: true });
  expect(e.settings.engine).toBe("qwant");
});

test("cadrerFenetre keeps the size and position; unknown window → same reference", () => {
  expect(fen().frame).toBeNull();
  ag({ type: "cadrerFenetre", id: F, frame: { x: 10, y: 20, width: 800, height: 600 } });
  expect(fen().frame).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  const before = e;
  expect(apply(e, { type: "cadrerFenetre", id: "inconnue", frame: { x: 0, y: 0, width: 1, height: 1 } }, genId)).toBe(before);
});

test("majOnglet with no change → same reference (nothing to rebroadcast)", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, fields: { title: "A", loading: true } });
  const before = e;
  expect(apply(e, { type: "majOnglet", id: a, fields: { title: "A", loading: true } }, genId)).toBe(before);
});

test("majOnglet only touches the given fields; unknown id → same reference", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, fields: { title: "A", loading: true } });
  expect(e.tabs[a]).toMatchObject({ title: "A", loading: true, url: "https://a.test/" });
  for (const action of [
    { type: "majOnglet", id: "inconnu", fields: { title: "x" } },
    { type: "fermerOnglet", id: "inconnu" },
    { type: "activerOnglet", id: "inconnu" },
    { type: "ouvrirOnglet", windowId: "inconnue", url: "https://x.test/" },
    { type: "activerEspace", windowId: F, id: "inconnu" },
    { type: "ouvrirFavori", windowId: F, kind: "essentiel", id: "inconnu" },
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
    ag({ type: "ouvrirOnglet", windowId: F, url: "https://b.test/" });
    ag({ type: "epinglerOnglet", id: a });
    ag({ type: "creerEspace", name: "B", icon: "💼", private: false, profile: "defaut", windowId: F });
    ag({ type: "fermerOnglet", id: a });
  }).not.toThrow();
});

test("afficherPageVide: the space no longer has an active tab, its tabs remain", () => {
  const a = open("https://a.fr");
  ag({ type: "afficherPageVide", windowId: F });
  expect(active()).toBeNull();
  expect(order()).toEqual([a]);
});

test("fermerFenetre: its tabs (all spaces) go into the remaining window's recently closed, ⇧⌘T reopens them", () => {
  ag({ type: "ouvrirFenetre", id: "F2" });
  ag({ type: "ouvrirOnglet", windowId: "F2", url: "https://x.fr" });
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: "F2" });
  ag({ type: "ouvrirOnglet", windowId: "F2", url: "https://y.fr" });
  ag({ type: "fermerFenetre", id: "F2" });
  expect(fen().recentlyClosed.map((x) => x.url)).toEqual(["https://y.fr", "https://x.fr"]);
  ag({ type: "rouvrirOngletFerme", windowId: F });
  expect(Object.values(e.tabs).map((o) => o.url)).toEqual(["https://y.fr"]);
});

test("choisirProfilAgent changes the setting (claude by default)", () => {
  expect(e.settings.agentProfile).toBe("claude");
  ag({ type: "choisirProfilAgent", profile: "autre" });
  expect(e.settings.agentProfile).toBe("autre");
});

test("panneauAgentAccueil: opens only on the home page (otherwise the tab would be given to the agent); always closes", () => {
  open("https://a.test/");
  const before = e;
  ag({ type: "panneauAgentAccueil", windowId: F, open: true });
  expect(e).toBe(before);
  ag({ type: "afficherPageVide", windowId: F });
  ag({ type: "panneauAgentAccueil", windowId: F, open: true });
  expect(fen().agentPanelOpen).toBe(true);
  ag({ type: "panneauAgentAccueil", windowId: F, open: true });
  expect(fen().agentPanelOpen).toBe(true);
  open("https://b.test/");
  ag({ type: "panneauAgentAccueil", windowId: F, open: false });
  expect(fen().agentPanelOpen).toBe(false);
});

test("largeurPanneauAgent: 420 by default, kept, clamped between 280 and 1000", () => {
  expect(e.settings.agentPanelWidth).toBe(420);
  ag({ type: "largeurPanneauAgent", width: 612.4 });
  expect(e.settings.agentPanelWidth).toBe(612);
  ag({ type: "largeurPanneauAgent", width: 50 });
  expect(e.settings.agentPanelWidth).toBe(280);
  ag({ type: "largeurPanneauAgent", width: 5000 });
  expect(e.settings.agentPanelWidth).toBe(1000);
});

test("ouvrirApplications reuses the window's existing tab", () => {
  open("https://a.test/");
  ag({ type: "ouvrirApplications", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_APPLICATIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ title: "Applications", spaceId: P });
  expect(active()).toBe(page.id);
  // Already displayed: nothing changes.
  const before = e;
  ag({ type: "ouvrirApplications", windowId: F });
  expect(e).toBe(before);
  // Another tab in front: go back to the page instead of opening a second one.
  open("https://b.test/");
  ag({ type: "ouvrirApplications", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  expect(fen().activeSpace).not.toBe(P);
  ag({ type: "ouvrirApplications", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().activeSpace).toBe(P);
  expect(active()).toBe(page.id);
});

test("ouvrirExtensions opens or activates the page, like ouvrirApplications", () => {
  expect(URL_EXTENSIONS).toBe("webaios://extensions");
  expect(hasView(URL_EXTENSIONS)).toBe(false);
  open("https://a.test/");
  ag({ type: "ouvrirExtensions", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_EXTENSIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ title: "Extensions", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirExtensions", windowId: F });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirExtensions", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  ag({ type: "ouvrirExtensions", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().activeSpace).toBe(P);
});

test("ouvrirWorkflow opens a titled webaios://workflow/<id> tab, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "ouvrirWorkflow", windowId: F, id: "meteo", name: "Météo" });
  const pages = (id = "meteo") => Object.values(e.tabs).filter((o) => o.url === urlWorkflow(id));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: "webaios://workflow/meteo", title: "Workflow — Météo", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  ag({ type: "ouvrirWorkflow", windowId: F, id: "meteo", name: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(fen().activeSpace).toBe(P);
  expect(active()).toBe(page.id);
  // Another widget: its own page.
  ag({ type: "ouvrirWorkflow", windowId: F, id: "actus", name: "Actus" });
  expect(pages("actus")).toHaveLength(1);
  expect(pages()).toHaveLength(1);
  // The widget renamed: back to the same page, and its title follows.
  ag({ type: "ouvrirWorkflow", windowId: F, id: "meteo", name: "Météo de Lyon" });
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ id: page.id, title: "Workflow — Météo de Lyon" });
});

test("openAction opens a webaios://action/<id> tab titled with the name, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  const pages = () => Object.values(e.tabs).filter((o) => o.url.startsWith("webaios://action/gitlab"));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: urlAction("gitlab"), title: "GitLab", spaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // Another action: its own page.
  ag({ type: "ouvrirAction", windowId: F, id: "meteo", name: "Météo" });
  expect(Object.values(e.tabs).filter((o) => o.url === urlAction("meteo"))).toHaveLength(1);
});

test("openAction finds the action's tab in another space of the window; with execution, changes its URL", () => {
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  const page = Object.keys(e.tabs).at(-1)!;
  ag({ type: "creerEspace", name: "Boulot", icon: "💼", private: false, profile: "defaut", windowId: F });
  expect(fen().activeSpace).not.toBe(P);
  const ex = "2026-10-31T10-00-00-000Z";
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab", run: ex });
  expect(Object.keys(e.tabs)).toHaveLength(1);
  expect(fen().activeSpace).toBe(P);
  expect(active()).toBe(page);
  expect(e.tabs[page]).toMatchObject({ url: urlAction("gitlab", ex), title: "GitLab" });
  // The tab shows a specific run: it stays the action's tab (same id), the name follows.
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "Mes tickets" });
  expect(Object.keys(e.tabs)).toHaveLength(1);
  expect(e.tabs[page]).toMatchObject({ url: urlAction("gitlab", ex), title: "Mes tickets" });
  // Invalid run: refused by the schema, never a URL.
  expect(SchemaAction.safeParse({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab", run: "./" }).success).toBe(false);
  expect(SchemaAction.safeParse({ type: "ouvrirAction", windowId: F, id: "../x", name: "GitLab" }).success).toBe(false);
});

test("openAction neither opens nor finds anything in a private space", () => {
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  const page = Object.keys(e.tabs).at(-1)!;
  ag({ type: "creerEspace", name: "Banque", icon: "🏦", private: true, profile: "nouveau", windowId: F });
  const bank = fen().activeSpace;
  // The non-private space's tab is found; the window goes back there.
  ag({ type: "ouvrirAction", windowId: F, id: "gitlab", name: "GitLab" });
  expect(fen().activeSpace).toBe(P);
  expect(active()).toBe(page);
  // No tab elsewhere: nothing is opened in the private space.
  ag({ type: "activerEspace", windowId: F, id: bank });
  const before = e;
  ag({ type: "ouvrirAction", windowId: F, id: "meteo", name: "Météo" });
  expect(e).toBe(before);
});

test("ouvrirActions opens the single « Actions » page, then returns to it", () => {
  ag({ type: "ouvrirActions", windowId: F });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === URL_ACTIONS);
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ title: "Actions" });
  open("https://b.test/");
  ag({ type: "ouvrirActions", windowId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
});

test("ouvrirWorkflow of an action opens webaios://workflow/action/<id>", () => {
  ag({ type: "ouvrirWorkflow", windowId: F, id: "gitlab", name: "GitLab", owner: "action" });
  expect(Object.values(e.tabs)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", title: "Workflow — GitLab" });
  ag({ type: "ouvrirWorkflow", windowId: F, id: "gitlab", name: "GitLab" });
  expect(Object.values(e.tabs).map((o) => o.url)).toEqual(["webaios://workflow/action/gitlab", urlWorkflow("gitlab")]);
});

test("profilesInUse: by identifier, spaces included", () => {
  const copy = structuredClone(e);
  copy.spaces[0]!.profile = "autre";
  expect(profilesInUse(copy)).toEqual(new Set(["defaut", "autre"]));
});

// Plan 17, task 11: a project's review page.
test("ouvrirRelecture opens webaios://relecture/app-essai titled « Relecture — Essai »; a second call returns to the same tab", async () => {
  const { reviewUrl } = await import("../../shared/model");
  ag({ type: "ouvrirRelecture", windowId: F, project: "app-essai", name: "Essai" });
  const pages = () => Object.values(e.tabs).filter((o) => o.url === "webaios://relecture/app-essai");
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ title: "Relecture — Essai" });
  expect(reviewUrl("app-essai")).toBe("webaios://relecture/app-essai");
  open("https://b.test/");
  ag({ type: "ouvrirRelecture", windowId: F, project: "app-essai", name: "Essai" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
  expect(SchemaAction.safeParse({ type: "ouvrirRelecture", windowId: F, project: "../x", name: "x" }).success).toBe(false);
});

test("reviewUrlProject refuses webaios://relecture/../x and webaios://relecture/app-", async () => {
  const { reviewUrlProject } = await import("../../shared/model");
  const { PROJECT_ID } = await import("@webaios/kernel");
  expect(reviewUrlProject("webaios://relecture/../x")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-essai/x")).toBeNull();
  expect(reviewUrlProject("webaios://applications")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-essai")).toBe("app-essai");
  expect(reviewUrlProject("webaios://relecture/ext-0123456789abcdef")).toBe("ext-0123456789abcdef");
  // The UI copies follow the kernel.
  const { NOT_DISPLAYABLE } = await import("../../shared/model");
  const { BINARY_FILE, FILE_TOO_BIG } = await import("@webaios/kernel");
  expect(NOT_DISPLAYABLE).toEqual({ binary: BINARY_FILE, "trop-gros": FILE_TOO_BIG });
  const { PAGE_LINE_CHANGED } = await import("../../shared/model");
  const { LINE_CHANGED } = await import("@webaios/kernel");
  expect(PAGE_LINE_CHANGED).toBe(LINE_CHANGED);
  for (const p of ["app-essai", "app-.x", "ext-0123456789abcdef", "ext-0123", "demo-15283", "demo-", "app-a/b", "site-tuning", "site-", "site-A", "site-../x"])
    expect(reviewUrlProject(`webaios://relecture/${p}`) !== null).toBe(PROJECT_ID.test(p));
});
