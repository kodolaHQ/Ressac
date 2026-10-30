import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { chargeesDans, ERREUR_PROFIL_PRIVE, GARDES_PAR_DEFAUT, type EtatExtensions } from "@webaios/noyau";
import type { Decision, Demande, EtatNavigateur } from "../../src/commun/modele";

vi.mock("electron", () => ({ app: { on: () => {} }, session: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { ServiceExtensions, DESACTIVEE_PORTEE } = await import("../../src/main/extensions/service");
const { DOSSIER_ABSENT } = await import("../../src/main/extensions/agent");

// Les extensions de l'agent : une copie contrôlée (vrais gardes du noyau) dans `<dossier>/copies/<id>`, accordée par la
// carte, chargée par les sessions (leurrées : on regarde l'état qu'elles reçoivent).

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

let dossier: string;
let agent: string;
let synchronisees: EtatExtensions[];
let nav: EtatNavigateur;
let cartes: Demande[];
/** Ce que fait l'utilisateur devant la carte (après avoir laissé le test agir pendant qu'elle est affichée). */
let reponse: Decision;
let pendantLaCarte: () => void;

function etatNav(prive = false): EtatNavigateur {
  return {
    version: 2,
    espaces: [{ id: "e1", nom: "Travail", icone: "x", epingles: [], prive, profil: "defaut" }],
    profils: [{ id: "defaut" }],
    essentiels: [],
    onglets: {},
    fenetres: [],
    reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
  } as unknown as EtatNavigateur;
}

const manifeste = (matches: string[]) => ({
  manifest_version: 3,
  name: "Cacheur de l'agent",
  version: "1.0.0",
  content_scripts: [{ matches, css: ["cache.css"] }],
});

function ecrire(id: string, fichiers: Record<string, string | object>): void {
  const d = join(agent, id);
  mkdirSync(d, { recursive: true });
  for (const [nom, contenu] of Object.entries(fichiers)) writeFileSync(join(d, nom), typeof contenu === "string" ? contenu : JSON.stringify(contenu));
}

function demarrer() {
  const service = new ServiceExtensions();
  const magasin = { get etat() { return nav; }, abonner: () => {} };
  const profils = {
    synchroniser: async (e: EtatExtensions) => void synchronisees.push(e),
    erreursChargement: () => new Map<string, string>(),
    retirerAgentsPrives: () => {},
  };
  const sessions = { session: () => {} };
  const pret = service.demarrer({ dossier, dossierAgent: agent, dossierGardes: GARDES_PAR_DEFAUT, magasin, profils, sessions, vues: {} } as never);
  service.brancherQuestions((champs, repondre) => {
    cartes.push({ ...champs, ongletId: null });
    pendantLaCarte();
    const r = reponse;
    setTimeout(() => repondre(r));
    return () => {};
  });
  return { service, pret };
}

const espace = () => nav.espaces[0]!;
const registre = () => JSON.parse(readFileSync(join(dossier, "etat.json"), "utf8")) as EtatExtensions;
const chargees = () => chargeesDans(synchronisees.at(-1)!, "defaut", false);
const copie = (id: string, fichier: string) => readFileSync(join(dossier, "copies", id, fichier), "utf8");
const attendre = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-ext-agent-"));
  temporaires.push(dossier);
  agent = join(dossier, "racine", "extensions");
  mkdirSync(agent, { recursive: true });
  synchronisees = [];
  nav = etatNav();
  cartes = [];
  reponse = "autoriser";
  pendantLaCarte = () => {};
});

test("modifié pendant la carte : c'est la copie montrée qui est chargée, pas le dossier modifié", async () => {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "#cache-moi { display: none }" });
  const { service, pret } = demarrer();
  await pret;
  pendantLaCarte = () =>
    ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*", "https://ailleurs.example/*"]), "cache.css": "body { display: none }" });
  expect(await service.demanderActivation("cacheur", { espace: espace() })).toEqual({ ok: true });

  expect(cartes).toHaveLength(1);
  expect(cartes[0]!.extension!.sites).toEqual(["http://127.0.0.1/*"]);
  // La copie chargée est celle qui a été montrée.
  expect(copie("cacheur", "cache.css")).toBe("#cache-moi { display: none }");
  expect(JSON.stringify(JSON.parse(copie("cacheur", "manifest.json")).content_scripts)).not.toContain("ailleurs");
  const x = registre().extensions["agent:cacheur"]!;
  expect(x.accord?.hotes).toEqual(["http://127.0.0.1/*"]);
  expect(x.profils).toEqual(["defaut"]);
  expect(x.modifieeLe).not.toBeNull();
  expect(chargees()).toEqual(["agent:cacheur"]);
  // Aucune copie d'attente ne reste.
  expect(readdirSync(join(dossier, "copies"))).toEqual(["cacheur"]);
});

