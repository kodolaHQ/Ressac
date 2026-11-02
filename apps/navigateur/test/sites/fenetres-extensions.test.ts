import { beforeEach, expect, test, vi } from "vitest";
import type { DeclarationSite } from "@webaios/noyau";
import { HAUTEUR_BARRE_SITE, PANNEAU_EXTENSIONS_MAX } from "../../src/commun/sites";

// C16 : `INVISIBLE` est lu à l'import de fenetres.ts ; posé ici avant l'import dynamique (comme en e2e).
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
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return wc;
}

type FausseFenetre = {
  options: Record<string, unknown>;
  webContents: ReturnType<typeof fausseWc>;
  detruite: boolean;
  destroy(): void;
  close(): void;
  isDestroyed(): boolean;
  show: ReturnType<typeof vi.fn>;
};
const fenetresCreees: FausseFenetre[] = [];
const vuesCreees: { webContents: ReturnType<typeof fausseWc>; bornes: { x: number; y: number; width: number; height: number } | null }[] = [];
/** La session de l'appli : seules les extensions qui y sont chargées ont des pages à ouvrir. */
const sessionVidola = { extensions: { getExtension: (id: string) => (id === EXT ? { id } : null) } };
const EXT = "abcdefghijklmnopabcdefghijklmnop";

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
    /** Comme Electron : la fenêtre détruite (ou fermée) émet « closed » une fois. */
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
    static getFocusedWindow = () => null;
  },
  WebContentsView: class {
    webContents = fausseWc();
    bornes: { x: number; y: number; width: number; height: number } | null = null;
    constructor() {
      vuesCreees.push(this);
    }
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();
    setBounds = (b: { x: number; y: number; width: number; height: number }) => void (this.bornes = b);
  },
}));
vi.mock("../../src/main/sites/session", () => ({ preferencesSite: () => ({}), sessionSite: () => sessionVidola }));
vi.mock("../../src/main/applications/fenetres", () => ({ cadreVisible: () => ({}) }));
vi.mock("../../src/main/agent/accueil", () => ({ navigationCadrePermise: () => false }));
vi.mock("../../src/main/applications/favicon", () => ({ faviconEnDonnees: async () => null }));

const { FenetresSites } = await import("../../src/main/sites/fenetres");

const DEPART = "https://vidola-a.example/";
const declaration: DeclarationSite = {
  nom: "Vidola",
  description: "",
  adresse: DEPART,
  domaines: ["vidola-a.example"],
  connexion: ["compte.example"],
  retouches: [],
  reprise: false,
};
const site = { id: "vidola", declaration, domaines: ["vidola-a.example"], depart: DEPART, aAccueil: false, accordRequis: false };

const surVue = vi.fn();
function fenetres() {
  return new FenetresSites({ memoire: { lire: () => ({}), noter: vi.fn() }, adressesLocales: false, ouvrirOnglet: vi.fn(), surVue });
}

beforeEach(() => {
  fenetresCreees.splice(0);
  vuesCreees.splice(0);
  surVue.mockClear();
});

/** Le gestionnaire `evenement` posé sur une page. */
const ecouteur = (wc: ReturnType<typeof fausseWc>, evenement: string) => wc.on.mock.calls.find((c) => c[0] === evenement)![1] as (...a: unknown[]) => void;

test("ouvrirPourExtension d'une page chrome-extension: : petite fenêtre de la session de l'appli, show faux en test, fermée avec l'appli", async () => {
  const f = fenetres();
  f.ouvrir(site);
  const appli = fenetresCreees[0]!;
  const url = `chrome-extension://${EXT}/options.html`;
  const [wc, fenetre] = await f.ouvrirPourExtension("vidola", url);
  const petite = fenetresCreees[1]!;
  expect(fenetre).toBe(petite);
  expect(wc).toBe(petite.webContents);
  expect(petite.options).toMatchObject({ width: 500, height: 650, show: false, fullscreenable: false });
  expect(petite.options.webPreferences).toEqual({ session: sessionVidola, sandbox: true, contextIsolation: true });
  expect(petite.show).not.toHaveBeenCalled();
  expect(petite.webContents.charges).toEqual([url]);
  // Elle ne quitte pas l'origine de son extension, et n'ouvre rien.
  const naviguer = ecouteur(petite.webContents, "will-frame-navigate");
  const vers = (u: string, isMainFrame = true) => {
    const e = { url: u, isMainFrame, preventDefault: vi.fn() };
    naviguer(e);
    return e.preventDefault.mock.calls.length > 0;
  };
  expect(vers(`chrome-extension://${EXT}/autre.html`)).toBe(false);
  expect(vers(`chrome-extension://${"b".repeat(32)}/options.html`)).toBe(true);
  expect(vers("https://vidola-a.example/")).toBe(true);
  expect((petite.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown)()).toEqual({ action: "deny" });
  // L'appli se ferme : sa petite fenêtre aussi.
  appli.destroy();
  expect(petite.isDestroyed()).toBe(true);
});

