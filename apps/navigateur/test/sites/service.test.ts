import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cheminsEspace, lireAccordsSites, accorderSite, DeclarationSite } from "@webaios/noyau";
import { SchemaActionSite } from "../../src/commun/api";
import { modifierAvecAgent } from "../../src/commun/sites";

const journal: string[] = [];
const ouvertes = new Set<string>();

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
  FenetresSites: class {
    site = (id: string) => (ouvertes.has(id) ? { id } : undefined);
    ouvertes = () => [...ouvertes].map((id) => ({ id }));
    fermer = async (id: string) => {
      await new Promise((r) => setTimeout(r, 20));
      journal.push(`fermee ${id}`);
      ouvertes.delete(id);
    };
    ouvrir = (s: { id: string }) => void ouvertes.add(s.id);
    mettreAJour = () => false;
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

const { demarrerSites } = await import("../../src/main/sites/service");

let racine: string;
let profil: string;
let service: ReturnType<typeof demarrerSites>;
const deboguer = vi.fn();

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
