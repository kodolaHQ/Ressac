import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EntreeExtension, EtatExtensions } from "@webaios/noyau";
import type { EtatNavigateur } from "../../src/commun/modele";

// La vraie bibliothèque electron-chrome-extensions (mise dans le graphe de vite, voir vitest.config.ts), sur un
// `electron` leurré : seules les surfaces qu'elle touche à la construction et au chargement existent.
// `vi.mock` passe avant les imports : ce qu'utilise le leurre est créé par `vi.hoisted`.
const { EventEmitter } = await vi.hoisted(() => import("node:events"));
type EventEmitter = import("node:events").EventEmitter;
const { notificationsMontrees, ecouteursApp, gestionnairesIpc, menus, vuesParId } = vi.hoisted(() => ({
  /** `webContents.fromId` : les vues posées par un test (sinon un objet vide). */
  vuesParId: new Map<number, unknown>(),
  notificationsMontrees: [] as unknown[],
  menus: [] as { items: { label?: string; click?: () => void }[] }[],
  /** `ipcMain.handle` : canal → gestionnaire (le dernier posé). */
  gestionnairesIpc: new Map<string, (...a: unknown[]) => unknown>(),
  ecouteursApp: new (require("node:events") as typeof import("node:events")).EventEmitter(),
}));
vi.mock("electron", () => {
  class Notification extends EventEmitter {
    constructor(o: unknown) {
      super();
      notificationsMontrees.push(o);
    }
    show() {}
    close() {}
    static isSupported() {
      return true;
    }
  }
  return {
    app: {
      name: "WebAiOs",
      isReady: () => true,
      on: (n: string, f: (...a: unknown[]) => void) => ecouteursApp.on(n, f),
      getMaxListeners: () => ecouteursApp.getMaxListeners(),
      setMaxListeners: (n: number) => ecouteursApp.setMaxListeners(n),
    },
    ipcMain: {
      handle: (canal: string, f: (...a: unknown[]) => unknown) => void gestionnairesIpc.set(canal, f),
      on: (canal: string, f: (...a: unknown[]) => unknown) => void gestionnairesIpc.set(canal, f),
    },
    session: { defaultSession: fausseSession("defaut-electron") },
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null, getFocusedWindow: () => null },
    BaseWindow: { getAllWindows: () => [] },
    webContents: { fromId: (id: number) => vuesParId.get(id) ?? {} },
    webFrameMain: { fromId: () => null },
    Notification,
    // Le menu d'un bouton d'extension : ses entrées sont gardées (`menus`), jamais montrées.
    Menu: class {
      items: { label?: string; click?: () => void }[] = [];
      constructor() {
        menus.push(this as { items: { label?: string; click?: () => void }[] });
      }
      append(i: { label?: string; click?: () => void }) {
        this.items.push(i);
      }
      popup() {}
    },
    MenuItem: class {
      constructor(o: object) {
        Object.assign(this, o);
      }
    },
    protocol: {},
    nativeImage: {},
  };
});

/** Une fausse session : les extensions chargées, les service workers démarrés. */
interface FausseSession {
  nom: string;
  charges: Map<string, { id: string; chemin: string }>;
  chargements: { chemin: string; options: unknown }[];
  retraits: string[];
  demarres: string[];
  echecs: Set<string>;
  /** Tant qu'elle n'est pas résolue, chaque chargement attend. */
  lent?: Promise<void>;
  /** Manifeste rendu pour un dossier chargé (sinon : `background` si le chemin contient « fond »). */
  manifestes: Map<string, Record<string, unknown>>;
  /** Service workers par versionId (`getWorkerFromVersionID`). */
  workers: Map<number, unknown>;
  extensions: EventEmitter & Record<string, unknown>;
  serviceWorkers: EventEmitter & Record<string, unknown>;
  protocol: Record<string, unknown>;
  cookies: EventEmitter & { poses: { url: string; name: string; domain?: string }[] };
  preloads: unknown[];
  /** `webRequest.onBeforeRequest` posés. */
  ecouteursRequetes: { filtre: unknown; f: (d: unknown, r: (x: unknown) => void) => void }[];
  registerPreloadScript(o: unknown): void;
  isPersistent(): boolean;
}
function fausseSession(nom: string): FausseSession {
  const s = {
    nom,
    charges: new Map(),
    chargements: [],
    retraits: [],
    demarres: [],
    echecs: new Set<string>(),
    manifestes: new Map(),
    workers: new Map(),
    preloads: [] as unknown[],
    registerPreloadScript(o: unknown) {
      (s as unknown as { preloads: unknown[] }).preloads.push(o);
    },
    isPersistent: () => true,
    cookies: Object.assign(new EventEmitter(), {
      poses: [] as { url: string; name: string; domain?: string; secure?: boolean; path?: string }[],
      async set(d: { url: string; name: string }) {
        (s as unknown as FausseSession).cookies.poses.push(d);
      },
      async get(f: { url?: string }) {
        const tous = (s as unknown as FausseSession).cookies.poses.map((c) => ({ ...c, domain: c.domain ?? new URL(c.url).hostname, path: "/", secure: true }));
        return f.url ? tous.filter((c) => new URL(f.url!).hostname === c.domain) : tous;
      },
      async remove() {},
    }),
    protocol: { isProtocolHandled: () => false, handle: () => {}, unhandle: () => {} },
    ecouteursRequetes: [],
    webRequest: {
      onBeforeRequest(filtre: unknown, f: (d: unknown, r: (x: unknown) => void) => void) {
        (s as unknown as FausseSession).ecouteursRequetes.push({ filtre, f });
      },
    },
  } as unknown as FausseSession;
  const extensions = Object.assign(new EventEmitter(), {
    async loadExtension(chemin: string, options: unknown) {
      s.chargements.push({ chemin, options });
      if (s.lent) await s.lent;
      if (s.echecs.has(chemin)) throw new Error(`Manifest file is missing or unreadable: ${chemin}`);
      const id = `id-${chemin.split("/").slice(-2).join("-")}`;
      const manifeste = s.manifestes.get(chemin) ?? (chemin.includes("fond") ? { background: { service_worker: "fond.js" } } : {});
      const ext = { id, chemin, url: `chrome-extension://${id}/`, manifest: manifeste, path: chemin, name: id, version: String(manifeste.version ?? "1") };
      s.charges.set(id, ext);
      return ext;
    },
    removeExtension(id: string) {
      s.retraits.push(id);
      s.charges.delete(id);
    },
    getExtension: (id: string) => s.charges.get(id) ?? null,
    getAllExtensions: () => [...s.charges.values()],
  });
  const serviceWorkers = Object.assign(new EventEmitter(), {
    async startWorkerForScope(scope: string) {
      s.demarres.push(scope);
      return {};
    },
    getWorkerFromVersionID: (v: number) => s.workers.get(v),
  });
  s.extensions = extensions as unknown as FausseSession["extensions"];
  s.serviceWorkers = serviceWorkers as unknown as FausseSession["serviceWorkers"];
  return s;
}

