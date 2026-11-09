import { expect, test } from "vitest";
import type { ActionAffichee } from "../shared/actions";
import type { ApplicationAffichee } from "../shared/api";
import type { Visite } from "../shared/modele";
import type { SiteAffiche } from "../shared/sites";
import { appliSourceDeProjet, appliSourceDeSite, demandeParametre, lignesCommande, parametreParDefaut, titreAvant, type AppliSource, type OngletSource, type SourcesCommande } from "../ui/composants/commande";

const action = (id: string, nom: string): ActionAffichee => ({ id, nom, description: "", motsCles: [], saisie: null, compte: [], publiques: [], accord: true, dernier: null });
const onglet = (id: string, titre: string, url = `https://${id}.fr/`): OngletSource => ({ id, titre, url, favicon: null });
const visite = (url: string, titre = url): Visite => ({ url, titre, derniereVisite: "2026-01-01T00:00:00Z", visites: 1, espaceId: "e", prive: false, retenu: false });
const appli = (id: string, nom: string): AppliSource => ({ genre: "site", id, nom, action: "ouvrir", favicon: null });
const VIDE: SourcesCommande = { actions: [], onglets: [], applis: [], historique: [] };

test("empty text without sources: a single default line « Page d'accueil »", () => {
  expect(lignesCommande("", VIDE, null)).toEqual([{ type: "defaut", texte: "", libelle: "Page d'accueil" }]);
});

test("adresse : « Ouvrir exemple.fr » en premier ; mots : « Rechercher »", () => {
  expect(lignesCommande(" exemple.fr ", VIDE, null)[0]).toEqual({ type: "defaut", texte: "exemple.fr", libelle: "Ouvrir exemple.fr" });
  expect(lignesCommande("chat noir", VIDE, null)[0]).toEqual({ type: "defaut", texte: "chat noir", libelle: "Rechercher « chat noir »" });
});

test("group order: default, actions, tabs, apps, history", () => {
  const S: SourcesCommande = { actions: [action("a", "Chat action")], onglets: [onglet("o", "chat")], applis: [appli("p", "Chat appli")], historique: [visite("https://h.fr/", "chat h")] };
  expect(lignesCommande("chat", S, null).map((l) => l.type)).toEqual(["defaut", "action", "onglet", "appli", "historique"]);
});

test("limites : 3 onglets, 5 visites", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [1, 2, 3, 4, 5].map((i) => onglet(`o${i}`, `chat ${i}`)), historique: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => visite(`https://h${i}.fr/`, `chat ${i}`)) };
  const l = lignesCommande("chat", S, null);
  expect(l.filter((x) => x.type === "onglet")).toHaveLength(3);
  expect(l.filter((x) => x.type === "historique")).toHaveLength(5);
});

test("tab found by title or URL, ignoring accents and case", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "été 2026", "https://x.fr/"), onglet("b", "autre", "https://zeta.fr/")] };
  expect(lignesCommande("ÉTÉ", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
  expect(lignesCommande("ZETA", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
});

test("history without a duplicate with a listed tab", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "chat", "https://c.fr/")], historique: [visite("https://c.fr/", "chat"), visite("https://d.fr/", "chat d")] };
  const h = lignesCommande("chat", S, null).filter((x) => x.type === "historique");
  expect(h).toEqual([{ type: "historique", url: "https://d.fr/", titre: "chat d" }]);
});

test("⌘L: text === urlActive → only the default line", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "x", "https://c.fr/")], historique: [visite("https://c.fr/")] };
  expect(lignesCommande("https://c.fr/", S, "https://c.fr/")).toEqual([{ type: "defaut", texte: "https://c.fr/", libelle: "Ouvrir https://c.fr/" }]);
});

test("history without the active URL", () => {
  const S: SourcesCommande = { ...VIDE, historique: [visite("https://c.fr/", "chat"), visite("https://d.fr/", "chat d")] };
  const h = lignesCommande("chat", S, "https://c.fr/").filter((x) => x.type === "historique");
  expect(h.map((x) => (x as { url: string }).url)).toEqual(["https://d.fr/"]);
});

const projet = (o: Partial<ApplicationAffichee>): ApplicationAffichee => ({ dossier: "d", nom: "N", type: "application", creeLe: "", etat: "en-marche", favicon: "f.png", ...o }) as ApplicationAffichee;

