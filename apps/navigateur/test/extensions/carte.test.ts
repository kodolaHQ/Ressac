import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import type { AnalyseManifeste, Portee } from "@webaios/noyau";
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
    autresEspaces: ["Lecture", "Achats"],
    maj: null,
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
  await expect(reponse).resolves.toBe(true);
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
    await expect(sansDelai).resolves.toBe(false);

    const avecDelai = service.demanderAccord(CARTE, { delaiMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(posees[1]!.retiree).toBe(true);
    await expect(avecDelai).resolves.toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("demanderAccord : un signal levé retire la carte et refuse ; sans questions branchées, refus", async () => {
  const { service, posees } = avecQuestions();
  const controle = new AbortController();
  const reponse = service.demanderAccord(CARTE, { signal: controle.signal });
  controle.abort();
  await expect(reponse).resolves.toBe(false);
  expect(posees[0]!.retiree).toBe(true);
  await expect(new ServiceExtensions().demanderAccord(CARTE, {})).resolves.toBe(false);
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
