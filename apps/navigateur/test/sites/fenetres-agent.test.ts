import { beforeEach, expect, test, vi } from "vitest";
import { empreinteLectureSite, type DeclarationSite } from "@webaios/noyau";

/** Une page (vue du site ou interface) : ce que FenetresSites lit et appelle, sans Electron. */
function fausseWc() {
  let url = "";
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
    close: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: () => false,
    getURL: () => url,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return wc;
}

const vuesCreees: { webContents: ReturnType<typeof fausseWc>; visible: boolean }[] = [];

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = fausseWc();
    contentView = { addChildView: vi.fn() };
    detruite = false;
    private readonly ecouteurs = new Map<string, (() => void)[]>();
    on = vi.fn((e: string, f: () => void) => void this.ecouteurs.set(e, [...(this.ecouteurs.get(e) ?? []), f]));
    show = vi.fn();
    focus = vi.fn();
    /** Comme Electron : la fenêtre détruite émet « closed » ; la vue, elle, n'émet jamais « destroyed » ici. */
    destroy = () => {
      this.detruite = true;
      for (const f of this.ecouteurs.get("closed") ?? []) f();
    };
    isDestroyed = () => this.detruite;
    isFullScreen = () => false;
    getNormalBounds = () => ({ x: 0, y: 0, width: 1200, height: 800 });
    isMinimized = () => false;
    getContentSize = () => [1200, 800];
    static getFocusedWindow = () => null;
  },
  WebContentsView: class {
    webContents = fausseWc();
    visible = false;
    constructor() {
      vuesCreees.push(this);
    }
    setBackgroundColor = vi.fn();
    setVisible = (v: boolean) => void (this.visible = v);
    setBounds = vi.fn();
  },
}));
vi.mock("../../src/main/sites/session", () => ({ preferencesSite: () => ({}), sessionSite: () => ({}) }));
vi.mock("../../src/main/applications/fenetres", () => ({ cadreVisible: () => ({}) }));
vi.mock("../../src/main/agent/accueil", () => ({ navigationCadrePermise: () => false }));
/** Le favicon lu par la session de l'appli : rendu quand le test le décide. */
const favicon: { rendre: ((d: string | null) => void) | null } = { rendre: null };
vi.mock("../../src/main/applications/favicon", () => ({
  faviconEnDonnees: () => new Promise<string | null>((ok) => (favicon.rendre = ok)),
}));

const { DELAI_DESTRUCTION_VUE_MS, detruireVue, FenetresSites } = await import("../../src/main/sites/fenetres");

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

const noter = vi.fn();
function fenetres() {
  return new FenetresSites({
    memoire: { lire: () => ({}), noter },
    adressesLocales: false,
    ouvrirOnglet: vi.fn(),
  });
}

const site = (o: { aAccueil: boolean; accordRequis: boolean }) => ({ id: "vidola", declaration, domaines: ["vidola-a.example"], depart: DEPART, ...o });

beforeEach(() => {
  vuesCreees.splice(0);
  noter.mockClear();
  favicon.rendre = null;
});

test("naviguerPourAgent, vue du site : chargée tout de suite (« charge ») ; hors des domaines ou connexion : « refuse », rien chargé", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  const vue = vuesCreees[0]!.webContents;
  expect(vue.charges).toEqual([DEPART]);
  expect(f.naviguerPourAgent("vidola", "https://vidola-a.example/film/2")).toBe("charge");
  expect(vue.charges.at(-1)).toBe("https://vidola-a.example/film/2");
  for (const url of ["https://pub.example/", "https://compte.example/connexion"]) expect(f.naviguerPourAgent("vidola", url)).toBe("refuse");
  expect(f.naviguerPourAgent("youtube", "https://vidola-a.example/")).toBe("refuse");
  expect(vue.charges).toHaveLength(2);
});

test("naviguerPourAgent depuis l'accueil : chargée, et la vue du site se montre", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: true, accordRequis: false }));
  expect(f.etat("vidola")?.vue).toBe("accueil");
  expect(f.naviguerPourAgent("vidola", "https://vidola-a.example/film/2")).toBe("charge");
  expect(f.etat("vidola")?.vue).toBe("site");
  expect(vuesCreees[0]!.visible).toBe(true);
});