const { ElectronChromeExtensions } = await import("electron-chrome-extensions");
const { detournerNotifications, ExtensionsProfils, CANAL_DEMARRAGE, CANAL_ONGLET } = await import("../../src/main/extensions/sessions");
const { connexionNative } = await import("../../src/main/extensions/natif");

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

function entree(source: "store" | "agent", profils: string[], plus: Partial<EntreeExtension> = {}): EntreeExtension {
  return {
    source,
    idChrome: null,
    nom: "essai",
    version: "1.0.0",
    accord: { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false },
    profils,
    epinglee: false,
    modifieeLe: null,
    desactivee: null,
    majEnAttente: null,
    vues: {},
    ...plus,
  };
}
const etatExt = (extensions: Record<string, EntreeExtension>, toutesCoupees = false): EtatExtensions => ({ version: 1, toutesCoupees, extensions });

/** État du navigateur : une fenêtre `f1` dont `actif` est l'espace actif ; chaque espace a un profil (et peut être privé). */
function etatNav(espaces: { id: string; profil: string; prive?: boolean }[], actif?: string): EtatNavigateur {
  return {
    version: 2,
    espaces: espaces.map((e) => ({ id: e.id, nom: e.id, icone: "x", epingles: [], prive: e.prive ?? false, profil: e.profil })),
    profils: [...new Set(espaces.map((e) => e.profil))].map((id) => ({ id })),
    essentiels: [],
    onglets: {},
    fenetres: [
      {
        id: "f1",
        espaceActif: actif ?? espaces[0]?.id ?? "",
        ordre: Object.fromEntries(espaces.map((e) => [e.id, []])),
        actif: Object.fromEntries(espaces.map((e) => [e.id, null])),
        compact: false,
        panneauAgentOuvert: false,
        fermesRecemment: [],
        cadre: null,
      },
    ],
    reglages: { moteur: "google", profilAgent: "claude", largeurPanneauAgent: 420 },
  } as EtatNavigateur;
}

let dossier: string;
let etat: EtatNavigateur;
let ouvertures: { cible: unknown; url: string; actif: boolean }[];
let fichierNotifications: string;

/** Les versions vues par profil (`noterVue`), clé `<cle>|<profil>`. */
let vuesNotees: Map<string, string>;

/** Instances créées par le test en cours : détruites ensuite (le canal des pages ne les interroge plus). */
let creees: InstanceType<typeof ExtensionsProfils>[] = [];
afterEach(() => {
  for (const p of creees) p.detruire();
  creees = [];
});

function creer(
  o: {
    invisible?: boolean;
    notifications?: boolean;
    verifierUrl?: (extension: Electron.Extension, url: string) => boolean;
    verifierHote?: (extension: Electron.Extension, url: string) => boolean;
    estOnglet?: (wc: Electron.WebContents) => boolean;
  } = {},
) {
  const p = new ExtensionsProfils({
    preloadCorrectifs: "/out/preload/extensions.js",
    noterVue: async (cle, profil, version) => {
      const precedente = vuesNotees.get(`${cle}|${profil}`);
      if (precedente === version) return { nouvelle: false };
      vuesNotees.set(`${cle}|${profil}`, version);
      return precedente ? { nouvelle: true, precedente } : { nouvelle: true };
    },
    ...(o.verifierUrl ? { verifierUrl: o.verifierUrl } : {}),
    ...(o.verifierHote ? { verifierHote: o.verifierHote } : {}),
    ...(o.estOnglet ? { estOnglet: o.estOnglet } : {}),
    dossier,
    etat: () => etat,
    premierPlan: () => "f1",
    ouvrirOnglet: async (cible, url, actif) => {
      ouvertures.push({ cible, url, actif });
      return null;
    },
    fenetreDe: () => null,
    activer: () => {},
    fermer: () => {},
    invisible: o.invisible ?? false,
    ...(o.notifications ? { fichierNotifications } : {}),
  });
  creees.push(p);
  return p;
}

/** Accès aux rouages de la bibliothèque (version figée 4.10.0) : son magasin et son routeur. */
type Rouages = {
  ctx: {
    store: { createTab(d: unknown): Promise<unknown>; impl: { createTab(d: unknown): Promise<unknown> }; tabs: Set<unknown> };
    router: { getHandler(n: string): { callback(...a: unknown[]): Promise<unknown> } };
  };
};
const rouages = (s: FausseSession) => ElectronChromeExtensions.fromSession(s as unknown as Electron.Session) as unknown as Rouages;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "webaios-ext-sessions-"));
  temporaires.push(dossier);
  fichierNotifications = join(dossier, "notifications.jsonl");
  etat = etatNav([{ id: "e1", profil: "defaut" }]);
  ouvertures = [];
  vuesNotees = new Map();
  notificationsMontrees.length = 0;
});

test("brancher crée une seule instance par session et ne charge rien sans entrée", async () => {
  const p = creer();
  const s = fausseSession("p1");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const instance = ElectronChromeExtensions.fromSession(s as unknown as Electron.Session);
  expect(instance).toBeDefined();
  // Une seconde fois : ni nouvelle instance, ni erreur (la bibliothèque lèverait pour une session déjà équipée).
  expect(() => p.brancher(s as unknown as Electron.Session, "defaut")).not.toThrow();
  expect(ElectronChromeExtensions.fromSession(s as unknown as Electron.Session)).toBe(instance);
  await p.synchroniser(etatExt({}));
  expect(s.chargements).toEqual([]);
});

