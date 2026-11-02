import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheminsEspace, lireAccordsSites, accorderSite, DeclarationSite, empreinteLectureSite } from "@webaios/noyau";
import { SchemaActionSite } from "../../src/commun/api";
import { ICONE_MAX } from "../../src/commun/sites";
import { modifierAvecAgent } from "../../src/commun/sites";

const journal: string[] = [];
const ouvertes = new Map<string, Record<string, unknown>>();
const options: { surSuivi?: (id: string, url: string | null) => void } = {};
const misesAJour: Record<string, unknown>[] = [];
/** Lecture de la page de référence : le signal reçu, et de quoi la garder en suspens. */
const lectures: { signal?: AbortSignal }[] = [];
/** Les accords lus par `preparer` : tenus un instant quand `portail.tenir` est armé (relecture en cours). */
const portail: { tenir: boolean; atteint: (() => void) | null; ouvrir: (() => void) | null } = { tenir: false, atteint: null, ouvrir: null };
/** La lecture du dossier des applis (`readdir`) : tenue une fois quand `dossierTenu.tenir` est armé. */
const dossierTenu: { tenir: boolean; atteint: (() => void) | null; ouvrir: (() => void) | null } = { tenir: false, atteint: null, ouvrir: null };
/** Ce que rend `fenetres.fermer` : la vue encore vivante après le délai (elle n'a jamais été détruite), ou null. */
const fermeture: { restante: { isDestroyed(): boolean; close(): void; forcefullyCrashRenderer(): void } | null } = { restante: null };

vi.mock("node:fs/promises", async (importer) => {
  const vrai = await importer<typeof import("node:fs/promises")>();
  return {
    ...vrai,
    readdir: async (...a: Parameters<typeof vrai.readdir>) => {
      if (dossierTenu.tenir) {
        dossierTenu.tenir = false;
        await new Promise<void>((ok) => {
          dossierTenu.ouvrir = ok;
          dossierTenu.atteint?.();
        });
      }
      return vrai.readdir(...a);
    },
  };
});

vi.mock("@webaios/noyau", async (importer) => {
  const vrai = await importer<typeof import("@webaios/noyau")>();
  return {
    ...vrai,
    lireAccordsSites: async (...a: Parameters<typeof vrai.lireAccordsSites>) => {
      const lus = await vrai.lireAccordsSites(...a);
      if (portail.tenir) {
        portail.tenir = false;
        await new Promise<void>((ok) => {
          portail.ouvrir = ok;
          portail.atteint?.();
        });
      }
      return lus;
    },
  };
});
vi.mock("../../src/main/agent/lecture-invisible", () => ({
  lirePageInvisible: (_page: string, o: { signal?: AbortSignal }) => {
    lectures.push(o.signal ? { signal: o.signal } : {});
    return new Promise((_ok, ko) => o.signal?.addEventListener("abort", () => ko(new Error("annulée"))));
  },
}));

vi.mock("electron", () => ({
  ipcMain: { on: () => {}, handle: () => {} },
  shell: { showItemInFolder: (c: string) => void journal.push(`dossier ${c}`) },
  net: {},
  session: {},
  BrowserWindow: class {},
  WebContentsView: class {},
}));
vi.mock("../../src/main/sites/session", () => ({
  fixerPreloadSite: () => {},
  sessionSite: () => ({}),
  siteDeSession: () => undefined,
  effacerSessionSite: async (id: string) => void journal.push(`session ${id}`),
}));
vi.mock("../../src/main/sites/fenetres", () => ({
  empreinteDroits: () => "",
  detruireVue: (wc: { isDestroyed(): boolean; close(): void }) => {
    if (!wc.isDestroyed()) wc.close();
  },
  FenetresSites: class {
    constructor(o: { surSuivi: (id: string, url: string | null) => void }) {
      options.surSuivi = o.surSuivi;
    }
    site = (id: string) => ouvertes.get(id);
    ouvertes = () => [...ouvertes.keys()].map((id) => ({ id }));
    etat = () => ({ vue: "accord" });
    apresAccord = (id: string, s: Record<string, unknown> | null) => void journal.push(`apresAccord ${id} ${s ? s.accordRequis : "non"}`);
    rediffuser = () => {};
    cherche = () => {};
    avis = () => {};
    adresseChangee = () => {};
    rechargerVue = () => {};
    fermer = async (id: string) => {
      await new Promise((r) => setTimeout(r, 20));
      journal.push(`fermee ${id}`);
      ouvertes.delete(id);
      return fermeture.restante;
    };
    ouvrir = (s: { id: string }) => void ouvertes.set(s.id, s);
    depuisAccueil = (id: string, url: string) => (journal.push(`accueil ${id} ${url}`), true);
    mettreAJour = (s: { id: string }) => {
      misesAJour.push(s);
      ouvertes.set(s.id, s);
      return false;
    };
    vueSite = () => undefined;
    erreursRetouches = () => [];
    envoyer = () => {};
  },
}));
vi.mock("../../src/main/applications/service", () => ({
  MemoireApplications: class {
    oublies: string[] = [];
    lire = () => ({});
    oublier(id: string) {
      journal.push(`souvenir ${id}`);
    }
    vider = async () => {};
  },
}));