test("naviguerPourAgent pendant la carte des retouches : « en-attente », rien chargé ; après le choix, l'adresse demandée gagne sur l'accueil", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: true, accordRequis: true }));
  const vue = vuesCreees[0]!.webContents;
  expect(f.etat("vidola")?.vue).toBe("accord");
  expect(f.naviguerPourAgent("vidola", "https://vidola-a.example/film/2")).toBe("en-attente");
  expect(vue.charges).toEqual([]);
  // L'utilisateur choisit (ici « Ouvrir sans retouches ») : l'adresse se charge et la vue du site se montre, pas l'accueil.
  f.apresAccord("vidola", null);
  expect(vue.charges).toEqual(["https://vidola-a.example/film/2"]);
  expect(f.etat("vidola")?.vue).toBe("site");
});

test("sans demande de l'agent, l'appli avec accueil revient bien à l'accueil après la carte", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: true, accordRequis: true }));
  f.apresAccord("vidola", null);
  expect(f.etat("vidola")?.vue).toBe("accueil");
});

test("ouvertes : le domaine actuel de l'appli (celui du départ), jamais l'hôte de la page affichée", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  // La page va sur le domaine de connexion (OAuth) : le domaine montré reste celui de l'appli.
  vuesCreees[0]!.webContents.loadURL("https://compte.example/connexion");
  expect(f.ouvertes()).toEqual([{ id: "vidola", nom: "Vidola", url: "https://compte.example/connexion", domaine: "vidola-a.example", empreinte: empreinteLectureSite(declaration) }]);
});

test("ouvertes : l'empreinte suit la déclaration d'aujourd'hui (site.json relu avec un domaine de plus)", () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  const avant = f.ouvertes()[0]!.empreinte;
  const plus = { ...declaration, domaines: [...declaration.domaines, "mail.example.com"] };
  f.mettreAJour({ ...site({ aAccueil: false, accordRequis: false }), declaration: plus });
  expect(f.ouvertes()[0]!.empreinte).toBe(empreinteLectureSite(plus));
  expect(f.ouvertes()[0]!.empreinte).not.toBe(avant);
});

/** Le gestionnaire `evenement` posé sur la vue du site. */
const ecouteurVue = (evenement: string) => vuesCreees[0]!.webContents.on.mock.calls.find((c) => c[0] === evenement)![1] as (...a: unknown[]) => void;

test("un favicon lu après la fermeture de la fenêtre (suppression) n'est pas retenu", async () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  ecouteurVue("page-favicon-updated")({}, ["https://vidola-a.example/favicon.ico"]);
  expect(favicon.rendre).not.toBeNull();
  void f.fermer("vidola", 0);
  favicon.rendre!("data:image/png;base64,AAAA");
  await new Promise((r) => setTimeout(r, 0));
  expect(noter.mock.calls.filter((c) => "favicon" in (c[1] as object))).toEqual([]);
});

test("un favicon lu fenêtre ouverte est retenu", async () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  ecouteurVue("page-favicon-updated")({}, ["https://vidola-a.example/favicon.ico"]);
  favicon.rendre!("data:image/png;base64,AAAA");
  await new Promise((r) => setTimeout(r, 0));
  expect(noter).toHaveBeenCalledWith("vidola", { favicon: "data:image/png;base64,AAAA" });
});

test("fermer : une vue qui n'émet jamais « destroyed » est rendue au bout du délai (3 s), sans bloquer", async () => {
  vi.useFakeTimers();
  try {
    const f = fenetres();
    f.ouvrir(site({ aAccueil: false, accordRequis: false }));
    let rendue: unknown = "en attente";
    void f.fermer("vidola").then((r) => (rendue = r));
    await vi.advanceTimersByTimeAsync(DELAI_DESTRUCTION_VUE_MS - 1);
    expect(rendue).toBe("en attente");
    await vi.advanceTimersByTimeAsync(1);
    expect(rendue).toBe(vuesCreees[0]!.webContents);
    expect(DELAI_DESTRUCTION_VUE_MS).toBe(3000);
  } finally {
    vi.useRealTimers();
  }
});

test("fermer : la vue détruite à temps rend null ; detruireVue arrête puis ferme une vue restée vivante", async () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  const wc = vuesCreees[0]!.webContents;
  const fin = f.fermer("vidola");
  (wc.once.mock.calls.find((c) => c[0] === "destroyed")![1] as () => void)();
  expect(await fin).toBeNull();
  detruireVue(wc as never);
  expect(wc.forcefullyCrashRenderer).toHaveBeenCalled();
  expect(wc.close).toHaveBeenCalled();
});
