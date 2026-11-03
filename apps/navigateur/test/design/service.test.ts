import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AVERTISSEMENT_CAPTURE_SITE, INDISPONIBLE_DESIGN, INDISPONIBLE_DESIGN_SITE, REMARQUE_VIDE, Remarques, type ProjetExterne } from "@webaios/noyau";

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
const calques: { bulles: unknown[]; fermees: string[]; paniers: unknown[][]; messages: unknown[][]; messagesFermes: string[] } = { bulles: [], fermees: [], paniers: [], messages: [], messagesFermes: [] };
vi.mock("../../src/main/design/calque", () => ({
  Calques: class {
    montrerBulle(cle: string, _f: unknown, place: unknown, contexte: unknown) {
      calques.bulles.push({ cle, place, contexte });
    }
    fermerBulle(cle: string) {
      calques.fermees.push(cle);
    }
    montrerPanier(...args: unknown[]) {
      calques.paniers.push(args);
    }
    fermerPanier() {}
    montrerMessage(...args: unknown[]) {
      calques.messages.push(args);
    }
    fermerMessage(cle: string) {
      calques.messagesFermes.push(cle);
    }
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
const { placeBulle, ServiceDesign } = await import("../../src/main/design/service");

afterEach(() => {
  armements.splice(0);
  calques.bulles = [];
  calques.fermees = [];
  calques.paniers = [];
  calques.messages = [];
  calques.messagesFermes = [];
  fenetre.webContents.removeAllListeners();
  vi.mocked(viseur.armerViseur).mockClear();
  vi.mocked(viseur.lireSource).mockClear();
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
  focus = vi.fn();
}

const fenetre = { getContentSize: () => [1200, 800], isDestroyed: () => false, once: () => {}, on: () => {}, webContents: new FauxWc("app://interface") };

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
const entreeClavier = (type: string) => ({ type, key: "a" });
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

test("le clavier revient à la page : au basculement, après Ajouter et après Annuler", async () => {
  const { s, wc } = service("http://localhost:15283/");
  await s.basculer(CIBLE);
  await attendre();
  expect(wc.focus).toHaveBeenCalledTimes(1);
  armements[0]!(capture);
  await attendre();
  expect(await s.ajouter(CIBLE, "Plus grand")).toEqual({ ok: true });
  expect(wc.focus).toHaveBeenCalledTimes(2);
  await attendre();
  armements[1]!(capture);
  await attendre();
  s.annuler(CIBLE);
  expect(wc.focus).toHaveBeenCalledTimes(3);
});

test("placeBulle avec hautMin 356 dans une fenêtre de 400 : y = 356", () => {
  const p = placeBulle({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, { x: 0, y: 356, width: 1200, height: 44 }, [1200, 400], { hautMin: 356, hauteur: 190 });
  expect(p).toEqual({ x: 10, y: 356, width: 320, height: 190 });
});

test("placeBulle sans options : résultats du plan 17 inchangés", () => {
  const bornes = { x: 300, y: 50, width: 900, height: 750 };
  expect(placeBulle({ x: 10, y: 20, largeur: 100, hauteur: 30 }, 1, bornes, [1200, 800])).toEqual({ x: 310, y: 106, width: 320, height: 170 });
  expect(placeBulle({ x: 1000, y: 700, largeur: 50, hauteur: 30 }, 1, bornes, [1200, 800])).toEqual({ x: 880, y: 630, width: 320, height: 170 });
});

/** Une appli de site « Tuning » (id tuning) : sa vue sous la barre de 36 px, disponibilité réglable. */
function serviceSite(o: { disponible?: boolean; sites?: { id: string; nom: string }[]; accueil?: boolean } = {}) {
  const wc = new FauxWc("https://tuning-a.localhost/");
  // L'accueil : l'interface de la fenêtre et son cadre (id 7), posé sous la barre au-dessus du bouton « Entrer ».
  const ui = new FauxWc("app://site");
  const cadre = { frameTreeNodeId: 7, url: "webaios-site://tuning/index.html", isDestroyed: () => false, send: vi.fn(), executeJavaScript: vi.fn() };
  const bornesCadre = { x: 0, y: 36, width: 1200, height: 710 };
  const bornesAccueilSite = vi.fn(async () => (etat.accueil ? bornesCadre : null));
  const fenetreSite = { getContentSize: () => [1200, 800], isDestroyed: () => false, once: () => {}, on: () => {}, focus: vi.fn() };
  const etat = { disponible: o.disponible ?? true, accueil: o.accueil ?? false };
  const remarques = new Remarques({ dossiers: { remarquesEspace: mkdtempSync(join(tmpdir(), "design-")), prive: mkdtempSync(join(tmpdir(), "design-prive-")) } });
  const ordre: string[] = [];
  let libererMenu: () => void = () => {};
  const messageSite = vi.fn();
  const fermerMenuSite = vi.fn(
    () =>
      new Promise<void>((ok) => {
        ordre.push("fermerMenu");
        libererMenu = () => {
          ordre.push("menuFerme");
          ok();
        };
      }),
  );
  const vueSite = vi.fn((id: string) =>
    id !== "tuning"
      ? null
      : etat.accueil
        ? { wc: ui as never, cadre: cadre as never, bornes: { x: 0, y: 36, width: 1200, height: 764 }, fenetre: fenetreSite as never, url: cadre.url, nom: "Tuning", barre: 36, disponible: etat.disponible }
        : { wc: wc as never, cadre: null, bornes: { x: 0, y: 36, width: 1200, height: 764 }, fenetre: fenetreSite as never, url: wc.url, nom: "Tuning", barre: 36, disponible: etat.disponible },
  );
  const s = new ServiceDesign({
    remarques,
    registre: () => ({ projets: () => [], clients: () => [] }) as never,
    applis: async () => [],
    plages: [[15280, 15284]],
    vueOnglet: () => null,
    fenetreApp: () => null,
    diffuser: vi.fn(),
    envoyer: async () => {},
    vueSite,
    sites: async () => o.sites ?? [{ id: "tuning", nom: "Tuning" }],
    messageSite,
    fermerMenuSite,
    bornesAccueilSite,
  });
  return { s, wc, ui, cadre, remarques, etat, messageSite, fermerMenuSite, vueSite, bornesAccueilSite, ordre, liberer: () => libererMenu(), fenetreSite };
}

const SITE = { type: "site", id: "tuning" } as const;
const captureSite = { ...capture, adresse: "https://tuning-a.localhost/", vue: { largeur: 1200, hauteur: 764 } };

/** Bascule le mode sur l'appli de site et libère la fermeture du menu. */
async function basculerSite(x: ReturnType<typeof serviceSite>) {
  const p = x.s.basculer(SITE);
  await attendre();
  x.liberer();
  await p;
  await attendre();
}

test("etat d'une cible site indisponible : indisponible = INDISPONIBLE_DESIGN_SITE, projet site-tuning, destination l'agent, panier compté", async () => {
  const { s, remarques } = serviceSite({ disponible: false });
  const { rect: _r, ...contexte } = captureSite;
  await remarques.ajouterAuPanier("site-tuning", { texte: "Cacher", contexte: { ...contexte, source: null }, capture: null });
  const e = await s.etat(SITE);
  expect(e.indisponible).toBe(INDISPONIBLE_DESIGN_SITE);
  expect(e.projet).toEqual({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" });
  expect(e.destination).toBe("l'agent");
  expect(e.panier).toBe(1);
  expect(e.actif).toBe(false);
  expect(e.nom).toBe("Tuning");
});

test("basculer indisponible : messageSite(tuning, INDISPONIBLE_DESIGN_SITE), armerViseur jamais appelé", async () => {
  const x = serviceSite({ disponible: false });
  await x.s.basculer(SITE);
  await attendre();
  expect(x.messageSite).toHaveBeenCalledWith("tuning", INDISPONIBLE_DESIGN_SITE);
  expect(x.fermerMenuSite).not.toHaveBeenCalled();
  expect(viseur.armerViseur).not.toHaveBeenCalled();
  expect((await x.s.etat(SITE)).actif).toBe(false);
});

test("basculer disponible : fermerMenuSite attendu avant armerViseur ; la capture n'est pas lue dans la page, bulle avertie sous la barre", async () => {
  const x = serviceSite();
  const p = x.s.basculer(SITE);
  await attendre();
  expect(x.fermerMenuSite).toHaveBeenCalledWith("tuning");
  expect(viseur.armerViseur).not.toHaveBeenCalled();
  x.liberer();
  await p;
  await attendre();
  expect(x.ordre).toEqual(["fermerMenu", "menuFerme"]);
  expect(viseur.armerViseur).toHaveBeenCalledTimes(1);
  // La vue est relue après la fermeture du menu (bornes à jour).
  expect(x.vueSite.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(x.wc.focus).toHaveBeenCalled();
  expect((await x.s.etat(SITE)).actif).toBe(true);
  armements[0]!(captureSite);
  await attendre();
  expect(viseur.lireSource).not.toHaveBeenCalled();
  expect(calques.bulles).toHaveLength(1);
  const b = calques.bulles[0] as { cle: string; place: unknown; contexte: { source: unknown; avertissement: unknown; projet: unknown } };
  expect(b.cle).toBe("site:tuning");
  expect(b.place).toEqual({ x: 10, y: 92, width: 320, height: 190 });
  expect(b.contexte.source).toBeNull();
  expect(b.contexte.avertissement).toBe(AVERTISSEMENT_CAPTURE_SITE);
  expect(b.contexte.projet).toBe("site-tuning");
  expect(await x.s.ajouter(SITE, "Cacher la bannière")).toEqual({ ok: true });
  const [e] = await x.remarques.panier("site-tuning");
  expect(e?.type === "design" && e.contexte.source).toBeNull();
});

test("basculer disponible puis indisponible le temps de fermer le menu : rien n'est armé, le message est dit", async () => {
  const x = serviceSite();
  const p = x.s.basculer(SITE);
  await attendre();
  x.etat.disponible = false;
  x.liberer();
  await p;
  await attendre();
  expect(viseur.armerViseur).not.toHaveBeenCalled();
  expect(x.messageSite).toHaveBeenCalledWith("tuning", INDISPONIBLE_DESIGN_SITE);
  expect((await x.s.etat(SITE)).actif).toBe(false);
});

test("site : navigation d'un autre document pendant la bulle : mode arrêté, bulle fermée, panier inchangé", async () => {
  const x = serviceSite();
  await basculerSite(x);
  armements[0]!(captureSite);
  await attendre();
  expect(await x.s.ajouter(SITE, "Plus grand")).toEqual({ ok: true });
  await attendre();
  armements[1]!(captureSite);
  await attendre();
  expect(calques.bulles).toHaveLength(2);
  calques.fermees = [];
  x.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, url: "https://tuning-a.localhost/autre" });
  await attendre();
  expect((await x.s.etat(SITE)).actif).toBe(false);
  expect(calques.fermees).toContain("site:tuning");
  expect(await x.remarques.panier("site-tuning")).toHaveLength(1);
});

test("site : navigation dans le même document : le mode reste, le viseur est réarmé", async () => {
  const x = serviceSite();
  await basculerSite(x);
  x.wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true, url: "https://tuning-a.localhost/#x" });
  armements[0]!(null);
  await attendre();
  expect((await x.s.etat(SITE)).actif).toBe(true);
  expect(viseur.armerViseur).toHaveBeenCalledTimes(2);
});

test("accueil : le viseur vise son cadre, la source y est lue, capture décalée du cadre, bulle sans avertissement", async () => {
  const x = serviceSite({ accueil: true });
  await basculerSite(x);
  expect(viseur.armerViseur).toHaveBeenCalledWith(x.ui, x.cadre);
  armements[0]!({ ...captureSite, adresse: "webaios-site://tuning/index.html", vue: { largeur: 1200, hauteur: 710 } });
  await attendre();
  expect(viseur.lireSource).toHaveBeenCalledWith(x.ui, captureSite.selecteur, x.cadre);
  expect(viseur.capturerElement).toHaveBeenCalledWith(x.ui, captureSite.rect, { largeur: 1200, hauteur: 710 }, { x: 0, y: 36, width: 1200, height: 710 });
  const b = calques.bulles[0] as { place: unknown; contexte: { source: unknown; avertissement: unknown } };
  expect(b.place).toEqual({ x: 10, y: 92, width: 320, height: 170 });
  expect(b.contexte.avertissement).toBeNull();
  expect(b.contexte.source).toBe("src/Inscription.svelte:12");
  expect(await x.s.ajouter(SITE, "Titre plus gros")).toEqual({ ok: true });
  const [e] = await x.remarques.panier("site-tuning");
  expect(e?.type === "design" && e.contexte.adresse).toBe("webaios-site://tuning/index.html");
});

test("accueil : une navigation de son cadre arrête le mode ; celle d'un autre cadre ou de la page de l'interface, non", async () => {
  const x = serviceSite({ accueil: true });
  await basculerSite(x);
  x.ui.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false, frame: { frameTreeNodeId: 99 } });
  x.ui.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false, frame: { frameTreeNodeId: 1 } });
  await attendre();
  expect((await x.s.etat(SITE)).actif).toBe(true);
  x.ui.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false, frame: { frameTreeNodeId: 7 } });
  await attendre();
  expect((await x.s.etat(SITE)).actif).toBe(false);
  expect(viseur.desarmerViseur).toHaveBeenCalledWith(x.ui, x.cadre);
});

