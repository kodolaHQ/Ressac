import { expect, test } from "vitest";
import type { ActionAffichee } from "../src/commun/actions";
import type { ApplicationAffichee } from "../src/commun/api";
import type { Visite } from "../src/commun/modele";
import type { SiteAffiche } from "../src/commun/sites";
import { appliSourceDeProjet, appliSourceDeSite, lignesCommande, type AppliSource, type OngletSource, type SourcesCommande } from "../src/renderer/composants/commande";

const action = (id: string, nom: string): ActionAffichee => ({ id, nom, description: "", motsCles: [], saisie: null, compte: [], publiques: [], accord: true, dernier: null });
const onglet = (id: string, titre: string, url = `https://${id}.fr/`): OngletSource => ({ id, titre, url, favicon: null });
const visite = (url: string, titre = url): Visite => ({ url, titre, derniereVisite: "2026-01-01T00:00:00Z", visites: 1, espaceId: "e", prive: false, retenu: false });
const appli = (id: string, nom: string): AppliSource => ({ genre: "site", id, nom, action: "ouvrir", favicon: null });
const VIDE: SourcesCommande = { actions: [], onglets: [], applis: [], historique: [] };

test("texte vide : une seule ligne défaut « Page d'accueil »", () => {
  expect(lignesCommande("", VIDE, null)).toEqual([{ type: "defaut", texte: "", libelle: "Page d'accueil" }]);
});

test("adresse : « Ouvrir exemple.fr » en premier ; mots : « Rechercher »", () => {
  expect(lignesCommande(" exemple.fr ", VIDE, null)[0]).toEqual({ type: "defaut", texte: "exemple.fr", libelle: "Ouvrir exemple.fr" });
  expect(lignesCommande("chat noir", VIDE, null)[0]).toEqual({ type: "defaut", texte: "chat noir", libelle: "Rechercher « chat noir »" });
});

test("ordre des groupes : défaut, actions, onglets, applis, historique", () => {
  const S: SourcesCommande = { actions: [action("a", "Chat action")], onglets: [onglet("o", "chat")], applis: [appli("p", "Chat appli")], historique: [visite("https://h.fr/", "chat h")] };
  expect(lignesCommande("chat", S, null).map((l) => l.type)).toEqual(["defaut", "action", "onglet", "appli", "historique"]);
});

test("limites : 3 onglets, 5 visites", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [1, 2, 3, 4, 5].map((i) => onglet(`o${i}`, `chat ${i}`)), historique: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => visite(`https://h${i}.fr/`, `chat ${i}`)) };
  const l = lignesCommande("chat", S, null);
  expect(l.filter((x) => x.type === "onglet")).toHaveLength(3);
  expect(l.filter((x) => x.type === "historique")).toHaveLength(5);
});

test("onglet trouvé par titre ou URL, sans accents ni casse", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "été 2026", "https://x.fr/"), onglet("b", "autre", "https://zeta.fr/")] };
  expect(lignesCommande("ÉTÉ", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
  expect(lignesCommande("ZETA", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
});

test("historique sans doublon avec un onglet listé", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "chat", "https://c.fr/")], historique: [visite("https://c.fr/", "chat"), visite("https://d.fr/", "chat d")] };
  const h = lignesCommande("chat", S, null).filter((x) => x.type === "historique");
  expect(h).toEqual([{ type: "historique", url: "https://d.fr/", titre: "chat d" }]);
});

test("⌘L : texte === urlActive → seule la ligne défaut", () => {
  const S: SourcesCommande = { ...VIDE, onglets: [onglet("a", "x", "https://c.fr/")], historique: [visite("https://c.fr/")] };
  expect(lignesCommande("https://c.fr/", S, "https://c.fr/")).toEqual([{ type: "defaut", texte: "https://c.fr/", libelle: "Ouvrir https://c.fr/" }]);
});

test("historique sans l'URL active", () => {
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
