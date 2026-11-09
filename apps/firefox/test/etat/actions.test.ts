import { beforeEach, expect, test } from "vitest";
import { apply } from "../../core/etat/actions";
import { initialState } from "../../core/etat/etat-initial";
import { SchemaAction, type Action } from "../../shared/api";
import { spaceKey, historyContext, privateTab, profilesInUse, tabProfile, hasView, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, urlAction, urlWorkflow, type BrowserState, type Tab } from "../../shared/modele";

let n = 0;
const genId = () => `g${++n}`;
let e: BrowserState;
let F: string; // window
let P: string; // space « Perso »
const ag = (a: Action) => (e = apply(e, a, genId));
const fen = () => e.fenetres.find((f) => f.id === F)!;
const order = (space = P) => fen().ordre[space] ?? [];
const active = (space = P) => fen().actif[space] ?? null;
const open = (url: string, extra: Partial<Extract<Action, { type: "ouvrirOnglet" }>> = {}) => {
  ag({ type: "ouvrirOnglet", fenetreId: F, url, ...extra });
  return Object.keys(e.onglets).at(-1)!;
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
  F = e.fenetres[0]!.id;
  P = e.espaces[0]!.id;
});

test("initial state: one Perso space, one window, no tab, Google", () => {
  expect(e.version).toBe(2);
  expect(e.espaces).toEqual([{ id: P, nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" }]);
  expect(e.profils).toEqual([{ id: "defaut" }]);
  expect(e.fenetres).toHaveLength(1);
  expect(e.onglets).toEqual({});
  expect(e.reglages.moteur).toBe("google");
  expect(fen()).toMatchObject({ espaceActif: P, compact: false, panneauAgentOuvert: false, fermesRecemment: [] });
});

test("open three tabs then close the active middle one → the next becomes active", () => {
  const a = open("https://a.test/");
  const b = open("https://b.test/");
  const c = open("https://c.test/", { activer: false });
  expect(order()).toEqual([a, b, c]);
  expect(active()).toBe(b);
  ag({ type: "fermerOnglet", id: b });
  expect(order()).toEqual([a, c]);
  expect(active()).toBe(c);
  expect(e.onglets[b]).toBeUndefined();
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
  const c = open("https://c.test/", { apres: a });
  expect(order()).toEqual([a, c, b]);
  expect(e.onglets[c]).toEqual({
    id: c, fenetreId: F, espaceId: P, url: "https://c.test/", titre: "https://c.test/", favicon: null, lien: null,
    ouvertParAgent: false, chargement: false, peutReculer: false, peutAvancer: false, zoom: 1, plante: false, erreur: null,
  });
});

test("link opened from a tab of a background space: it stays in that space; from a displayed essential, in the displayed space", () => {
  const a = open("https://a.test/");
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Privé", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const c = open("https://c.test/", { apres: a });
  expect(e.onglets[c]!.espaceId).toBe(P);
  expect(order(P)).toEqual([a, c]);
  expect(order(B)).toEqual([]);
  expect(fen().espaceActif).toBe(B);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const D = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  const m = open("https://m.test/", { apres: g });
  expect(e.onglets[m]!.espaceId).toBe(D);
});

test("tab opened by the agent: ouvertParAgent true", () => {
  const a = open("http://localhost:5280/", { ouvertParAgent: true });
  expect(e.onglets[a]!.ouvertParAgent).toBe(true);
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
  expect(fen().fermesRecemment).toHaveLength(20);
  expect(fen().fermesRecemment[0]).toEqual({ url: "https://24.test/", espaceId: P });
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e.onglets[active()!]!.url).toBe("https://24.test/");
  expect(fen().fermesRecemment[0]!.url).toBe("https://23.test/");
});

test("rouvrirOngletFerme with an empty stack changes nothing", () => {
  const before = e;
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e).toBe(before);
});

test("pinning a tab creates a favorite in the space and the tab leaves ordre", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", favicon: "https://a.test/f.ico" } });
  ag({ type: "epinglerOnglet", id: a });
  const [fav] = e.espaces[0]!.epingles;
  expect(fav).toMatchObject({ url: "https://a.test/", titre: "A", favicon: "https://a.test/f.ico" });
  expect(e.onglets[a]!.lien).toEqual({ type: "epingle", id: fav!.id });
  expect(order()).toEqual([]);
  expect(active()).toBe(a);
});

