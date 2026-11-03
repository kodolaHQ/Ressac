import { beforeEach, expect, test } from "vitest";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import { SchemaAction, type Action } from "../../src/commun/api";
import { cleEspace, contexteHistorique, ongletPrive, profilsChanges, profilsEnUsage, profilDOnglet, aUneVue, URL_ACTIONS, URL_APPLICATIONS, URL_EXTENSIONS, urlAction, urlWorkflow, type EtatNavigateur, type Onglet } from "../../src/commun/modele";

let n = 0;
const genId = () => `g${++n}`;
let e: EtatNavigateur;
let F: string; // fenêtre
let P: string; // espace « Perso »
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

test("état initial : un espace Perso, une fenêtre, aucun onglet, Google", () => {
  expect(e.version).toBe(2);
  expect(e.espaces).toEqual([{ id: P, nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" }]);
  expect(e.profils).toEqual([{ id: "defaut" }]);
  expect(e.fenetres).toHaveLength(1);
  expect(e.onglets).toEqual({});
  expect(e.reglages.moteur).toBe("google");
  expect(fen()).toMatchObject({ espaceActif: P, compact: false, panneauAgentOuvert: false, fermesRecemment: [] });
});

test("ouvrir trois onglets puis fermer l'actif du milieu → le suivant devient actif", () => {
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

test("fermer l'onglet actif en fin de liste → le précédent devient actif", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  ag({ type: "fermerOnglet", id: b });
  expect(actif()).toBe(a);
});

test("fermer le dernier onglet de l'espace → actif null", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(actif()).toBeNull();
  expect(ordre()).toEqual([]);
});

test("fermer un onglet inactif ne change pas l'actif", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  ag({ type: "fermerOnglet", id: a });
  expect(actif()).toBe(b);
});

test("ouvrirOnglet avec apres insère juste après ; un nouvel onglet a des valeurs par défaut", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  const c = ouvrir("https://c.test/", { apres: a });
  expect(ordre()).toEqual([a, c, b]);
  expect(e.onglets[c]).toEqual({
    id: c, fenetreId: F, espaceId: P, url: "https://c.test/", titre: "https://c.test/", favicon: null, lien: null,
    ouvertParAgent: false, chargement: false, peutReculer: false, peutAvancer: false, zoom: 1, plante: false, erreur: null,
  });
});

test("onglet ouvert par l'agent : ouvertParAgent vrai", () => {
  const a = ouvrir("http://localhost:5280/", { ouvertParAgent: true });
  expect(e.onglets[a]!.ouvertParAgent).toBe(true);
});

test("deplacerOnglet réordonne (index borné)", () => {
  const a = ouvrir("https://a.test/");
  const b = ouvrir("https://b.test/");
  const c = ouvrir("https://c.test/");
  ag({ type: "deplacerOnglet", id: c, index: 0 });
  expect(ordre()).toEqual([c, a, b]);
  ag({ type: "deplacerOnglet", id: c, index: 99 });
  expect(ordre()).toEqual([a, b, c]);
});

test("rouvrirOngletFerme rouvre le plus récent et le retire de la pile ; pile limitée à 20", () => {
  for (let i = 0; i < 25; i++) ag({ type: "fermerOnglet", id: ouvrir(`https://${i}.test/`) });
  expect(fen().fermesRecemment).toHaveLength(20);
  expect(fen().fermesRecemment[0]).toEqual({ url: "https://24.test/", espaceId: P });
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e.onglets[actif()!]!.url).toBe("https://24.test/");
  expect(fen().fermesRecemment[0]!.url).toBe("https://23.test/");
});

test("rouvrirOngletFerme avec une pile vide ne change rien", () => {
  const avant = e;
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(e).toBe(avant);
});

test("épingler un onglet crée un favori dans l'espace et l'onglet sort de ordre", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", favicon: "https://a.test/f.ico" } });
  ag({ type: "epinglerOnglet", id: a });
  const [fav] = e.espaces[0]!.epingles;
  expect(fav).toMatchObject({ url: "https://a.test/", titre: "A", favicon: "https://a.test/f.ico" });
  expect(e.onglets[a]!.lien).toEqual({ type: "epingle", id: fav!.id });
  expect(ordre()).toEqual([]);
  expect(actif()).toBe(a);
});

test("fermer un onglet épinglé : le favori reste, rien n'entre dans fermesRecemment", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "fermerOnglet", id: a });
  expect(e.espaces[0]!.epingles).toHaveLength(1);
  expect(fen().fermesRecemment).toEqual([]);
  expect(actif()).toBeNull();
});

