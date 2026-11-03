import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DeclarationSite } from "@webaios/noyau";
import { CANAUX } from "../../src/commun/canaux";
import { DUREE_AVIS_INFO_MS, HAUTEUR_BARRE_SITE, type EtatFenetreSite } from "../../src/commun/sites";

// `INVISIBLE` est lu à l'import de fenetres.ts ; posé ici avant l'import dynamique (comme en e2e).
process.env.WEBAIOS_INVISIBLE = "1";

/** Une page (vue du site, interface, petite fenêtre) : ce que FenetresSites lit et appelle, sans Electron. */
function fausseWc() {
  let url = "";
  let detruite = false;
  const wc = {
    charges: [] as string[],
    on: vi.fn(),
    once: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    loadFile: vi.fn(async () => {}),
    loadURL: vi.fn(async (u: string) => {
      url = u;
      wc.charges.push(u);
    }),
    reload: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(() => void (detruite = true)),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: () => detruite,
    detruire: () => void (detruite = true),
    getURL: () => url,
    /** Comme une page qui a navigué d'elle-même (sans `loadURL`). */
    poserURL: (u: string) => void (url = u),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    /** Les cadres de la page (l'accueil d'une appli, dans l'interface de sa fenêtre). */
    mainFrame: { frames: [] as { url: string; isDestroyed: () => boolean }[] },
  };
  return wc;
}
type FausseWc = ReturnType<typeof fausseWc>;

type FausseFenetre = { webContents: FausseWc; destroy(): void; isDestroyed(): boolean };
const fenetresCreees: FausseFenetre[] = [];
type Bornes = { x: number; y: number; width: number; height: number };
const vuesCreees: { webContents: FausseWc; bornes: Bornes | null }[] = [];
/** La fenêtre au premier plan que rend `BrowserWindow.getFocusedWindow()`. */
let auPremierPlan: unknown = null;

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = fausseWc();
    contentView = { addChildView: vi.fn() };
    detruite = false;
    private readonly ecouteurs = new Map<string, (() => void)[]>();
    constructor(public options: Record<string, unknown>) {
      fenetresCreees.push(this as unknown as FausseFenetre);
    }
    on = vi.fn((e: string, f: () => void) => void this.ecouteurs.set(e, [...(this.ecouteurs.get(e) ?? []), f]));
    show = vi.fn();
    focus = vi.fn();
    destroy = () => {
      if (this.detruite) return;
      this.detruite = true;
      this.webContents.detruire();
      for (const f of this.ecouteurs.get("closed") ?? []) f();
    };
    close = () => this.destroy();
    isDestroyed = () => this.detruite;
    isFullScreen = () => false;
    getNormalBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
    isMinimized = () => false;
    getContentSize = () => [1200, 800];
    static getFocusedWindow = () => auPremierPlan;
  },
  WebContentsView: class {
    webContents = fausseWc();
    bornes: Bornes | null = null;
    constructor() {
      vuesCreees.push(this);
    }
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
    setBounds = (b: Bornes) => void (this.bornes = b);
    getBounds = () => this.bornes ?? { x: 0, y: 0, width: 0, height: 0 };
  },
}));
vi.mock("../../src/main/sites/session", () => ({ preferencesSite: () => ({}), sessionSite: () => ({ extensions: { getExtension: () => null } }) }));
vi.mock("../../src/main/applications/fenetres", () => ({ cadreVisible: () => ({}) }));
vi.mock("../../src/main/agent/accueil", () => ({ navigationCadrePermise: () => false }));
vi.mock("../../src/main/applications/favicon", () => ({ faviconEnDonnees: async () => null }));

const { FenetresSites, DELAI_FERMETURE_MENU_MS } = await import("../../src/main/sites/fenetres");
const { BrowserWindow } = await import("electron");

const DEPART = "https://tuning.test/";
const declaration: DeclarationSite = {
  nom: "Tuning",
  description: "",
  adresse: DEPART,
  domaines: ["tuning.test"],
  connexion: ["compte.test"],
  retouches: [],
  reprise: false,
};
const site = { id: "tuning", declaration, domaines: ["tuning.test"], depart: DEPART, aAccueil: false, accordRequis: false };

const surInterruption = vi.fn();
function fenetres() {
  return new FenetresSites({ memoire: { lire: () => ({}), noter: vi.fn() }, adressesLocales: false, ouvrirOnglet: vi.fn(), surInterruption });
}

beforeEach(() => {
  fenetresCreees.splice(0);
  vuesCreees.splice(0);
  surInterruption.mockClear();
  auPremierPlan = null;
});
afterEach(() => {
  vi.useRealTimers();
});

/** Le gestionnaire `evenement` posé sur une page. */
const ecouteur = (wc: FausseWc, evenement: string) => wc.on.mock.calls.find((c) => c[0] === evenement)![1] as (...a: unknown[]) => void;

