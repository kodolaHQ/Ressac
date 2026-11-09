import { beforeEach, expect, test } from "vitest";
import { appliquer } from "../../core/etat/actions";
import { etatInitial } from "../../core/etat/etat-initial";
import { SchemaAction, type Action } from "../../shared/api";
import { cleEspace, contexteHistorique, ongletPrive, profilsEnUsage, profilDOnglet, aUneVue, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, urlAction, urlWorkflow, type EtatNavigateur, type Onglet } from "../../shared/modele";

let n = 0;
const genId = () => `g${++n}`;
let e: EtatNavigateur;
let F: string; // window
let P: string; // space « Perso »
const ag = (a: Action) => (e = appliquer(e, a, genId));
const fen = () => e.fenetres.find((f) => f.id === F)!;
const ordre = (esp = P) => fen().ordre[esp] ?? [];
const actif = (esp = P) => fen().actif[esp] ?? null;
const ouvrir = (url: string, extra: Partial<Extract<Action, { type: "ouvrirOnglet" }>> = {}) => {
  ag({ type: "ouvrirOnglet", fenetreId: F, url, ...extra });
  return Object.keys(e.onglets).at(-1)!;
};

function gelerProfond<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) gelerProfond(v);
  }
  return o;
}

beforeEach(() => {
  n = 0;
  e = etatInitial(genId);
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
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  const c = ouvrir("https://c.test/", { activer: false });
  expect(ordre()).toEqual([a, b, c]);
  expect(actif()).toBe(b);
  ag({ type: "fermerOnglet", id: b });
  expect(ordre()).toEqual([a, c]);
  expect(actif()).toBe(c);
  expect(e.onglets[b]).toBeUndefined();
});

test("closing the active tab at the end of the list → the previous becomes active", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  ag({ type: "fermerOnglet", id: b });
  expect(actif()).toBe(a);
});

test("closing the last tab of the space → active null", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(actif()).toBeNull();
  expect(ordre()).toEqual([]);
});

test("closing an inactive tab does not change the active one", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(actif()).toBe(b);
});

test("ouvrirOnglet with apres inserts right after; a new tab has default values", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  const c = ouvrir("https://c.test/", { apres: a });
  expect(ordre()).toEqual([a, c, b]);
  expect(e.onglets[c]).toEqual({
    id: c, fenetreId: F, espaceId: P, url: "https://c.test/", titre: "https://c.test/", favicon: null, lien: null,
    ouvertParAgent: false, chargement: false, peutReculer: false, peutAvancer: false, zoom: 1, plante: false, erreur: null,
  });
});

test("link opened from a tab of a background space: it stays in that space; from a displayed essential, in the displayed space", () => {
  const a = ouvrir("https://a.test/");
  const g = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Privé", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const c = ouvrir("https://c.test/", { apres: a });
  expect(e.onglets[c]!.espaceId).toBe(P);
  expect(ordre(P)).toEqual([a, c]);
  expect(ordre(B)).toEqual([]);
  expect(fen().espaceActif).toBe(B);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const D = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  const m = ouvrir("https://m.test/", { apres: g });
  expect(e.onglets[m]!.espaceId).toBe(D);
});

test("tab opened by the agent: ouvertParAgent true", () => {
  const a = ouvrir("http://localhost:5280/", { ouvertParAgent: true });
  expect(e.onglets[a]!.ouvertParAgent).toBe(true);
});

test("deplacerOnglet reorders (clamped index)", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  const c = ouvrir("https://c.test/");
  ag({ type: "deplacerOnglet", id: c, index: 0 });
  expect(ordre()).toEqual([c, a, b]);
  ag({ type: "deplacerOnglet", id: c, index: 99 });
  expect(ordre()).toEqual([a, b, c]);
});