test("ouvrirFavori crée l'onglet lié puis le réutilise", () => {
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

test("désépingler : le favori disparaît, l'onglet lié redevient normal", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "epinglerOnglet", id: a });
  ag({ type: "desepingler", espaceId: P, favoriId: e.espaces[0]!.epingles[0]!.id });
  expect(e.espaces[0]!.epingles).toEqual([]);
  expect(e.onglets[a]!.lien).toBeNull();
  expect(ordre()).toEqual([a]);
});

test("essentiels communs à tous les espaces ; retirer un essentiel", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  expect(e.essentiels).toHaveLength(1);
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(B);
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  // Un seul onglet par fenêtre pour un essentiel : le même Gmail, sans rechargement, dans chaque espace.
  expect(actif(B)).toBe(a);
  expect(Object.keys(e.onglets)).toEqual([a]);
  ag({ type: "retirerEssentiel", favoriId: e.essentiels[0]!.id });
  expect(e.essentiels).toEqual([]);
  // Redevenu un onglet normal de « Perso », il n'est plus affiché dans « Boulot ».
  expect(ordre(P)).toEqual([a]);
  expect(actif(B)).toBeNull();
});

test("fermer un essentiel affiché dans deux espaces : aucun espace ne garde un onglet actif disparu", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "fermerOnglet", id: a });
  expect(actif(P)).toBeNull();
  expect(actif(B)).toBeNull();
});

test("supprimer l'espace d'origine d'un essentiel ouvert ailleurs : l'autre espace ne pointe plus vers lui", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "supprimerEspace", id: P });
  const restant = actif(B);
  expect(restant === null || !!e.onglets[restant]).toBe(true);
});

test("activerEspace garde l'onglet actif propre à chaque espace", () => {
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

test("activerOnglet d'un autre espace bascule l'espace actif", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = ouvrir("https://b.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b });
  expect(fen().espaceActif).toBe(B);
});

test("activerOnglet garderEspace : l'onglet devient celui de son espace, la fenêtre reste sur le sien", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b1 = ouvrir("https://b1.test/");
  ouvrir("https://b2.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b1, garderEspace: true });
  expect(fen().espaceActif).toBe(P);
  expect(actif(B)).toBe(b1);
});

test("reglerEspace change le nom et l'icône", () => {
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(e.espaces[0]).toMatchObject({ nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
});

test("reglerEspace sans aucun changement laisse l'état inchangé", () => {
  const avant = e;
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: false, profil: "defaut" });
  expect(e).toBe(avant);
});

test("creerEspace avec un nouveau profil de connexion : un profil neuf ; avec un profil existant : il est repris", () => {
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

test("creerEspace sur un profil de connexion inconnu est refusé", () => {
  const avant = e;
  ag({ type: "creerEspace", nom: "X", icone: "❓", prive: false, profil: "inconnu" });
  expect(e).toBe(avant);
});

test("reglerEspace qui laisse un profil de connexion inutilisé le retire, y compris le profil par défaut", () => {
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

test("supprimerEspace retire le profil de connexion qu'il était seul à utiliser", () => {
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: false, profil: "nouveau" });
  const banque = e.espaces[1]!;
  ag({ type: "supprimerEspace", id: banque.id });
  expect(e.profils).toEqual([{ id: "defaut" }]);
});

test("essentiel ouvert dans un espace d'une autre clé (privé ou autre profil) : un second onglet, jamais le même", () => {
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
  // Même clé (non privé, profil par défaut) : l'onglet de Perso est repris.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  expect(actif(C)).toBe(a);
  // Même clé que l'espace privé : son onglet est repris.
  ag({ type: "creerEspace", nom: "Privé 2", icone: "🔐", prive: true, profil: "defaut", fenetreId: F });
  const D = e.espaces[3]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: essentiel });
  expect(actif(D)).toBe(b);
  expect(Object.keys(e.onglets)).toHaveLength(2);
});

test("reglerEspace qui change la clé d'un espace : l'onglet qu'un espace de l'ancienne clé affiche lui revient", () => {
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

test("reglerEspace qui change la clé d'un espace : un onglet qu'aucun autre espace n'affiche lui reste, les autres le lâchent", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "creerEspace", nom: "Coffre", icone: "🔒", prive: true, profil: "defaut", fenetreId: F });
  const C = e.espaces[2]!.id;
  // C (autre clé) ne peut pas l'afficher ; B, de même clé que P, ne l'affiche pas.
  ag({ type: "reglerEspace", id: P, nom: "Perso", icone: "🏠", prive: true, profil: "defaut" });
  expect(e.onglets[a]!.espaceId).toBe(P);
  expect(actif(P)).toBe(a);
  expect(actif(B)).toBeNull();
  expect(actif(C)).toBeNull();
});

test("reglerEspace : les pointeurs d'autres espaces restés compatibles sont gardés", () => {
  const a = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: a });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(actif(B)).toBe(a);
});