test("synchroniser charge les clés actives du profil et retire celles qui ne le sont plus", async () => {
  etat = etatNav([
    { id: "e1", profil: "defaut" },
    { id: "e2", profil: "autre" },
  ]);
  const p = creer();
  const defaut = fausseSession("defaut");
  const autre = fausseSession("autre");
  p.brancher(defaut as unknown as Electron.Session, "defaut");
  p.brancher(autre as unknown as Electron.Session, "autre");
  const e1 = etatExt({
    [`store:${ID_A}`]: entree("store", ["defaut"], { version: "2.1.0" }),
    "agent:fond": entree("agent", ["defaut", "autre"]),
    [`store:${ID_B}`]: entree("store", ["autre"]),
    "agent:sans-accord": entree("agent", ["defaut"], { accord: null }),
  });
  await p.synchroniser(e1);
  expect(defaut.chargements.map((c) => c.chemin).sort()).toEqual([join(dossier, "copies", "fond"), join(dossier, "store", ID_A, "2.1.0_0")].sort());
  expect(defaut.chargements.every((c) => (c.options as { allowFileAccess: boolean }).allowFileAccess === false)).toBe(true);
  expect(autre.chargements.map((c) => c.chemin).sort()).toEqual([join(dossier, "copies", "fond"), join(dossier, "store", ID_B, "1.0.0_0")].sort());
  // Une extension avec un fond : son service worker est démarré (P16).
  expect(defaut.demarres).toEqual([`chrome-extension://id-copies-fond/`]);

  // L'agent quitte « defaut », le Store change de version : retiré, puis rechargé depuis la nouvelle version.
  await p.synchroniser(
    etatExt({
      [`store:${ID_A}`]: entree("store", ["defaut"], { version: "2.2.0" }),
      "agent:fond": entree("agent", ["autre"]),
      [`store:${ID_B}`]: entree("store", ["autre"]),
    }),
  );
  expect(defaut.retraits.sort()).toEqual(["id-copies-fond", `id-${ID_A}-2.1.0_0`].sort());
  expect([...defaut.charges.values()].map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "2.2.0_0")]);
  // Rien ne change dans « autre » : ni retrait, ni rechargement.
  expect(autre.retraits).toEqual([]);
  expect(autre.chargements).toHaveLength(2);
});

test("une extension de l'agent n'est jamais chargée dans le profil d'un espace privé ; celles du Store le sont", async () => {
  etat = etatNav([{ id: "e1", profil: "defaut", prive: true }]);
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  expect(s.chargements.map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]);
});

test("toutesCoupees : tout est retiré", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const extensions = { "agent:fond": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) };
  await p.synchroniser(etatExt(extensions));
  expect(s.charges.size).toBe(2);
  await p.synchroniser(etatExt(extensions, true));
  expect(s.charges.size).toBe(0);
  expect(s.retraits).toHaveLength(2);
});

test("un profil branché après la synchronisation reçoit aussitôt ses extensions", async () => {
  const p = creer();
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await vi.waitFor(() => expect(s.chargements.map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]));
});

test("un échec de chargement est gardé par clé, sans empêcher les autres ; il s'efface quand le chargement réussit", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  s.echecs.add(join(dossier, "copies", "casse"));
  const extensions = { "agent:casse": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) };
  await p.synchroniser(etatExt(extensions));
  expect(p.erreursChargement().get("agent:casse")).toMatch(/Manifest file is missing/);
  expect(s.charges.size).toBe(1);
  s.echecs.clear();
  await p.synchroniser(etatExt(extensions));
  expect(p.erreursChargement().has("agent:casse")).toBe(false);
  expect(s.charges.size).toBe(2);
});

test("createTab vers un profil sans espace : refusé", async () => {
  const p = creer();
  const s = fausseSession("orphelin");
  p.brancher(s as unknown as Electron.Session, "orphelin");
  await expect(rouages(s).ctx.store.impl.createTab({ url: "https://exemple.invalid/" })).rejects.toThrow(/Aucun espace/);
  expect(ouvertures).toEqual([]);
});

test("createTab : l'espace actif s'il est du profil, sinon le premier espace du profil, jamais un espace d'un autre profil", async () => {
  etat = etatNav(
    [
      { id: "autre-profil", profil: "autre" },
      { id: "e1", profil: "defaut" },
      { id: "e2", profil: "defaut" },
    ],
    "e2",
  );
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const impl = rouages(s).ctx.store.impl;
  await impl.createTab({ url: "https://exemple.invalid/1", active: false }).catch(() => {});
  etat = { ...etat, fenetres: [{ ...etat.fenetres[0]!, espaceActif: "autre-profil" }] };
  await impl.createTab({ url: "https://exemple.invalid/2" }).catch(() => {});
  expect(ouvertures).toEqual([
    { cible: { fenetreId: "f1", espaceId: "e2" }, url: "https://exemple.invalid/1", actif: false },
    { cible: { fenetreId: "f1", espaceId: "e1" }, url: "https://exemple.invalid/2", actif: true },
  ]);
});

test("notifications : détournées vers le fichier des tests, jamais montrées", async () => {
  const p = creer({ notifications: true });
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const creerNotif = rouages(s).ctx.router.getHandler("notifications.create");
  const extension = { id: "x".repeat(32), path: dossier, url: `chrome-extension://${"x".repeat(32)}/` };
  const id = await creerNotif.callback({ extension }, "n1", { type: "basic", iconUrl: "data:,", title: "Titre", message: "Texte" });
  expect(id).toBe("n1");
  expect(notificationsMontrees).toEqual([]);
  expect(readFileSync(fichierNotifications, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([
    { titre: "Titre", texte: "Texte", extension: "x".repeat(32) },
  ]);
});

test("mode invisible sans fichier : les notifications sont jetées", async () => {
  const p = creer({ invisible: true });
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const extension = { id: "x".repeat(32), path: dossier, url: `chrome-extension://${"x".repeat(32)}/` };
  await rouages(s).ctx.router.getHandler("notifications.create").callback({ extension }, { type: "basic", iconUrl: "data:,", title: "T", message: "M" });
  expect(notificationsMontrees).toEqual([]);
  expect(existsSync(fichierNotifications)).toBe(false);
});

test("mode invisible : toute fenêtre créée ensuite reste cachée (show, showInactive, focus neutralisés)", () => {
  creer({ invisible: true });
  const montree = { show: vi.fn(), showInactive: vi.fn(), focus: vi.fn() };
  const fenetre = { ...montree };
  ecouteursApp.emit("browser-window-created", {}, fenetre);
  fenetre.show();
  fenetre.showInactive();
  fenetre.focus();
  expect(montree.show).not.toHaveBeenCalled();
  expect(montree.showInactive).not.toHaveBeenCalled();
  expect(montree.focus).not.toHaveBeenCalled();
});

test("un profil devenu privé : ses extensions de l'agent sont retirées tout de suite, même celle dont le chargement est en cours", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  expect(s.charges.size).toBe(2);
  // Une seconde extension de l'agent se charge lentement…
  let liberer!: () => void;
  s.lent = new Promise((ok) => (liberer = ok));
  const enCours = p.synchroniser(
    etatExt({ "agent:fond": entree("agent", ["defaut"]), "agent:lente": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) }),
  );
  await vi.waitFor(() => expect(s.chargements.map((c) => c.chemin)).toContain(join(dossier, "copies", "lente")));
  // …quand l'espace devient privé : le retrait est synchrone, sans attendre la file.
  etat = etatNav([{ id: "e1", profil: "defaut", prive: true }]);
  p.retirerAgentsPrives(etat);
  expect([...s.charges.values()].map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]);
  liberer();
  await enCours;
  // Celle qui se chargeait est retirée dès la fin de son chargement.
  expect([...s.charges.values()].map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]);
});

