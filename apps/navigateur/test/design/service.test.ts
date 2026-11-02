import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { INDISPONIBLE_DESIGN, REMARQUE_VIDE, Remarques, type ProjetExterne } from "@webaios/noyau";

vi.mock("electron", () => ({ WebContentsView: vi.fn(), BrowserWindow: vi.fn() }));

/** Le viseur simulé : chaque armement rend une promesse que le test résout. */
const armements: ((v: unknown) => void)[] = [];
vi.mock("../../src/main/design/viseur", () => ({
  armerViseur: vi.fn(() => new Promise((ok) => armements.push(ok))),
  desarmerViseur: vi.fn(async () => {
    armements.splice(0).forEach((ok) => ok(null));
  }),
  lireSource: vi.fn(async () => ({ fichier: "src/Inscription.svelte", ligne: 12 })),
  capturerElement: vi.fn(async () => null),
}));

/** Le calque simulé : on note ce qu'il montre. */
const calques: { bulles: unknown[]; fermees: string[] } = { bulles: [], fermees: [] };
vi.mock("../../src/main/design/calque", () => ({
  Calques: class {
    montrerBulle(cle: string, _f: unknown, place: unknown, contexte: unknown) {
      calques.bulles.push({ cle, place, contexte });
    }
    fermerBulle(cle: string) {
      calques.fermees.push(cle);
    }
    montrerPanier() {}
    fermerPanier() {}
    estOuvert() {
      return false;
    }
    cibleDe() {
      return undefined;
    }
    contexte() {
      return null;
    }
    notifier() {}
    oublier() {}
  },
}));

const viseur = await import("../../src/main/design/viseur");
const { ServiceDesign } = await import("../../src/main/design/service");

afterEach(() => {
  armements.splice(0);
  calques.bulles = [];
  calques.fermees = [];
  vi.mocked(viseur.armerViseur).mockClear();
});

class FauxWc extends EventEmitter {
  constructor(public url: string) {
    super();
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
  getZoomFactor() {
    return 1;
  }
}

const fenetre = { getContentSize: () => [1200, 800], isDestroyed: () => false, once: () => {}, on: () => {} };

function service(url: string, o: { externes?: ProjetExterne[] } = {}) {
  const wc = new FauxWc(url);
  const remarques = new Remarques({ dossiers: { remarquesEspace: mkdtempSync(join(tmpdir(), "design-")), prive: mkdtempSync(join(tmpdir(), "design-prive-")) } });
  const diffuser = vi.fn();
  const s = new ServiceDesign({
    remarques,
    registre: () => ({ projets: () => o.externes ?? [], clients: () => [] }) as never,
    applis: async () => [],
    plages: [[15280, 15284]],
    vueOnglet: () => ({ wc: wc as never, bornes: { x: 300, y: 50, width: 900, height: 750 }, fenetre: fenetre as never, url: wc.url }),
    fenetreApp: () => null,
    diffuser,
    envoyer: async () => {},
  });
  return { s, wc, remarques, diffuser };
}

const CIBLE = { type: "fenetre", fenetreId: "f1" } as const;
const capture = {
  selecteur: "#email", etiquette: "input#email.champ", html: '<input id="email">', voisinage: { parent: "form#inscription", freres: [] },
  styles: {}, rect: { x: 10, y: 20, largeur: 100, hauteur: 30 }, adresse: "http://localhost:15283/", vue: { largeur: 900, hauteur: 750 },
};
const attendre = () => new Promise((r) => setTimeout(r, 10));

test("etat d'un onglet https://exemple.fr : indisponible", async () => {
  const { s } = service("https://exemple.fr/");
  const e = await s.etat(CIBLE);
  expect(e.indisponible).toBe(INDISPONIBLE_DESIGN);
  expect(e.projet).toBeNull();
  expect(e.actif).toBe(false);
});

test("etat de localhost:15283 : demo-15283, destination l'agent", async () => {
  const { s } = service("http://localhost:15283/");
  const e = await s.etat(CIBLE);
  expect(e.indisponible).toBeNull();
  expect(e.projet?.projet).toBe("demo-15283");
  expect(e.destination).toBe("l'agent");
  expect(e.panier).toBe(0);
});

test("etat du port d'un projet externe sans client : destination null", async () => {
  const externe: ProjetExterne = { id: "0123456789abcdef", nom: "Site", dossier: "/tmp/site", ports: [4321], client: null, declare: "2026-11-02T00:00:00Z" };
  const { s } = service("http://127.0.0.1:4321/", { externes: [externe] });
  const e = await s.etat(CIBLE);
  expect(e.projet?.projet).toBe("ext-0123456789abcdef");
  expect(e.indisponible).toBeNull();
  expect(e.destination).toBeNull();
});

test("basculer sur une cible indisponible : le viseur n'est jamais armé", async () => {
  const { s } = service("https://exemple.fr/");
  await s.basculer(CIBLE);
  await attendre();
  expect(viseur.armerViseur).not.toHaveBeenCalled();
  expect((await s.etat(CIBLE)).actif).toBe(false);
});

test("navigation pendant le mode : arreter appelé, panier inchangé", async () => {
  const { s, wc, remarques } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  expect(viseur.armerViseur).toHaveBeenCalledTimes(1);
  armements[0]!(capture);
  await attendre();
  expect(calques.bulles).toHaveLength(1);
  expect(await s.ajouter(CIBLE, "Plus grand")).toEqual({ ok: true });
  await attendre();
  expect(viseur.armerViseur).toHaveBeenCalledTimes(2);
  const arreter = vi.spyOn(s, "arreter");
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "http://localhost:15283/autre" });
  await attendre();
  expect(arreter).toHaveBeenCalledWith(CIBLE);
  expect((await s.etat(CIBLE)).actif).toBe(false);
  expect(await remarques.panier("demo-15283")).toHaveLength(1);
});

