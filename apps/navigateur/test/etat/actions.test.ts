import { beforeEach, expect, test } from "vitest";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import type { Action } from "../../src/commun/api";
import type { EtatNavigateur } from "../../src/commun/modele";

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
  expect(e.espaces).toEqual([{ id: P, nom: "Perso", icone: "🏠", epingles: [] }]);
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
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", fenetreId: F });
  const B = e.espaces[1]!.id;
  expect(fen().espaceActif).toBe(B);
  ag({ type: "ouvrirFavori", fenetreId: F, genre: "essentiel", id: e.essentiels[0]!.id });
  expect(e.onglets[actif(B)!]).toMatchObject({ espaceId: B, url: "https://mail.google.com/" });
  ag({ type: "retirerEssentiel", favoriId: e.essentiels[0]!.id });
  expect(e.essentiels).toEqual([]);
});

test("activerEspace garde l'onglet actif propre à chaque espace", () => {
  const a = ouvrir("https://a.test/");
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼" });
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
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", fenetreId: F });
  const B = e.espaces[1]!.id;
  const b = ouvrir("https://b.test/");
  ag({ type: "activerEspace", fenetreId: F, id: P });
  ag({ type: "activerOnglet", id: b });
  expect(fen().espaceActif).toBe(B);
});

test("renommerEspace", () => {
  ag({ type: "renommerEspace", id: P, nom: "Maison", icone: "🏡" });
  expect(e.espaces[0]).toMatchObject({ nom: "Maison", icone: "🏡" });
});

test("supprimerEspace ferme ses onglets et bascule les fenêtres", () => {
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", fenetreId: F });
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
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼" });
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
    ag({ type: "creerEspace", nom: "B", icone: "💼", fenetreId: F });
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
  ag({ type: "creerEspace", nom: "Boulot", icone: "💼", fenetreId: "F2" });
  ag({ type: "ouvrirOnglet", fenetreId: "F2", url: "https://y.fr" });
  ag({ type: "fermerFenetre", id: "F2" });
  expect(fen().fermesRecemment.map((x) => x.url)).toEqual(["https://y.fr", "https://x.fr"]);
  ag({ type: "rouvrirOngletFerme", fenetreId: F });
  expect(Object.values(e.onglets).map((o) => o.url)).toEqual(["https://y.fr"]);
});