const { demarrerSites, lireIcone } = await import("../../src/main/sites/service");

let racine: string;
let profil: string;
let service: ReturnType<typeof demarrerSites>;
const deboguer = vi.fn();
/** Appelé quand une suppression commence (l'accord de lecture de l'agent tombe). */
const surSupprimee = vi.fn((id: string) => void journal.push(`supprimee ${id}`));

const declaration = {
  nom: "Vidola",
  description: "Séries",
  adresse: "https://vidola-a.example/",
  domaines: ["vidola-a.example"],
  retouches: [],
  reprise: true,
};

beforeEach(() => {
  journal.length = 0;
  ouvertes.clear();
  misesAJour.length = 0;
  lectures.length = 0;
  portail.tenir = false;
  dossierTenu.tenir = false;
  fermeture.restante = null;
  racine = mkdtempSync(join(tmpdir(), "service-sites-"));
  profil = mkdtempSync(join(tmpdir(), "service-profil-"));
  const c = cheminsEspace(racine);
  mkdirSync(join(c.sites, "vidola"), { recursive: true });
  writeFileSync(join(c.sites, "vidola", "site.json"), JSON.stringify(declaration));
  writeFileSync(join(c.sites, "vidola", "garde.txt"), "x");
  mkdirSync(join(c.sites, "casse"), { recursive: true });
  writeFileSync(join(c.sites, "casse", "site.json"), "{pas du json");
  const garde = join(profil, "garde.js");
  writeFileSync(garde, "// garde");
  service = demarrerSites({
    chemins: c,
    dossierProfil: profil,
    preloadSite: "/x/site.js",
    cheminGarde: garde,
    adressesLocales: false,
    ouvrirOnglet: () => {},
    deboguer,
    diffuser: () => {},
    surSupprimee,
  });
});
afterEach(async () => {
  await service.arreter();
  rmSync(racine, { recursive: true, force: true });
  rmSync(profil, { recursive: true, force: true });
});

test("liste : le domaine actuel, et « Sans fiche » avec l'erreur pour un site.json abîmé", async () => {
  const l = await service.liste();
  expect(l.find((s) => s.id === "vidola")).toMatchObject({ nom: "Vidola", domaine: "vidola-a.example", ouverte: false });
  const casse = l.find((s) => s.id === "casse")!;
  expect(casse.erreur).toMatch(/site\.json/);
  expect(casse.domaine).toBeNull();
});