test("accueil quitté pendant la visée (bornes du cadre introuvables) : le mode s'arrête, aucune bulle", async () => {
  const x = serviceSite({ accueil: true });
  await basculerSite(x);
  x.etat.accueil = false;
  armements[0]!(captureSite);
  await attendre();
  expect(calques.bulles).toHaveLength(0);
  expect((await x.s.etat(SITE)).actif).toBe(false);
});

test("projetSuivi(site-tuning) : nom de sites() ; absent de sites() → null", async () => {
  expect(await serviceSite().s.projetSuivi("site-tuning")).toEqual({ type: "site", projet: "site-tuning", id: "tuning", nom: "Tuning" });
  expect(await serviceSite({ sites: [{ id: "autre", nom: "Autre" }] }).s.projetSuivi("site-tuning")).toBeNull();
});

test("ouvrirPanier(site) : montrerPanier reçoit la marge 48, sans avertissement", async () => {
  const x = serviceSite({ disponible: false });
  await x.s.ouvrirPanier(SITE);
  expect(calques.paniers).toHaveLength(1);
  const [cle, f, contexte, marge] = calques.paniers[0]!;
  expect(cle).toBe("site:tuning");
  expect(f).toBe(x.fenetreSite);
  expect(contexte).toMatchObject({ mode: "panier", projet: "site-tuning", destination: "l'agent", avertissement: null });
  expect(marge).toBe(48);
});

