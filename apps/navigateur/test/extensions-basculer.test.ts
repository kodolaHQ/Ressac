import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {}, ipcMain: {}, webContents: {}, BrowserWindow: class {}, Menu: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));
vi.mock("electron-chrome-web-store", () => ({ installChromeWebStore: () => {} }));
const demander = vi.fn();
vi.mock("../src/main/extensions/agent", async (original) => ({ ...(await original<object>()), demanderActivation: (...a: unknown[]) => demander(...a) }));

const { ServiceExtensions } = await import("../src/main/extensions/service");
const { enFileStore } = await import("../src/main/extensions/store");
const { ERREUR_PROFIL_PRIVE } = await import("@webaios/noyau");
const { DESACTIVEE_PLANTAGES, DESACTIVEE_PORTEE } = await import("../src/commun/extensions");
const { TOUTES_COUPEES_AGENT } = await import("../src/main/extensions/agent");

const STORE = `store:${"a".repeat(32)}`;
const ACCORD = { permissions: [], hotes: ["http://127.0.0.1/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
const entree = (source: "agent" | "store", sur: Record<string, unknown> = {}) => ({
  source, idChrome: null, nom: "Ext", version: "1.0.0", accord: ACCORD, profils: [] as string[], epinglee: false, modifieeLe: null, desactivee: null, majEnAttente: null, vues: {}, ...sur,
});
const espaces = [
  { id: "e1", nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" },
  { id: "e2", nom: "Secret", icone: "🔒", epingles: [], prive: true, profil: "banque" },
];

let dossier: string;
const ecrire = (extensions: Record<string, unknown>, toutesCoupees = false) =>
  writeFileSync(join(dossier, "extensions", "etat.json"), JSON.stringify({ version: 1, toutesCoupees, extensions }));
const lire = () => JSON.parse(readFileSync(join(dossier, "extensions", "etat.json"), "utf8")) as { extensions: Record<string, { profils: string[] }> };

/** Un service démarré à la main : registre dans `dossier`, sessions et vues factices. */
function service(extensions: Record<string, unknown>, o: { memoire?: Record<string, unknown>; coupeeEnMemoire?: boolean } = {}) {
  ecrire(extensions);
  const reel = new ServiceExtensions();
  // Champs privés posés à la main (le service n'est pas démarré par Electron ici).
  const s = reel as unknown as { o: unknown; pret: boolean; etat: unknown } & Pick<typeof reel, "basculer">;
  s.o = {
    dossier: join(dossier, "extensions"),
    profils: { synchroniser: async () => {}, retirerAgentsPrives: () => {}, erreursChargement: () => new Map() },
    sessions: { session: () => ({}) },
    vues: {},
    magasin: { etat: { espaces, profils: [{ id: "defaut" }, { id: "banque" }], onglets: {}, fenetres: [] }, abonner: () => {} },
    dossierGardes: "",
    dossierAgent: join(dossier, "agent"),
  };
  s.pret = true;
  s.etat = { version: 1, toutesCoupees: o.coupeeEnMemoire ?? false, extensions: (o.memoire ?? extensions) as never };
  return s;
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-basculer-"));
  mkdirSync(join(dossier, "extensions"), { recursive: true });
  demander.mockReset();
  demander.mockResolvedValue({ ok: true });
});

test("agent avec accord valide : activée tout de suite, sans carte", async () => {
  const s = service({ "agent:cacheur": entree("agent") });
  expect(await s.basculer("agent:cacheur", "e1", true)).toEqual({ ok: true });
  expect(demander).not.toHaveBeenCalled();
  expect(lire().extensions["agent:cacheur"]!.profils).toEqual(["defaut"]);
});

test("agent sans accord : la carte (demanderActivation), rien d'écrit par l'interrupteur", async () => {
  const s = service({ "agent:cacheur": entree("agent", { accord: null }) });
  expect(await s.basculer("agent:cacheur", "e1", true, "f1")).toEqual({ ok: true });
  expect(demander).toHaveBeenCalledTimes(1);
  expect(demander.mock.calls[0]![0]).toBe("cacheur");
  expect(demander.mock.calls[0]![1]).toMatchObject({ fenetre: "f1", espace: { id: "e1" } });
  expect(lire().extensions["agent:cacheur"]!.profils).toEqual([]);
});

test("dossier de l'agent jamais accordé (absent du registre) : la carte", async () => {
  const s = service({});
  await s.basculer("agent:neuf", "e1", true);
  expect(demander.mock.calls[0]![0]).toBe("neuf");
});

test("agent dont la portée a été élargie (desactivee) : pas d'activation directe, la carte est demandée", async () => {
  const s = service({ "agent:cacheur": entree("agent", { desactivee: { raison: "portee-elargie", le: "2026-01-01T00:00:00Z" } }) });
  demander.mockResolvedValue({ ok: false, erreur: "Activation refusée" });
  expect(await s.basculer("agent:cacheur", "e1", true)).toEqual({ ok: false, erreur: "Activation refusée" });
  expect(demander).toHaveBeenCalledTimes(1);
  expect(lire().extensions["agent:cacheur"]!.profils).toEqual([]);
});

test("agent dans un profil privé : ERREUR_PROFIL_PRIVE, ni carte ni écriture", async () => {
  const s = service({ "agent:cacheur": entree("agent") });
  expect(await s.basculer("agent:cacheur", "e2", true)).toEqual({ ok: false, erreur: ERREUR_PROFIL_PRIVE });
  expect(demander).not.toHaveBeenCalled();
});

test("Store désactivée pour plantages ou portée : refus avec le bon message", async () => {
  const d = (raison: string) => ({ raison, le: "2026-01-01T00:00:00Z" });
  let s = service({ [STORE]: entree("store", { desactivee: d("plantages") }) });
  expect(await s.basculer(STORE, "e1", true)).toEqual({ ok: false, erreur: DESACTIVEE_PLANTAGES });
  s = service({ [STORE]: entree("store", { desactivee: d("portee-elargie") }) });
  expect(await s.basculer(STORE, "e1", true)).toEqual({ ok: false, erreur: DESACTIVEE_PORTEE });
  expect(lire().extensions[STORE]!.profils).toEqual([]);
});

test("désactivée pour plantages entre la décision et l'écriture : le message des plantages, pas celui de la portée", async () => {
  // La mémoire est en retard sur le disque : l'écriture sérialisée relit le registre.
  const s = service({ [STORE]: entree("store", { desactivee: { raison: "plantages", le: "2026-01-01T00:00:00Z" } }) }, { memoire: { [STORE]: entree("store") } });
  expect(await s.basculer(STORE, "e1", true)).toEqual({ ok: false, erreur: DESACTIVEE_PLANTAGES });
});

test("coupure générale : refus, aussi quand elle arrive après la décision (revérifiée dans l'écriture)", async () => {
  let s = service({ [STORE]: entree("store") }, { coupeeEnMemoire: true });
  expect(await s.basculer(STORE, "e1", true)).toEqual({ ok: false, erreur: TOUTES_COUPEES_AGENT });
  // Le disque dit « coupé », la mémoire pas encore.
  s = service({ [STORE]: entree("store") });
  ecrire({ [STORE]: entree("store") }, true);
  expect(await s.basculer(STORE, "e1", true)).toEqual({ ok: false, erreur: TOUTES_COUPEES_AGENT });
  expect(lire().extensions[STORE]!.profils).toEqual([]);
});

test("Store : l'interrupteur attend la file de l'extension (installation, mise à jour) et ne la double pas", async () => {
  const s = service({ [STORE]: entree("store") });
  let libere!: () => void;
  const bloque = enFileStore(join(dossier, "extensions"), "a".repeat(32), () => new Promise<void>((ok) => (libere = ok)));
  let fini = false;
  const r = s.basculer(STORE, "e1", true).then((x) => ((fini = true), x));
  await new Promise((ok) => setTimeout(ok, 100));
  expect(fini).toBe(false);
  libere();
  await bloque;
  expect(await r).toEqual({ ok: true });
  expect(lire().extensions[STORE]!.profils).toEqual(["defaut"]);
  // Désactiver, en parallèle d'une autre opération de la file : même ordre.
  const off = s.basculer(STORE, "e1", false);
  const on = s.basculer(STORE, "e1", true);
  expect(await off).toEqual({ ok: true });
  expect(await on).toEqual({ ok: true });
  expect(lire().extensions[STORE]!.profils).toEqual(["defaut"]);
});