test("closing a pinned tab: the favorite stays, nothing enters fermesRecemment", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "fermerOnglet", id: a });
  expect(e.espaces[0]!.epingles).toHaveLength(1);
  expect(fen().fermesRecemment).toEqual([]);
  expect(active()).toBeNull();
});

test("ouvrirFavori creates the linked tab then reuses it", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  const favId = e.espaces[0]!.epingles[0]!.id;
  ag({ type: "fermerOnglet", id: a });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favId });
  const fresh = active()!;
  expect(e.onglets[fresh]).toMatchObject({ url: "https://a.test/", lien: { type: "epingle", id: favId } });
  open("https://b.test/");
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favId });
  expect(active()).toBe(fresh);
  expect(Object.keys(e.onglets)).toHaveLength(2);
});

test("unpinning: the favorite disappears, the linked tab becomes normal again", () => {
  const a = open("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "desepingler", espaceId: P, favoriId: e.espaces[0]!.epingles[0]!.id });
  expect(e.espaces[0]!.epingles).toEqual([]);
  expect(e.onglets[a]!.lien).toBeNull();
  expect(order()).toEqual([a]);
});

test("essentials shared by all spaces; removing an essential", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  expect(e.essentiels).toHaveLength(1);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(B);
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  // One tab per window for an essential: the same Gmail, without reloading, in every space.
  expect(active(B)).toBe(a);
  expect(Object.keys(e.onglets)).toEqual([a]);
  ag({ type: "retirerEssentiel", favoriId: e.essentiels[0]!.id });
  expect(e.essentiels).toEqual([]);
  // Back to a normal tab of « Perso », it is no longer displayed in « Boulot ».
  expect(order(P)).toEqual([a]);
  expect(active(B)).toBeNull();
});

test("closing an essential displayed in two spaces: no space keeps a vanished active tab", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "fermerOnglet", id: a });
  expect(active(P)).toBeNull();
  expect(active(B)).toBeNull();
});

test("deleting the origin space of an essential open elsewhere: the other space no longer points to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "supprimerEspace", id: P });
  const restant = active(B);
  expect(restant === null || !!e.onglets[restant]).toBe(true);
});

test("activerEspace keeps each space's own active tab", () => {
  const a = open("https://a.test/");
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(P);
  ag({ type: "activerEspace", fenetreId: F, id: B });
  const b = open("https://b.test/");
  expect(e.onglets[b]!.espaceId).toBe(B);
  ag({ type: "activerEspace", fenetreId: F, id: P });
  expect(active()).toBe(a);
  expect(active(B)).toBe(b);
});

test("activerOnglet of another space switches the active space", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b });
  expect(fen().espaceActif).toBe(B);
});

test("activerOnglet garderEspace: the tab becomes its space's, the window stays on its own", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b1 = open("https://b1.test/");
  open("https://b2.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b1, garderEspace: true });
  expect(fen().espaceActif).toBe(P);
  expect(active(B)).toBe(b1);
});

test("reglerEspace changes the name and the icon", () => {
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(e.espaces[0]).toMatchObject({ nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
});

test("reglerEspace with no change leaves the state unchanged", () => {
  const before = e;
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: false, profil: "defaut" });
  expect(e).toBe(before);
});

