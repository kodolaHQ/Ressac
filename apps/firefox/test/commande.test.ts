import { expect, test } from "vitest";
import type { ActionShown } from "../shared/actions";
import type { ApplicationShown } from "../shared/api";
import type { Visite } from "../shared/modele";
import type { ShownSite } from "../shared/sites";
import { projectSiteApp, siteSiteApp, paramRequest, commandLines, defaultParam, titleBefore, type SiteApp, type SourceTab, type CommandSources } from "../ui/composants/commande";

const action = (id: string, name: string): ActionShown => ({ id, nom: name, description: "", motsCles: [], saisie: null, compte: [], publiques: [], accord: true, dernier: null });
const tab = (id: string, titre: string, url = `https://${id}.fr/`): SourceTab => ({ id, titre, url, favicon: null });
const visite = (url: string, titre = url): Visite => ({ url, titre, derniereVisite: "2026-01-01T00:00:00Z", visites: 1, espaceId: "e", prive: false, retenu: false });
const app = (id: string, name: string): SiteApp => ({ genre: "site", id, nom: name, action: "ouvrir", favicon: null });
const EMPTY: CommandSources = { actions: [], onglets: [], applis: [], historique: [] };

test("empty text without sources: a single default line « Page d'accueil »", () => {
  expect(commandLines("", EMPTY, null)).toEqual([{ type: "defaut", texte: "", libelle: "Page d'accueil" }]);
});

test("address: « Ouvrir exemple.fr » first; words: « Rechercher »", () => {
  expect(commandLines(" exemple.fr ", EMPTY, null)[0]).toEqual({ type: "defaut", texte: "exemple.fr", libelle: "Ouvrir exemple.fr" });
  expect(commandLines("chat noir", EMPTY, null)[0]).toEqual({ type: "defaut", texte: "chat noir", libelle: "Rechercher « chat noir »" });
});

test("group order: default, actions, tabs, apps, history", () => {
  const S: CommandSources = { actions: [action("a", "Chat action")], onglets: [tab("o", "chat")], applis: [app("p", "Chat appli")], historique: [visite("https://h.fr/", "chat h")] };
  expect(commandLines("chat", S, null).map((l) => l.type)).toEqual(["defaut", "action", "onglet", "appli", "historique"]);
});

test("limits: 3 tabs, 5 visits", () => {
  const S: CommandSources = { ...EMPTY, onglets: [1, 2, 3, 4, 5].map((i) => tab(`o${i}`, `chat ${i}`)), historique: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => visite(`https://h${i}.fr/`, `chat ${i}`)) };
  const l = commandLines("chat", S, null);
  expect(l.filter((x) => x.type === "onglet")).toHaveLength(3);
  expect(l.filter((x) => x.type === "historique")).toHaveLength(5);
});