test("navigation dans le même document : le mode reste, le viseur est réarmé", async () => {
  const { s, wc } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url: "http://localhost:15283/x" });
  armements[0]!(null);
  await attendre();
  expect((await s.etat(CIBLE)).actif).toBe(true);
  expect(viseur.armerViseur).toHaveBeenCalledTimes(2);
});

test("Échap dans la page (viseur rendu null) : le mode s'arrête", async () => {
  const { s } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  armements[0]!(null);
  await attendre();
  expect((await s.etat(CIBLE)).actif).toBe(false);
});

test("ajouter avec un texte vide : REMARQUE_VIDE, la bulle reste ouverte", async () => {
  const { s, remarques } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  armements[0]!(capture);
  await attendre();
  expect(await s.ajouter(CIBLE, "   ")).toEqual({ ok: false, erreur: REMARQUE_VIDE });
  expect(calques.fermees).toEqual([]);
  expect(viseur.armerViseur).toHaveBeenCalledTimes(1);
  expect(await remarques.panier("demo-15283")).toHaveLength(0);
  // La remarque garde la source lue et la capture en attente.
  expect(await s.ajouter(CIBLE, "Bordure rouge")).toEqual({ ok: true });
  const [e] = await remarques.panier("demo-15283");
  expect(e?.type === "design" && e.contexte.source).toEqual({ fichier: "src/Inscription.svelte", ligne: 12 });
});

test("la bulle se pose sous l'élément, décalée des bornes de la vue, bornée à la fenêtre", async () => {
  const { s } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  armements[0]!(capture);
  await attendre();
  expect((calques.bulles[0] as { place: unknown }).place).toEqual({ x: 310, y: 106, width: 320, height: 170 });
  await s.annuler(CIBLE);
  await attendre();
  armements[1]!({ ...capture, rect: { x: 1000, y: 700, largeur: 50, hauteur: 30 } });
  await attendre();
  expect((calques.bulles[1] as { place: unknown }).place).toEqual({ x: 880, y: 630, width: 320, height: 170 });
});