test("beaucoup de profils : aucun avertissement d'écouteurs en trop sur app", () => {
  // La bibliothèque ajoute un `app.on("web-contents-created")` par session équipée.
  const p = creer();
  for (let i = 0; i < 15; i++) p.brancher(fausseSession(`p${i}`) as unknown as Electron.Session, `p${i}`);
  expect(ecouteursApp.listenerCount("web-contents-created")).toBeLessThanOrEqual(ecouteursApp.getMaxListeners());
});

test("détournement des notifications impossible (bibliothèque changée) : erreur levée, jamais une vraie notification", () => {
  expect(() => detournerNotifications({} as never, undefined)).toThrow(/notifications/);
});

test("brancher en mode invisible lève si les notifications ne peuvent pas être détournées, et rien n'est chargé dans ce profil", async () => {
  const p = creer({ invisible: true });
  const s = fausseSession("defaut");
  // La bibliothèque sans routeur : simulée en cassant `ctx` juste après sa construction.
  // (`prependPreload` est le dernier appel du constructeur.)
  const vrai = Object.getOwnPropertyDescriptor(ElectronChromeExtensions.prototype, "prependPreload")!;
  Object.defineProperty(ElectronChromeExtensions.prototype, "prependPreload", {
    configurable: true,
    value(this: { ctx?: unknown }, ...a: unknown[]) {
      const r = vrai.value.call(this, ...a);
      delete this.ctx;
      return r;
    },
  });
  try {
    expect(() => p.brancher(s as unknown as Electron.Session, "defaut")).toThrow(/notifications/);
  } finally {
    Object.defineProperty(ElectronChromeExtensions.prototype, "prependPreload", vrai);
  }
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  expect(s.chargements).toEqual([]);
});

/** Une extension appelante, telle que la bibliothèque la passe à ses gestionnaires (`event.extension`). */
const appelante = (id = "x".repeat(32), permissions: string[] = []) =>
  ({ id, url: `chrome-extension://${id}/`, path: dossier, manifest: { permissions } }) as unknown as Electron.Extension;

test("tabs.create, tabs.update et windows.create demandent verifierUrl avec l'extension appelante ; un refus fait échouer l'appel", async () => {
  const demandes: [string, string][] = [];
  let permis = false;
  const p = creer({
    verifierUrl: (extension, url) => {
      demandes.push([extension.id, url]);
      return permis;
    },
  });
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const routeur = rouages(s).ctx.router;
  const extension = appelante();
  await expect(routeur.getHandler("tabs.create").callback({ extension }, { url: "https://refus.invalid/a" })).rejects.toThrow(/refusée/);
  await expect(routeur.getHandler("tabs.update").callback({ extension }, 1, { url: "https://refus.invalid/b" })).rejects.toThrow(/refusée/);
  await expect(
    routeur.getHandler("windows.create").callback({ extension }, { url: ["https://refus.invalid/c", "https://refus.invalid/d"] }),
  ).rejects.toThrow(/refusée/);
  // Une adresse relative est d'abord résolue dans l'extension : c'est l'adresse finale qui est vérifiée.
  await expect(routeur.getHandler("tabs.create").callback({ extension }, { url: "page.html" })).rejects.toThrow(/refusée/);
  expect(ouvertures).toEqual([]);
  expect(demandes).toEqual([
    [extension.id, "https://refus.invalid/a"],
    [extension.id, "https://refus.invalid/b"],
    [extension.id, "https://refus.invalid/c"],
    [extension.id, `chrome-extension://${extension.id}/page.html`],
  ]);
  // Permis : l'onglet est demandé à WebAiOs (qui n'en ouvre pas ici).
  permis = true;
  await routeur.getHandler("tabs.create").callback({ extension }, { url: "https://permis.invalid/" }).catch(() => {});
  expect(ouvertures.map((o) => o.url)).toEqual(["https://permis.invalid/"]);
});

test("sans verifierUrl ni verifierHote : tout est permis (comportement de la bibliothèque)", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await rouages(s).ctx.router.getHandler("tabs.create").callback({ extension: appelante() }, { url: "https://libre.invalid/" }).catch(() => {});
  expect(ouvertures.map((o) => o.url)).toEqual(["https://libre.invalid/"]);
  const onglet = { id: 7, isDestroyed: () => false, getURL: () => "https://site.invalid/", insertCSS: vi.fn() };
  rouages(s).ctx.store.tabs.add(onglet);
  await rouages(s).ctx.router.getHandler("tabs.insertCSS").callback({ extension: appelante() }, 7, { code: "p{}" });
  expect(onglet.insertCSS).toHaveBeenCalledWith("p{}");
});

test("tabs.insertCSS demande verifierHote avec l'extension et l'adresse de l'onglet ; refusé, aucun CSS n'est inséré", async () => {
  const demandes: [string, string][] = [];
  let permis = false;
  const p = creer({
    verifierHote: (extension, url) => {
      demandes.push([extension.id, url]);
      return permis;
    },
  });
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const onglet = { id: 7, isDestroyed: () => false, getURL: () => "https://site.invalid/page", insertCSS: vi.fn() };
  rouages(s).ctx.store.tabs.add(onglet);
  const extension = appelante();
  await expect(rouages(s).ctx.router.getHandler("tabs.insertCSS").callback({ extension }, 7, { code: "p{}" })).rejects.toThrow(/refusé/);
  expect(onglet.insertCSS).not.toHaveBeenCalled();
  permis = true;
  await rouages(s).ctx.router.getHandler("tabs.insertCSS").callback({ extension }, 7, { code: "p{}" });
  expect(onglet.insertCSS).toHaveBeenCalledWith("p{}");
  expect(demandes).toEqual([
    [extension.id, "https://site.invalid/page"],
    [extension.id, "https://site.invalid/page"],
  ]);
});

