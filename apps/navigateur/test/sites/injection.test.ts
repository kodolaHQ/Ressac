import { beforeEach, expect, test, vi } from "vitest";
import { accordCouvre, accordNecessaire, CLE_INVALIDE, DeclarationSite, MemoireSite, VALEUR_NON_JSON, type RetouchesLues } from "@webaios/noyau";
import { existsSync, mkdtempSync } from "node:fs";
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

const { ajouterConsoleRetouche, brancherInjection, injectionPour, repriseDansCadre } = await import("../../src/main/sites/injection");

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

test("sous-cadre lecteur.localhost hors des motifs cadres déclarés : rien, pas même la reprise", () => {
  const i = injectionPour(avec(), { url: "https://lecteur.localhost/v", principal: false });
  expect(i).toEqual({ css: [], js: [], garde: null, hotes: [], pont: false, reprise: false });
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
let dossierMemoire: string;
let controle: ReturnType<typeof brancherInjection>;
let accorde: boolean;
let reprise: boolean;
/** La mémoire refusée par le service (appli en cours de suppression). */
let memoireRefusee: boolean;
let horloge: number;
let differes: { f: () => void; ms: number }[];
let demandes: { id: string; cadre: { url: string; principal: boolean } }[];
beforeEach(async () => {
  on.clear();
  handle.clear();
  demandes = [];
  accorde = true;
  reprise = true;
  memoireRefusee = false;
  horloge = 0;
  differes = [];
  vue.mainFrame = principal;
  dossierMemoire = mkdtempSync(join(tmpdir(), "injection-"));
  memoire = await MemoireSite.ouvrir(dossierMemoire, "vidola");
  controle = brancherInjection({
    siteDeSession: (s) => ((s as unknown) === session ? "vidola" : undefined),
    vue: (id) => (id === "vidola" ? (vue as never) : undefined),
    injection: (id, cadre) => {
      demandes.push({ id, cadre });
      return injectionPour(avec(), cadre);
    },
    accorde: () => accorde,
    reprise: (_id, cadre) => reprise && (cadre.principal || !cadre.url.includes("pub.example")),
    maintenant: () => horloge,
    differer: (f, ms) => void differes.push({ f, ms }),
    memoire: async () => {
      if (memoireRefusee) throw new Error("appli de site en cours de suppression : vidola");
      return memoire;
    },
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

test("mémoire refusée par le service (appli en cours de suppression) : le refus de la mémoire, rien d'écrit", async () => {
  memoireRefusee = true;
  for (const op of ["retenir", "lire", "oublier"]) {
    expect(await memoireIpc(vue, principal, { op, cle: "x", valeur: 1 })).toEqual({ ok: false, erreur: expect.any(String) });
  }
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

// --- Reprise des vidéos : la position de la page principale appartient à la vidéo de même durée.

type CadreReprise = { url: string; parent: CadreReprise | null; top: CadreReprise | null };
/** La vue est sur `url` : son cadre principal (son propre `top`), un lecteur d'un autre domaine et une publicité dedans. */
function pageAvecLecteur(url: string) {
  const page: CadreReprise = { url, parent: null, top: null };
  page.top = page;
  vue.mainFrame = page as never;
  const lecteur: CadreReprise = { url: "https://www.lecteur.example/embed/9", parent: page, top: page };
  const lecteur2: CadreReprise = { url: "https://autre-lecteur.example/e/9", parent: page, top: page };
  const pub: CadreReprise = { url: "https://ads.pub.example/v", parent: page, top: page };
  return { page, lecteur, lecteur2, pub };
}
/** Envoie une position (canal sans réponse) et laisse la mémoire, ouverte de façon asynchrone, la noter. */
const positionIpc = async (sender: unknown, cadre: CadreReprise | null, p: unknown) => {
  on.get("webaios:site-position")!(evenement(sender, cadre as never), p);
  await new Promise((r) => setTimeout(r));
};
/** Une note un peu plus tard (au-delà de la limite d'une note par seconde et par cadre). */
const plusTard = async (sender: unknown, cadre: CadreReprise | null, p: unknown) => {
  horloge += 1000;
  await positionIpc(sender, cadre, p);
};
const repriseIpc = (sender: unknown, cadre: CadreReprise | null, d: unknown) => handle.get("webaios:site-reprise")!(evenement(sender, cadre as never), d);

test("position : notée sous l'adresse relative de la page principale, depuis le lecteur comme depuis la page", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4?s=1");
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  expect(memoire.contenu().positions).toEqual({ "/episode/4?s=1": { t: 70, duree: 90, quand: expect.any(String) } });
  await plusTard(vue, page, { t: 72, duree: 90 });
  expect(memoire.position("/episode/4?s=1")?.t).toBe(72);
  expect(Object.keys(memoire.contenu().positions)).toEqual(["/episode/4?s=1"]);
});

test("position : refusée sans accord, sans reprise dans ce cadre, hors du site, hors de la vue, valeurs invalides", async () => {
  const { lecteur, pub } = pageAvecLecteur("https://vidola-b.example/episode/4");
  accorde = false;
  await plusTard(vue, lecteur, { t: 70, duree: 90 });
  accorde = true;
  reprise = false;
  await plusTard(vue, lecteur, { t: 70, duree: 90 });
  reprise = true;
  await plusTard(vue, pub, { t: 70, duree: 90 });
  await plusTard({ session }, lecteur, { t: 70, duree: 90 });
  await plusTard(vue, null, { t: 70, duree: 90 });
  for (const p of [null, "x", { t: "70", duree: 90 }, { t: 70 }, { t: Infinity, duree: 90 }]) await plusTard(vue, lecteur, p);
  // Un cadre d'une autre arborescence (son top n'est pas le cadre principal de la vue).
  const ailleurs: CadreReprise = { url: "https://vidola-b.example/x", parent: null, top: null };
  await plusTard(vue, { url: "https://www.lecteur.example/v", parent: ailleurs, top: ailleurs }, { t: 70, duree: 90 });
  pageAvecLecteur("https://compte.example/connexion");
  await plusTard(vue, vue.mainFrame as never, { t: 70, duree: 90 });
  expect(memoire.contenu().positions).toEqual({});
});

test("position : au plus une note par seconde et par cadre ; la dernière trop tôt est écrite au bout de la seconde ; la fin, tout de suite", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  horloge += 300;
  await positionIpc(vue, lecteur, { t: 71, duree: 90 });
  horloge += 300;
  await positionIpc(vue, lecteur, { t: 71.5, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(70);
  // Une seule écriture différée, au bout de la seconde, avec la dernière valeur (une pause juste après un saut n'est pas perdue).
  expect(differes.map((d) => d.ms)).toEqual([700]);
  horloge = 1000;
  differes.shift()!.f();
  await new Promise((r) => setTimeout(r));
  expect(memoire.position("/episode/4")?.t).toBe(71.5);
  // Un autre cadre de la page n'est pas freiné par le premier.
  await positionIpc(vue, page, { t: 72, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(72);
  // La fin passe tout de suite et annule une note en attente (qui ne ferait pas revenir la position oubliée).
  horloge += 100;
  await positionIpc(vue, lecteur, { t: 80, duree: 90 });
  expect(differes).toHaveLength(1);
  await positionIpc(vue, lecteur, { t: 90, duree: 90, fin: true });
  expect(memoire.position("/episode/4")).toBeNull();
  differes.shift()!.f();
  await new Promise((r) => setTimeout(r));
  expect(memoire.position("/episode/4")).toBeNull();
  horloge += 1000;
  await positionIpc(vue, lecteur, { t: 30, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(30);
});

test("reprise : la position de la page à une vidéo de même durée (±2 s), à chaque nouvel élément ; rien sous l'adresse du lecteur", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  memoire.noterPosition("/episode/4", 70, 90);
  memoire.noterPosition("https://www.lecteur.example/embed/9", 30, 90);
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBe(70);
  // Un <video> recréé, la page rechargée : de nouveau servie.
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBe(70);
  expect(await repriseIpc(vue, page, { duree: 91.5 })).toBe(70);
  expect(await repriseIpc(vue, lecteur, { duree: 92.5 })).toBeNull();
  for (const d of [undefined, null, {}, { duree: "90" }, { duree: NaN }]) expect(await repriseIpc(vue, lecteur, d)).toBeNull();
});

test("une publicité d'une autre durée ne prend pas la position et ne l'écrase ni ne l'efface ; le lecteur arrivé second reprend", async () => {
  const { lecteur, lecteur2 } = pageAvecLecteur("https://vidola-b.example/episode/4");
  memoire.noterPosition("/episode/4", 70, 90);
  // La publicité de 75 s dans un cadre où la reprise tourne (pas de motif cadres) : jouée d'abord.
  expect(await repriseIpc(vue, lecteur2, { duree: 75 })).toBeNull();
  await plusTard(vue, lecteur2, { t: 0.2, duree: 75 });
  await plusTard(vue, lecteur2, { t: 40, duree: 75 });
  await plusTard(vue, lecteur2, { t: 75, duree: 75, fin: true });
  expect(memoire.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBe(70);
});

test("« Lecteur 2 » : le cadre change de lecteur, la même vidéo reprend où le premier en était", async () => {
  const { lecteur, lecteur2 } = pageAvecLecteur("https://vidola-b.example/episode/4");
  memoire.noterPosition("/episode/4", 1200, 2700);
  expect(await repriseIpc(vue, lecteur, { duree: 2700 })).toBe(1200);
  await plusTard(vue, lecteur, { t: 1210, duree: 2700 });
  expect(await repriseIpc(vue, lecteur2, { duree: 2699 })).toBe(1210);
  expect(memoire.position("/episode/4")?.t).toBe(1210);
});

test("sans position retenue : le premier élément de 60 s ou plus note ; une vidéo d'une autre durée ne l'écrase pas ensuite", async () => {
  const { lecteur, lecteur2 } = pageAvecLecteur("https://vidola-b.example/episode/5");
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBeNull();
  await plusTard(vue, lecteur, { t: 40, duree: 90 });
  expect(memoire.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
  await plusTard(vue, lecteur2, { t: 10, duree: 300 });
  expect(memoire.position("/episode/5")).toMatchObject({ t: 40, duree: 90 });
});

test("pushState vers un autre épisode : chaque épisode garde et reprend sa propre position (adresse lue à chaque demande)", async () => {
  const { page, lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  memoire.noterPosition("/episode/4", 70, 90);
  memoire.noterPosition("/episode/5", 720, 1500);
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBe(70);
  // La page change d'adresse sans nouveau document (même cadre principal).
  page.url = "https://vidola-b.example/episode/5";
  expect(await repriseIpc(vue, lecteur, { duree: 1500 })).toBe(720);
  await plusTard(vue, lecteur, { t: 730, duree: 1500 });
  expect(memoire.position("/episode/5")?.t).toBe(730);
  expect(memoire.position("/episode/4")).toMatchObject({ t: 70, duree: 90 });
});

test("reprise : rien sans accord, sans reprise dans ce cadre, hors du site, ou depuis la petite fenêtre", async () => {
  memoire.noterPosition("/episode/4", 70, 90);
  const { lecteur, pub } = pageAvecLecteur("https://vidola-b.example/episode/4");
  accorde = false;
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBeNull();
  accorde = true;
  reprise = false;
  expect(await repriseIpc(vue, lecteur, { duree: 90 })).toBeNull();
  reprise = true;
  expect(await repriseIpc(vue, pub, { duree: 90 })).toBeNull();
  expect(await repriseIpc({ session }, lecteur, { duree: 90 })).toBeNull();
  const { page } = pageAvecLecteur("https://compte.example/episode/4");
  expect(await repriseIpc(vue, page, { duree: 90 })).toBeNull();
});

test("motifs cadres déclarés : la reprise ne va que dans le cadre principal et les cadres qui leur correspondent ; sans motif, partout", () => {
  const avecCadres = injectionPour(avec(), { url: "https://www.lecteur.example/v", principal: false })!;
  expect(avecCadres.reprise).toBe(true);
  expect(injectionPour(avec(), { url: "https://ads.pub.example/v", principal: false })!.reprise).toBe(false);
  expect(injectionPour(avec(), { url: "https://vidola-b.example/episode/4", principal: true })!.reprise).toBe(true);
  expect(repriseDansCadre(declaration, { url: "https://ads.pub.example/v", principal: false })).toBe(false);
  const sansCadres = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/series/*"], js: ["a.js"] }] });
  expect(repriseDansCadre(sansCadres, { url: "https://ads.pub.example/v", principal: false })).toBe(true);
  expect(repriseDansCadre({ ...sansCadres, reprise: false }, { url: "https://vidola-b.example/", principal: true })).toBe(false);
  // Tests : un lecteur http d'un hôte local comparé comme en https.
  const local = DeclarationSite.parse({ ...declaration, retouches: [{ correspond: ["/x"], cadres: ["https://lecteur.localhost:*/*"] }] });
  expect(repriseDansCadre(local, { url: "http://lecteur.localhost:4000/v", principal: false }, true)).toBe(true);
  expect(repriseDansCadre(local, { url: "http://pub.localhost:4000/v", principal: false }, true)).toBe(false);
});

test("oublier : une note en attente de sa seconde ne recrée pas memoire.json (1,5 s plus tard)", async () => {
  const { lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  horloge += 300;
  // Trop tôt : attend sa seconde.
  await positionIpc(vue, lecteur, { t: 75, duree: 90 });
  expect(differes).toHaveLength(1);
  // « Oublier ce que l'appli a retenu » : notes annulées, puis mémoire effacée.
  controle.annulerNotes("vidola");
  await memoire.effacer();
  horloge = 1000;
  differes.shift()!.f();
  await new Promise((r) => setTimeout(r, 1500));
  expect(memoire.contenu().positions).toEqual({});
  expect(existsSync(join(dossierMemoire, "vidola", "memoire.json"))).toBe(false);
  // Une note neuve, après l'oubli, est de nouveau retenue.
  horloge += 2000;
  await positionIpc(vue, lecteur, { t: 30, duree: 90 });
  expect(memoire.position("/episode/4")?.t).toBe(30);
});

test("accord retiré avant l'écriture différée : la note n'est pas écrite", async () => {
  const { lecteur } = pageAvecLecteur("https://vidola-b.example/episode/4");
  await positionIpc(vue, lecteur, { t: 70, duree: 90 });
  horloge += 300;
  await positionIpc(vue, lecteur, { t: 75, duree: 90 });
  accorde = false;
  horloge = 1000;
  differes.shift()!.f();
  await new Promise((r) => setTimeout(r));
  expect(memoire.position("/episode/4")?.t).toBe(70);
});