test("rouvrirOngletFerme reopens the most recent one and removes it from the stack; stack limited to 20", () => {
  for (let i = 0; i < 25; i++) ag({ type: "fermerOnglet", id: ouvrir(`https://${i}.test/`) });
  expect(fen().fermesRecemment).toHaveLength(20);
  expect(fen().fermesRecemment[0]).toEqual({ url: "https://24.test/", espaceId: P });
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e.onglets[actif()!]!.url).toBe("https://24.test/");
  expect(fen().fermesRecemment[0]!.url).toBe("https://23.test/");
});

test("rouvrirOngletFerme with an empty stack changes nothing", () => {
  const avant = e;
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e).toBe(avant);
});

test("pinning a tab creates a favorite in the space and the tab leaves ordre", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", favicon: "https://a.test/f.ico" } });
  ag({ type: "epinglerOnglet", id: a });
  const [fav] = e.espaces[0]!.epingles;
  expect(fav).toMatchObject({ url: "https://a.test/", titre: "A", favicon: "https://a.test/f.ico" });
  expect(e.onglets[a]!.lien).toEqual({ type: "epingle", id: fav!.id });
  expect(ordre()).toEqual([]);
  expect(actif()).toBe(a);
});

test("closing a pinned tab: the favorite stays, nothing enters fermesRecemment", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "fermerOnglet", id: a });
  expect(e.espaces[0]!.epingles).toHaveLength(1);
  expect(fen().fermesRecemment).toEqual([]);
  expect(actif()).toBeNull();
});

test("ouvrirFavori creates the linked tab then reuses it", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  const favId = e.espaces[0]!.epingles[0]!.id;
  ag({ type: "fermerOnglet", id: a });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favId });
  const nouvel = actif()!;
  expect(e.onglets[nouvel]).toMatchObject({ url: "https://a.test/", lien: { type: "epingle", id: favId } });
  ouvrir("https://b.test/");
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "epingle", id: favId });
  expect(actif()).toBe(nouvel);
  expect(Object.keys(e.onglets)).toHaveLength(2);
});

test("unpinning: the favorite disappears, the linked tab becomes normal again", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "desepingler", espaceId: P, favoriId: e.espaces[0]!.epingles[0]!.id });
  expect(e.espaces[0]!.epingles).toEqual([]);
  expect(e.onglets[a]!.lien).toBeNull();
  expect(ordre()).toEqual([a]);
});

test("essentials shared by all spaces; removing an essential", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  expect(e.essentiels).toHaveLength(1);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(B);
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  // One tab per window for an essential: the same Gmail, without reloading, in every space.
  expect(actif(B)).toBe(a);
  expect(Object.keys(e.onglets)).toEqual([a]);
  ag({ type: "retirerEssentiel", favoriId: e.essentiels[0]!.id });
  expect(e.essentiels).toEqual([]);
  // Back to a normal tab of « Perso », it is no longer displayed in « Boulot ».
  expect(ordre(P)).toEqual([a]);
  expect(actif(B)).toBeNull();
});

test("closing an essential displayed in two spaces: no space keeps a vanished active tab", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "fermerOnglet", id: a });
  expect(actif(P)).toBeNull();
  expect(actif(B)).toBeNull();
});

test("deleting the origin space of an essential open elsewhere: the other space no longer points to it", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "supprimerEspace", id: P });
  const restant = actif(B);
  expect(restant === null || !!e.onglets[restant]).toBe(true);
});

test("activerEspace keeps each space's own active tab", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut" });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(P);
  ag({ type: "activerEspace", fenetreId: F, id: B });
  const b = ouvrir("https://b.test/");
  expect(e.onglets[b]!.espaceId).toBe(B);
  ag({ type: "activerEspace", fenetreId: F, id: P });
  expect(actif()).toBe(a);
  expect(actif(B)).toBe(b);
});

test("activerOnglet of another space switches the active space", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = ouvrir("https://b.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b });
  expect(fen().espaceActif).toBe(B);
});

test("activerOnglet garderEspace: the tab becomes its space's, the window stays on its own", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b1 = ouvrir("https://b1.test/");
  ouvrir("https://b2.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b1, garderEspace: true });
  expect(fen().espaceActif).toBe(P);
  expect(actif(B)).toBe(b1);
});