test("supprimer : fenêtre fermée avant la session, dossier à la corbeille, mémoire, adresse et accord effacés", async () => {
  const c = cheminsEspace(racine);
  const d = DeclarationSite.parse(declaration);
  await accorderSite(profil, "vidola", d);
  const m = await service.memoire("vidola");
  m.retenir("serie", { a: 1 }, "/s");
  await m.vider();
  mkdirSync(join(profil, "sites", "vidola"), { recursive: true });
  writeFileSync(join(profil, "sites", "vidola", "adresse.json"), "{}");
  expect(existsSync(join(profil, "sites", "vidola", "memoire.json"))).toBe(true);
  expect(await service.ouvrirParId("vidola")).toBe(true);

  await service.agir("vidola", "supprimer", "f1" as never);

  // La fenêtre est détruite avant que la session soit effacée.
  expect(journal.filter((j) => /^(fermee|session)/.test(j))).toEqual(["fermee vidola", "session vidola"]);
  expect(existsSync(join(profil, "sites", "vidola"))).toBe(false);
  expect(Object.hasOwn(await lireAccordsSites(profil), "vidola")).toBe(false);
  const corbeille = readdirSync(join(c.sites, ".corbeille"));
  expect(corbeille).toHaveLength(1);
  expect(corbeille[0]).toMatch(/^vidola-\d+$/);
  expect(existsSync(join(c.sites, "vidola"))).toBe(false);
  expect(existsSync(join(c.sites, ".corbeille", corbeille[0]!, "site.json"))).toBe(true);
  // Une mémoire rouverte au même id repart vide.
  expect((await service.memoire("vidola")).contenu()).toMatchObject({ valeurs: {}, positions: {} });
});

test("oublier : memoire.json supprimé, mémoire vide ; le dossier de l'appli n'est pas touché", async () => {
  const c = cheminsEspace(racine);
  const m = await service.memoire("vidola");
  m.retenir("serie", 1, "/s");
  await m.vider();
  await service.agir("vidola", "oublier", "f1" as never);
  expect(existsSync(join(profil, "sites", "vidola", "memoire.json"))).toBe(false);
  expect(readdirSync(join(c.sites, "vidola")).sort()).toEqual(["garde.txt", "site.json"]);
  expect((await service.memoire("vidola")).contenu().valeurs).toEqual({});
});

test("modifier : le terminal de l'agent est pré-rempli ; dossier : montré dans le Finder", async () => {
  await service.agir("vidola", "modifier", "f1" as never);
  expect(deboguer).toHaveBeenCalledWith("f1", modifierAvecAgent("vidola"));
  await service.agir("vidola", "dossier", "f1" as never);
  expect(journal).toContain(`dossier ${join(cheminsEspace(racine).sites, "vidola")}`);
});

test("un id « ../x » (ou en majuscules) est refusé par SchemaActionSite, et par agir", async () => {
  for (const id of ["../x", "Vidola", "a/b", ".corbeille", ""]) expect(SchemaActionSite.safeParse({ id, action: "supprimer" }).success).toBe(false);
  expect(SchemaActionSite.safeParse({ id: "vidola", action: "supprimer" }).success).toBe(true);
  await service.agir("../x", "supprimer", "f1" as never);
  expect(existsSync(join(cheminsEspace(racine).sites, ".corbeille"))).toBe(false);
});

// --- Icône déclarée

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