test("refusée : la copie d'attente est effacée, rien n'est inscrit", async () => {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "x" });
  const { service, pret } = demarrer();
  await pret;
  reponse = "refuser";
  const r = await service.demanderActivation("cacheur", { espace: espace() });
  expect(r.ok).toBe(false);
  expect(readdirSync(join(dossier, "copies"))).toEqual([]);
  expect(existsSync(join(dossier, "etat.json"))).toBe(false);
});

test("demander l'activation dans un espace privé : ERREUR_PROFIL_PRIVE, aucune carte, aucune copie", async () => {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "x" });
  nav = etatNav(true);
  const { service, pret } = demarrer();
  await pret;
  expect(await service.demanderActivation("cacheur", { espace: espace() })).toEqual({ ok: false, erreur: ERREUR_PROFIL_PRIVE });
  expect(cartes).toEqual([]);
  expect(existsSync(join(dossier, "copies", "cacheur.attente"))).toBe(false);
});

test("l'espace devient privé pendant la carte : rien n'est activé", async () => {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "x" });
  const { service, pret } = demarrer();
  await pret;
  pendantLaCarte = () => {
    nav = etatNav(true);
  };
  expect(await service.demanderActivation("cacheur", { espace: espace() })).toEqual({ ok: false, erreur: ERREUR_PROFIL_PRIVE });
  expect(existsSync(join(dossier, "etat.json"))).toBe(false);
  expect(readdirSync(join(dossier, "copies"))).toEqual([]);
});

test("un lien symbolique sur le chemin du dossier de l'agent est refusé, sans carte", async () => {
  const ailleurs = join(dossier, "ailleurs");
  mkdirSync(ailleurs);
  writeFileSync(join(ailleurs, "manifest.json"), JSON.stringify(manifeste(["http://127.0.0.1/*"])));
  writeFileSync(join(ailleurs, "cache.css"), "x");
  symlinkSync(ailleurs, join(agent, "lien"));
  const { service, pret } = demarrer();
  await pret;
  const r = await service.demanderActivation("lien", { espace: espace() });
  expect(r.ok).toBe(false);
  expect(!r.ok && r.erreur).toMatch(/Lien symbolique refusé/);
  expect(cartes).toEqual([]);
});

test("une extension refusée par l'analyse : aucune carte, les refus sont rendus", async () => {
  ecrire("mauvaise", { "manifest.json": { ...manifeste(["http://127.0.0.1/*"]), permissions: ["debugger"] }, "cache.css": "x" });
  const { service, pret } = demarrer();
  await pret;
  const r = await service.demanderActivation("mauvaise", { espace: espace() });
  expect(r).toEqual({ ok: false, erreur: expect.stringContaining("debugger") });
  expect(cartes).toEqual([]);
});

async function activee() {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "v1" });
  const d = demarrer();
  await d.pret;
  expect(await d.service.demanderActivation("cacheur", { espace: espace() })).toEqual({ ok: true });
  cartes = [];
  return d.service;
}

