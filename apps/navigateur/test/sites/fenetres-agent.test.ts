import { beforeEach, expect, test, vi } from "vitest";
import type { DeclarationSite } from "@webaios/noyau";

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
    on = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    isDestroyed = () => false;
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

function fenetres() {
  return new FenetresSites({
    memoire: { lire: () => ({}), noter: vi.fn() } as never,
    adressesLocales: false,
    ouvrirOnglet: vi.fn(),
  });
}

const site = (o: { aAccueil: boolean; accordRequis: boolean }) => ({ id: "vidola", declaration, domaines: ["vidola-a.example"], depart: DEPART, ...o });

beforeEach(() => void vuesCreees.splice(0));

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
  expect(f.ouvertes()).toEqual([{ id: "vidola", nom: "Vidola", url: "https://compte.example/connexion", domaine: "vidola-a.example" }]);
});
