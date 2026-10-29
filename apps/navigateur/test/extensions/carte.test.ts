import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { empreintePortee, type AnalyseManifeste, type EtatExtensions, type Portee } from "@webaios/noyau";
import type { Decision, Demande, EtatNavigateur } from "../../src/commun/modele";
import { carteDe, type CarteExtension } from "../../src/commun/extensions";

vi.mock("electron", () => ({ app: { on: () => {} }, session: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { ServiceExtensions } = await import("../../src/main/extensions/service");

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

const portee = (p: Partial<Portee> = {}): Portee => ({
  permissions: [],
  hotes: [],
  reseau: [],
  tousLesSites: false,
  scriptsTousLesSites: false,
  ...p,
});
const analyse = (p: Partial<Portee> = {}): AnalyseManifeste => ({ nom: "Essai", version: "1.2.0", portee: portee(p), refus: [], avertissements: [] });

const etat = {
  espaces: [
    { id: "e1", nom: "Perso", icone: "🏠", epingles: [], prive: false, profil: "defaut" },
    { id: "e2", nom: "Travail", icone: "💼", epingles: [], prive: false, profil: "pro" },
    { id: "e3", nom: "Lecture", icone: "📚", epingles: [], prive: false, profil: "defaut" },
    { id: "e4", nom: "Achats", icone: "🛒", epingles: [], prive: false, profil: "defaut" },
  ],
} as unknown as EtatNavigateur;
const perso = etat.espaces[0]!;

test("carteDe : renforcé seulement pour l'agent avec scripts sur tous les sites", () => {
  const tous = { tousLesSites: true, scriptsTousLesSites: true, hotes: ["<all_urls>"], scripts: true };
  expect(carteDe(analyse(tous), { cle: "agent:essai", source: "agent", espace: perso, etat }).renforce).toBe(true);
  expect(carteDe(analyse(tous), { cle: `store:${"a".repeat(32)}`, source: "store", espace: perso, etat }).renforce).toBe(false);
  // Scripts sur un seul site : l'accord simple suffit.
  const unSite = { hotes: ["https://exemple.com/*"], scripts: true };
  expect(carteDe(analyse(unSite), { cle: "agent:essai", source: "agent", espace: perso, etat }).renforce).toBe(false);
});

test("carteDe : renforcé aussi pour l'agent avec scripting et un accès à tous les sites, sans script de contenu", () => {
  const p = { permissions: ["scripting"], hotes: ["<all_urls>"], tousLesSites: true };
  expect(carteDe(analyse(p), { cle: "agent:essai", source: "agent", espace: perso, etat }).renforce).toBe(true);
  // scripting limité à un site : pas de renforcé.
  const limite = { permissions: ["scripting"], hotes: ["https://exemple.com/*"] };
  expect(carteDe(analyse(limite), { cle: "agent:essai", source: "agent", espace: perso, etat }).renforce).toBe(false);
});

test("autresEspaces : les autres espaces du profil, pas l'espace lui-même", () => {
  const c = carteDe(analyse(), { cle: "agent:essai", source: "agent", espace: perso, etat });
  expect(c.espace).toBe("Perso");
  expect(c.autresEspaces).toEqual(["Lecture", "Achats"]);
  const seul = carteDe(analyse(), { cle: "agent:essai", source: "agent", espace: etat.espaces[1]!, etat });
  expect(seul.autresEspaces).toEqual([]);
});

test("carteDe : libellés, sites, réseau (null pour le Store) et mise à jour", () => {
  const p = { permissions: ["storage", "tabs"], hotes: ["https://a.com/*", "https://b.com/*"], reseau: ["api.a.com"], scripts: true };
  const agent = carteDe(analyse(p), { cle: "agent:essai", source: "agent", espace: perso, etat });
  expect(agent).toEqual({
    cle: "agent:essai",
    nom: "Essai",
    source: "agent",
    version: "1.2.0",
    droits: ["Modifier l'apparence et le contenu des pages", "Garder ses réglages", "Voir la liste des onglets et leurs adresses"],
    sites: ["https://a.com/*", "https://b.com/*"],
    tousLesSites: false,
    reseau: ["api.a.com"],
    renforce: false,
    espace: "Perso",
    espaceId: "e1",
    autresEspaces: ["Lecture", "Achats"],
    maj: null,
    empreinte: empreintePortee(portee(p)),
  } satisfies CarteExtension);
  const store = carteDe(analyse(p), { cle: `store:${"a".repeat(32)}`, source: "store", espace: perso, etat, maj: { de: "1.1.0" } });
  expect(store.reseau).toBeNull();
  expect(store.maj).toEqual({ de: "1.1.0" });
});

// demanderAccord : la carte passe par la question de la fenêtre (poserQuestion d'index.ts).
const CARTE: CarteExtension = carteDe(analyse(), { cle: "agent:essai", source: "agent", espace: perso, etat });

function avecQuestions() {
  const service = new ServiceExtensions();
  const posees: { champs: Omit<Demande, "ongletId">; repondre: (d: Decision) => void; retiree: boolean }[] = [];
  service.brancherQuestions((champs, repondre) => {
    const q = { champs, repondre, retiree: false };
    posees.push(q);
    return () => void (q.retiree = true);
  });
  return { service, posees };
}

test("demanderAccord : la carte est posée dans la fenêtre demandée ; « Activer » rend vrai", async () => {
  const { service, posees } = avecQuestions();
  const reponse = service.demanderAccord(CARTE, { fenetre: "f2" });
  expect(posees).toHaveLength(1);
  expect(posees[0]!.champs).toEqual({ permissions: ["extension"], origine: "agent:essai", extension: CARTE, fenetreId: "f2" });
  posees[0]!.repondre("autoriser");
  await expect(reponse).resolves.toEqual({ accepte: true, empreinte: CARTE.empreinte });
});

test("demanderAccord : sans délai, la carte attend l'utilisateur ; avec un délai, elle tombe et vaut refus", async () => {
  vi.useFakeTimers();
  try {
    const { service, posees } = avecQuestions();
    let finie = false;
    const sansDelai = service.demanderAccord(CARTE, {}).finally(() => (finie = true));
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(finie).toBe(false);
    expect(posees[0]!.retiree).toBe(false);
    posees[0]!.repondre("refuser");
    await expect(sansDelai).resolves.toEqual({ accepte: false, empreinte: CARTE.empreinte });

    const avecDelai = service.demanderAccord(CARTE, { delaiMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(posees[1]!.retiree).toBe(true);
    await expect(avecDelai).resolves.toMatchObject({ accepte: false });
  } finally {
    vi.useRealTimers();
  }
});

test("demanderAccord : un signal levé retire la carte et refuse ; sans questions branchées, refus", async () => {
  const { service, posees } = avecQuestions();
  const controle = new AbortController();
  const reponse = service.demanderAccord(CARTE, { signal: controle.signal });
  controle.abort();
  await expect(reponse).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(true);
  await expect(new ServiceExtensions().demanderAccord(CARTE, {})).resolves.toMatchObject({ accepte: false });
});

test("carte de test : posée au branchement, la réponse est notée à côté du fichier", async () => {
  const dossier = mkdtempSync(join(tmpdir(), "webaios-carte-"));
  temporaires.push(dossier);
  const chemin = join(dossier, "carte.json");
  writeFileSync(chemin, JSON.stringify(CARTE));
  const service = new ServiceExtensions();
  const posees: { champs: Omit<Demande, "ongletId">; repondre: (d: Decision) => void }[] = [];
  service.brancherQuestions(
    (champs, repondre) => {
      posees.push({ champs, repondre });
      return () => {};
    },
    { carteTest: chemin },
  );
  await vi.waitFor(() => expect(posees).toHaveLength(1));
  expect(posees[0]!.champs.extension).toEqual(CARTE);
  posees[0]!.repondre("autoriser");
  await vi.waitFor(() => expect(readFileSync(`${chemin}.reponse`, "utf8")).toBe("true"));
});

test("une demande identique rejoint la carte ouverte et reçoit la même réponse", async () => {
  const { service, posees } = avecQuestions();
  const premiere = service.demanderAccord(CARTE, {});
  const seconde = service.demanderAccord({ ...CARTE }, {});
  expect(posees).toHaveLength(1);
  posees[0]!.repondre("autoriser");
  await expect(seconde).resolves.toEqual({ accepte: true, empreinte: CARTE.empreinte });
  await expect(premiere).resolves.toEqual({ accepte: true, empreinte: CARTE.empreinte });
  // Réglée : une nouvelle demande pose une nouvelle carte.
  void service.demanderAccord(CARTE, {});
  expect(posees).toHaveLength(2);
});

test("même clé, autre espace, autre portée, autre mise à jour ou autre renforcé : une carte à part, chacune sa réponse", async () => {
  const { service, posees } = avecQuestions();
  const premiere = service.demanderAccord(CARTE, {});
  const autreEspace = service.demanderAccord({ ...CARTE, espaceId: "e3", espace: "Lecture" }, {});
  const autrePortee = service.demanderAccord({ ...CARTE, empreinte: "f".repeat(64) }, {});
  const autreMaj = service.demanderAccord({ ...CARTE, maj: { de: "1.0.0" } }, {});
  const autreRenforce = service.demanderAccord({ ...CARTE, renforce: true }, {});
  expect(posees).toHaveLength(5);
  expect(posees.map((q) => q.champs.extension?.espaceId)).toEqual(["e1", "e3", "e1", "e1", "e1"]);
  posees[1]!.repondre("autoriser");
  await expect(autreEspace).resolves.toEqual({ accepte: true, empreinte: CARTE.empreinte });
  posees[2]!.repondre("refuser");
  await expect(autrePortee).resolves.toEqual({ accepte: false, empreinte: "f".repeat(64) });
  // La première carte attend toujours l'utilisateur.
  expect(posees[0]!.retiree).toBe(false);
  posees[0]!.repondre("refuser");
  await expect(premiere).resolves.toMatchObject({ accepte: false });
  posees[3]!.repondre("autoriser");
  posees[4]!.repondre("autoriser");
  await expect(autreMaj).resolves.toMatchObject({ accepte: true });
  await expect(autreRenforce).resolves.toMatchObject({ accepte: true });
});

test("une demande jointe garde son propre délai : elle seule tombe, la carte reste pour la première", async () => {
  vi.useFakeTimers();
  try {
    const { service, posees } = avecQuestions();
    const premiere = service.demanderAccord(CARTE, {});
    const jointe = service.demanderAccord(CARTE, { delaiMs: 1000 });
    expect(posees).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(jointe).resolves.toMatchObject({ accepte: false });
    expect(posees[0]!.retiree).toBe(false);
    posees[0]!.repondre("autoriser");
    await expect(premiere).resolves.toMatchObject({ accepte: true });
  } finally {
    vi.useRealTimers();
  }
});

test("la première demande abandonnée pendant qu'une jointe attend : la carte reste, la jointe reçoit la réponse de l'utilisateur", async () => {
  const { service, posees } = avecQuestions();
  const controle = new AbortController();
  const premiere = service.demanderAccord(CARTE, { signal: controle.signal });
  const jointe = service.demanderAccord(CARTE, {});
  controle.abort();
  await expect(premiere).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(false);
  posees[0]!.repondre("autoriser");
  await expect(jointe).resolves.toEqual({ accepte: true, empreinte: CARTE.empreinte });
});

test("toutes les demandes d'une carte abandonnées : la carte est retirée ; une nouvelle demande en pose une autre", async () => {
  const { service, posees } = avecQuestions();
  const a = new AbortController();
  const b = new AbortController();
  const premiere = service.demanderAccord(CARTE, { signal: a.signal });
  const jointe = service.demanderAccord(CARTE, { signal: b.signal });
  a.abort();
  expect(posees[0]!.retiree).toBe(false);
  b.abort();
  await expect(premiere).resolves.toMatchObject({ accepte: false });
  await expect(jointe).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(true);
  void service.demanderAccord(CARTE, {});
  expect(posees).toHaveLength(2);
});

test("une demande jointe dont le signal tombe reçoit un refus, sans retirer la carte des autres", async () => {
  const { service, posees } = avecQuestions();
  const premiere = service.demanderAccord(CARTE, {});
  const controle = new AbortController();
  const jointe = service.demanderAccord(CARTE, { signal: controle.signal });
  controle.abort();
  await expect(jointe).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(false);
  posees[0]!.repondre("autoriser");
  await expect(premiere).resolves.toMatchObject({ accepte: true });
});

// Registre réel (dossier temporaire) : la carte tombe quand l'extension est retirée ou que tout est coupé.
const entree = (source: "store" | "agent") => ({
  source,
  idChrome: null,
  nom: "Essai",
  version: "1.0.0",
  accord: portee(),
  profils: [],
  epinglee: false,
  modifieeLe: null,
  desactivee: null,
  majEnAttente: null,
  vues: {},
});

async function avecRegistre(extensions: EtatExtensions["extensions"], toutesCoupees = false) {
  const dossier = mkdtempSync(join(tmpdir(), "webaios-carte-registre-"));
  temporaires.push(dossier);
  const gardes = join(dossier, "gardes");
  mkdirSync(gardes);
  writeFileSync(join(dossier, "etat.json"), JSON.stringify({ version: 1, toutesCoupees, extensions }));
  const nav = { espaces: [{ id: "e1", nom: "Perso", profil: "defaut", prive: false }], profils: [{ id: "defaut" }], fenetres: [], onglets: {} } as unknown as EtatNavigateur;
  const { service, posees } = avecQuestions();
  await service.demarrer({
    dossier,
    dossierGardes: gardes,
    magasin: { etat: nav, abonner: () => {} },
    profils: { synchroniser: async () => {}, erreursChargement: () => new Map(), retirerAgentsPrives: () => {} },
    sessions: { session: () => {} },
    vues: {},
  } as never);
  return { service, posees };
}

test("une carte d'une extension retirée du registre tombe et vaut refus ; celle d'une extension pas encore installée, non", async () => {
  const { service, posees } = await avecRegistre({ "agent:essai": entree("agent") });
  const retiree = service.demanderAccord(CARTE, {});
  const nouvelle = service.demanderAccord({ ...CARTE, cle: "agent:autre" }, {});
  await service.modifier((e) => ({ ...e, extensions: {} }));
  await expect(retiree).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(true);
  expect(posees[1]!.retiree).toBe(false);
  posees[1]!.repondre("autoriser");
  await expect(nouvelle).resolves.toMatchObject({ accepte: true });
});

test("« Désactiver toutes les extensions » retire les cartes ouvertes ; tant qu'il est actif, aucune carte n'est posée", async () => {
  const { service, posees } = await avecRegistre({});
  const ouverte = service.demanderAccord(CARTE, {});
  await service.modifier((e) => ({ ...e, toutesCoupees: true }));
  await expect(ouverte).resolves.toMatchObject({ accepte: false });
  expect(posees[0]!.retiree).toBe(true);
  await expect(service.demanderAccord(CARTE, {})).resolves.toMatchObject({ accepte: false });
  expect(posees).toHaveLength(1);
});

test("pendant la coupure, une carte demandée par un clic de l'utilisateur (pendantCoupure) est posée et ne tombe pas à l'écriture suivante ; une autre demande ne la rejoint pas", async () => {
  const { service, posees } = await avecRegistre({}, true);
  const ouverte = service.demanderAccord(CARTE, { pendantCoupure: true });
  expect(posees).toHaveLength(1);
  // Une demande identique sans `pendantCoupure` (l'agent) : refusée, sans rejoindre la carte.
  await expect(service.demanderAccord(CARTE, {})).resolves.toMatchObject({ accepte: false });
  await service.modifier((e) => ({ ...e, toutesCoupees: true }));
  expect(posees[0]!.retiree).toBe(false);
  posees[0]!.repondre("autoriser");
  await expect(ouverte).resolves.toMatchObject({ accepte: true });
});

test("une carte dont l'espace n'existe plus n'est pas posée", async () => {
  const { service, posees } = await avecRegistre({});
  await expect(service.demanderAccord({ ...CARTE, espaceId: "disparu" }, {})).resolves.toMatchObject({ accepte: false });
  expect(posees).toHaveLength(0);
});