test("recharger sans changement de portée : rechargée, modifieeLe mis à jour", async () => {
  const service = await activee();
  const avant = registre().extensions["agent:cacheur"]!.modifieeLe;
  await attendre(5);
  ecrire("cacheur", { "cache.css": "v2" });
  expect(await service.recharger("cacheur")).toEqual({ etat: "rechargee", detail: [] });
  expect(cartes).toEqual([]);
  expect(copie("cacheur", "cache.css")).toBe("v2");
  const x = registre().extensions["agent:cacheur"]!;
  expect(x.modifieeLe).not.toBe(avant);
  expect(x.desactivee).toBeNull();
  // Les sessions reçoivent la nouvelle marque (modifieeLe) : elles la retirent puis la rechargent.
  expect(synchronisees.at(-1)!.extensions["agent:cacheur"]!.modifieeLe).toBe(x.modifieeLe);
  expect(chargees()).toEqual(["agent:cacheur"]);
});

test("recharger avec un hôte de plus : désactivée partout avec DESACTIVEE_PORTEE", async () => {
  const service = await activee();
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*", "https://exemple.com/*"]), "cache.css": "v2" });
  expect(await service.recharger("cacheur")).toEqual({ etat: "desactivee", detail: [DESACTIVEE_PORTEE] });
  expect(cartes).toEqual([]);
  const x = registre().extensions["agent:cacheur"]!;
  expect(x.desactivee?.raison).toBe("portee-elargie");
  // L'accord est gardé jusqu'à un nouvel accord ; la copie n'est pas remplacée.
  expect(x.accord?.hotes).toEqual(["http://127.0.0.1/*"]);
  expect(copie("cacheur", "cache.css")).toBe("v1");
  expect(chargees()).toEqual([]);
  expect(readdirSync(join(dossier, "copies"))).toEqual(["cacheur"]);

  // Une nouvelle demande montre la carte de la nouvelle portée ; acceptée, elle repart.
  expect(await service.demanderActivation("cacheur", { espace: espace() })).toEqual({ ok: true });
  expect(cartes[0]!.extension!.sites).toEqual(["http://127.0.0.1/*", "https://exemple.com/*"]);
  expect(registre().extensions["agent:cacheur"]!.desactivee).toBeNull();
  expect(copie("cacheur", "cache.css")).toBe("v2");
  expect(chargees()).toEqual(["agent:cacheur"]);
});

test("recharger avec un refus : rien ne change, les refus sont rendus", async () => {
  const service = await activee();
  const avant = registre();
  ecrire("cacheur", { "manifest.json": { ...manifeste(["http://127.0.0.1/*"]), permissions: ["debugger"] } });
  const r = await service.recharger("cacheur");
  expect(r.etat).toBe("refusee");
  expect(r.detail.join()).toContain("debugger");
  expect(registre()).toEqual(avant);
  expect(copie("cacheur", "cache.css")).toBe("v1");
  expect(service.erreurs().get("agent:cacheur")).toContain("debugger");
});

test("démarrage : rechargée depuis le dossier de l'agent ; modifieeLe ne change que si le dossier a changé", async () => {
  await activee();
  const premiere = registre().extensions["agent:cacheur"]!.modifieeLe;
  // Restes d'une copie interrompue : effacés au démarrage.
  mkdirSync(join(dossier, "copies", "cacheur.1234.tmp"));
  mkdirSync(join(dossier, "copies", "cacheur.5678.ancienne"));
  mkdirSync(join(dossier, "copies", "cacheur.attente"));

  synchronisees = [];
  await demarrer().pret;
  expect(registre().extensions["agent:cacheur"]!.modifieeLe).toBe(premiere);
  expect(chargees()).toEqual(["agent:cacheur"]);
  expect(readdirSync(join(dossier, "copies"))).toEqual(["cacheur"]);

  await attendre(5);
  ecrire("cacheur", { "cache.css": "v2" });
  synchronisees = [];
  await demarrer().pret;
  expect(registre().extensions["agent:cacheur"]!.modifieeLe).not.toBe(premiere);
  expect(copie("cacheur", "cache.css")).toBe("v2");
  expect(cartes).toEqual([]);
});