test("reglerEspace changes the name and the icon", () => {
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(e.espaces[0]).toMatchObject({ nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
});

test("reglerEspace with no change leaves the state unchanged", () => {
  const avant = e;
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: false, profil: "defaut" });
  expect(e).toBe(avant);
});

test("creerEspace with a new sign-in profile: a fresh profile; with an existing profile: it is reused", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" });
  const banque = e.espaces[1]!;
  expect(banque).toMatchObject({ nom: "Banque", prive: true });
  expect(banque.profil).not.toBe("defaut");
  expect(banque.profil).not.toBe("nouveau");
  expect(e.profils).toEqual([{ id: "defaut" }, { id: banque.profil }]);
  ag({ type: "creerEspace", nom: "Comptes", icone: "📒", prive: false, profil: banque.profil });
  expect(e.espaces[2]!.profil).toBe(banque.profil);
  expect(e.profils).toHaveLength(2);
});

test("creerEspace on an unknown sign-in profile is refused", () => {
  const avant = e;
  ag({ type: "creerEspace", nom: "X", icone: "❓", prive: false, profil: "inconnu" });
  expect(e).toBe(avant);
});

test("reglerEspace that leaves a sign-in profile unused removes it, including the default profile", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const banque = e.espaces[1]!;
  ag({ type: "reglerEspace", id: banque.id, nom: "Banque", icone: "🏦", prive: false, profil: "defaut" });
  expect(e.profils).toEqual([{ id: "defaut" }]);
  ag({ type: "reglerEspace", id: banque.id, nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const neuf = e.espaces[1]!.profil;
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: false, profil: neuf });
  expect(e.profils).toEqual([{ id: neuf }]);
  expect(e.espaces.every((x) => x.profil === neuf)).toBe(true);
});

test("supprimerEspace removes the sign-in profile it was the only one using", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const banque = e.espaces[1]!;
  ag({ type: "supprimerEspace", id: banque.id });
  expect(e.profils).toEqual([{ id: "defaut" }]);
});

test("essential opened in a space with another key (private or other profile): a second tab, never the same", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  const essentiel = e.essentiels[0]!.id;
  ag({ type: "creerEspace", nom: "Privé", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  const b = actif(B)!;
  expect(b).not.toBe(a);
  expect(e.onglets[b]).toMatchObject({ espaceId: B, lien: { type: "essentiel", id: essentiel } });
  expect(actif(P)).toBe(a);
  // Same key (not private, default profile): Perso's tab is reused.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  expect(actif(C)).toBe(a);
  // Same key as the private space: its tab is reused.
  ag({ type: "creerEspace", nom: "Privé 2", icone: "🔐", prive: true, profil: "defaut", fenetreId: F });
  const D = e.espaces[3]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  expect(actif(D)).toBe(b);
  expect(Object.keys(e.onglets)).toHaveLength(2);
});

test("reglerEspace that changes a space's key: the tab that a space of the old key displays comes back to it", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(actif(B)).toBe(a);
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: true, profil: "defaut" });
  expect(e.onglets[a]!.espaceId).toBe(B);
  expect(actif(B)).toBe(a);
  expect(actif(P)).toBeNull();
});

test("reglerEspace that changes a space's key: a tab that no other space displays stays with it, the others let go of it", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "creerEspace", nom: "Coffre", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  // C (other key) cannot display it; B, with the same key as P, does not display it.
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: true, profil: "defaut" });
  expect(e.onglets[a]!.espaceId).toBe(P);
  expect(actif(P)).toBe(a);
  expect(actif(B)).toBeNull();
  expect(actif(C)).toBeNull();
});

test("reglerEspace: pointers of other spaces that stayed compatible are kept", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(actif(B)).toBe(a);
});

