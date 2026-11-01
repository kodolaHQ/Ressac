import { beforeEach, expect, test, vi } from "vitest";
import { CLE_INVALIDE, DeclarationSite, MemoireSite, VALEUR_NON_JSON, type RetouchesLues } from "@webaios/noyau";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectionCadre } from "../../src/commun/sites";
import type { SiteOuvrable } from "../../src/main/sites/fenetres";

type Gestionnaire = (e: unknown, ...a: unknown[]) => unknown;
const on = new Map<string, Gestionnaire>();
const handle = new Map<string, Gestionnaire>();
vi.mock("electron", () => ({
  ipcMain: {
    on: (canal: string, g: Gestionnaire) => void on.set(canal, g),
    handle: (canal: string, g: Gestionnaire) => void handle.set(canal, g),
  },
}));

const { brancherInjection, injectionPour } = await import("../../src/main/sites/injection");

const GARDE = "/* garde */";
const declaration = DeclarationSite.parse({
  nom: "Vidola",
  adresse: "https://vidola-b.example/",
  domaines: ["vidola-a.example"],
  connexion: ["compte.example"],
  retouches: [
    { correspond: ["/series/*"], js: ["a.js"], css: ["a.css"] },
    { correspond: ["/rien"], js: ["lecteur.js"], cadres: ["https://*.lecteur.example/*"] },
  ],
  reprise: true,
});
const site: SiteOuvrable = {
  id: "vidola",
  declaration,
  aAccueil: false,
  // vidola-a : l'ancien domaine ; vidola-b : l'actuel (adresse.json du profil).
  domaines: ["vidola-a.example", "vidola-b.example"],
  depart: "https://vidola-b.example/",
  accordRequis: false,
};
const retouches: RetouchesLues = { js: { "a.js": "window.a = 1", "lecteur.js": "window.l = 1" }, css: { "a.css": ".shorts{display:none}" } };
const avec = (accorde = true) => ({ site, retouches, accorde, garde: GARDE });

test("sans accord : null", () => {
  expect(injectionPour(avec(false), { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(avec(false), { url: "https://www.lecteur.example/v", principal: false })).toBeNull();
});

test("cadre principal sur /series/x : js et css de la retouche, pont vrai, hotes des domaines effectifs", () => {
  const i = injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: true });
  expect(i).toEqual({
    css: [".shorts{display:none}"],
    js: [{ code: "window.a = 1", nom: "webaios-retouche://vidola/a.js" }],
    garde: GARDE,
    hotes: ["https://*.vidola-a.example/*", "https://vidola-a.example/*", "https://*.vidola-b.example/*", "https://vidola-b.example/*"],
    pont: true,
    reprise: true,
  } satisfies InjectionCadre);
});

test("cadre principal sur l'ancien domaine : mêmes retouches", () => {
  const actuel = injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: true });
  const ancien = injectionPour(avec(), { url: "https://www.vidola-a.example/series/x", principal: true });
  expect(ancien).toEqual(actuel);
});

test("cadre principal sur une page sans retouche : ni garde ni script, le pont reste", () => {
  const i = injectionPour(avec(), { url: "https://vidola-b.example/films", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
  expect(i.garde).toBeNull();
  expect(i.reprise).toBe(true);
});

test("sous-cadre lecteur.localhost sans motif cadres : seulement la reprise", () => {
  const i = injectionPour(avec(), { url: "https://lecteur.localhost/v", principal: false });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: true });
  const sansReprise = injectionPour({ ...avec(), site: { ...site, declaration: { ...declaration, reprise: false } } }, { url: "https://lecteur.localhost/v", principal: false });
  expect(sansReprise?.reprise).toBe(false);
});

test("sous-cadre qui correspond à cadres : js, pont faux", () => {
  const i = injectionPour(avec(), { url: "https://www.lecteur.example/v/1", principal: false })!;
  expect(i.js).toEqual([{ code: "window.l = 1", nom: "webaios-retouche://vidola/lecteur.js" }]);
  expect(i.garde).toBe(GARDE);
  expect(i.pont).toBe(false);
  expect(i.hotes).toEqual(["https://www.lecteur.example/*"]);
  // Le motif de la page principale ne vaut jamais pour un sous-cadre (même sur le site).
  expect(injectionPour(avec(), { url: "https://vidola-b.example/series/x", principal: false })?.js).toEqual([]);
});

test("tests seulement : un sous-cadre http local correspond aux motifs https (le serveur de test n'a pas de TLS)", () => {
  const motif = { ...declaration, retouches: [{ correspond: ["/rien"], js: ["lecteur.js"], css: [], cadres: ["https://lecteur.localhost:8080/*"] }] };
  const o = { ...avec(), site: { ...site, declaration: motif } };
  const cadre = { url: "http://lecteur.localhost:8080/v", principal: false };
  expect(injectionPour({ ...o, adressesLocales: true }, cadre)?.js).toHaveLength(1);
  expect(injectionPour(o, cadre)?.js ?? []).toEqual([]);
});

test("page hors site (connexion) : aucune retouche", () => {
  const i = injectionPour(avec(), { url: "https://compte.example/series/x", principal: true });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
  for (const url of ["about:blank", "javascript:alert(1)", "https://pub.example/series/x", ""]) {
    expect(injectionPour(avec(), { url, principal: true })?.js ?? []).toEqual([]);
    expect(injectionPour(avec(), { url, principal: true })?.pont ?? false).toBe(false);
  }
});