test("creerEspace with a new sign-in profile: a fresh profile; with an existing profile: it is reused", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" });
  const bank = e.espaces[1]!;
  expect(bank).toMatchObject({ nom: "Banque", prive: true });
  expect(bank.profil).not.toBe("defaut");
  expect(bank.profil).not.toBe("nouveau");
  expect(e.profils).toEqual([{ id: "defaut" }, { id: bank.profil }]);
  ag({ type: "creerEspace", nom: "Comptes", icone: "📒", prive: false, profil: bank.profil });
  expect(e.espaces[2]!.profil).toBe(bank.profil);
  expect(e.profils).toHaveLength(2);
});

test("creerEspace on an unknown sign-in profile is refused", () => {
  const before = e;
  ag({ type: "creerEspace", nom: "X", icone: "❓", prive: false, profil: "inconnu" });
  expect(e).toBe(before);
});

test("reglerEspace that leaves a sign-in profile unused removes it, including the default profile", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const bank = e.espaces[1]!;
  ag({ type: "reglerEspace", id: bank.id, nom: "Banque", icone: "🏦", prive: false, profil: "defaut" });
  expect(e.profils).toEqual([{ id: "defaut" }]);
  ag({ type: "reglerEspace", id: bank.id, nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const fresh = e.espaces[1]!.profil;
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: false, profil: fresh });
  expect(e.profils).toEqual([{ id: fresh }]);
  expect(e.espaces.every((x) => x.profil === fresh)).toBe(true);
});

test("supprimerEspace removes the sign-in profile it was the only one using", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const bank = e.espaces[1]!;
  ag({ type: "supprimerEspace", id: bank.id });
  expect(e.profils).toEqual([{ id: "defaut" }]);
});

test("essential opened in a space with another key (private or other profile): a second tab, never the same", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  const essential = e.essentiels[0]!.id;
  ag({ type: "creerEspace", nom: "Privé", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essential });
  const b = active(B)!;
  expect(b).not.toBe(a);
  expect(e.onglets[b]).toMatchObject({ espaceId: B, lien: { type: "essentiel", id: essential } });
  expect(active(P)).toBe(a);
  // Same key (not private, default profile): Perso's tab is reused.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essential });
  expect(active(C)).toBe(a);
  // Same key as the private space: its tab is reused.
  ag({ type: "creerEspace", nom: "Privé 2", icone: "🔐", prive: true, profil: "defaut", fenetreId: F });
  const D = e.espaces[3]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essential });
  expect(active(D)).toBe(b);
  expect(Object.keys(e.onglets)).toHaveLength(2);
});

test("reglerEspace that changes a space's key: the tab that a space of the old key displays comes back to it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(active(B)).toBe(a);
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: true, profil: "defaut" });
  expect(e.onglets[a]!.espaceId).toBe(B);
  expect(active(B)).toBe(a);
  expect(active(P)).toBeNull();
});

test("reglerEspace that changes a space's key: a tab that no other space displays stays with it, the others let go of it", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "creerEspace", nom: "Coffre", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  // C (other key) cannot display it; B, with the same key as P, does not display it.
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: true, profil: "defaut" });
  expect(e.onglets[a]!.espaceId).toBe(P);
  expect(active(P)).toBe(a);
  expect(active(B)).toBeNull();
  expect(active(C)).toBeNull();
});

test("reglerEspace: pointers of other spaces that stayed compatible are kept", () => {
  const a = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(active(B)).toBe(a);
});

test("reglerEspace: an essential shared by two private spaces stays private when its owner no longer is", () => {
  // « Banque » and « Banque pro », private on the same profile; the Gmail tab belongs to Banque, also displayed in Banque pro.
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const bank = e.espaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Banque pro", icone: "💳", prive: true, profil: bank.profil, fenetreId: F });
  const pro = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(active(pro)).toBe(g);
  expect(e.onglets[g]!.espaceId).toBe(bank.id);
  ag({ type: "reglerEspace", id: bank.id, nom: "Banque", icone: "🏦", prive: false, profil: bank.profil });
  // The tab goes to Banque pro (still private); Banque, now non-private, lets go of it.
  expect(e.onglets[g]!.espaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(bank.id)).toBeNull();
  expect(privateTab(e, e.onglets[g]!)).toBe(true);
  // No tab is displayed under a key different from its owner's.
  for (const [space, id] of Object.entries(fen().actif))
    if (id) expect(spaceKey(e, space)).toBe(spaceKey(e, e.onglets[id]!.espaceId));
});