/** Les états diffusés à l'interface de la fenêtre de l'appli. */
const diffuses = (f: FausseFenetre) => f.webContents.send.mock.calls.filter((c) => c[0] === CANAUX.siteEtatChange).map((c) => c[1] as EtatFenetreSite);

/** Ouvre l'appli en vue « site », la page sur `url`. */
function ouvrirSur(url = "https://tuning.test/x", s = site) {
  const f = fenetres();
  f.ouvrir(s);
  const vue = vuesCreees[0]!.webContents;
  vue.poserURL(url);
  return { f, vue, fenetre: fenetresCreees[0]! };
}

test("vueDesign : disponible en vue « site » sur https://tuning.test/x ; rend la vue, la fenêtre, l'adresse et le nom", () => {
  const { f, vue, fenetre } = ouvrirSur();
  const v = f.vueDesign("tuning");
  expect(v).not.toBeNull();
  expect(v!.disponible).toBe(true);
  expect(v!.wc).toBe(vue);
  expect(v!.fenetre).toBe(fenetre);
  expect(v!.url).toBe("https://tuning.test/x");
  expect(v!.nom).toBe("Tuning");
  expect(f.vueDesign("autre")).toBeNull();
});

test("vueDesign : null quand la vue est détruite ou la fenêtre fermée", () => {
  const { f, vue, fenetre } = ouvrirSur();
  vue.detruire();
  expect(f.vueDesign("tuning")).toBeNull();
  fenetre.destroy();
  expect(f.vueDesign("tuning")).toBeNull();
});

test("vueDesign sur l'accueil : l'interface et le cadre de son accueil (pas celui d'une autre appli) ; indisponible tant que le cadre manque", () => {
  const { f, fenetre } = ouvrirSur("https://tuning.test/x", { ...site, aAccueil: true });
  expect(f.vueDesign("tuning")!.disponible).toBe(false);
  const autre = { url: "webaios-site://vidola/index.html", isDestroyed: () => false };
  const sien = { url: "webaios-site://tuning/index.html", isDestroyed: () => false };
  fenetre.webContents.mainFrame.frames.push(autre);
  expect(f.vueDesign("tuning")!.disponible).toBe(false);
  fenetre.webContents.mainFrame.frames.push(sien);
  const v = f.vueDesign("tuning")!;
  expect(v.disponible).toBe(true);
  expect(v.wc).toBe(fenetre.webContents);
  expect(v.cadre).toBe(sien);
  expect(v.url).toBe("webaios-site://tuning/index.html");
  // Entrer dans le site depuis l'accueil interrompt le mode ; la vue du site reprend, sans cadre.
  surInterruption.mockClear();
  f.entrer("tuning");
  expect(surInterruption).toHaveBeenCalledWith("tuning");
  expect(f.vueDesign("tuning")!.cadre).toBeNull();
});

test("vueDesign : indisponible sur la carte d'accord, en plein écran d'un élément, sur une page de connexion, sur about:blank et \"\"", () => {
  // L'accueil (⌂).
  const a = ouvrirSur("https://tuning.test/x", { ...site, aAccueil: true });
  a.f.entrer("tuning");
  a.vue.poserURL("https://tuning.test/x");
  expect(a.f.vueDesign("tuning")!.disponible).toBe(true);
  a.f.accueil("tuning");
  // Accueil affiché mais son cadre pas encore là.
  expect(a.f.vueDesign("tuning")!.disponible).toBe(false);
  a.fenetre.destroy();

  // La carte d'accord.
  vuesCreees.splice(0);
  fenetresCreees.splice(0);
  const c = ouvrirSur("https://tuning.test/x", { ...site, accordRequis: true });
  expect(c.f.vueDesign("tuning")!.disponible).toBe(false);
  c.fenetre.destroy();

  // Plein écran d'un élément, puis sa sortie.
  vuesCreees.splice(0);
  fenetresCreees.splice(0);
  const p = ouvrirSur();
  ecouteur(p.vue, "enter-html-full-screen")();
  expect(p.f.vueDesign("tuning")!.disponible).toBe(false);
  ecouteur(p.vue, "leave-html-full-screen")();
  expect(p.f.vueDesign("tuning")!.disponible).toBe(true);

  // Page de connexion, page vide, page pas encore chargée.
  for (const url of ["https://compte.test/connexion", "about:blank", ""]) {
    p.vue.poserURL(url);
    expect(p.f.vueDesign("tuning")!.disponible, url).toBe(false);
  }
});

test("plein écran : l'état est rediffusé à l'entrée et à la sortie (la barre relit la disponibilité)", () => {
  const { vue, fenetre } = ouvrirSur();
  const avant = diffuses(fenetre).length;
  ecouteur(vue, "enter-html-full-screen")();
  expect(diffuses(fenetre).length).toBe(avant + 1);
  ecouteur(vue, "leave-html-full-screen")();
  expect(diffuses(fenetre).length).toBe(avant + 2);
});

