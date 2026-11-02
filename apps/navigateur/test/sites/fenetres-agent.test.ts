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
    stop: vi.fn(),
    session: { extensions: { getAllExtensions: () => extensionsChargees } },
    close: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    isDestroyed: () => false,
    getURL: () => url,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  return wc;
}

/** Les extensions chargées dans la session de l'appli (M1 ne joue qu'avec au moins une). */
let extensionsChargees: unknown[] = [];
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

// --- Les extensions de l'appli (plan 16)

test("urlPermisePourExtension : sa propre page et une page de l'appli, oui ; la page d'une autre extension, javascript:, file:, non ; pub.localhost, non, avec « Lien vers pub.localhost bloqué »", () => {
  const f = new FenetresSites({ memoire: { lire: () => ({}), noter }, adressesLocales: true, ouvrirOnglet: vi.fn() });
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  const ext = "abcdefghijklmnopabcdefghijklmnop";
  expect(f.urlPermisePourExtension("vidola", ext, `chrome-extension://${ext}/options.html`)).toBe(true);
  expect(f.urlPermisePourExtension("vidola", ext, "https://vidola-a.example/film/2")).toBe(true);
  for (const url of [`chrome-extension://${"b".repeat(32)}/options.html`, "javascript:alert(1)", "file:///etc/passwd", "about:blank", "data:text/html,x"])
    expect(f.urlPermisePourExtension("vidola", ext, url), url).toBe(false);
  // Rien de ce qui précède n'est mentionné : il n'y a rien à ouvrir dans un onglet.
  expect(f.etat("vidola")?.avis).toBeNull();
  expect(f.urlPermisePourExtension("vidola", ext, "http://pub.localhost:4000/pub.js")).toBe(false);
  // Le texte « Lien vers pub.localhost bloqué » vient de l'interface : le main n'en donne que le domaine.
  expect(f.etat("vidola")?.avis).toEqual({ genre: "lien-bloque", domaine: "pub.localhost" });
  // C7 : l'entrée « page d'accueil » du menu du bouton passe aussi par cette vérification (refusée, mentionnée).
  expect(f.urlPermisePourExtension("vidola", ext, "https://chrome.google.com/webstore/detail/x")).toBe(false);
  expect(f.etat("vidola")?.avis).toEqual({ genre: "lien-bloque", domaine: "chrome.google.com" });
  // Appli fermée : rien n'est permis.
  expect(f.urlPermisePourExtension("youtube", ext, "https://vidola-a.example/")).toBe(false);
});

/** Un tour de la boucle : les arrêts de la vue (`stop`) sont faits au tour suivant. */
const tour = () => new Promise<void>((r) => setImmediate(r));

test("C8 : la vue du site arrête tout chargement de son cadre principal qui n'est pas http(s) (tabs.update vers une page d'extension), au tour suivant (jamais dans l'écouteur)", async () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: false, accordRequis: false }));
  const wc = vuesCreees[0]!.webContents;
  const demarrer = async (url: string, isMainFrame = true) => {
    const avant = wc.stop.mock.calls.length;
    for (const c of wc.on.mock.calls.filter((c) => c[0] === "did-start-navigation")) (c[1] as (d: unknown) => void)({ url, isMainFrame, isSameDocument: false });
    // stop() dans l'écouteur ferait planter Electron : rien n'est arrêté avant le tour suivant.
    expect(wc.stop.mock.calls.length).toBe(avant);
    await tour();
  };
  await demarrer("https://vidola-a.example/film/2");
  await demarrer("chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html", false);
  expect(wc.stop).not.toHaveBeenCalled();
  await demarrer("chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html");
  expect(wc.stop).toHaveBeenCalledTimes(1);
  await demarrer("file:///etc/passwd");
  expect(wc.stop).toHaveBeenCalledTimes(2);
});

test("M1 : extension chargée, sur l'accueil (ou la carte), un chargement http(s) de la vue que WebAiOs n'a pas lancé est arrêté ; un chargement voulu, ou en vue « site », non ; sans extension, rien (plan 15)", async () => {
  const f = fenetres();
  f.ouvrir(site({ aAccueil: true, accordRequis: false }));
  const wc = vuesCreees[0]!.webContents;
  const demarrer = async (url: string) => {
    for (const c of wc.on.mock.calls.filter((c) => c[0] === "did-start-navigation")) (c[1] as (d: unknown) => void)({ url, isMainFrame: true, isSameDocument: false });
    await tour();
  };
  extensionsChargees = [];
  await demarrer("https://vidola-a.example/sans-extension");
  expect(wc.stop).not.toHaveBeenCalled();
  extensionsChargees = [{ id: "x" }];
  // Accueil, page jamais chargée : `tabs.update` d'une extension vers une page de l'appli.
  await demarrer("https://vidola-a.example/x");
  expect(wc.stop).toHaveBeenCalledTimes(1);
  // « Entrer dans le site » : voulu, puis vue « site » : un clic dans la page passe.
  f.entrer("vidola");
  await demarrer("https://vidola-a.example/");
  await demarrer("https://vidola-a.example/clic");
  expect(wc.stop).toHaveBeenCalledTimes(1);
  // De retour à l'accueil : la page cachée ne charge rien d'elle-même ; un rechargement voulu passe.
  f.accueil("vidola");
  await demarrer("https://vidola-a.example/seule");
  expect(wc.stop).toHaveBeenCalledTimes(2);
  f.rechargerVue("vidola");
  await demarrer("https://vidola-a.example/clic");
  expect(wc.stop).toHaveBeenCalledTimes(2);
  extensionsChargees = [];
});