test("messagerie native : WebAiOs refuse toujours ; le port se ferme avec « Messagerie native non prise en charge », aucun hôte lancé", async () => {
  expect(connexionNative(appelante(), "com.exemple.hote")).toBe(false);
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const routeur = rouages(s).ctx.router;
  const extension = appelante("x".repeat(32), ["nativeMessaging"]);
  const expediteur = { send: vi.fn(), ipc: { on: vi.fn(), off: vi.fn() } };
  await routeur.getHandler("runtime.connectNative").callback({ extension, sender: expediteur }, "connexion-1", "com.exemple.hote");
  expect(expediteur.send).toHaveBeenCalledWith("crx-native-msg-connexion-1-disconnect", "Messagerie native non prise en charge");
  // Aucun hôte créé : il écouterait les messages de l'extension sur `sender.ipc`.
  expect(expediteur.ipc.on).not.toHaveBeenCalled();
  await expect(
    routeur.getHandler("runtime.sendNativeMessage").callback({ extension, sender: expediteur }, "com.exemple.hote", { bonjour: 1 }),
  ).rejects.toThrow("Messagerie native non prise en charge");
  expect(expediteur.ipc.on).not.toHaveBeenCalled();
});

test("le preload des correctifs est enregistré pour les service workers et les pages, après celui de la bibliothèque", () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const ids = (s.preloads as { id: string; type: string }[]).map((x) => `${x.id}:${x.type}`);
  expect(ids).toEqual(["crx-mv2-preload:frame", "crx-mv3-preload:service-worker", "webaios-extensions-fond:service-worker", "webaios-extensions-page:frame"]);
});

/** Démarre le service worker d'une extension chargée : la réponse à son preload. */
async function demarrerFond(s: FausseSession, id: string, versionId: number): Promise<unknown> {
  const gestionnaires = new Map<string, (...a: unknown[]) => unknown>();
  s.workers.set(versionId, { scope: `chrome-extension://${id}/`, ipc: { handle: (c: string, f: (...a: unknown[]) => unknown) => void gestionnaires.set(c, f), on: () => {} } });
  s.serviceWorkers.emit("running-status-changed", { runningStatus: "starting", versionId });
  const f = gestionnaires.get(CANAL_DEMARRAGE);
  if (!f) throw new Error("aucun gestionnaire de démarrage sur ce service worker");
  return f({ session: s, versionId });
}

test("démarrage du fond : installation et rulesets du manifeste la première fois d'une version, rien ensuite, update à la version suivante", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const chemin1 = join(dossier, "store", ID_A, "1.0.0_0");
  const chemin2 = join(dossier, "store", ID_A, "2.0.0_0");
  const manifeste = (version: string) => ({
    version,
    background: { service_worker: "fond.js" },
    declarative_net_request: {
      rule_resources: [
        { id: "actif", enabled: true, path: "a.json" },
        { id: "coupe", enabled: false, path: "b.json" },
      ],
    },
  });
  s.manifestes.set(chemin1, manifeste("1.0.0"));
  s.manifestes.set(chemin2, manifeste("2.0.0"));
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  const id1 = [...s.charges.keys()][0]!;
  expect(await demarrerFond(s, id1, 1)).toEqual({ installation: { reason: "install" }, rulesets: ["actif"], rulesetsInactifs: ["coupe"], agent: false });
  // Redémarrage du même service worker (ou de l'application) : ni onInstalled, ni rulesets touchés.
  expect(await demarrerFond(s, id1, 2)).toEqual({ installation: null, rulesets: [], rulesetsInactifs: [], agent: false });
  expect(vuesNotees.get(`store:${ID_A}|defaut`)).toBe("1.0.0");

  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"], { version: "2.0.0" }) }));
  const id2 = [...s.charges.keys()][0]!;
  // À la mise à jour, l'état des rulesets redevient exactement celui du manifeste.
  expect(await demarrerFond(s, id2, 3)).toEqual({
    installation: { reason: "update", previousVersion: "1.0.0" },
    rulesets: ["actif"],
    rulesetsInactifs: ["coupe"],
    agent: false,
  });
  expect(await demarrerFond(s, id2, 4)).toEqual({ installation: null, rulesets: [], rulesetsInactifs: [], agent: false });
});

test("démarrage : une extension de l'agent est signalée comme telle ; un service worker hors extension n'a pas de gestionnaire", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]) }));
  expect(await demarrerFond(s, "id-copies-fond", 1)).toMatchObject({ installation: { reason: "install" }, agent: true });
  const gestionnaires = new Map<string, unknown>();
  s.workers.set(9, { scope: "https://site.invalid/", ipc: { handle: (c: string, f: unknown) => void gestionnaires.set(c, f), on: () => {} } });
  s.serviceWorkers.emit("running-status-changed", { runningStatus: "starting", versionId: 9 });
  expect(gestionnaires.has(CANAL_DEMARRAGE)).toBe(false);
});

test("extension de l'agent : un nouveau modifieeLe la retire puis la recharge depuis la même copie ; sinon rien", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { modifieeLe: "2026-10-30T10:00:00.000Z" }) }));
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { modifieeLe: "2026-10-30T10:00:00.000Z" }) }));
  expect(s.chargements).toHaveLength(1);
  expect(s.retraits).toEqual([]);
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { modifieeLe: "2026-10-30T11:00:00.000Z" }) }));
  expect(s.retraits).toEqual(["id-copies-fond"]);
  expect(s.chargements.map((c) => c.chemin)).toEqual([join(dossier, "copies", "fond"), join(dossier, "copies", "fond")]);
});

test("extension de l'agent rechargée à la même version : onInstalled « update » et rulesets du manifeste, comme le rechargement de Chrome", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const chemin = join(dossier, "copies", "fond");
  s.manifestes.set(chemin, { version: "1.0.0", background: { service_worker: "fond.js" }, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "r.json" }] } });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { modifieeLe: "2026-10-30T10:00:00.000Z" }) }));
  expect(await demarrerFond(s, "id-copies-fond", 1)).toEqual({ installation: { reason: "install" }, rulesets: ["r"], rulesetsInactifs: [], agent: true });
  expect(await demarrerFond(s, "id-copies-fond", 2)).toMatchObject({ installation: null });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { modifieeLe: "2026-10-30T11:00:00.000Z" }) }));
  expect(await demarrerFond(s, "id-copies-fond", 3)).toEqual({
    installation: { reason: "update", previousVersion: "1.0.0" },
    rulesets: ["r"],
    rulesetsInactifs: [],
    agent: true,
  });
  expect(await demarrerFond(s, "id-copies-fond", 4)).toMatchObject({ installation: null });
});