test("un domaine à la fois dans domaines et connexion (ou un sous-domaine d'un domaine de connexion) : indisponible, adressePermise reste vrai", () => {
  const d = { ...declaration, domaines: ["tuning.test", "compte.test", "sso.auth.test"], connexion: ["compte.test", "auth.test"] };
  const s = { ...site, declaration: d, domaines: d.domaines };
  const { f, vue } = ouvrirSur("https://compte.test/x", s);
  expect(f.adressePermise("tuning", "https://compte.test/x")).toBe(true);
  expect(f.vueDesign("tuning")!.disponible).toBe(false);
  vue.poserURL("https://sso.auth.test/y");
  expect(f.adressePermise("tuning", "https://sso.auth.test/y")).toBe(true);
  expect(f.vueDesign("tuning")!.disponible).toBe(false);
  vue.poserURL("https://tuning.test/z");
  expect(f.vueDesign("tuning")!.disponible).toBe(true);
});

test("vueDesign.bornes et barre : sous la barre, repoussées par le menu « Extensions », toute la fenêtre en plein écran", () => {
  const { f, vue } = ouvrirSur();
  expect(f.vueDesign("tuning")!.bornes).toEqual({ x: 0, y: HAUTEUR_BARRE_SITE, width: 1200, height: 800 - HAUTEUR_BARRE_SITE });
  expect(f.vueDesign("tuning")!.barre).toBe(HAUTEUR_BARRE_SITE);
  f.panneauExtensions("tuning", 120);
  expect(f.vueDesign("tuning")!.barre).toBe(156);
  expect(f.vueDesign("tuning")!.bornes.y).toBe(156);
  f.panneauExtensions("tuning", 0);
  ecouteur(vue, "enter-html-full-screen")();
  expect(f.vueDesign("tuning")!.bornes.y).toBe(0);
});

test("surInterruption : une fois pour entrer() depuis l'accueil et pour accueil(), pour enter-html-full-screen, pour l'ouverture du menu (pas une seconde hauteur, ni 0), et quand mettreAJour passe à la carte", () => {
  const a = ouvrirSur("https://tuning.test/x", { ...site, aAccueil: true });
  a.f.entrer("tuning");
  expect(surInterruption).toHaveBeenCalledTimes(1);
  surInterruption.mockClear();
  a.f.entrer("tuning");
  expect(surInterruption).not.toHaveBeenCalled();
  a.f.accueil("tuning");
  expect(surInterruption).toHaveBeenCalledTimes(1);
  expect(surInterruption).toHaveBeenLastCalledWith("tuning");
  a.fenetre.destroy();

  vuesCreees.splice(0);
  fenetresCreees.splice(0);
  surInterruption.mockClear();
  const p = ouvrirSur();
  ecouteur(p.vue, "enter-html-full-screen")();
  expect(surInterruption).toHaveBeenCalledTimes(1);
  ecouteur(p.vue, "leave-html-full-screen")();
  expect(surInterruption).toHaveBeenCalledTimes(1);

  surInterruption.mockClear();
  p.f.panneauExtensions("tuning", 120);
  expect(surInterruption).toHaveBeenCalledTimes(1);
  p.f.panneauExtensions("tuning", 200);
  p.f.panneauExtensions("tuning", 0);
  expect(surInterruption).toHaveBeenCalledTimes(1);
  p.f.panneauExtensions("tuning", 80);
  expect(surInterruption).toHaveBeenCalledTimes(2);
  p.f.panneauExtensions("tuning", 0);

  surInterruption.mockClear();
  p.f.mettreAJour({ ...site, accordRequis: true });
  expect(p.f.etat("tuning")?.vue).toBe("accord");
  expect(surInterruption).toHaveBeenCalledTimes(1);
  expect(surInterruption).toHaveBeenLastCalledWith("tuning");
});

test("avisInfo : diffusée, effacée après 5 s ; une seconde repart de 5 s ; un did-navigate l'efface", () => {
  vi.useFakeTimers();
  expect(DUREE_AVIS_INFO_MS).toBe(5000);
  const { f, vue, fenetre } = ouvrirSur();
  f.avisInfo("tuning", "Indisponible ici");
  expect(diffuses(fenetre).at(-1)!.avis).toEqual({ genre: "info", texte: "Indisponible ici" });
  vi.advanceTimersByTime(DUREE_AVIS_INFO_MS - 1);
  expect(f.etat("tuning")!.avis).toEqual({ genre: "info", texte: "Indisponible ici" });
  vi.advanceTimersByTime(1);
  expect(f.etat("tuning")!.avis).toBeNull();
  expect(diffuses(fenetre).at(-1)!.avis).toBeNull();

  // Une seconde mention repart de 5 s.
  f.avisInfo("tuning", "un");
  vi.advanceTimersByTime(3000);
  f.avisInfo("tuning", "deux");
  vi.advanceTimersByTime(3000);
  expect(f.etat("tuning")!.avis).toEqual({ genre: "info", texte: "deux" });
  vi.advanceTimersByTime(2000);
  expect(f.etat("tuning")!.avis).toBeNull();

  // Une nouvelle page l'efface.
  f.avisInfo("tuning", "trois");
  ecouteur(vue, "did-navigate")();
  expect(f.etat("tuning")!.avis).toBeNull();
  expect(diffuses(fenetre).at(-1)!.avis).toBeNull();
});