test("reglerEspace: several spaces display the tab under the old key, the first in space order takes it back", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const bank = e.espaces[1]!;
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  const essential = e.essentiels[0]!.id;
  ag({ type: "creerEspace", nom: "Banque pro", icone: "💳", prive: true, profil: bank.profil, fenetreId: F });
  const pro = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essential });
  ag({ type: "creerEspace", nom: "Impôts", icone: "🧾", prive: true, profil: bank.profil, fenetreId: F });
  const impots = e.espaces[3]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essential });
  ag({ type: "reglerEspace", id: bank.id, nom: "Banque", icone: "🏦", prive: false, profil: bank.profil });
  expect(e.onglets[g]!.espaceId).toBe(pro);
  expect(active(pro)).toBe(g);
  expect(active(impots)).toBe(g);
  expect(active(bank.id)).toBeNull();
});

test("contexteHistorique: a shared essential counts in the space that displays it, otherwise in its own; unknown: private", () => {
  const g = open("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(historyContext(e, g)).toEqual({ espaceId: P, prive: false });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(e.onglets[g]!.espaceId).toBe(P);
  expect(historyContext(e, g)).toEqual({ espaceId: B, prive: false });
  // Back in Perso, which also displays it: the visit returns there.
  ag({ type: "activerEspace", fenetreId: F, id: P });
  expect(historyContext(e, g)).toEqual({ espaceId: P, prive: false });
  // Displayed in an unknown space: private, to be safe.
  const bizarre = structuredClone(e);
  const f = bizarre.fenetres[0]!;
  f.espaceActif = "disparu";
  f.actif["disparu"] = g;
  expect(historyContext(bizarre, g)).toEqual({ espaceId: "disparu", prive: true });
  expect(historyContext(e, "inexistant")).toBeNull();
});

test("cleEspace, ongletPrive, profilDOnglet", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" });
  const bank = e.espaces[1]!;
  expect(spaceKey(e, P)).toBe("defaut|false");
  expect(spaceKey(e, bank.id)).toBe(`${bank.profil}|true`);
  expect(spaceKey(e, "inconnu")).not.toBe(spaceKey(e, P));
  ag({ type: "activerEspace", fenetreId: F, id: bank.id });
  const idO = open("https://banque.test/");
  const o = e.onglets[idO]!;
  expect(privateTab(e, o)).toBe(true);
  expect(tabProfile(e, o)).toBe(bank.profil);
  ag({ type: "activerEspace", fenetreId: F, id: P });
  const idP = open("https://a.test/");
  const p = e.onglets[idP]!;
  expect(privateTab(e, p)).toBe(false);
  expect(tabProfile(e, p)).toBe("defaut");
  const orphan: Tab = { ...p, espaceId: "disparu" };
  expect(privateTab(e, orphan)).toBe(true);
});

test("supprimerEspace closes its tabs and switches the windows", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = open("https://b.test/");
  ag({ type: "supprimerEspace", id: B });
  expect(e.espaces.map((x) => x.id)).toEqual([P]);
  expect(e.onglets[b]).toBeUndefined();
  expect(fen().espaceActif).toBe(P);
  expect(fen().ordre[B]).toBeUndefined();
});

test("deleting the last space is refused", () => {
  const before = e;
  ag({ type: "supprimerEspace", id: P });
  expect(e).toBe(before);
});