test("reglerEspace: an essential shared by two private spaces stays private when its owner no longer is", () => {
  // « Banque » and « Banque pro », private on the same profile; the Gmail tab belongs to Banque, also displayed in Banque pro.
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const banque = e.espaces[1]!;
  const g = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Banque pro", icone: "💳", prive: true, profil: banque.profil, fenetreId: F });
  const pro = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(actif(pro)).toBe(g);
  expect(e.onglets[g]!.espaceId).toBe(banque.id);
  ag({ type: "reglerEspace", id: banque.id, nom: "Banque", icone: "🏦", prive: false, profil: banque.profil });
  // The tab goes to Banque pro (still private); Banque, now non-private, lets go of it.
  expect(e.onglets[g]!.espaceId).toBe(pro);
  expect(actif(pro)).toBe(g);
  expect(actif(banque.id)).toBeNull();
  expect(ongletPrive(e, e.onglets[g]!)).toBe(true);
  // No tab is displayed under a key different from its owner's.
  for (const [esp, id] of Object.entries(fen().actif))
    if (id) expect(cleEspace(e, esp)).toBe(cleEspace(e, e.onglets[id]!.espaceId));
});

test("reglerEspace: several spaces display the tab under the old key, the first in space order takes it back", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const banque = e.espaces[1]!;
  const g = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  const essentiel = e.essentiels[0]!.id;
  ag({ type: "creerEspace", nom: "Banque pro", icone: "💳", prive: true, profil: banque.profil, fenetreId: F });
  const pro = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  ag({ type: "creerEspace", nom: "Impôts", icone: "🧾", prive: true, profil: banque.profil, fenetreId: F });
  const impots = e.espaces[3]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  ag({ type: "reglerEspace", id: banque.id, nom: "Banque", icone: "🏦", prive: false, profil: banque.profil });
  expect(e.onglets[g]!.espaceId).toBe(pro);
  expect(actif(pro)).toBe(g);
  expect(actif(impots)).toBe(g);
  expect(actif(banque.id)).toBeNull();
});

test("contexteHistorique: a shared essential counts in the space that displays it, otherwise in its own; unknown: private", () => {
  const g = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(contexteHistorique(e, g)).toEqual({ espaceId: P, prive: false });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(e.onglets[g]!.espaceId).toBe(P);
  expect(contexteHistorique(e, g)).toEqual({ espaceId: B, prive: false });
  // Back in Perso, which also displays it: the visit returns there.
  ag({ type: "activerEspace", fenetreId: F, id: P });
  expect(contexteHistorique(e, g)).toEqual({ espaceId: P, prive: false });
  // Displayed in an unknown space: private, to be safe.
  const bizarre = structuredClone(e);
  const f = bizarre.fenetres[0]!;
  f.espaceActif = "disparu";
  f.actif["disparu"] = g;
  expect(contexteHistorique(bizarre, g)).toEqual({ espaceId: "disparu", prive: true });
  expect(contexteHistorique(e, "inexistant")).toBeNull();
});

test("cleEspace, ongletPrive, profilDOnglet", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" });
  const banque = e.espaces[1]!;
  expect(cleEspace(e, P)).toBe("defaut|false");
  expect(cleEspace(e, banque.id)).toBe(`${banque.profil}|true`);
  expect(cleEspace(e, "inconnu")).not.toBe(cleEspace(e, P));
  ag({ type: "activerEspace", fenetreId: F, id: banque.id });
  const idO = ouvrir("https://banque.test/");
  const o = e.onglets[idO]!;
  expect(ongletPrive(e, o)).toBe(true);
  expect(profilDOnglet(e, o)).toBe(banque.profil);
  ag({ type: "activerEspace", fenetreId: F, id: P });
  const idP = ouvrir("https://a.test/");
  const p = e.onglets[idP]!;
  expect(ongletPrive(e, p)).toBe(false);
  expect(profilDOnglet(e, p)).toBe("defaut");
  const orphelin: Onglet = { ...p, espaceId: "disparu" };
  expect(ongletPrive(e, orphelin)).toBe(true);
});