test("démarrage depuis une page d'extension : expéditeur vérifié ; l'installation n'y est donnée que si l'extension n'a pas de fond", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const sansFond = join(dossier, "store", ID_B, "1.0.0_0");
  s.manifestes.set(sansFond, { version: "1.0.0", declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "r.json" }] } });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]), [`store:${ID_B}`]: entree("store", ["defaut"]) }));
  const page = gestionnairesIpc.get(CANAL_DEMARRAGE)!;
  expect(page).toBeDefined();
  // Comme `ipcMain.handle` : une exception du gestionnaire devient un refus de la promesse.
  const depuis = async (url: string, session: unknown = s) => page({ sender: { session }, senderFrame: { url } });
  // Avec un fond : le fond seul reçoit l'installation, la page jamais (elle ne la consomme pas).
  expect(await depuis("chrome-extension://id-copies-fond/popup.html")).toEqual({ installation: null, rulesets: [], rulesetsInactifs: [], agent: true });
  expect(await demarrerFond(s, "id-copies-fond", 1)).toMatchObject({ installation: { reason: "install" } });
  // Sans fond : la première page reçoit installation et rulesets.
  const idSansFond = `id-${ID_B}-1.0.0_0`;
  expect(await depuis(`chrome-extension://${idSansFond}/options.html`)).toEqual({ installation: { reason: "install" }, rulesets: ["r"], rulesetsInactifs: [], agent: false });
  expect(await depuis(`chrome-extension://${idSansFond}/options.html`)).toEqual({ installation: null, rulesets: [], rulesetsInactifs: [], agent: false });
  // Expéditeurs refusés : une page web, une extension non chargée, une autre session.
  await expect(depuis("https://site.invalid/")).rejects.toThrow(/refusé/);
  await expect(depuis(`chrome-extension://${"z".repeat(32)}/x.html`)).rejects.toThrow(/refusé/);
  await expect(depuis("chrome-extension://id-copies-fond/popup.html", fausseSession("ailleurs"))).rejects.toThrow(/refusé/);
});

/** Deux extensions chargées dans la session « defaut » : celle de l'agent (avec fond) et une du Store. */
async function deuxExtensions() {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]), [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  return { p, s, agent: "id-copies-fond", store: `id-${ID_A}-1.0.0_0` };
}
const page = (s: FausseSession, url: string) => ({ type: "frame", sender: { session: s, id: 1, once: () => {} }, senderFrame: { url } });
const fond = (s: FausseSession, scope: string) => ({ type: "service-worker", session: s, serviceWorker: { scope } });
const routeurIpc = (canal: string) => gestionnairesIpc.get(canal)!;

test("crx-msg : l'id d'extension annoncé doit être celui de l'origine de l'expéditeur (page ou service worker)", async () => {
  const { s, agent, store } = await deuxExtensions();
  const msg = routeurIpc("crx-msg");
  // Une page de l'agent qui se fait passer pour l'extension du Store : refusée, avant tout crochet ou contrôle de droit.
  await expect((async () => msg(page(s, `chrome-extension://${agent}/popup.html`), store, "tabs.query", {}))()).rejects.toThrow(/Expéditeur refusé/);
  await expect((async () => msg(fond(s, `chrome-extension://${agent}/`), store, "tabs.query", {}))()).rejects.toThrow(/Expéditeur refusé/);
  // Sous son propre nom : permis.
  expect(await msg(page(s, `chrome-extension://${agent}/popup.html`), agent, "tabs.query", {})).toEqual([]);
  expect(await msg(fond(s, `chrome-extension://${store}/`), store, "tabs.query", {})).toEqual([]);
});

test("crx-msg : depuis une origine qui n'est pas une extension (script de contenu, page web), tout appel nommant une extension est refusé", async () => {
  const { s, store } = await deuxExtensions();
  const msg = routeurIpc("crx-msg");
  for (const [nom, args] of [
    ["tabs.query", [{}]],
    ["tabs.create", [{ url: "https://x.invalid/" }]],
    ["windows.getAll", [{}]],
    ["contextMenus.create", [{ id: "m", title: "t" }]],
    ["browserAction.setBadgeText", [{ text: "1" }]],
    ["cookies.getAll", [{}]],
    ["notifications.create", [{ type: "basic", title: "t", message: "m", iconUrl: "data:," }]],
    ["webNavigation.getAllFrames", [{ tabId: 1 }]],
    ["runtime.openOptionsPage", []],
  ] as const) {
    await expect((async () => msg(page(s, "https://site.invalid/"), store, nom, ...args))(), nom).rejects.toThrow(/Expéditeur refusé/);
  }
  // Cadre détruit (pas d'adresse) : refusé aussi.
  await expect((async () => msg({ type: "frame", sender: { session: s }, senderFrame: null }, store, "tabs.query", {}))()).rejects.toThrow(/Expéditeur refusé/);
});

test("crx-add-listener / crx-remove-listener : un abonnement au nom d'une autre extension est ignoré", async () => {
  const { s, agent, store } = await deuxExtensions();
  const ajouter = routeurIpc("crx-add-listener");
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const ecouteurs = () => (rouages(s).ctx.router as unknown as { listeners: Map<string, { extensionId: string }[]> }).listeners.get("tabs.onUpdated") ?? [];
  ajouter(page(s, `chrome-extension://${agent}/popup.html`), store, "tabs.onUpdated");
  ajouter(page(s, "https://site.invalid/"), store, "tabs.onUpdated");
  expect(ecouteurs()).toEqual([]);
  ajouter(fond(s, `chrome-extension://${store}/`), store, "tabs.onUpdated");
  expect(ecouteurs().map((x) => x.extensionId)).toEqual([store]);
  routeurIpc("crx-remove-listener")(fond(s, `chrome-extension://${agent}/`), store, "tabs.onUpdated");
  expect(ecouteurs().map((x) => x.extensionId)).toEqual([store]);
  expect(erreur).toHaveBeenCalled();
  erreur.mockRestore();
});

test("detruire : l'instance ne répond plus sur le canal des pages", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]) }));
  const canal = gestionnairesIpc.get(CANAL_DEMARRAGE)!;
  await expect((async () => canal({ sender: { session: s }, senderFrame: { url: "chrome-extension://id-copies-fond/p.html" } }))()).resolves.toBeTruthy();
  p.detruire();
  await expect((async () => canal({ sender: { session: s }, senderFrame: { url: "chrome-extension://id-copies-fond/p.html" } }))()).rejects.toThrow(/refusé/);
});