test("appliSourceDeProjet", () => {
  expect(appliSourceDeProjet(projet({ type: "sans-fiche" }))).toBeNull();
  expect(appliSourceDeProjet(projet({}))).toEqual({ genre: "projet", id: "d", nom: "N", action: "ouvrir", favicon: "f.png" });
  expect(appliSourceDeProjet(projet({ etat: "arretee" }))?.action).toBe("lancer");
});

test("appliSourceDeSite", () => {
  const s: SiteAffiche = { id: "s", nom: "S", description: "", domaine: null, icone: "i.png", ouverte: false };
  expect(appliSourceDeSite(s)).toEqual({ genre: "site", id: "s", nom: "S", action: "ouvrir", favicon: "i.png" });
});

const avecSaisie = (id: string, nom: string, libelle: string): ActionAffichee => ({ ...action(id, nom), saisie: { libelle } });

test("an action that expects an entry carries its label; typed with its entry, it no longer asks for one", () => {
  const S: SourcesCommande = { ...VIDE, actions: [avecSaisie("r", "Résumé YouTube", "Vidéo"), action("t", "Résumé tickets")] };
  const l = lignesCommande("résumé", S, null).filter((x) => x.type === "action");
  expect(l).toEqual([
    { type: "action", id: "t", nom: "Résumé tickets", saisie: null, parametre: null },
    { type: "action", id: "r", nom: "Résumé YouTube", saisie: null, parametre: "Vidéo" },
  ]);
  expect(l.map(demandeParametre)).toEqual([false, true]);
  const tapee = lignesCommande("résumé youtube https://y.fr/v", S, null).find((x) => x.type === "action")!;
  expect(tapee).toMatchObject({ id: "r", saisie: "https://y.fr/v", parametre: "Vidéo" });
  expect(demandeParametre(tapee)).toBe(false);
});

test("titles: one per section, on its first line; none for the default line", () => {
  const S: SourcesCommande = { actions: [action("a", "Chat action")], onglets: [onglet("o", "chat"), onglet("p", "chat 2")], applis: [], historique: [visite("https://h.fr/", "chat h")] };
  const l = lignesCommande("chat", S, null);
  expect(l.map((_, i) => titreAvant(l, i))).toEqual([null, "Actions", "Onglets ouverts", null, "Historique"]);
});

test("default parameter: the web address displayed without an anchor, nothing for an internal or too long page", () => {
  expect(parametreParDefaut("https://www.youtube.com/watch?v=abc#t=3")).toBe("https://www.youtube.com/watch?v=abc");
  expect(parametreParDefaut("http://exemple.fr/")).toBe("http://exemple.fr/");
  expect(parametreParDefaut("https://moi:secret@exemple.fr/p")).toBe("https://exemple.fr/p");
  expect(parametreParDefaut("webaios://historique")).toBe("");
  expect(parametreParDefaut("about:blank")).toBe("");
  expect(parametreParDefaut(undefined)).toBe("");
  expect(parametreParDefaut(`https://x.fr/?q=${"a".repeat(2000)}`)).toBe("");
});

test("empty field: the home first, then the actions (last launched first) and the open tabs without the displayed tab", () => {
  const lancee = (id: string, nom: string, debut: string): ActionAffichee => ({ ...action(id, nom), dernier: { execution: debut, debut, statut: "reussie" } as ActionAffichee["dernier"] });
  const S: SourcesCommande = {
    actions: [action("b", "Bravo"), lancee("z", "Zulu", "2026-11-02T10:00:00Z"), action("a", "Alpha"), { ...action("x", "Cassée"), erreur: "invalide" }, avecSaisie("r", "Résumé", "Vidéo"), action("c", "Charlie")],
    onglets: [1, 2, 3, 4, 5, 6, 7].map((i) => onglet(`o${i}`, `Onglet ${i}`)),
    applis: [appli("p", "Appli")],
    historique: [visite("https://h.fr/")],
  };
  const l = lignesCommande("", S, null, "o2");
  expect(l[0]).toEqual({ type: "defaut", texte: "", libelle: "Page d'accueil" });
  expect(l.filter((x) => x.type === "action").map((x) => (x as { id: string }).id)).toEqual(["z", "a", "b", "c"]);
  expect(l.filter((x) => x.type === "onglet").map((x) => (x as { onglet: OngletSource }).onglet.id)).toEqual(["o1", "o3", "o4", "o5", "o6"]);
  expect(l.some((x) => x.type === "appli" || x.type === "historique")).toBe(false);
  const r = lignesCommande("", { ...VIDE, actions: [avecSaisie("r", "Résumé", "Vidéo")] }, null).find((x) => x.type === "action")!;
  expect(demandeParametre(r)).toBe(true);
});