test("supprimerEspace closes its tabs and switches the windows", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = ouvrir("https://b.test/");
  ag({ type: "supprimerEspace", id: B });
  expect(e.espaces.map((x) => x.id)).toEqual([P]);
  expect(e.onglets[b]).toBeUndefined();
  expect(fen().espaceActif).toBe(P);
  expect(fen().ordre[B]).toBeUndefined();
});

test("deleting the last space is refused", () => {
  const avant = e;
  ag({ type: "supprimerEspace", id: P });
  expect(e).toBe(avant);
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
  const avant = e;
  ag({ type: "fermerFenetre", id: F });
  expect(e).toBe(avant);
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
  const avant = e;
  expect(appliquer(e, { type: "cadrerFenetre", id: "inconnue", cadre: { x: 0, y: 0, largeur: 1, hauteur: 1 } }, genId)).toBe(avant);
});

test("majOnglet with no change → same reference (nothing to rebroadcast)", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", chargement: true } });
  const avant = e;
  expect(appliquer(e, { type: "majOnglet", id: a, champs: { titre: "A", chargement: true } }, genId)).toBe(avant);
});

test("majOnglet only touches the given fields; unknown id → same reference", () => {
  const a = ouvrir("https://a.test/");
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
    const avant = e;
    ag(action);
    expect(e, action.type).toBe(avant);
  }
});

