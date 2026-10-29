import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import type { EtatExtensions } from "@webaios/noyau";
import type { EtatNavigateur } from "../../src/commun/modele";

vi.mock("electron", () => ({ app: { on: () => {} }, session: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { ServiceExtensions } = await import("../../src/main/extensions/service");

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

const ID = "c".repeat(32);
const accord = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
const entree = (source: "store" | "agent", profils: string[]) => ({
  source,
  idChrome: null,
  nom: "essai",
  version: "1.0.0",
  accord,
  profils,
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
});

let dossier: string;
let gardes: string;
let synchronisees: EtatExtensions[];
let branchees: string[];
let abonnes: ((e: EtatNavigateur) => void)[];
let nav: EtatNavigateur;

const etatNav = (prive: boolean) =>
  ({ espaces: [{ id: "e1", profil: "defaut", prive }], profils: [{ id: "defaut" }], fenetres: [], onglets: {} }) as unknown as EtatNavigateur;

function demarrer() {
  const service = new ServiceExtensions();
  const magasin = { get etat() { return nav; }, abonner: (f: (e: EtatNavigateur) => void) => void abonnes.push(f) };
  const profils = { synchroniser: async (e: EtatExtensions) => void synchronisees.push(e), erreursChargement: () => new Map<string, string>() };
  const sessions = { session: (id: string) => void branchees.push(id) };
  return {
    service,
    pret: service.demarrer({ dossier, dossierGardes: gardes, magasin, profils, sessions, vues: {} } as never),
  };
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-ext-service-"));
  temporaires.push(dossier);
  gardes = join(dossier, "gardes");
  mkdirSync(gardes);
  writeFileSync(join(gardes, "webaios-correctifs-page.js"), "// correctifs\n");
  synchronisees = [];
  branchees = [];
  abonnes = [];
  nav = etatNav(false);
});

test("registre illisible : aucune extension chargée, et le démarrage ne lève pas", async () => {
  mkdirSync(join(dossier, "etat.json")); // un dossier à la place du fichier : EISDIR, pas ENOENT
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(demarrer().pret).resolves.toBeUndefined();
  expect(synchronisees).toEqual([]);
  expect(branchees).toEqual([]);
  expect(erreur).toHaveBeenCalled();
  erreur.mockRestore();
});

test("démarrage : le Store préparé est chargé, celui dont la préparation échoue ne l'est pas et garde son erreur", async () => {
  const version = join(dossier, "store", ID, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] }));
  writeFileSync(
    join(dossier, "etat.json"),
    JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`store:${ID}`]: entree("store", ["defaut"]), [`store:${"d".repeat(32)}`]: entree("store", ["defaut"]), "agent:essai": entree("agent", ["defaut"]) } }),
  );
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const { service, pret } = demarrer();
  await pret;
  erreur.mockRestore();
  expect(Object.keys(synchronisees.at(-1)!.extensions).sort()).toEqual(["agent:essai", `store:${ID}`]);
  expect(service.erreurs().get(`store:${"d".repeat(32)}`)).toMatch(/ENOENT/);
  // La session du profil où une extension est active est branchée tout de suite.
  expect(branchees).toContain("defaut");
});

test("un espace qui devient privé relance la synchronisation ; un changement sans effet sur les profils, non", async () => {
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { "agent:essai": entree("agent", ["defaut"]) } }));
  await demarrer().pret;
  expect(synchronisees).toHaveLength(1);
  for (const f of abonnes) f(nav);
  expect(synchronisees).toHaveLength(1);
  nav = etatNav(true);
  for (const f of abonnes) f(nav);
  await vi.waitFor(() => expect(synchronisees).toHaveLength(2));
});