test("ouvrirPourExtension : une page de l'appli fait aller la vue ; une autre adresse, ou la page d'une extension non chargée dans l'appli, lève", async () => {
  const f = fenetres();
  f.ouvrir(site);
  const vue = vuesCreees[0]!.webContents;
  const [wc, fenetre] = await f.ouvrirPourExtension("vidola", "https://vidola-a.example/film/2");
  expect(wc).toBe(vue);
  expect(fenetre).toBe(fenetresCreees[0]);
  expect(vue.charges.at(-1)).toBe("https://vidola-a.example/film/2");
  for (const url of ["https://pub.example/", "https://compte.example/connexion", `chrome-extension://${"b".repeat(32)}/options.html`, "javascript:1", "about:blank"])
    await expect(f.ouvrirPourExtension("vidola", url), url).rejects.toThrow();
  await expect(f.ouvrirPourExtension("youtube", `chrome-extension://${EXT}/options.html`)).rejects.toThrow();
  expect(fenetresCreees).toHaveLength(1);
});

test("fermerPageExtension : ferme seulement une petite fenêtre qu'elle a ouverte ; une page déjà détruite, la vue ou l'interface : rien", async () => {
  const f = fenetres();
  f.ouvrir(site);
  const [wc] = await f.ouvrirPourExtension("vidola", `chrome-extension://${EXT}/options.html`);
  const petite = fenetresCreees[1]!;
  f.fermerPageExtension(vuesCreees[0]!.webContents as never);
  f.fermerPageExtension(fenetresCreees[0]!.webContents as never);
  expect(vuesCreees[0]!.webContents.isDestroyed()).toBe(false);
  expect(fenetresCreees[0]!.isDestroyed()).toBe(false);
  expect(petite.isDestroyed()).toBe(false);
  f.fermerPageExtension(wc);
  expect(petite.isDestroyed()).toBe(true);
  // Déjà détruite : sans erreur.
  expect(() => f.fermerPageExtension(wc)).not.toThrow();
});

test("surVue : « creee » après la création de la vue, « detruite » juste avant sa fermeture ; vueEtFenetre la rend tant qu'elle est ouverte", () => {
  const f = fenetres();
  f.ouvrir(site);
  const vue = vuesCreees[0]!.webContents;
  const appli = fenetresCreees[0]!;
  expect(surVue.mock.calls).toEqual([["vidola", "creee", vue, appli]]);
  expect(f.vueEtFenetre("vidola")).toEqual({ wc: vue, fenetre: appli });
  expect(f.vueEtFenetre("youtube")).toBeNull();
  appli.destroy();
  expect(surVue.mock.calls[1]).toEqual(["vidola", "detruite", vue, appli]);
  expect(vue.close).toHaveBeenCalled();
  expect(f.vueEtFenetre("vidola")).toBeNull();
});

test("panneauExtensions repousse la vue sous la barre, borné à [0, PANNEAU_EXTENSIONS_MAX]", () => {
  const f = fenetres();
  f.ouvrir(site);
  const v = vuesCreees[0]!;
  expect(v.bornes).toEqual({ x: 0, y: HAUTEUR_BARRE_SITE, width: 1200, height: 800 - HAUTEUR_BARRE_SITE });
  f.panneauExtensions("vidola", 120);
  expect(v.bornes).toEqual({ x: 0, y: HAUTEUR_BARRE_SITE + 120, width: 1200, height: 800 - HAUTEUR_BARRE_SITE - 120 });
  f.panneauExtensions("vidola", 10_000);
  expect(v.bornes!.y).toBe(HAUTEUR_BARRE_SITE + PANNEAU_EXTENSIONS_MAX);
  f.panneauExtensions("vidola", -5);
  expect(v.bornes!.y).toBe(HAUTEUR_BARRE_SITE);
  expect(PANNEAU_EXTENSIONS_MAX).toBe(320);
});