test("reglerEspace : un essentiel partagé par deux espaces privés reste privé quand son propriétaire ne l'est plus", () => {
  // « Banque » et « Banque pro », privés sur le même profil ; l'onglet Gmail appartient à Banque, affiché aussi dans Banque pro.
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
  // L'onglet passe à Banque pro (toujours privé) ; Banque, devenu non privé, le lâche.
  expect(e.onglets[g]!.espaceId).toBe(pro);
  expect(actif(pro)).toBe(g);
  expect(actif(banque.id)).toBeNull();
  expect(ongletPrive(e, e.onglets[g]!)).toBe(true);
  // Aucun onglet n'est affiché sous une clé différente de celle de son propriétaire.
  for (const [esp, id] of Object.entries(fen().actif))
    if (id) expect(cleEspace(e, esp)).toBe(cleEspace(e, e.onglets[id]!.espaceId));
});

test("reglerEspace : plusieurs espaces affichent l'onglet sous l'ancienne clé, le premier dans l'ordre des espaces le reprend", () => {
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

test("contexteHistorique : un essentiel partagé compte dans l'espace qui l'affiche, sinon dans le sien ; inconnu : privé", () => {
  const g = ouvrir("https://mail.google.com/");
  ag({ type: "ajouterEssentiel", id: g });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(contexteHistorique(e, g)).toEqual({ espaceId: P, prive: false });
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(e.onglets[g]!.espaceId).toBe(P);
  expect(contexteHistorique(e, g)).toEqual({ espaceId: B, prive: false });
  // Retour dans Perso, qui l'affiche aussi : la visite y revient.
  ag({ type: "activerEspace", fenetreId: F, id: P });
  expect(contexteHistorique(e, g)).toEqual({ espaceId: P, prive: false });
  // Affiché dans un espace inconnu : privé, par prudence.
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

test("supprimerEspace ferme ses onglets et bascule les fenêtres", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = ouvrir("https://b.test/");
  ag({ type: "supprimerEspace", id: B });
  expect(e.espaces.map((x) => x.id)).toEqual([P]);
  expect(e.onglets[b]).toBeUndefined();
  expect(fen().espaceActif).toBe(P);
  expect(fen().ordre[B]).toBeUndefined();
});

test("supprimer le dernier espace est refusé", () => {
  const avant = e;
  ag({ type: "supprimerEspace", id: P });
  expect(e).toBe(avant);
});

test("ouvrirFenetre sur un espace donné ; fermerFenetre supprime ses onglets", () => {
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

test("fermer la dernière fenêtre ne change pas l'état", () => {
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

test("cadrerFenetre retient la taille et la position ; fenêtre inconnue → même référence", () => {
  expect(fen().cadre).toBeNull();
  ag({ type: "cadrerFenetre", id: F, cadre: { x: 10, y: 20, largeur: 800, hauteur: 600 } });
  expect(fen().cadre).toEqual({ x: 10, y: 20, largeur: 800, hauteur: 600 });
  const avant = e;
  expect(appliquer(e, { type: "cadrerFenetre", id: "inconnue", cadre: { x: 0, y: 0, largeur: 1, hauteur: 1 } }, genId)).toBe(avant);
});

test("majOnglet sans aucun changement → même référence (rien à rediffuser)", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "majOnglet", id: a, champs: { titre: "A", chargement: true } });
  const avant = e;
  expect(appliquer(e, { type: "majOnglet", id: a, champs: { titre: "A", chargement: true } }, genId)).toBe(avant);
});

test("majOnglet ne touche que les champs donnés ; id inconnu → même référence", () => {
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

test("appliquer ne mute jamais l'état d'entrée", () => {
  const a = ouvrir("https://a.test/");
  gelerProfond(e);
  expect(() => {
    ag({ type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" });
    ag({ type: "epinglerOnglet", id: a });
    ag({ type: "creerEspace", nom: "B", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
    ag({ type: "fermerOnglet", id: a });
  }).not.toThrow();
});

test("afficherPageVide : l'espace n'a plus d'onglet actif, ses onglets restent", () => {
  const a = ouvrir("https://a.fr");
  ag({ type: "afficherPageVide", fenetreId: F });
  expect(actif()).toBeNull();
  expect(ordre()).toEqual([a]);
});

test("fermerFenetre : ses onglets (tous espaces) vont dans les fermés récemment de la fenêtre restante, ⇧⌘T les rouvre", () => {
  ag({ type: "ouvrirFenetre", id: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://x.fr" });
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://y.fr" });
  ag({ type: "fermerFenetre", id: "F2" });
  expect(fen().fermesRecemment.map((x) => x.url)).toEqual(["https://y.fr", "https://x.fr"]);
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["https://y.fr"]);
});

test("choisirProfilAgent change le réglage (claude par défaut)", () => {
  expect(e.reglages.profilAgent).toBe("claude");
  ag({ type: "choisirProfilAgent", profil: "autre" });
  expect(e.reglages.profilAgent).toBe("autre");
});

test("panneauAgentAccueil : ouvre seulement sur la page d'accueil (sinon l'onglet serait donné à l'agent) ; ferme toujours", () => {
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

test("largeurPanneauAgent : 420 par défaut, retenue, bornée entre 280 et 1000", () => {
  expect(e.reglages.largeurPanneauAgent).toBe(420);
  ag({ type: "largeurPanneauAgent", largeur: 612.4 });
  expect(e.reglages.largeurPanneauAgent).toBe(612);
  ag({ type: "largeurPanneauAgent", largeur: 50 });
  expect(e.reglages.largeurPanneauAgent).toBe(280);
  ag({ type: "largeurPanneauAgent", largeur: 5000 });
  expect(e.reglages.largeurPanneauAgent).toBe(1000);
});

test("ouvrirApplications réutilise l'onglet existant de la fenêtre", () => {
  ouvrir("https://a.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_APPLICATIONS);
  expect(pages()).toHaveLength(1);
  const page = pages()[0]!;
  expect(page).toMatchObject({ titre: "Applications", espaceId: P });
  expect(actif()).toBe(page.id);
  // Déjà affichée : rien ne change.
  const avant = e;
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(e).toBe(avant);
  // Un autre onglet devant : on revient à la page au lieu d'en ouvrir une deuxième.
  ouvrir("https://b.test/");
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(page.id);
  // Depuis un autre espace : on revient à la page de la fenêtre, dans son espace.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  expect(fen().espaceActif).not.toBe(P);
  ag({ type: "ouvrirApplications", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page.id);
});

test("ouvrirExtensions ouvre ou active la page, comme ouvrirApplications", () => {
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

test("ouvrirWorkflow ouvre un onglet webaios://workflow/<id> titré, puis y revient au lieu d'en ouvrir un second", () => {
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
  // Depuis un autre espace : on revient à la page de la fenêtre, dans son espace.
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: F });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(pages()).toHaveLength(1);
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page.id);
  // Un autre widget : sa propre page.
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "actus", nom: "Actus" });
  expect(pages("actus")).toHaveLength(1);
  expect(pages()).toHaveLength(1);
  // Le widget renommé : on revient à la même page, et son titre suit.
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "meteo", nom: "Météo de Lyon" });
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ id: page.id, titre: "Workflow — Météo de Lyon" });
});

test("ouvrirAction ouvre un onglet webaios://action/<id> titré du nom, puis y revient au lieu d'en ouvrir un second", () => {
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
  // Une autre action : sa propre page.
  ag({ type: "ouvrirAction", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(Object.values(e.onglets).filter((o) => o.url === urlAction("meteo"))).toHaveLength(1);
});

test("ouvrirAction retrouve l'onglet de l'action dans un autre espace de la fenêtre ; avec execution, change son URL", () => {
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
  // L'onglet montre une exécution précise : il reste celui de l'action (même id), le nom suit.
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "Mes tickets" });
  expect(Object.keys(e.onglets)).toHaveLength(1);
  expect(e.onglets[page]).toMatchObject({ url: urlAction("gitlab", ex), titre: "Mes tickets" });
  // Exécution invalide : refusée par le schéma, jamais une URL.
  expect(SchemaAction.safeParse({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab", execution: "../etat" }).success).toBe(false);
  expect(SchemaAction.safeParse({ type: "ouvrirAction", fenetreId: F, id: "../x", nom: "GitLab" }).success).toBe(false);
});

test("ouvrirAction n'ouvre ni ne retrouve rien dans un espace privé", () => {
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  const page = Object.keys(e.onglets).at(-1)!;
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau", fenetreId: F });
  const banque = fen().espaceActif;
  // L'onglet de l'espace non privé est retrouvé ; la fenêtre y retourne.
  ag({ type: "ouvrirAction", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(fen().espaceActif).toBe(P);
  expect(actif()).toBe(page);
  // Aucun onglet ailleurs : rien n'est ouvert dans l'espace privé.
  ag({ type: "activerEspace", fenetreId: F, id: banque });
  const avant = e;
  ag({ type: "ouvrirAction", fenetreId: F, id: "meteo", nom: "Météo" });
  expect(e).toBe(avant);
});

test("ouvrirActions ouvre la page unique « Actions », puis y revient", () => {
  ag({ type: "ouvrirActions", fenetreId: F });
  const pages = () => Object.values(e.onglets).filter((o) => o.url === URL_ACTIONS);
  expect(pages()).toHaveLength(1);
  expect(pages()[0]).toMatchObject({ titre: "Actions" });
  ouvrir("https://b.test/");
  ag({ type: "ouvrirActions", fenetreId: F });
  expect(pages()).toHaveLength(1);
  expect(actif()).toBe(pages()[0]!.id);
});

test("ouvrirWorkflow d'une action ouvre webaios://workflow/action/<id>", () => {
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab", proprietaire: "action" });
  expect(Object.values(e.onglets)[0]).toMatchObject({ url: "webaios://workflow/action/gitlab", titre: "Workflow — GitLab" });
  ag({ type: "ouvrirWorkflow", fenetreId: F, id: "gitlab", nom: "GitLab" });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["webaios://workflow/action/gitlab", urlWorkflow("gitlab")]);
});

test("profilsEnUsage et profilsChanges : par identifiant, espaces compris", () => {
  const copie = structuredClone(e);
  expect(profilsChanges(e, copie)).toBe(false);
  copie.espaces[0]!.profil = "autre";
  expect(profilsEnUsage(copie)).toEqual(new Set(["defaut", "autre"]));
  expect(profilsChanges(e, copie)).toBe(true);
  ag({ type: "creerEspace", nom: "Banque", icone: "🏦", prive: true, profil: "nouveau" });
  const avant = e;
  ag({ type: "reglerEspace", id: P, nom: "Maison", icone: "🏡", prive: false, profil: "defaut" });
  expect(e.profils).not.toBe(avant.profils);
  expect(profilsChanges(avant, e)).toBe(false);
});

// Plan 17, tâche 11 : la page Relecture d'un projet.
test("ouvrirRelecture ouvre webaios://relecture/app-essai titré « Relecture — Essai » ; un second appel revient au même onglet", async () => {
  const { urlRelecture } = await import("../../src/commun/modele");
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

test("projetDeUrlRelecture refuse webaios://relecture/../x et webaios://relecture/app-", async () => {
  const { projetDeUrlRelecture } = await import("../../src/commun/modele");
  const { ID_PROJET } = await import("@webaios/noyau");
  expect(projetDeUrlRelecture("webaios://relecture/../x")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-essai/x")).toBeNull();
  expect(projetDeUrlRelecture("webaios://applications")).toBeNull();
  expect(projetDeUrlRelecture("webaios://relecture/app-essai")).toBe("app-essai");
  expect(projetDeUrlRelecture("webaios://relecture/ext-0123456789abcdef")).toBe("ext-0123456789abcdef");
  // Les copies de l'interface suivent le noyau.
  const { NON_AFFICHABLE } = await import("../../src/commun/modele");
  const { FICHIER_BINAIRE, FICHIER_TROP_GROS } = await import("@webaios/noyau");
  expect(NON_AFFICHABLE).toEqual({ binaire: FICHIER_BINAIRE, "trop-gros": FICHIER_TROP_GROS });
  const { LIGNE_CHANGEE_PAGE } = await import("../../src/commun/modele");
  const { LIGNE_CHANGEE } = await import("@webaios/noyau");
  expect(LIGNE_CHANGEE_PAGE).toBe(LIGNE_CHANGEE);
  for (const p of ["app-essai", "app-.x", "ext-0123456789abcdef", "ext-0123", "demo-15283", "demo-", "app-a/b", "site-tuning", "site-", "site-A", "site-../x"])
    expect(projetDeUrlRelecture(`webaios://relecture/${p}`) !== null).toBe(ID_PROJET.test(p));
});