test("ouvrirFenetre on a given space; fermerFenetre deletes its tabs", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFenetre", id: "f2", espaceId: B });
  const f2 = e.fenetres.find((f) => f.id === "f2")!;
  expect(f2).toMatchObject({ espaceActif: B, ordre: { [P]: [], [B]: [] }, actif: { [P]: null, [B]: null } });
  ag({ type: "ouvrirOnglet", fenetreId: "f2", url: "https://x.test/" });
  const x = Object.keys(e.onglets).at(-1)!;
  ag({ type: "fermerFenetre", id: "f2" });
  expect(e.fenetres).toHaveLength(1);
  expect(e.onglets[x]).toBeUndefined();
});

test("closing the last window does not change the state", () => {
  const before = e;
  ag({ type: "fermerFenetre", id: F });
  expect(e).toBe(before);
});

test("basculerCompact, basculerPanneauAgent, choisirMoteur", () => {
  ag({ type: "basculerCompact", fenetreId: F });
  ag({ type: "basculerPanneauAgent", fenetreId: F });
  ag({ type: "choisirMoteur", moteur: "qwant" });
  expect(fen()).toMatchObject({ compact: true, panneauAgentOuvert: true });
  expect(e.reglages.moteur).toBe("qwant");
});

test("cadrerFenetre keeps the size and position; unknown window → same reference", () => {
  expect(fen().cadre).toBeNull();
  ag({ type: "cadrerFenetre", id: F, cadre: { x: 10, y: 20, largeur: 800, hauteur: 600 } });
  expect(fen().cadre).toEqual({ x: 10, y: 20, largeur: 800, hauteur: 600 });
  const before = e;
  expect(apply(e, { type: "cadrerFenetre", id: "inconnue", cadre: { x: 0, y: 0, largeur: 1, hauteur: 1 } }, genId)).toBe(before);
});

test("majOnglet with no change → same reference (nothing to rebroadcast)", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", chargement: true } });
  const before = e;
  expect(apply(e, { type: "majOnglet", id: a, champs: { titre: "A", chargement: true } }, genId)).toBe(before);
});

test("majOnglet only touches the given fields; unknown id → same reference", () => {
  const a = open("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", chargement: true } });
  expect(e.onglets[a]).toMatchObject({ titre: "A", chargement: true, url: "https://a.test/" });
  for (const action of [
    { type: "majOnglet", id: "inconnu", champs: { titre: "x" } },
    { type: "fermerOnglet", id: "inconnu" },
    { type: "activerOnglet", id: "inconnu" },
    { type: "ouvrirOnglet", fenetreId: "inconnue", url: "https://x.test/" },
    { type: "activerEspace", fenetreId: F, id: "inconnu" },
    { type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: "inconnu" },
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
    ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" });
    ag({ type: "epinglerOnglet", id: a });
    ag({ type: "creerEspace", nom: "B", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
    ag({ type: "fermerOnglet", id: a });
  }).not.toThrow();
});

test("afficherPageVide: the space no longer has an active tab, its tabs remain", () => {
  const a = open("https://a.fr");
  ag({ type: "afficherPageVide", fenetreId: F });
  expect(active()).toBeNull();
  expect(order()).toEqual([a]);
});

test("fermerFenetre: its tabs (all spaces) go into the remaining window's recently closed, ⇧⌘T reopens them", () => {
  ag({ type: "ouvrirFenetre", id: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://x.fr" });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://y.fr" });
  ag({ type: "fermerFenetre", id: "F2" });
  expect(fen().fermesRecemment.map((x) => x.url)).toEqual(["https://y.fr", "https://x.fr"]);
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["https://y.fr"]);
});

test("choisirProfilAgent changes the setting (claude by default)", () => {
  expect(e.reglages.profilAgent).toBe("claude");
  ag({ type: "choisirProfilAgent", profil: "autre" });
  expect(e.reglages.profilAgent).toBe("autre");
});

test("panneauAgentAccueil: opens only on the home page (otherwise the tab would be given to the agent); always closes", () => {
  open("https://a.test/");
  const before = e;
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(e).toBe(before);
  ag({ type: "afficherPageVide", fenetreId: F });
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(fen().panneauAgentOuvert).toBe(true);
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(fen().panneauAgentOuvert).toBe(true);
  open("https://b.test/");
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: false });
  expect(fen().panneauAgentOuvert).toBe(false);
});