test("lireIcone : png et svg valides en data: ; trop gros, lien, lien hors du dossier, tube nommé, mauvaise extension : null", async () => {
  const d = mkdtempSync(join(tmpdir(), "icone-"));
  const dehors = mkdtempSync(join(tmpdir(), "icone-dehors-"));
  try {
    writeFileSync(join(d, "i.png"), PNG);
    writeFileSync(join(d, "i.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    writeFileSync(join(d, "gros.png"), Buffer.alloc(ICONE_MAX + 1));
    writeFileSync(join(d, "limite.png"), Buffer.alloc(ICONE_MAX));
    writeFileSync(join(d, "x.gif"), PNG);
    writeFileSync(join(dehors, "secret.png"), PNG);
    symlinkSync(join(d, "i.png"), join(d, "lien.png"));
    symlinkSync(join(dehors, "secret.png"), join(d, "sortie.png"));
    symlinkSync(dehors, join(d, "dossier"));
    execFileSync("mkfifo", [join(d, "tube.png")]);
    expect(await lireIcone(d, "i.png")).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(await lireIcone(d, "i.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(await lireIcone(d, "limite.png")).not.toBeNull();
    expect(await lireIcone(d, "gros.png")).toBeNull();
    expect(await lireIcone(d, "lien.png")).toBeNull();
    expect(await lireIcone(d, "sortie.png")).toBeNull();
    expect(await lireIcone(d, "dossier/secret.png")).toBeNull();
    expect(await lireIcone(d, "x.gif")).toBeNull();
    expect(await lireIcone(d, "absente.png")).toBeNull();
    const debut = Date.now();
    expect(await lireIcone(d, "tube.png")).toBeNull();
    expect(Date.now() - debut).toBeLessThan(1000);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(dehors, { recursive: true, force: true });
  }
});

// --- Supprimer et oublier : bords

test("un id jamais montré (sans dossier) : ni oublier ni supprimer n'effacent rien", async () => {
  mkdirSync(join(profil, "sites", "inconnu"), { recursive: true });
  writeFileSync(join(profil, "sites", "inconnu", "memoire.json"), JSON.stringify({ version: 1, valeurs: {}, positions: {} }));
  await service.agir("inconnu", "oublier", "f1" as never);
  await service.agir("inconnu", "supprimer", "f1" as never);
  expect(existsSync(join(profil, "sites", "inconnu", "memoire.json"))).toBe(true);
  expect(journal.filter((j) => j.startsWith("session"))).toEqual([]);
});

test("supprimer une ligne périmée (dossier disparu depuis la liste) : les données sont effacées, pas d'erreur", async () => {
  await service.liste();
  const m = await service.memoire("vidola");
  m.retenir("a", 1, "/");
  await m.vider();
  rmSync(join(cheminsEspace(racine).sites, "vidola"), { recursive: true });
  await service.agir("vidola", "supprimer", "f1" as never);
  expect(journal).toContain("session vidola");
  expect(existsSync(join(profil, "sites", "vidola"))).toBe(false);
  expect((await service.liste()).find((s) => s.id === "vidola")).toBeUndefined();
});

test("corbeille impossible : les données sont effacées, le dossier reste, la ligne porte l'erreur en texte", async () => {
  const c = cheminsEspace(racine);
  writeFileSync(join(c.sites, ".corbeille"), "je suis un fichier");
  await service.liste();
  await service.agir("vidola", "supprimer", "f1" as never);
  expect(existsSync(join(c.sites, "vidola", "site.json"))).toBe(true);
  const ligne = (await service.liste()).find((s) => s.id === "vidola")!;
  expect(ligne.erreurAction).toMatch(/corbeille/);
  // Une action suivante efface l'avis.
  await service.agir("vidola", "modifier", "f1" as never);
  expect((await service.liste()).find((s) => s.id === "vidola")!.erreurAction).toBeUndefined();
});

test("une ligne à id refusé (« MonSite ») n'a aucune action", async () => {
  mkdirSync(join(cheminsEspace(racine).sites, "MonSite"), { recursive: true });
  const l = await service.liste();
  expect(l.find((s) => s.id === "MonSite")).toMatchObject({ sansActions: true });
  expect(l.find((s) => s.id === "casse")!.sansActions).toBeUndefined();
});

test("supprimer pendant une lecture de l'adresse : la lecture est annulée", async () => {
  const c = cheminsEspace(racine);
  writeFileSync(join(c.sites, "vidola", "site.json"), JSON.stringify({ ...declaration, suiviAdresse: { page: "https://reference.example/", motif: "vidola" } }));
  expect(await service.ouvrirParId("vidola")).toBe(true);
  options.surSuivi!("vidola", null);
  await vi.waitFor(() => expect(lectures).toHaveLength(1));
  expect(lectures[0]!.signal?.aborted).toBe(false);
  await service.agir("vidola", "supprimer", "f1" as never);
  expect(lectures[0]!.signal?.aborted).toBe(true);
});

test("deux suppressions en même temps : une seule fait le travail", async () => {
  await service.liste();
  await Promise.all([service.agir("vidola", "supprimer", "f1" as never), service.agir("vidola", "supprimer", "f1" as never)]);
  expect(journal.filter((j) => j === "session vidola")).toHaveLength(1);
  expect(readdirSync(join(cheminsEspace(racine).sites, ".corbeille"))).toHaveLength(1);
});

test("ouvrirParId est refusé pendant une suppression, accepté ensuite", async () => {
  await service.liste();
  const fin = service.agir("vidola", "supprimer", "f1" as never);
  expect(await service.ouvrirParId("vidola")).toBe(false);
  await fin;
  expect(ouvertes.has("vidola")).toBe(false);
});

test("ouvrirParId pendant que supprimer commence (lecture du dossier tenue) : refusé, aucune fenêtre, rien de l'appli ne revient", async () => {
  await service.liste();
  const atteint = new Promise<void>((ok) => (dossierTenu.atteint = ok));
  dossierTenu.tenir = true;
  const ouverture = service.ouvrirParId("vidola");
  await atteint;
  // La suppression commence pendant que l'ouverture lit le dossier (site.json et l'accord sont encore là).
  const fin = service.agir("vidola", "supprimer", "f1" as never);
  // Pendant la suppression, la mémoire n'est ni ouverte ni écrite.
  await expect(service.memoire("vidola")).rejects.toThrow();
  dossierTenu.ouvrir!();
  expect(await ouverture).toBe(false);
  await fin;
  expect(ouvertes.has("vidola")).toBe(false);
  expect(existsSync(join(profil, "sites", "vidola"))).toBe(false);
});

test("ouvrirParId : une suppression commencée et finie pendant la lecture du dossier refuse aussi l'ouverture", async () => {
  await service.liste();
  const atteint = new Promise<void>((ok) => (dossierTenu.atteint = ok));
  dossierTenu.tenir = true;
  const ouverture = service.ouvrirParId("vidola");
  await atteint;
  // L'appli est recréée au même id juste après : l'ouverture d'avant ne l'ouvre pas pour autant.
  await service.agir("vidola", "supprimer", "f1" as never);
  mkdirSync(join(cheminsEspace(racine).sites, "vidola"), { recursive: true });
  writeFileSync(join(cheminsEspace(racine).sites, "vidola", "site.json"), JSON.stringify(declaration));
  dossierTenu.ouvrir!();
  expect(await ouverture).toBe(false);
  expect(ouvertes.has("vidola")).toBe(false);
});

test("supprimer : une vue jamais détruite (délai passé) est détruite après l'effacement de la session", async () => {
  const vue = { detruite: false, isDestroyed: () => vue.detruite, close: () => void ((vue.detruite = true), journal.push("vue detruite")), forcefullyCrashRenderer: () => {} };
  fermeture.restante = vue;
  expect(await service.ouvrirParId("vidola")).toBe(true);
  await service.agir("vidola", "supprimer", "f1" as never);
  expect(journal.filter((j) => /^(fermee|session|vue)/.test(j))).toEqual(["fermee vidola", "session vidola", "vue detruite"]);
  expect(existsSync(join(profil, "sites", "vidola"))).toBe(false);
});

// --- Accord et relecture

test("accorder : une relecture commencée avant l'accord est jetée (elle a lu l'accord d'avant)", async () => {
  const c = cheminsEspace(racine);
  const avecRetouches = { ...declaration, retouches: [{ correspond: ["/s/*"], js: ["a.js"], css: [], cadres: false }] };
  mkdirSync(join(c.sites, "vidola", "retouches"), { recursive: true });
  writeFileSync(join(c.sites, "vidola", "retouches", "a.js"), "1");
  writeFileSync(join(c.sites, "vidola", "site.json"), JSON.stringify(avecRetouches));
  expect(await service.ouvrirParId("vidola")).toBe(true);
  expect(ouvertes.get("vidola")!.accordRequis).toBe(true);
  // Une relecture (site.json touché) lit l'accord (absent), puis attend.
  const atteint = new Promise<void>((ok) => (portail.atteint = ok));
  portail.tenir = true;
  writeFileSync(join(c.sites, "vidola", "site.json"), JSON.stringify({ ...avecRetouches, description: "autre" }));
  await atteint;
  misesAJour.length = 0;
  await service.accorder("vidola", true, "");
  portail.ouvrir!();
  await vi.waitFor(() => expect(misesAJour.length).toBeGreaterThan(0), { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 300));
  // Aucune mise à jour ne porte l'accord d'avant (accordRequis: true).
  expect(misesAJour.map((m) => m.accordRequis)).not.toContain(true);
  expect(journal).toContain("apresAccord vidola false");
});

// --- Ouvertures demandées par l'accueil : un vrai geste récent, de cette fenêtre, une par seconde

const accueilOuvertes = () => journal.filter((j) => j.startsWith("accueil "));

test("accueil : sans geste de l'utilisateur, rien ne s'ouvre", async () => {
  expect(await service.ouvrirParId("vidola")).toBe(true);
  expect(service.ouvrirDepuisAccueil("vidola", "/series/x")).toBe(false);
  expect(accueilOuvertes()).toEqual([]);
  // Le geste est consommé par une ouverture : la suivante en redemande un.
  service.gesteAccueil("vidola");
  expect(service.ouvrirDepuisAccueil("vidola", "/series/x")).toBe(true);
  expect(accueilOuvertes()).toEqual(["accueil vidola https://vidola-a.example/series/x"]);
});

test("accueil : un geste de plus de 1,5 s ne compte plus", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    expect(await service.ouvrirParId("vidola")).toBe(true);
    service.gesteAccueil("vidola");
    vi.setSystemTime(Date.now() + 1501);
    expect(service.ouvrirDepuisAccueil("vidola", "/series/x")).toBe(false);
    service.gesteAccueil("vidola");
    vi.setSystemTime(Date.now() + 1400);
    expect(service.ouvrirDepuisAccueil("vidola", "/series/x")).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("accueil : une seconde ouverture moins d'1 s après la première est refusée, même avec un nouveau geste", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    expect(await service.ouvrirParId("vidola")).toBe(true);
    service.gesteAccueil("vidola");
    expect(service.ouvrirDepuisAccueil("vidola", "/a")).toBe(true);
    vi.setSystemTime(Date.now() + 500);
    service.gesteAccueil("vidola");
    expect(service.ouvrirDepuisAccueil("vidola", "/b")).toBe(false);
    vi.setSystemTime(Date.now() + 600);
    expect(service.ouvrirDepuisAccueil("vidola", "/b")).toBe(true);
    expect(accueilOuvertes()).toEqual(["accueil vidola https://vidola-a.example/a", "accueil vidola https://vidola-a.example/b"]);
  } finally {
    vi.useRealTimers();
  }
});

test("accueil : le geste fait dans la fenêtre d'une autre appli n'ouvre rien dans celle-ci", async () => {
  expect(await service.ouvrirParId("vidola")).toBe(true);
  ouvertes.set("youtube", { id: "youtube", depart: "https://youtube.example/", domaines: ["youtube.example"] });
  service.gesteAccueil("youtube");
  expect(service.ouvrirDepuisAccueil("vidola", "/series/x")).toBe(false);
  expect(accueilOuvertes()).toEqual([]);
  // Le geste de youtube reste à youtube.
  expect(service.ouvrirDepuisAccueil("youtube", "/v")).toBe(true);
});

// --- Ce que voit l'agent : l'empreinte de la déclaration, et l'accord retiré à la suppression

test("listeAgent : l'empreinte de la déclaration d'aujourd'hui (site.json réécrit avec un domaine de plus : une autre), aucune pour un site.json abîmé", async () => {
  const c = cheminsEspace(racine);
  const avant = (await service.listeAgent()).find((s) => s.id === "vidola")!;
  expect(avant).toMatchObject({ id: "vidola", nom: "Vidola", domaine: "vidola-a.example", ouverte: false, empreinte: empreinteLectureSite(DeclarationSite.parse(declaration)) });
  const plus = { ...declaration, domaines: [...declaration.domaines, "mail.example.com"] };
  writeFileSync(join(c.sites, "vidola", "site.json"), JSON.stringify(plus));
  const apres = (await service.listeAgent()).find((s) => s.id === "vidola")!;
  expect(apres.empreinte).toBe(empreinteLectureSite(DeclarationSite.parse(plus)));
  expect(apres.empreinte).not.toBe(avant.empreinte);
  expect((await service.listeAgent()).find((s) => s.id === "casse")!.empreinte).toBeUndefined();
  // La liste de la page Applications ne la porte pas.
  expect((await service.liste()).find((s) => s.id === "vidola")).not.toHaveProperty("empreinte");
});

test("supprimer : l'accord de lecture de l'agent est retiré dès le début, avant la fermeture", async () => {
  expect(await service.ouvrirParId("vidola")).toBe(true);
  await service.agir("vidola", "supprimer", "f1" as never);
  expect(surSupprimee).toHaveBeenCalledWith("vidola");
  expect(journal.filter((j) => /^(supprimee|fermee)/.test(j))).toEqual(["supprimee vidola", "fermee vidola"]);
});