test("appliquer never mutates the input state", () => {
  const a = ouvrir("https://a.test/");
  gelerProfond(e);
  expect(() => {
    ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" });
    ag({ type: "epinglerOnglet", id: a });
    ag({ type: "creerEspace", nom: "B", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
    ag({ type: "fermerOnglet", id: a });
  }).not.toThrow();
});

test("afficherPageVide: the space no longer has an active tab, its tabs remain", () => {
  const a = ouvrir("https://a.fr");
  ag({ type: "afficherPageVide", fenetreId: F });
  expect(actif()).toBeNull();
  expect(ordre()).toEqual([a]);
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
  ouvrir("https://a.test/");
  const avant = e;
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(e).toBe(avant);
  ag({ type: "afficherPageVide", fenetreId: F });
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(fen().panneauAgentOuvert).toBe(true);
  ag({ type: "panneauAgentAccueil", fenetreId: F, ouvert: true });
  expect(fen().panneauAgentOuvert).toBe(true);
  ouvrir("https://b.test/");
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
  ouvrir("https://a.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_APPLICATIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ titre: "Applications", espaceId: P });
  expect(actif()).toBe(page.id);
  // Already displayed: nothing changes.
  const avant = e;
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(e).toBe(avant);
  // Another tab in front: go back to the page instead of opening a second one.
  ouvrir("https://b.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  expect(fen().espaceActif).not.toBe(P);
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page.id);
});

test("ouvrirExtensions opens or activates the page, like ouvrirApplications", () => {
  expect(URL_EXTENSIONS).toBe("webaios://extensions");
  expect(aUneVue(URL_EXTENSIONS)).toBe(false);
  ouvrir("https://a.test/");
  ag({ type: "ouvrirExtensions", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_EXTENSIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ titre: "Extensions", espaceId: P });
  expect(actif()).toBe(page.id);
  const avant = e;
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(e).toBe(avant);
  ouvrir("https://b.test/");
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(page.id);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  ag({ type: "ouvrirExtensions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
});

test("ouvrirWorkflow opens a titled webaios://workflow/<id> tab, then returns to it instead of opening a second one", () => {
  ouvrir("https://a.test/");
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  const pages = (id = "meteo") => Object.values(e.onglets).filter((o) => o.url === urlWorkflow(id));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: "webaios://workflow/meteo", titre: "Workflow — Météo", espaceId: P });
  expect(actif()).toBe(page.id);
  const avant = e;
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(e).toBe(avant);
  ouvrir("https://b.test/");
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(page.id);
  // From another space: go back to the window's page, in its space.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page.id);
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
  ouvrir("https://a.test/");
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  const pages = () => Object.values(e.onglets).filter((o) => o.url.startsWith("webaios://action/gitlab"));
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ url: urlAction("gitlab"), titre: "GitLab", espaceId: P });
  expect(actif()).toBe(page.id);
  const avant = e;
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(e).toBe(avant);
  ouvrir("https://b.test/");
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(page.id);
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
  expect(actif()).toBe(page);
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
  const banque = fen().espaceActif;
  // The non-private space's tab is found; the window goes back there.
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page);
  // No tab elsewhere: nothing is opened in the private space.
  ag({ type: "activerEspace", fenetreId: F, id: banque });
  const avant = e;
  ag({ type: "ouvrirAction", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(e).toBe(avant);
});

test("ouvrirActions opens the single « Actions » page, then returns to it", () => {
  ag({ type: "ouvrirActions", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_ACTIONS);
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ titre: "Actions" });
  ouvrir("https://b.test/");
  ag({ type: "ouvrirActions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(pages()[0]!.id);
});

test("ouvrirWorkflow of an action opens webaios://workflow/action/<id>", () => {
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab", proprietaire: "action" });
  expect(Object.values(e.onglets)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", titre: "Workflow — GitLab" });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["webaios://workflow/action/gitlab", urlWorkflow("gitlab")]);
});

test("profilsEnUsage: by identifier, spaces included", () => {
  const copie = structuredClone(e);
  copie.espaces[0]!.profil = "autre";
  expect(profilsEnUsage(copie)).toEqual(new Set(["defaut", "autre"]));
});

// Plan 17, task 11: a project's review page.
test("ouvrirRelecture opens webaios://relecture/app-essai titled « Relecture — Essai »; a second call returns to the same tab", async () => {
  const { urlRelecture } = await import("../../shared/modele");
  ag({ type: "ouvrirRelecture", fenetreId: F, projet: "app-essai", nom: "Essai" });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === "webaios://relecture/app-essai");
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ titre: "Relecture — Essai" });
  expect(urlRelecture("app-essai")).toBe("webaios://relecture/app-essai");
  ouvrir("https://b.test/");
  ag({ type: "ouvrirRelecture", fenetreId: F, projet: "app-essai", nom: "Essai" });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(pages()[0]!.id);
  expect(SchemaAction.safeParse({ type: "ouvrirRelecture", fenetreId: F, projet: "../x", nom: "x" }).success).toBe(false);
});

test("projetDeUrlRelecture refuses webaios://relecture/../x and webaios://relecture/app-", async () => {
  const { projetDeUrlRelecture } = await import("../../shared/modele");
  const { PROJECT_ID: ID_PROJET } = await import("@webaios/noyau");
  expect(projetDeUrlRelecture("webaios://relecture/../x")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-essai/x")).toBeNull();
  expect(projetDeUrlRelecture("webaios://applications")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-essai")).toBe("app-essai");
  expect(projetDeUrlRelecture("webaios://relecture/ext-0123456789abcdef")).toBe("ext-0123456789abcdef");
  // The UI copies follow the kernel.
  const { NON_AFFICHABLE } = await import("../../shared/modele");
  const { BINARY_FILE: FICHIER_BINAIRE, FILE_TOO_BIG: FICHIER_TROP_GROS } = await import("@webaios/noyau");
  expect(NON_AFFICHABLE).toEqual({ binaire: FICHIER_BINAIRE, "trop-gros": FICHIER_TROP_GROS });
  const { LIGNE_CHANGEE_PAGE } = await import("../../shared/modele");
  const { LINE_CHANGED: LIGNE_CHANGEE } = await import("@webaios/noyau");
  expect(LIGNE_CHANGEE_PAGE).toBe(LIGNE_CHANGEE);
  for (const p of ["app-essai", "app-.x", "ext-0123456789abcdef", "ext-0123", "demo-15283", "demo-", "app-a/b", "site-tuning", "site-", "site-A", "site-../x"])
    expect(projetDeUrlRelecture(`webaios://relecture/${p}`) !== null).toBe(ID_PROJET.test(p));
});