// --- Réseau des extensions de l'agent (tâche 12)

const ACCORD_AGENT = { permissions: ["tabs"], hotes: ["https://*.hote.test/*"], reseau: ["api.accorde.test"], tousLesSites: false, scriptsTousLesSites: false };

test("aucun session.webRequest sur une session de profil (il couperait tout declarativeNetRequest, branche B)", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }), [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  expect(s.ecouteursRequetes).toEqual([]);
});

test("accordAgent : connu avant la fin du chargement (id calculé du dossier de la copie), puis par l'id de Chromium ; null sans accord ; undefined hors agent", async () => {
  const { idChromeDeDossier } = await import("../../src/main/extensions/reseau");
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  let liberer!: () => void;
  s.lent = new Promise((ok) => (liberer = ok));
  const fin = p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }), "agent:nue": entree("agent", ["defaut"], { accord: null }) }));
  await vi.waitFor(() => expect(s.chargements).toHaveLength(1));
  expect(p.accordAgent(idChromeDeDossier(join(dossier, "copies", "fond")))).toEqual(ACCORD_AGENT);
  liberer();
  await fin;
  expect(p.accordAgent("id-copies-fond")).toEqual(ACCORD_AGENT);
  expect(p.accordAgent(`id-store-${ID_A}-1.0.0_0`)).toBeUndefined();
  // Une entrée de l'agent dont l'idChrome est noté au registre, sans accord.
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }), "agent:nue": entree("agent", [], { accord: null, idChrome: "c".repeat(32) }) }));
  expect(p.accordAgent("c".repeat(32))).toBeNull();
});

test("estOnglet : vrai seulement pour une vue d'onglet de la session de l'extension, jamais une lecture invisible ; canal du service worker compris", async () => {
  const { marquerInvisible } = await import("../../src/main/contenus-invisibles");
  const s = fausseSession("defaut");
  const autre = fausseSession("autre");
  const vue = (session: FausseSession) => ({ isDestroyed: () => false, session });
  const onglet = vue(s);
  const lecture = vue(s);
  marquerInvisible(lecture as unknown as Electron.WebContents);
  const ailleurs = vue(autre);
  const popupExtension = vue(s);
  [onglet, lecture, ailleurs, popupExtension].forEach((v, i) => vuesParId.set(i + 1, v));
  try {
    // La lecture invisible et l'onglet d'un autre profil seraient des vues d'onglet pour `vues.ongletDe` : c'est
    // l'invisibilité et la session qui les écartent.
    const p = creer({ estOnglet: (wc) => wc !== (popupExtension as unknown) });
    p.brancher(s as unknown as Electron.Session, "defaut");
    await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
    const sess = s as unknown as Electron.Session;
    expect(p.estOnglet(sess, "id-copies-fond", 1)).toBe(true);
    expect(p.estOnglet(sess, "id-copies-fond", 2)).toBe(false);
    expect(p.estOnglet(sess, "id-copies-fond", 3)).toBe(false);
    expect(p.estOnglet(sess, "id-copies-fond", 4)).toBe(false);
    expect(p.estOnglet(sess, "id-copies-fond", 99)).toBe(false);
    expect(p.estOnglet(sess, "id-copies-fond", "1")).toBe(false);
    expect(p.estOnglet(sess, "inconnue", 1)).toBe(false);
    expect(p.estOnglet(sess, null, 1)).toBe(false);
    // Le service worker de l'extension demande par son propre canal.
    const gestionnaires = new Map<string, (...a: unknown[]) => unknown>();
    s.workers.set(5, { scope: "chrome-extension://id-copies-fond/", ipc: { handle: (c: string, f: (...a: unknown[]) => unknown) => void gestionnaires.set(c, f), on: () => {} } });
    s.serviceWorkers.emit("running-status-changed", { runningStatus: "starting", versionId: 5 });
    const f = gestionnaires.get(CANAL_ONGLET)!;
    expect(f({}, 1)).toBe(true);
    expect(f({}, 2)).toBe(false);
    // Sans option : rien n'est un onglet.
    const q = creer();
    const s2 = fausseSession("defaut");
    q.brancher(s2 as unknown as Electron.Session, "defaut");
    await q.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
    vuesParId.set(6, vue(s2));
    expect(q.estOnglet(s2 as unknown as Electron.Session, "id-copies-fond", 6)).toBe(false);
  } finally {
    vuesParId.clear();
  }
});

