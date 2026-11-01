import { beforeEach, expect, test, vi } from "vitest";
import { accordCouvre, accordNecessaire, CLE_INVALIDE, DeclarationSite, MemoireSite, VALEUR_NON_JSON, type RetouchesLues } from "@webaios/noyau";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLE_RETOUCHES_TOTAL, type InjectionCadre } from "../../src/commun/sites";
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

const { ajouterConsoleRetouche, brancherInjection, injectionPour } = await import("../../src/main/sites/injection");

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
const principal: FauxCadre = { url: "https://vidola-b.example/series/x", parent: null };
/** La vue du site : son cadre principal est celui qu'Electron donne (`mainFrame`), changé par les tests qui naviguent. */
const vue: { session: typeof session; mainFrame: FauxCadre } = { session, mainFrame: principal };
/** La vue navigue vers `url` : son nouveau cadre principal. */
const naviguer = (url: string): FauxCadre => (vue.mainFrame = { url, parent: null });
const sous: FauxCadre = { url: "https://www.lecteur.example/v", parent: principal };
const evenement = (sender: unknown, senderFrame: FauxCadre | null) => ({ sender, senderFrame, returnValue: undefined as unknown });

let memoire: MemoireSite;
let accorde: boolean;
let reprise: boolean;
let demandes: { id: string; cadre: { url: string; principal: boolean } }[];
beforeEach(async () => {
  on.clear();
  handle.clear();
  demandes = [];
  accorde = true;
  reprise = true;
  vue.mainFrame = principal;
  memoire = await MemoireSite.ouvrir(mkdtempSync(join(tmpdir(), "injection-")), "vidola");
  brancherInjection({
    siteDeSession: (s) => ((s as unknown) === session ? "vidola" : undefined),
    vue: (id) => (id === "vidola" ? (vue as never) : undefined),
    injection: (id, cadre) => {
      demandes.push({ id, cadre });
      return injectionPour(avec(), cadre);
    },
    accorde: () => accorde,
    reprise: () => reprise,
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
  expect(await memoireIpc(vue, naviguer("https://vidola-b.example/serie/the-bear?e=4"), { op: "retenir", cle: "encours.the-bear", valeur: { titre: "The Bear" } })).toEqual({ ok: true });
  expect(memoire.contenu().valeurs["encours.the-bear"]).toMatchObject({ valeur: { titre: "The Bear" }, adresse: "/serie/the-bear?e=4" });
  vue.mainFrame = principal;
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
  expect(await memoireIpc(vue, naviguer("https://compte.example/"), demande)).toEqual(refus);
  vue.mainFrame = principal;
  for (const d of [null, "x", { op: "effacer", cle: "x" }, { op: "lire", cle: 3 }]) expect(await memoireIpc(vue, principal, d)).toEqual(refus);
  expect(memoire.contenu().valeurs).toEqual({});
});

test("principal = le cadre principal de la vue (mainFrame), jamais un autre cadre sans parent (cadre clôturé)", async () => {
  const cloture: FauxCadre = { url: "https://vidola-b.example/series/x", parent: null };
  expect((injection(evenement(vue, cloture)) as InjectionCadre).pont).toBe(false);
  expect(demandes.at(-1)).toEqual({ id: "vidola", cadre: { url: cloture.url, principal: false } });
  expect(await memoireIpc(vue, cloture, { op: "retenir", cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: expect.any(String) });
  expect(memoire.contenu().valeurs).toEqual({});
});

test("mémoire : sans accord, refusée quel que soit l'appelant (même le cadre principal de la vue)", async () => {
  accorde = false;
  for (const op of ["retenir", "lire", "oublier"]) {
    expect(await memoireIpc(vue, principal, { op, cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: expect.any(String) });
  }
  expect(memoire.contenu().valeurs).toEqual({});
});

test("un accord qui couvre moins de droits que la déclaration (cadres ajoutés) : aucune injection", () => {
  const plus = DeclarationSite.parse({ ...declaration, retouches: [...declaration.retouches, { correspond: ["/x"], cadres: ["https://*.autre.example/*"] }] });
  const accord = { domaines: ["vidola-a.example"], connexion: ["compte.example"], cadres: ["https://*.lecteur.example/*"], reprise: true };
  // Ce que fait le service : accorde = !accordRequis, accordRequis = accordNecessaire && !accordCouvre.
  const requis = accordNecessaire(plus) && !accordCouvre(accord, plus);
  expect(requis).toBe(true);
  const o = { ...avec(!requis), site: { ...site, declaration: plus, accordRequis: requis } };
  expect(injectionPour(o, { url: "https://vidola-b.example/series/x", principal: true })).toBeNull();
  expect(injectionPour(o, { url: "https://www.lecteur.example/v", principal: false })).toBeNull();
  // Avec l'ancienne déclaration, le même accord suffit.
  expect(accordCouvre(accord, declaration)).toBe(true);
});

test("console des retouches : texte tronqué à 2000 caractères, source à 500, total borné, 50 au plus, jamais vérifiée", () => {
  const l: ReturnType<typeof ajouterConsoleRetouche> = [];
  ajouterConsoleRetouche(l, { texte: "a".repeat(10_000), source: "webaios-retouche://vidola/" + "b".repeat(1000) }, "t");
  expect(l[0]!.texte).toHaveLength(2000);
  expect(l[0]!.source).toHaveLength(500);
  expect(l[0]!.sourceVerifiee).toBe(false);
  for (let n = 0; n < 100; n++) ajouterConsoleRetouche(l, { texte: `${n}`.padEnd(2000, "x"), source: "s" }, "t");
  expect(l.reduce((t, e) => t + e.texte.length, 0)).toBeLessThanOrEqual(CONSOLE_RETOUCHES_TOTAL);
  expect(l.at(-1)!.texte.startsWith("99")).toBe(true);
  const petits: ReturnType<typeof ajouterConsoleRetouche> = [];
  for (let n = 0; n < 80; n++) ajouterConsoleRetouche(petits, { texte: `${n}`, source: "s" }, "t");
  expect(petits).toHaveLength(50);
  expect(petits[0]!.texte).toBe("30");
});

// --- Reprise des vidéos : la position de la page principale, jamais celle du lecteur.

type CadreReprise = { url: string; parent: CadreReprise | null; top: CadreReprise | null };
/** La vue est sur `url` : son cadre principal (son propre `top`) et un lecteur d'un autre domaine dedans. */
function pageAvecLecteur(url: string) {
  const page: CadreReprise = { url, parent: null, top: null };
  page.top = page;
  vue.mainFrame = page as never;
  const lecteur: CadreReprise = { url: "https://www.lecteur.example/embed/9", parent: page, top: page };
  return { page, lecteur };
}
/** Envoie une position (canal sans réponse) et laisse la mémoire, ouverte de façon asynchrone, la noter. */
const positionIpc = async (sender: unknown, cadre: CadreReprise | null, p: unknown) => {
  on.get("webaios:site-position")!(evenement(sender, cadre as never), p);
  await new Promise((r) => setTimeout(r));
};
const repriseIpc = (sender: unknown, cadre: CadreReprise | null) => handle.get("webaios:site-reprise")!(evenement(sender, cadre as never));
/** Le preload du cadre principal demande son injection : un nouveau chargement de la page. */
const charger = (page: CadreReprise) => injection(evenement(vue, page as never));

test("position : notée sous l'adresse relative de la page principale, depuis le lecteur comme depuis la page", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4?s=1");
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  expect(memoire.contenu().positions).toEqual({ "/episode/4?s=1": { t: 70, duree: 90, quand: expect.any(String) } });
  await positionIpc(vue, page, { t: 72, duree: 90 });
  expect(memoire.position("/episode/4?s=1")?.t).toBe(72);
  expect(Object.keys(memoire.contenu().positions)).toEqual(["/episode/4?s=1"]);
});

test("position : refusée sans accord, sans reprise déclarée, hors du site, hors de la vue, valeurs invalides", async () => {
  const { lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  accorde = false;
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  accorde = true;
  reprise = false;
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  reprise = true;
  await positionIpc({ session }, lecteur, { t: 70, duree: 90 });
  await positionIpc(vue, null, { t: 70, duree: 90 });
  for (const p of [null, "x", { t: "70", duree: 90 }, { t: 70 }, { t: Infinity, duree: 90 }]) await positionIpc(vue, lecteur, p);
  // Un cadre d'une autre arborescence (son top n'est pas le cadre principal de la vue).
  const ailleurs: CadreReprise = { url: "https://vidola-b.example/x", parent: null, top: null };
  await positionIpc(vue, { url: "https://www.lecteur.example/v", parent: ailleurs, top: ailleurs }, { t: 70, duree: 90 });
  pageAvecLecteur("https://compte.example/connexion");
  await positionIpc(vue, vue.mainFrame as never, { t: 70, duree: 90 });
  expect(memoire.contenu().positions).toEqual({});
});

test("reprise : la position de la page, au plus une fois par chargement du cadre principal", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  memoire.noterPosition("/episode/4", 70, 90);
  memoire.noterPosition("https://www.lecteur.example/embed/9", 30, 90);
  charger(page);
  expect(await repriseIpc(vue, lecteur)).toBe(70);
  expect(await repriseIpc(vue, lecteur)).toBeNull();
  expect(await repriseIpc(vue, page)).toBeNull();
  // Un lecteur rechargé seul ne redonne rien ; la page rechargée, si.
  charger(page);
  expect(await repriseIpc(vue, lecteur)).toBe(70);
});

test("reprise : une page sans position rend null, et la page qui note ensuite ne se la redonne pas", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/5");
  charger(page);
  expect(await repriseIpc(vue, lecteur)).toBeNull();
  await positionIpc(vue, lecteur, { t: 40, duree: 90 });
  expect(await repriseIpc(vue, lecteur)).toBeNull();
});

test("reprise : rien sans accord, sans reprise déclarée, hors du site, ou depuis la petite fenêtre", async () => {
  memoire.noterPosition("/episode/4", 70, 90);
  for (const cas of ["accord", "reprise", "fenetre"] as const) {
    const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
    charger(page);
    accorde = cas !== "accord";
    reprise = cas !== "reprise";
    expect(await repriseIpc(cas === "fenetre" ? { session } : vue, lecteur)).toBeNull();
    accorde = true;
    reprise = true;
  }
  const { page } = pageAvecLecteur("https://compte.example/episode/4");
  charger(page);
  expect(await repriseIpc(vue, page)).toBeNull();
});