test("diffuserATous : l'interface de chaque appli ouverte", () => {
  const f = fenetres();
  f.ouvrir(site);
  f.ouvrir({ ...site, id: "youtube" });
  f.diffuserATous("webaios:extensions-change", null);
  expect(fenetresCreees.map((x) => x.webContents.send.mock.calls.filter((c) => c[0] === "webaios:extensions-change").length)).toEqual([1, 1]);
});

test("M7 : la petite fenêtre ne charge que les pages de l'extension qui l'a ouverte (filet : arrêt au tour suivant, jamais dans l'écouteur)", async () => {
  const f = fenetres();
  f.ouvrir(site);
  await f.ouvrirPourExtension("vidola", `chrome-extension://${EXT}/options.html`);
  const wc = fenetresCreees[1]!.webContents;
  const demarrer = async (url: string, isMainFrame = true) => {
    const avant = wc.stop.mock.calls.length;
    for (const c of wc.on.mock.calls.filter((c) => c[0] === "did-start-navigation")) (c[1] as (d: unknown) => void)({ url, isMainFrame, isSameDocument: false });
    expect(wc.stop.mock.calls.length).toBe(avant);
    await new Promise<void>((r) => setImmediate(r));
  };
  await demarrer(`chrome-extension://${EXT}/autre.html`);
  await demarrer("https://vidola-a.example/", false);
  expect(wc.stop).not.toHaveBeenCalled();
  await demarrer("https://vidola-a.example/");
  expect(wc.stop).toHaveBeenCalledTimes(1);
  await demarrer(`chrome-extension://${"b".repeat(32)}/options.html`);
  expect(wc.stop).toHaveBeenCalledTimes(2);
});

test("I1 : peutChargerPourExtension (tabs.update, avant tout chargement) : la vue en vue « site » seulement et en http(s) ; la petite fenêtre, les pages de son extension seulement ; le reste, non", async () => {
  const f = fenetres();
  const autre = `chrome-extension://${"b".repeat(32)}/options.html`;
  // Appli fermée : rien.
  expect(f.peutChargerPourExtension("vidola", fausseWc() as never, DEPART)).toBe(false);
  // Une appli avec un accueil : la vue cachée ne charge rien tant que l'utilisateur n'est pas entré.
  f.ouvrir({ ...site, aAccueil: true });
  const vue = vuesCreees[0]!.webContents as never;
  expect(f.peutChargerPourExtension("vidola", vue, `${DEPART}x`)).toBe(false);
  f.entrer("vidola");
  expect(f.peutChargerPourExtension("vidola", vue, `${DEPART}x`)).toBe(true);
  expect(f.peutChargerPourExtension("vidola", vue, `chrome-extension://${EXT}/options.html`)).toBe(false);
  expect(f.peutChargerPourExtension("vidola", vue, "file:///etc/passwd")).toBe(false);
  expect(f.peutChargerPourExtension("vidola", vue, "data:text/html,x")).toBe(false);
  // De retour à l'accueil : de nouveau non.
  f.accueil("vidola");
  expect(f.peutChargerPourExtension("vidola", vue, `${DEPART}x`)).toBe(false);
  // La petite fenêtre d'une page d'extension.
  const [page] = await f.ouvrirPourExtension("vidola", `chrome-extension://${EXT}/options.html`);
  expect(f.peutChargerPourExtension("vidola", page, `chrome-extension://${EXT}/autre.html`)).toBe(true);
  expect(f.peutChargerPourExtension("vidola", page, autre)).toBe(false);
  expect(f.peutChargerPourExtension("vidola", page, DEPART)).toBe(false);
  // L'interface de l'appli, ou une page inconnue : non.
  expect(f.peutChargerPourExtension("vidola", fenetresCreees[0]!.webContents as never, DEPART)).toBe(false);
  expect(f.peutChargerPourExtension("vidola", fausseWc() as never, `chrome-extension://${EXT}/x.html`)).toBe(false);
});