test("extension de l'agent : tabs.create, tabs.update, windows.create hors de son accord rejettent « URL refusée par WebAiOs » ; tabs.insertCSS hors de ses hôtes « Site refusé par WebAiOs »", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const routeur = rouages(s).ctx.router;
  const extension = appelante("id-copies-fond");
  await expect(routeur.getHandler("tabs.create").callback({ extension }, { url: "https://autre.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(routeur.getHandler("tabs.update").callback({ extension }, 1, { url: "data:text/html,x" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(routeur.getHandler("windows.create").callback({ extension }, { url: "https://autre.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  expect(ouvertures).toEqual([]);
  await routeur.getHandler("tabs.create").callback({ extension }, { url: "https://www.hote.test/" }).catch(() => {});
  await routeur.getHandler("tabs.create").callback({ extension }, { url: "page.html" }).catch(() => {});
  expect(ouvertures.map((o) => o.url)).toEqual(["https://www.hote.test/", "chrome-extension://id-copies-fond/page.html"]);
  const onglet = { id: 7, isDestroyed: () => false, getURL: () => "https://autre.test/", insertCSS: vi.fn() };
  rouages(s).ctx.store.tabs.add(onglet);
  await expect(routeur.getHandler("tabs.insertCSS").callback({ extension }, 7, { code: "p{}" })).rejects.toThrow("Site refusé par WebAiOs");
  expect(onglet.insertCSS).not.toHaveBeenCalled();
});

test("menu du bouton d'une extension de l'agent : son site (homepage_url) hors accord n'est pas ouvert ; dans l'accord, si", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const chemin = join(dossier, "copies", "fond");
  s.manifestes.set(chemin, { homepage_url: "https://autre.test/?fuite=1" });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const menu = () => {
    menus.length = 0;
    (ElectronChromeExtensions.fromSession(s as unknown as Electron.Session) as unknown as { api: { browserAction: { activateContextMenu(d: unknown): void } } }).api.browserAction.activateContextMenu({
      extensionId: "id-copies-fond",
      anchorRect: { x: 0, y: 0, width: 1, height: 1 },
    });
    return menus[0]!.items[0]!;
  };
  menu().click!();
  await new Promise((ok) => setTimeout(ok, 0));
  expect(ouvertures).toEqual([]);
  expect(String(erreur.mock.calls[0]?.[0])).toContain("URL refusée par WebAiOs");
  s.manifestes.set(chemin, { homepage_url: "https://www.hote.test/" });
  (s.charges.get("id-copies-fond") as unknown as { manifest: unknown }).manifest = { homepage_url: "https://www.hote.test/" };
  menu().click!();
  await vi.waitFor(() => expect(ouvertures.map((o) => o.url)).toEqual(["https://www.hote.test/"]));
  erreur.mockRestore();
});

// --- Revue de la tâche 12 : popup, cookies, page d'options

test("popup : seulement une page de l'extension elle-même ; setPopup ou default_popup vers une adresse absolue ne donne aucune popup", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const chemin = join(dossier, "copies", "fond");
  s.manifestes.set(chemin, { action: { default_popup: "https://autre.test/defaut" } });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  const lib = ElectronChromeExtensions.fromSession(s as unknown as Electron.Session) as unknown as {
    api: { browserAction: { getPopupUrl(id: string, onglet?: number): string | undefined } };
  };
  const extension = appelante("id-copies-fond");
  expect(lib.api.browserAction.getPopupUrl("id-copies-fond")).toBeUndefined();
  const routeur = rouages(s).ctx.router;
  await routeur.getHandler("browserAction.setPopup").callback({ extension }, { popup: "https://autre.test/?d=secret" });
  expect(lib.api.browserAction.getPopupUrl("id-copies-fond")).toBeUndefined();
  await routeur.getHandler("browserAction.setPopup").callback({ extension }, { popup: `chrome-extension://${ID_B}/page.html` });
  expect(lib.api.browserAction.getPopupUrl("id-copies-fond")).toBeUndefined();
  await routeur.getHandler("browserAction.setPopup").callback({ extension }, { popup: "page.html" });
  expect(lib.api.browserAction.getPopupUrl("id-copies-fond")).toBe("chrome-extension://id-copies-fond/page.html");
  erreur.mockRestore();
});

test("cookies d'une extension de l'agent : set, get, remove hors de ses hôtes refusés (« Site refusé par WebAiOs ») ; getAll ne rend que ses sites ; Store inchangé", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const routeur = rouages(s).ctx.router;
  const agent = appelante("id-copies-fond");
  await expect(routeur.getHandler("cookies.set").callback({ extension: agent }, { url: "https://autre.test/", name: "d", value: "secret" })).rejects.toThrow(
    "Site refusé par WebAiOs",
  );
  await expect(routeur.getHandler("cookies.set").callback({ extension: agent }, { url: "https://www.hote.test/", domain: ".test", name: "d", value: "x" })).rejects.toThrow(
    "Site refusé par WebAiOs",
  );
  expect(s.cookies.poses).toEqual([]);
  await expect(routeur.getHandler("cookies.get").callback({ extension: agent }, { url: "https://autre.test/", name: "d" })).rejects.toThrow("Site refusé par WebAiOs");
  await expect(routeur.getHandler("cookies.remove").callback({ extension: agent }, { url: "https://autre.test/", name: "d" })).rejects.toThrow("Site refusé par WebAiOs");
  await routeur.getHandler("cookies.set").callback({ extension: agent }, { url: "https://www.hote.test/", name: "r", value: "1" });
  // Le Store pose où il veut (sa portée a été montrée à l'utilisateur).
  const store = appelante(ID_A);
  await routeur.getHandler("cookies.set").callback({ extension: store }, { url: "https://autre.test/", name: "s", value: "1" });
  const noms = (l: unknown) => (l as { name: string }[]).map((c) => c.name);
  expect(noms(await routeur.getHandler("cookies.getAll").callback({ extension: agent }, {}))).toEqual(["r"]);
  expect(noms(await routeur.getHandler("cookies.getAll").callback({ extension: store }, {}))).toEqual(["r", "s"]);
});

test("menu du bouton d'une extension de l'agent : une page d'options absolue hors accord n'est pas ouverte", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  s.manifestes.set(join(dossier, "copies", "fond"), { options_page: "https://autre.test/options?d=1" });
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  menus.length = 0;
  (ElectronChromeExtensions.fromSession(s as unknown as Electron.Session) as unknown as { api: { browserAction: { activateContextMenu(d: unknown): void } } }).api.browserAction.activateContextMenu({
    extensionId: "id-copies-fond",
    anchorRect: { x: 0, y: 0, width: 1, height: 1 },
  });
  menus[0]!.items.find((i) => i.label === "Options")!.click!();
  await new Promise((ok) => setTimeout(ok, 0));
  expect(ouvertures).toEqual([]);
  expect(String(erreur.mock.calls[0]?.[0])).toContain("URL refusée par WebAiOs");
  erreur.mockRestore();
});

test("cookies.onChanged : une extension de l'agent ne reçoit que les changements de ses sites ; le Store reçoit tout", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  s.charges.set(ID_A, { id: ID_A, chemin: "store", url: `chrome-extension://${ID_A}/`, manifest: {}, path: "store", name: "store", version: "1" } as never);
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  s.charges.set(ID_A, { id: ID_A, chemin: "store", url: `chrome-extension://${ID_A}/`, manifest: {}, path: "store", name: "store", version: "1" } as never);
  const routeur = rouages(s).ctx.router as unknown as { addListener(l: unknown, id: string, nom: string): void };
  const recus: Record<string, unknown[]> = { agent: [], store: [] };
  const hote = (nom: string) => ({ isDestroyed: () => false, send: (_c: string, info: { cookie: { domain: string } }) => recus[nom]!.push(info.cookie.domain), once: () => {}, on: () => {} });
  routeur.addListener({ type: "frame", extensionId: "id-copies-fond", host: hote("agent") }, "id-copies-fond", "cookies.onChanged");
  routeur.addListener({ type: "frame", extensionId: ID_A, host: hote("store") }, ID_A, "cookies.onChanged");
  const changer = (domain: string) => s.cookies.emit("changed", {}, { name: "c", value: "secret", domain, path: "/", secure: true }, "explicit", false);
  changer("autre.test");
  changer(".www.hote.test");
  expect(recus).toEqual({ agent: [".www.hote.test"], store: ["autre.test", ".www.hote.test"] });
});