test("démarrage : un dossier absent la décharge, l'entrée reste avec l'erreur « Dossier absent »", async () => {
  await activee();
  rmSync(join(agent, "cacheur"), { recursive: true });
  synchronisees = [];
  const { service, pret } = demarrer();
  await pret;
  expect(registre().extensions["agent:cacheur"]).toBeDefined();
  expect(Object.keys(synchronisees.at(-1)!.extensions)).not.toContain("agent:cacheur");
  expect(service.erreurs().get("agent:cacheur")).toBe(DOSSIER_ABSENT);

  // Le dossier revient : un rechargement la rend.
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "v1" });
  expect((await service.recharger("cacheur")).etat).toBe("rechargee");
  expect(chargees()).toEqual(["agent:cacheur"]);
  expect(service.erreurs().has("agent:cacheur")).toBe(false);
});

test("démarrage : un etat.json posé dans le dossier de l'agent n'a aucun effet", async () => {
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*"]), "cache.css": "x" });
  const faux = {
    version: 1,
    toutesCoupees: false,
    extensions: {
      "agent:cacheur": {
        source: "agent", idChrome: null, nom: "x", version: "1.0.0", profils: ["defaut"], epinglee: false, modifieeLe: null,
        desactivee: null, majEnAttente: null, vues: {},
        accord: { permissions: [], hotes: ["http://127.0.0.1/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: true },
      },
    },
  };
  writeFileSync(join(agent, "etat.json"), JSON.stringify(faux));
  await demarrer().pret;
  expect(chargees()).toEqual([]);
  expect(existsSync(join(dossier, "copies", "cacheur"))).toBe(false);
});

test("démarrage : les extensions du Store se chargent d'abord, celles de l'agent ensuite", async () => {
  await activee();
  synchronisees = [];
  await demarrer().pret;
  // Un premier chargement sans l'agent (avant qu'il ne soit prêt), puis un second qui l'ajoute.
  expect(synchronisees.length).toBeGreaterThanOrEqual(2);
  expect(Object.keys(synchronisees[0]!.extensions)).not.toContain("agent:cacheur");
  expect(Object.keys(synchronisees.at(-1)!.extensions)).toContain("agent:cacheur");
});

test("une erreur d'écriture de l'empreinte est un refus : pas d'exception, pas de copie d'attente", async () => {
  // L'agent pose un dossier là où la copie écrit son empreinte.
  mkdirSync(join(agent, "piege", "webaios-source.sha256"), { recursive: true });
  writeFileSync(join(agent, "piege", "webaios-source.sha256", "x"), "x");
  writeFileSync(join(agent, "piege", "manifest.json"), JSON.stringify(manifeste(["http://127.0.0.1/*"])));
  writeFileSync(join(agent, "piege", "cache.css"), "x");
  const { service, pret } = demarrer();
  await pret;
  const r = await service.demanderActivation("piege", { espace: espace() });
  expect(r.ok).toBe(false);
  expect(cartes).toEqual([]);
  expect(readdirSync(join(dossier, "copies"))).toEqual([]);
  const p = await service.preparerAgent("piege");
  expect(p.ok).toBe(false);
  expect(readdirSync(join(dossier, "copies"))).toEqual([]);
});

test("sans dossier de l'agent : des refus au format habituel, jamais une exception", async () => {
  const service = new ServiceExtensions();
  const magasin = { get etat() { return nav; }, abonner: () => {} };
  const profils = { synchroniser: async () => {}, erreursChargement: () => new Map<string, string>(), retirerAgentsPrives: () => {} };
  await service.demarrer({ dossier, dossierGardes: GARDES_PAR_DEFAUT, magasin, profils, sessions: { session: () => {} }, vues: {} } as never);
  expect((await service.demanderActivation("cacheur", { espace: espace() })).ok).toBe(false);
  expect((await service.recharger("cacheur")).etat).toBe("refusee");
  expect((await service.preparerAgent("cacheur")).ok).toBe(false);
});

test("dossier absent puis revenu avec un manifeste refusé : l'ancienne copie accordée repart, l'erreur est le refus", async () => {
  // Comportement voulu : comme pour toute extension chargée, un refus au rechargement laisse en place la copie accordée.
  await activee();
  rmSync(join(agent, "cacheur"), { recursive: true });
  synchronisees = [];
  const { service, pret } = demarrer();
  await pret;
  expect(service.erreurs().get("agent:cacheur")).toBe(DOSSIER_ABSENT);
  expect(chargees()).toEqual([]);

  ecrire("cacheur", { "manifest.json": { ...manifeste(["http://127.0.0.1/*"]), permissions: ["debugger"] }, "cache.css": "v2" });
  const r = await service.recharger("cacheur");
  expect(r.etat).toBe("refusee");
  expect(service.erreurs().get("agent:cacheur")).toContain("debugger");
  expect(chargees()).toEqual(["agent:cacheur"]);
  expect(copie("cacheur", "cache.css")).toBe("v1");
});

// ——— Tâche 17 (report de la tâche 11) ———

test("déjà accordée et active, mais son dossier a disparu : demanderActivation rend « Dossier absent », jamais ok", async () => {
  await activee();
  rmSync(join(agent, "cacheur"), { recursive: true });
  const { service, pret } = demarrer();
  await pret;
  cartes = [];
  const r = await service.demanderActivation("cacheur", { espace: espace() });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.erreur).toContain(DOSSIER_ABSENT);
  expect(cartes).toEqual([]);
});

test("I5 demandée pour un autre profil avec une portée élargie : la carte nomme les espaces où elle tourne déjà ; refusée, rien ne change nulle part", async () => {
  nav = etatNav();
  (nav.espaces as unknown[]).push({ id: "e2", nom: "Perso", icone: "x", epingles: [], prive: false, profil: "p2" });
  (nav.profils as unknown[]).push({ id: "p2" });
  const service = await activee();
  // Même portée, autre profil : la carte ne parle pas de remplacement.
  ecrire("cacheur", { "cache.css": "v1b" });
  reponse = "refuser";
  expect((await service.demanderActivation("cacheur", { espace: nav.espaces[1]! })).ok).toBe(false);
  expect(cartes[0]!.extension!.remplaceAussi).toEqual([]);
  cartes = [];
  // Portée élargie : la carte nomme « Travail ».
  ecrire("cacheur", { "manifest.json": manifeste(["http://127.0.0.1/*", "https://exemple.com/*"]), "cache.css": "v2" });
  expect((await service.demanderActivation("cacheur", { espace: nav.espaces[1]! })).ok).toBe(false);
  expect(cartes[0]!.extension!.remplaceAussi).toEqual(["Travail"]);
  let x = registre().extensions["agent:cacheur"]!;
  expect(x.accord?.hotes).toEqual(["http://127.0.0.1/*"]);
  expect(x.profils).toEqual(["defaut"]);
  expect(copie("cacheur", "cache.css")).toBe("v1");
  // Acceptée : la nouvelle version tourne dans les deux.
  cartes = [];
  reponse = "autoriser";
  expect(await service.demanderActivation("cacheur", { espace: nav.espaces[1]! })).toEqual({ ok: true });
  x = registre().extensions["agent:cacheur"]!;
  expect(x.accord?.hotes).toEqual(["http://127.0.0.1/*", "https://exemple.com/*"]);
  expect([...x.profils].sort()).toEqual(["defaut", "p2"]);
});