test("un fichier cité mais absent du cache n'est pas injecté", () => {
  const i = injectionPour({ ...avec(), retouches: { js: {}, css: {} } }, { url: "https://vidola-b.example/series/x", principal: true })!;
  expect(i.js).toEqual([]);
  expect(i.css).toEqual([]);
});

// --- IPC : décidé par l'expéditeur, jamais par ce que dit le cadre.

type FauxCadre = { url: string; parent: FauxCadre | null };
const session = { nom: "persist:site-vidola" };
const vue = { session };
const principal: FauxCadre = { url: "https://vidola-b.example/series/x", parent: null };
const sous: FauxCadre = { url: "https://www.lecteur.example/v", parent: principal };
const evenement = (sender: unknown, senderFrame: FauxCadre | null) => ({ sender, senderFrame, returnValue: undefined as unknown });

let memoire: MemoireSite;
let demandes: { id: string; cadre: { url: string; principal: boolean } }[];
beforeEach(async () => {
  on.clear();
  handle.clear();
  demandes = [];
  memoire = await MemoireSite.ouvrir(mkdtempSync(join(tmpdir(), "injection-")), "vidola");
  brancherInjection({
    siteDeSession: (s) => ((s as unknown) === session ? "vidola" : undefined),
    vue: (id) => (id === "vidola" ? (vue as never) : undefined),
    injection: (id, cadre) => {
      demandes.push({ id, cadre });
      return injectionPour(avec(), cadre);
    },
    memoire: async () => memoire,
    adresseRelative: (_id, url) => {
      const u = new URL(url);
      return u.hostname.endsWith("vidola-b.example") ? u.pathname + u.search : null;
    },
  });
});

const injection = (e: ReturnType<typeof evenement>) => {
  on.get("webaios:site-injection")!(e);
  return e.returnValue;
};

test("injection : le cadre principal de la vue reçoit ses retouches, calculées depuis senderFrame", () => {
  const e = evenement(vue, principal);
  const i = injection(e) as InjectionCadre;
  expect(i.pont).toBe(true);
  expect(demandes).toEqual([{ id: "vidola", cadre: { url: principal.url, principal: true } }]);
  expect((injection(evenement(vue, sous)) as InjectionCadre).pont).toBe(false);
  expect(demandes[1]).toEqual({ id: "vidola", cadre: { url: sous.url, principal: false } });
});

test("injection : la petite fenêtre de connexion (même session, autre webContents) ne reçoit rien", () => {
  const petite = { session };
  expect(injection(evenement(petite, { url: "https://vidola-b.example/series/x", parent: null }))).toBeNull();
  expect(injection(evenement(petite, sous))).toBeNull();
  expect(demandes).toEqual([]);
});

test("injection : un expéditeur hors d'une session de site, ou sans cadre, ne reçoit rien", () => {
  expect(injection(evenement({ session: { nom: "persist:webaios" } }, principal))).toBeNull();
  expect(injection(evenement(vue, null))).toBeNull();
  expect(demandes).toEqual([]);
});

const memoireIpc = (sender: unknown, cadre: FauxCadre | null, demande: unknown) => handle.get("webaios:site-memoire")!(evenement(sender, cadre), demande);

test("mémoire : retenir reçoit l'adresse relative de la page principale ; lire, oublier", async () => {
  expect(await memoireIpc(vue, { url: "https://vidola-b.example/serie/the-bear?e=4", parent: null }, { op: "retenir", cle: "encours.the-bear", valeur: { titre: "The Bear" } })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" });
  expect(await memoireIpc(vue, principal, { op: "lire", cle: "encours.the-bear" })).toEqual({ ok: true, valeur: { titre: "The Bear" } });
  expect(await memoireIpc(vue, principal, { op: "lire", cle: "absente" })).toEqual({ ok: true, valeur: null });
  expect(await memoireIpc(vue, principal, { op: "oublier", cle: "encours.the-bear" })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("mémoire : refus nommés de la mémoire (clé, valeur non JSON)", async () => {
  expect(await memoireIpc(vue, principal, { op: "retenir", cle: "", valeur: 1 })).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(await memoireIpc(vue, principal, { op: "retenir", cle: "x", valeur: undefined })).toEqual({ ok: false, erreur: VALEUR_NON_JSON });
});

test("mémoire : refusée à un sous-cadre, à la petite fenêtre, hors session, et à une page hors du site", async () => {
  const refus = { ok: false, erreur: expect.any(String) };
  const demande = { op: "retenir", cle: "x", valeur: 1 };
  expect(await memoireIpc(vue, sous, demande)).toEqual(refus);
  expect(await memoireIpc({ session }, principal, demande)).toEqual(refus);
  expect(await memoireIpc({ session: {} }, principal, demande)).toEqual(refus);
  expect(await memoireIpc(vue, null, demande)).toEqual(refus);
  expect(await memoireIpc(vue, { url: "https://compte.example/", parent: null }, demande)).toEqual(refus);
  for (const d of [null, "x", { op: "effacer", cle: "x" }, { op: "lire", cle: 3 }]) expect(await memoireIpc(vue, principal, d)).toEqual(refus);
  expect(memoire.contenu().valeurs).toEqual({});
});