test("avisInfo : une mention lien-bloque en cours n'est jamais remplacée, et une mention venue ensuite n'est pas effacée par la minuterie", () => {
  vi.useFakeTimers();
  const { f, fenetre } = ouvrirSur();
  f.avis("tuning", { genre: "lien-bloque", domaine: "pub.test" });
  f.avisInfo("tuning", "Indisponible ici");
  expect(f.etat("tuning")!.avis).toEqual({ genre: "lien-bloque", domaine: "pub.test" });
  vi.advanceTimersByTime(DUREE_AVIS_INFO_MS);
  expect(f.etat("tuning")!.avis).toEqual({ genre: "lien-bloque", domaine: "pub.test" });

  // La mention info remplacée par une autre : la minuterie ne l'efface pas.
  f.avis("tuning", null);
  f.avisInfo("tuning", "info");
  f.avis("tuning", { genre: "inchangee", texte: "autre" });
  vi.advanceTimersByTime(DUREE_AVIS_INFO_MS);
  expect(f.etat("tuning")!.avis).toEqual({ genre: "inchangee", texte: "autre" });

  // La fenêtre fermée : la minuterie est arrêtée.
  f.avis("tuning", null);
  f.avisInfo("tuning", "info");
  fenetre.destroy();
  expect(vi.getTimerCount()).toBe(0);
});

test("fermerMenu : panneau ouvert, demande la fermeture puis se résout à panneauExtensions(id, 0)", async () => {
  const { f, fenetre } = ouvrirSur();
  f.panneauExtensions("tuning", 120);
  fenetre.webContents.send.mockClear();
  let resolue = false;
  const p = f.fermerMenu("tuning").then(() => void (resolue = true));
  expect(fenetre.webContents.send).toHaveBeenCalledWith(CANAUX.siteExtensionsFermer);
  await Promise.resolve();
  expect(resolue).toBe(false);
  f.panneauExtensions("tuning", 120);
  await Promise.resolve();
  expect(resolue).toBe(false);
  f.panneauExtensions("tuning", 0);
  await p;
  expect(resolue).toBe(true);
});

test("fermerMenu : sans réponse de l'interface, résolue après 500 ms ; menu fermé, résolue tout de suite sans rien envoyer", async () => {
  vi.useFakeTimers();
  expect(DELAI_FERMETURE_MENU_MS).toBe(500);
  const { f, fenetre } = ouvrirSur();
  f.panneauExtensions("tuning", 120);
  let resolue = false;
  const p = f.fermerMenu("tuning").then(() => void (resolue = true));
  await vi.advanceTimersByTimeAsync(DELAI_FERMETURE_MENU_MS - 1);
  expect(resolue).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await p;
  expect(resolue).toBe(true);

  f.panneauExtensions("tuning", 0);
  fenetre.webContents.send.mockClear();
  await f.fermerMenu("tuning");
  expect(fenetre.webContents.send).not.toHaveBeenCalled();
  await f.fermerMenu("absente");
});

test("idAuPremierPlan / idDePetiteAuPremierPlan d'après la fenêtre au premier plan", () => {
  const { f, vue, fenetre } = ouvrirSur();
  // Une petite fenêtre de connexion ouverte par la page.
  const petite = new BrowserWindow({});
  ecouteur(vue, "did-create-window")(petite);

  auPremierPlan = fenetre;
  expect(f.idAuPremierPlan()).toBe("tuning");
  expect(f.idDePetiteAuPremierPlan()).toBeUndefined();

  auPremierPlan = petite;
  expect(f.idAuPremierPlan()).toBeUndefined();
  expect(f.idDePetiteAuPremierPlan()).toBe("tuning");

  auPremierPlan = new BrowserWindow({});
  expect(f.idAuPremierPlan()).toBeUndefined();
  expect(f.idDePetiteAuPremierPlan()).toBeUndefined();

  auPremierPlan = null;
  expect(f.idAuPremierPlan()).toBeUndefined();
  expect(f.idDePetiteAuPremierPlan()).toBeUndefined();
});