test("tab found by title or URL, ignoring accents and case", () => {
  const S: CommandSources = { ...EMPTY, onglets: [tab("a", "été 2026", "https://x.fr/"), tab("b", "autre", "https://zeta.fr/")] };
  expect(commandLines("ÉTÉ", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
  expect(commandLines("ZETA", S, null).filter((x) => x.type === "onglet")).toHaveLength(1);
});

test("history without a duplicate with a listed tab", () => {
  const S: CommandSources = { ...EMPTY, onglets: [tab("a", "chat", "https://c.fr/")], historique: [visite("https://c.fr/", "chat"), visite("https://d.fr/", "chat d")] };
  const h = commandLines("chat", S, null).filter((x) => x.type === "historique");
  expect(h).toEqual([{ type: "historique", url: "https://d.fr/", titre: "chat d" }]);
});

test("⌘L: text === urlActive → only the default line", () => {
  const S: CommandSources = { ...EMPTY, onglets: [tab("a", "x", "https://c.fr/")], historique: [visite("https://c.fr/")] };
  expect(commandLines("https://c.fr/", S, "https://c.fr/")).toEqual([{ type: "defaut", texte: "https://c.fr/", libelle: "Ouvrir https://c.fr/" }]);
});

test("history without the active URL", () => {
  const S: CommandSources = { ...EMPTY, historique: [visite("https://c.fr/", "chat"), visite("https://d.fr/", "chat d")] };
  const h = commandLines("chat", S, "https://c.fr/").filter((x) => x.type === "historique");
  expect(h.map((x) => (x as { url: string }).url)).toEqual(["https://d.fr/"]);
});

const project = (o: Partial<ApplicationShown>): ApplicationShown => ({ dossier: "d", nom: "N", type: "application", creeLe: "", etat: "en-marche", favicon: "f.png", ...o }) as ApplicationShown;

test("appliSourceDeProjet", () => {
  expect(projectSiteApp(project({ type: "sans-fiche" }))).toBeNull();
  expect(projectSiteApp(project({}))).toEqual({ genre: "projet", id: "d", nom: "N", action: "ouvrir", favicon: "f.png" });
  expect(projectSiteApp(project({ etat: "arretee" }))?.action).toBe("lancer");
});

test("appliSourceDeSite", () => {
  const s: ShownSite = { id: "s", nom: "S", description: "", domaine: null, icone: "i.png", ouverte: false };
  expect(siteSiteApp(s)).toEqual({ genre: "site", id: "s", nom: "S", action: "ouvrir", favicon: "i.png" });
});

const withEntry = (id: string, name: string, label: string): ActionShown => ({ ...action(id, name), saisie: { libelle: label } });

test("an action that expects an entry carries its label; typed with its entry, it no longer asks for one", () => {
  const S: CommandSources = { ...EMPTY, actions: [withEntry("r", "Résumé YouTube", "Vidéo"), action("t", "Résumé tickets")] };
  const l = commandLines("résumé", S, null).filter((x) => x.type === "action");
  expect(l).toEqual([
    { type: "action", id: "t", nom: "Résumé tickets", saisie: null, parametre: null },
    { type: "action", id: "r", nom: "Résumé YouTube", saisie: null, parametre: "Vidéo" },
  ]);
  expect(l.map(paramRequest)).toEqual([false, true]);
  const typed = commandLines("résumé youtube https://y.fr/v", S, null).find((x) => x.type === "action")!;
  expect(typed).toMatchObject({ id: "r", saisie: "https://y.fr/v", parametre: "Vidéo" });
  expect(paramRequest(typed)).toBe(false);
});

test("titles: one per section, on its first line; none for the default line", () => {
  const S: CommandSources = { actions: [action("a", "Chat action")], onglets: [tab("o", "chat"), tab("p", "chat 2")], applis: [], historique: [visite("https://h.fr/", "chat h")] };
  const l = commandLines("chat", S, null);
  expect(l.map((_, i) => titleBefore(l, i))).toEqual([null, "Actions", "Onglets ouverts", null, "Historique"]);
});

test("default parameter: the web address displayed without an anchor, nothing for an internal or too long page", () => {
  expect(defaultParam("https://www.youtube.com/watch?v=abc#t=3")).toBe("https://www.youtube.com/watch?v=abc");
  expect(defaultParam("http://exemple.fr/")).toBe("http://exemple.fr/");
  expect(defaultParam("https://moi:secret@exemple.fr/p")).toBe("https://exemple.fr/p");
  expect(defaultParam("webaios://historique")).toBe("");
  expect(defaultParam("about:blank")).toBe("");
  expect(defaultParam(undefined)).toBe("");
  expect(defaultParam(`https://x.fr/?q=${"a".repeat(2000)}`)).toBe("");
});

test("empty field: the home first, then the actions (last launched first) and the open tabs without the displayed tab", () => {
  const launched = (id: string, name: string, debut: string): ActionShown => ({ ...action(id, name), dernier: { execution: debut, debut, statut: "reussie" } as ActionShown["dernier"] });
  const S: CommandSources = {
    actions: [action("b", "Bravo"), launched("z", "Zulu", "2026-11-02T10:00:00Z"), action("a", "Alpha"), { ...action("x", "Cassée"), erreur: "invalide" }, withEntry("r", "Résumé", "Vidéo"), action("c", "Charlie")],
    onglets: [1, 2, 3, 4, 5, 6, 7].map((i) => tab(`o${i}`, `Onglet ${i}`)),
    applis: [app("p", "Appli")],
    historique: [visite("https://h.fr/")],
  };
  const l = commandLines("", S, null, "o2");
  expect(l[0]).toEqual({ type: "defaut", texte: "", libelle: "Page d'accueil" });
  expect(l.filter((x) => x.type === "action").map((x) => (x as { id: string }).id)).toEqual(["z", "a", "b", "c"]);
  expect(l.filter((x) => x.type === "onglet").map((x) => (x as { onglet: SourceTab }).onglet.id)).toEqual(["o1", "o3", "o4", "o5", "o6"]);
  expect(l.some((x) => x.type === "appli" || x.type === "historique")).toBe(false);
  const r = commandLines("", { ...EMPTY, actions: [withEntry("r", "Résumé", "Vidéo")] }, null).find((x) => x.type === "action")!;
  expect(paramRequest(r)).toBe(true);
});