test("largeurPanneauAgent: 420 by default, kept, clamped between 280 and 1000", () => {
  expect(e.reglages.largeurPanneauAgent).toBe(420);
  ag({ type: "largeurPanneauAgent", largeur: 612.4 });
  expect(e.reglages.largeurPanneauAgent).toBe(612);
  ag({ type: "largeurPanneauAgent", largeur: 50 });
  expect(e.reglages.largeurPanneauAgent).toBe(280);
  ag({ type: "largeurPanneauAgent", largeur: 5000 });
  expect(e.reglages.largeurPanneauAgent).toBe(1000);
});

test("ouvrirApplications reuses the window's existing tab", () => {
  open("https://a.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_APPLICATIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ titre: "Applications", espaceId: P });
  expect(active()).toBe(page.id);
  // Already displayed: nothing changes.
  const before = e;
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(e).toBe(before);
  // Another tab in front: go back to the page instead of opening a second one.
  open("https://b.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  expect(fen().espaceActif).not.toBe(P);
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(active()).toBe(page.id);
});

test("ouvrirExtensions opens or activates the page, like ouvrirApplications", () => {
  expect(URL_EXTENSIONS).toBe("webaios://extensions");
  expect(hasView(URL_EXTENSIONS)).toBe(false);
  open("https://a.test/");
  ag({ type: "ouvrirExtensions", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_EXTENSIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ titre: "Extensions", espaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
});

test("ouvrirWorkflow opens a titled webaios://workflow/<id> tab, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  const pages = (id = "meteo") => Object.values(e.onglets).filter((o) => o.url === urlWorkflow(id));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: "webaios://workflow/meteo", titre: "Workflow — Météo", espaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(active()).toBe(page.id);
  // Another widget: its own page.
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "actus", nom: "Actus" });
  expect(pages("actus")).toHaveLength(1);
  expect(pages()).toHaveLength(1);
  // The widget renamed: back to the same page, and its title follows.
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo de Lyon" });
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ id: page.id, titre: "Workflow — Météo de Lyon" });
});

test("ouvrirAction opens a webaios://action/<id> tab titled with the name, then returns to it instead of opening a second one", () => {
  open("https://a.test/");
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  const pages = () => Object.values(e.onglets).filter((o) => o.url.startsWith("webaios://action/gitlab"));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: urlAction("gitlab"), titre: "GitLab", espaceId: P });
  expect(active()).toBe(page.id);
  const before = e;
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(e).toBe(before);
  open("https://b.test/");
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(page.id);
  // Another action: its own page.
  ag({ type: "ouvrirAction", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(Object.values(e.onglets).filter((o) => o.url === urlAction("meteo"))).toHaveLength(1);
});