test("basculer sur https://exemple.fr : montrerMessage avec INDISPONIBLE_DESIGN, placé en haut à droite de la vue ({ x: 828, y: 62, width: 360, height: 56 }) ; basculer sur la démo 15283 : aucun montrerMessage", async () => {
  const { s, wc } = service("https://exemple.fr/");
  await s.basculer(CIBLE);
  await s.basculer(CIBLE);
  expect(calques.messages).toHaveLength(2);
  const [cle, f, place, texte] = calques.messages[0]!;
  expect(cle).toBe("fenetre:f1");
  expect(f).toBe(fenetre);
  expect(place).toEqual({ x: 828, y: 62, width: 360, height: 56 });
  expect(texte).toBe(INDISPONIBLE_DESIGN);
  // La frappe suivante le ferme ; l'écouteur est posé une seule fois, sur la page et sur l'interface.
  expect(wc.listenerCount("before-input-event")).toBe(1);
  expect(fenetre.webContents.listenerCount("before-input-event")).toBe(1);
  wc.emit("before-input-event", {}, entreeClavier("keyUp"));
  expect(calques.messagesFermes).toEqual([]);
  fenetre.webContents.emit("before-input-event", {}, entreeClavier("keyDown"));
  expect(calques.messagesFermes).toEqual(["fenetre:f1"]);
  expect(wc.listenerCount("before-input-event")).toBe(0);
  expect(fenetre.webContents.listenerCount("before-input-event")).toBe(0);

  const demo = service("http://localhost:15283/");
  await demo.s.basculer(CIBLE);
  await attendre();
  expect(calques.messages).toHaveLength(2);
  expect(demo.wc.listenerCount("before-input-event")).toBe(0);
});
