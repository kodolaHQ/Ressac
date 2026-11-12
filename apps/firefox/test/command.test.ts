import { expect, test } from "vitest";
import type { ActionShown } from "../shared/actions";
import type { ApplicationShown } from "../shared/api";
import type { Visit } from "../shared/model";
import type { ShownSite } from "../shared/sites";
import { projectSiteApp, siteSiteApp, paramRequest, commandLines, defaultParam, titleBefore, sectionOf, type SiteApp, type SourceTab, type CommandSources } from "../ui/components/command";

const action = (id: string, name: string): ActionShown => ({ id, name: name, description: "", keywords: [], input: null, account: [], public: [], grant: true, last: null });
const tab = (id: string, title: string, url = `https://${id}.fr/`): SourceTab => ({ id, title: title, url, favicon: null });
const visit = (url: string, title = url): Visit => ({ url, title: title, lastVisit: "2026-01-01T00:00:00Z", visits: 1, spaceId: "e", private: false, kept: false });
const app = (id: string, name: string): SiteApp => ({ kind: "site", id, name: name, action: "open", favicon: null });
const EMPTY: CommandSources = { actions: [], tabs: [], siteApps: [], history: [], bookmarks: [] };

test("empty text without sources: a single default line « Page d'accueil »", () => {
  expect(commandLines("", EMPTY, null)).toEqual([{ type: "default", text: "", label: "Page d'accueil" }]);
});

test("address: « Ouvrir exemple.fr » first; words: « Rechercher »", () => {
  expect(commandLines(" exemple.fr ", EMPTY, null)[0]).toEqual({ type: "default", text: "exemple.fr", label: "Ouvrir exemple.fr" });
  expect(commandLines("chat noir", EMPTY, null)[0]).toEqual({ type: "default", text: "chat noir", label: "Rechercher « chat noir »" });
});

test("group order: default, actions, tabs, apps, history", () => {
  const S: CommandSources = { actions: [action("a", "Chat action")], tabs: [tab("o", "chat")], siteApps: [app("p", "Chat appli")], history: [visit("https://h.fr/", "chat h")], bookmarks: [] };
  expect(commandLines("chat", S, null).map((l) => l.type)).toEqual(["default", "action", "tab", "app", "history"]);
});

test("limits: 3 tabs, 5 visits", () => {
  const S: CommandSources = { ...EMPTY, tabs: [1, 2, 3, 4, 5].map((i) => tab(`o${i}`, `chat ${i}`)), history: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => visit(`https://h${i}.fr/`, `chat ${i}`)) };
  const l = commandLines("chat", S, null);
  expect(l.filter((x) => x.type === "tab")).toHaveLength(3);
  expect(l.filter((x) => x.type === "history")).toHaveLength(5);
});

test("tab found by title or URL, ignoring accents and case", () => {
  const S: CommandSources = { ...EMPTY, tabs: [tab("a", "été 2026", "https://x.fr/"), tab("b", "autre", "https://zeta.fr/")] };
  expect(commandLines("ÉTÉ", S, null).filter((x) => x.type === "tab")).toHaveLength(1);
  expect(commandLines("ZETA", S, null).filter((x) => x.type === "tab")).toHaveLength(1);
});

test("history without a duplicate with a listed tab", () => {
  const S: CommandSources = { ...EMPTY, tabs: [tab("a", "chat", "https://c.fr/")], history: [visit("https://c.fr/", "chat"), visit("https://d.fr/", "chat d")] };
  const h = commandLines("chat", S, null).filter((x) => x.type === "history");
  expect(h).toEqual([{ type: "history", url: "https://d.fr/", title: "chat d" }]);
});

test("⌘L: text === urlActive → only the default line", () => {
  const S: CommandSources = { ...EMPTY, tabs: [tab("a", "x", "https://c.fr/")], history: [visit("https://c.fr/")] };
  expect(commandLines("https://c.fr/", S, "https://c.fr/")).toEqual([{ type: "default", text: "https://c.fr/", label: "Ouvrir https://c.fr/" }]);
});

test("history without the active URL", () => {
  const S: CommandSources = { ...EMPTY, history: [visit("https://c.fr/", "chat"), visit("https://d.fr/", "chat d")] };
  const h = commandLines("chat", S, "https://c.fr/").filter((x) => x.type === "history");
  expect(h.map((x) => (x as { url: string }).url)).toEqual(["https://d.fr/"]);
});