test("ouvrirAction finds the action's tab in another space of the window; with execution, changes its URL", () => {
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  const page = Object.keys(e.onglets).at(-1)!;
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  expect(fen().espaceActif).not.toBe(P);
  const ex = "2026-10-31T10-00-00-000Z";
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab", execution: ex });
  expect(Object.keys(e.onglets)).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(active()).toBe(page);
  expect(e.onglets[page]).toMatchObject({ url: urlAction("gitlab", ex), titre: "GitLab" });
  // The tab shows a specific run: it stays the action's tab (same id), the name follows.
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "Mes tickets" });
  expect(Object.keys(e.onglets)).toHaveLength(1);
  expect(e.onglets[page]).toMatchObject({ url: urlAction("gitlab", ex), titre: "Mes tickets" });
  // Invalid run: refused by the schema, never a URL.
  expect(SchemaAction.safeParse({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab", execution: "../etat" }).success).toBe(false);
  expect(SchemaAction.safeParse({ type: "ouvrirAction", fenetreId: F, id: "../x", nom: "GitLab" }).success).toBe(false);
});

test("ouvrirAction neither opens nor finds anything in a private space", () => {
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  const page = Object.keys(e.onglets).at(-1)!;
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const bank = fen().espaceActif;
  // The non-private space's tab is found; the window goes back there.
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(fen().espaceActif).toBe(P);
  expect(active()).toBe(page);
  // No tab elsewhere: nothing is opened in the private space.
  ag({ type: "activerEspace", fenetreId: F, id: bank });
  const before = e;
  ag({ type: "ouvrirAction", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(e).toBe(before);
});

test("ouvrirActions opens the single « Actions » page, then returns to it", () => {
  ag({ type: "ouvrirActions", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_ACTIONS);
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ titre: "Actions" });
  open("https://b.test/");
  ag({ type: "ouvrirActions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
});

test("ouvrirWorkflow of an action opens webaios://workflow/action/<id>", () => {
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab", proprietaire: "action" });
  expect(Object.values(e.onglets)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", titre: "Workflow — GitLab" });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["webaios://workflow/action/gitlab", urlWorkflow("gitlab")]);
});

test("profilsEnUsage: by identifier, spaces included", () => {
  const copy = structuredClone(e);
  copy.espaces[0]!.profil = "autre";
  expect(profilesInUse(copy)).toEqual(new Set(["defaut", "autre"]));
});

// Plan 17, task 11: a project's review page.
test("ouvrirRelecture opens webaios://relecture/app-essai titled « Relecture — Essai »; a second call returns to the same tab", async () => {
  const { reviewUrl: reviewUrl } = await import("../../shared/modele");
  ag({ type: "ouvrirRelecture", fenetreId: F, projet: "app-essai", nom: "Essai" });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === "webaios://relecture/app-essai");
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ titre: "Relecture — Essai" });
  expect(reviewUrl("app-essai")).toBe("webaios://relecture/app-essai");
  open("https://b.test/");
  ag({ type: "ouvrirRelecture", fenetreId: F, projet: "app-essai", nom: "Essai" });
  expect(pages()).toHaveLength(1);
  expect(active()).toBe(pages()[0]!.id);
  expect(SchemaAction.safeParse({ type: "ouvrirRelecture", fenetreId: F, projet: "../x", nom: "x" }).success).toBe(false);
});

test("projetDeUrlRelecture refuses webaios://relecture/../x and webaios://relecture/app-", async () => {
  const { reviewUrlProject: reviewUrlProject } = await import("../../shared/modele");
  const { PROJECT_ID: PROJECT_ID } = await import("@webaios/noyau");
  expect(reviewUrlProject("webaios://relecture/../x")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-essai/x")).toBeNull();
  expect(reviewUrlProject("webaios://applications")).toBeNull();
  expect(reviewUrlProject("webaios://relecture/app-essai")).toBe("app-essai");
  expect(reviewUrlProject("webaios://relecture/ext-0123456789abcdef")).toBe("ext-0123456789abcdef");
  // The UI copies follow the kernel.
  const { NOT_DISPLAYABLE: NOT_DISPLAYABLE } = await import("../../shared/modele");
  const { BINARY_FILE: BINARY_FILE, FILE_TOO_BIG: FILE_TOO_BIG } = await import("@webaios/noyau");
  expect(NOT_DISPLAYABLE).toEqual({ binaire: BINARY_FILE, "trop-gros": FILE_TOO_BIG });
  const { PAGE_LINE_CHANGED: PAGE_LINE_CHANGED } = await import("../../shared/modele");
  const { LINE_CHANGED: LINE_CHANGED } = await import("@webaios/noyau");
  expect(PAGE_LINE_CHANGED).toBe(LINE_CHANGED);
  for (const p of ["app-essai", "app-.x", "ext-0123456789abcdef", "ext-0123", "demo-15283", "demo-", "app-a/b", "site-tuning", "site-", "site-A", "site-../x"])
    expect(reviewUrlProject(`webaios://relecture/${p}`) !== null).toBe(PROJECT_ID.test(p));
});