const project = (o: Partial<ApplicationShown>): ApplicationShown => ({ folder: "d", name: "N", type: "app", createdAt: "", state: "running", favicon: "f.png", ...o }) as ApplicationShown;

test("projectSiteApp", () => {
  expect(projectSiteApp(project({ type: "no-manifest" }))).toBeNull();
  expect(projectSiteApp(project({}))).toEqual({ kind: "project", id: "d", name: "N", action: "open", favicon: "f.png" });
  expect(projectSiteApp(project({ state: "stopped" }))?.action).toBe("launch");
});

test("siteSiteApp", () => {
  const s: ShownSite = { id: "s", name: "S", description: "", domain: null, icon: "i.png", open: false };
  expect(siteSiteApp(s)).toEqual({ kind: "site", id: "s", name: "S", action: "open", favicon: "i.png" });
});

const withEntry = (id: string, name: string, label: string): ActionShown => ({ ...action(id, name), input: { label: label } });

test("an action that expects an entry carries its label; typed with its entry, it no longer asks for one", () => {
  const S: CommandSources = { ...EMPTY, actions: [withEntry("r", "Résumé YouTube", "Vidéo"), action("t", "Résumé tickets")] };
  const l = commandLines("résumé", S, null).filter((x) => x.type === "action");
  expect(l).toEqual([
    { type: "action", id: "t", name: "Résumé tickets", input: null, param: null },
    { type: "action", id: "r", name: "Résumé YouTube", input: null, param: "Vidéo" },
  ]);
  expect(l.map(paramRequest)).toEqual([false, true]);
  const typed = commandLines("résumé youtube https://y.fr/v", S, null).find((x) => x.type === "action")!;
  expect(typed).toMatchObject({ id: "r", input: "https://y.fr/v", param: "Vidéo" });
  expect(paramRequest(typed)).toBe(false);
});

test("titles: one per section, on its first line; none for the default line", () => {
  const S: CommandSources = { actions: [action("a", "Chat action")], tabs: [tab("o", "chat"), tab("p", "chat 2")], siteApps: [], history: [visit("https://h.fr/", "chat h")], bookmarks: [] };
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
  const launched = (id: string, name: string, start: string): ActionShown => ({ ...action(id, name), last: { run: start, start: start, status: "succeeded" } as ActionShown["last"] });
  const S: CommandSources = {
    actions: [action("b", "Bravo"), launched("z", "Zulu", "2026-11-02T10:00:00Z"), action("a", "Alpha"), { ...action("x", "Cassée"), error: "invalide" }, withEntry("r", "Résumé", "Vidéo"), action("c", "Charlie")],
    tabs: [1, 2, 3, 4, 5, 6, 7].map((i) => tab(`o${i}`, `Onglet ${i}`)),
    siteApps: [app("p", "Appli")],
    history: [visit("https://h.fr/")],
    bookmarks: [],
  };
  const l = commandLines("", S, null, "o2");
  expect(l[0]).toEqual({ type: "default", text: "", label: "Page d'accueil" });
  expect(l.filter((x) => x.type === "action").map((x) => (x as { id: string }).id)).toEqual(["z", "a", "b", "c"]);
  expect(l.filter((x) => x.type === "tab").map((x) => (x as { tab: SourceTab }).tab.id)).toEqual(["o1", "o3", "o4", "o5", "o6"]);
  expect(l.some((x) => x.type === "app" || x.type === "history")).toBe(false);
  const r = commandLines("", { ...EMPTY, actions: [withEntry("r", "Résumé", "Vidéo")] }, null).find((x) => x.type === "action")!;
  expect(paramRequest(r)).toBe(true);
});

test("bookmarks: a section after history, capped, without a URL already in a tab or in history", () => {
  const S: CommandSources = {
    ...EMPTY,
    tabs: [tab("a", "chat", "https://c.fr/")],
    history: [visit("https://d.fr/", "chat d")],
    bookmarks: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ url: `https://b${i}.fr/`, title: `chat ${i}` })).concat([{ url: "https://c.fr/", title: "chat" }, { url: "https://d.fr/", title: "chat d" }]),
  };
  const l = commandLines("chat", S, null);
  expect(l.map((x) => x.type)).toEqual(["default", "tab", "history", ...Array(5).fill("bookmark")]);
  expect(sectionOf(l[3]!)).toBe("bookmarks");
  expect(titleBefore(l, 3)).toBe("Favoris");
  expect(commandLines("", { ...EMPTY, bookmarks: S.bookmarks }, null).map((x) => x.type)).toEqual(["default"]);
});
