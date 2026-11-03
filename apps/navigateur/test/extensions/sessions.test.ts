import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { notificationsMontrees, ecouteursApp, gestionnairesIpc, menus, vuesParId, effacement } = vi.hoisted(() => ({
  /** Les vues de l'effacement du stockage (`WebContentsView`) : ce qu'elles chargent et exécutent, et leur fermeture. */
  effacement: {
    charger: (_url: string): Promise<void> => Promise.resolve(),
    executer: (_code: string): Promise<unknown> => Promise.resolve(0),
    adresses: [] as string[],
    fermees: 0,
  },
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
    WebContentsView: class {
      webContents = {
        loadURL: (url: string) => {
          effacement.adresses.push(url);
          return effacement.charger(url);
        },
        executeJavaScript: (code: string) => effacement.executer(code),
        close: () => void effacement.fermees++,
      };
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
    storagePath: null,
    effacees: [] as unknown[],
    async clearStorageData(o: unknown) {
      (s as unknown as { effacees: unknown[] }).effacees.push(o);
    },
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
const { detournerNotifications, ExtensionsProfils, CANAL_DEMARRAGE, CANAL_DEMARREE, CANAL_ONGLET } = await import("../../src/main/extensions/sessions");
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
    lisibleParAgent?: (wc: Electron.WebContents) => boolean;
    consoles?: ConstructorParameters<typeof ExtensionsProfils>[0]["consoles"];
    aTourneDansOnglet?: ConstructorParameters<typeof ExtensionsProfils>[0]["aTourneDansOnglet"];
    delaiEffacementMs?: number;
    delaiFondMs?: number;
    site?: ConstructorParameters<typeof ExtensionsProfils>[0]["site"];
    fermer?: (wc: Electron.WebContents) => void;
    avantInstallationStore?: ConstructorParameters<typeof ExtensionsProfils>[0]["avantInstallationStore"];
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
    ...(o.lisibleParAgent ? { lisibleParAgent: o.lisibleParAgent } : {}),
    ...(o.consoles ? { consoles: o.consoles } : {}),
    ...(o.aTourneDansOnglet ? { aTourneDansOnglet: o.aTourneDansOnglet } : {}),
    ...(o.delaiEffacementMs ? { delaiEffacementMs: o.delaiEffacementMs } : {}),
    ...(o.delaiFondMs ? { delaiFondMs: o.delaiFondMs } : {}),
    ...(o.site ? { site: o.site } : {}),
    ...(o.avantInstallationStore ? { avantInstallationStore: o.avantInstallationStore } : {}),
    dossier,
    etat: () => etat,
    premierPlan: () => "f1",
    ouvrirOnglet: async (cible, url, actif) => {
      ouvertures.push({ cible, url, actif });
      return null;
    },
    fenetreDe: () => null,
    activer: () => {},
    fermer: o.fermer ?? (() => {}),
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

/** Démarre le service worker d'une extension chargée : la réponse à son preload, et de quoi envoyer son accusé (I2). */
async function demarrerFondAccuse(s: FausseSession, id: string, versionId: number): Promise<{ reponse: unknown; accuser: () => Promise<unknown> }> {
  const gestionnaires = new Map<string, (...a: unknown[]) => unknown>();
  s.workers.set(versionId, { scope: `chrome-extension://${id}/`, ipc: { handle: (c: string, f: (...a: unknown[]) => unknown) => void gestionnaires.set(c, f), on: () => {} } });
  s.serviceWorkers.emit("running-status-changed", { runningStatus: "starting", versionId });
  const f = gestionnaires.get(CANAL_DEMARRAGE);
  const accuse = gestionnaires.get(CANAL_DEMARREE);
  if (!f || !accuse) throw new Error("gestionnaires de démarrage absents sur ce service worker");
  const reponse = await f({ session: s, versionId });
  return { reponse, accuser: async () => accuse({ session: s, versionId }) };
}

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

// ——— Tâche 17 : console filtrée ———

test("estOnglet note où l'extension a tourné : dans un onglet lisible par l'agent ou non", async () => {
  const s = fausseSession("defaut");
  const vue = () => ({ isDestroyed: () => false, session: s });
  const lisible = vue();
  const cache = vue();
  vuesParId.set(1, lisible);
  vuesParId.set(2, cache);
  const notes: [string, string, boolean][] = [];
  try {
    const p = creer({
      estOnglet: () => true,
      lisibleParAgent: (wc) => wc === (lisible as unknown),
      aTourneDansOnglet: (id, profil, l) => void notes.push([id, profil, l]),
    });
    p.brancher(s as unknown as Electron.Session, "defaut");
    await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
    const sess = s as unknown as Electron.Session;
    expect(p.estOnglet(sess, "id-copies-fond", 1)).toBe(true);
    expect(p.estOnglet(sess, "id-copies-fond", 2)).toBe(true);
    // Pas un onglet : rien n'est noté.
    expect(p.estOnglet(sess, "id-copies-fond", 99)).toBe(false);
    expect(notes).toEqual([
      ["id-copies-fond", "defaut", true],
      ["id-copies-fond", "defaut", false],
    ]);
  } finally {
    vuesParId.clear();
  }
});

test("console d'un onglet : un message dont la source est un fichier de l'extension est noté avec la lisibilité de l'onglet ; celui de la page, non", async () => {
  const s = fausseSession("defaut");
  const notes: { id: string; texte: string; onglet?: { lisible: boolean } }[] = [];
  let lisible = false;
  const p = creer({
    estOnglet: () => true,
    lisibleParAgent: () => lisible,
    consoles: { noter: (id, m, onglet) => void notes.push({ id, texte: m.texte, ...(onglet ? { onglet } : {}) }), plantage: () => {} },
  });
  p.brancher(s as unknown as Electron.Session, "defaut");
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) }));
  const wc = Object.assign(new EventEmitter(), { session: s, isDestroyed: () => false, getType: () => "window", getURL: () => "https://site.test/" });
  ecouteursApp.emit("web-contents-created", {}, wc);
  const message = (texte: string, sourceId: string) =>
    wc.emit("console-message", { message: texte, level: "info", sourceId, lineNumber: 1, frame: { url: "https://site.test/" } });
  message("caché", "chrome-extension://id-copies-fond/contenu.js");
  lisible = true;
  message("partagé", "chrome-extension://id-copies-fond/contenu.js");
  message("de la page", "https://site.test/app.js");
  // Une extension qui n'est pas chargée dans cette session : ignorée.
  message("inconnue", "chrome-extension://inconnue/contenu.js");
  expect(notes).toEqual([
    { id: "id-copies-fond", texte: "caché", onglet: { lisible: false } },
    { id: "id-copies-fond", texte: "partagé", onglet: { lisible: true } },
  ]);
});

// ——— Effacement du stockage d'une extension de l'agent supprimée (borné dans le temps) ———

test("effacerStockage : chargée, chrome.storage vidé depuis sa page, retirée, puis son origine effacée", async () => {
  effacement.charger = () => Promise.resolve();
  effacement.executer = () => Promise.resolve(0);
  effacement.fermees = 0;
  const p = creer({ delaiEffacementMs: 50 });
  const s = fausseSession("p1") as FausseSession & { effacees: unknown[] };
  await p.effacerStockage("/copies/essai", [s as never]);
  const id = "id-copies-essai";
  expect(s.chargements.map((c) => c.chemin)).toEqual(["/copies/essai"]);
  expect(effacement.adresses.at(-1)).toBe(`chrome-extension://${id}/manifest.json`);
  expect(effacement.fermees).toBe(1);
  expect(s.retraits).toEqual([id]);
  expect(s.effacees).toEqual([{ origin: `chrome-extension://${id}` }]);
});

test("effacerStockage : une étape qui ne rend jamais (chargement de la page, script) échoue après le délai ; la vue est fermée, l'extension retirée, la file continue", async () => {
  for (const bloquer of ["charger", "executer"] as const) {
    effacement.charger = () => Promise.resolve();
    effacement.executer = () => Promise.resolve(0);
    if (bloquer === "charger") effacement.charger = () => new Promise<void>(() => {});
    else effacement.executer = () => new Promise<unknown>(() => {});
    effacement.fermees = 0;
    const p = creer({ delaiEffacementMs: 30 });
    const s = fausseSession("p1");
    await expect(p.effacerStockage("/copies/essai", [s as never])).rejects.toThrow(/délai/);
    expect(effacement.fermees).toBe(1);
    expect(s.retraits).toEqual(["id-copies-essai"]);
    // La file des synchronisations n'est pas bloquée.
    await p.synchroniser(etatExt({}));
  }
  effacement.charger = () => Promise.resolve();
  effacement.executer = () => Promise.resolve(0);
});

test("effacerStockage : un chargement qui ne rend pas échoue après le délai ; s'il finit plus tard, l'extension est retirée aussitôt", async () => {
  const p = creer({ delaiEffacementMs: 30 });
  const s = fausseSession("p1");
  let finir: () => void = () => {};
  s.lent = new Promise((r) => (finir = r));
  await expect(p.effacerStockage("/copies/essai", [s as never])).rejects.toThrow(/délai/);
  expect(s.retraits).toEqual([]);
  await p.synchroniser(etatExt({}));
  finir();
  await vi.waitFor(() => expect(s.retraits).toEqual(["id-copies-essai"]));
});

test("I6 un échec de chargement compte au plus un plantage par synchronisation, quel que soit le nombre de profils ; chargementRate le dit ; sansPlantage n'en compte aucun", async () => {
  etat = etatNav([{ id: "e1", profil: "defaut" }, { id: "e2", profil: "p2" }, { id: "e3", profil: "p3" }]);
  const plantages: string[] = [];
  const p = creer({ consoles: { noter: () => {}, plantage: (id: string) => void plantages.push(id) } as never });
  const sessions = ["defaut", "p2", "p3"].map((n) => {
    const s = fausseSession(n);
    p.brancher(s as unknown as Electron.Session, n);
    return s;
  });
  const chemin = join(dossier, "store", ID_A, "1_0");
  for (const s of sessions) s.echecs.add(chemin);
  const extensions = { [`store:${ID_A}`]: entree("store", ["defaut", "p2", "p3"], { version: "1" }) };
  await p.synchroniser(etatExt(extensions));
  expect(plantages).toEqual([ID_A]);
  expect(p.chargementRate(`store:${ID_A}`)).toMatch(/Manifest file is missing/);
  await p.sansPlantage(`store:${ID_A}`, () => p.synchroniser(etatExt({ ...extensions })));
  expect(plantages).toEqual([ID_A]);
  // Chargée dans un profil, ratée dans un autre : encore « ratée ».
  sessions[0]!.echecs.clear();
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut", "p2", "p3"], { version: "1" }) }));
  expect(p.chargementRate(`store:${ID_A}`)).not.toBeNull();
  // Plus voulue dans les profils ratés : plus rien de raté.
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"], { version: "1" }) }));
  expect(p.chargementRate(`store:${ID_A}`)).toBeNull();
});

test("B un service worker qui ne démarre jamais ne retient pas la file des synchronisations (délai borné)", async () => {
  const p = creer({ delaiFondMs: 50 });
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  (s.serviceWorkers as unknown as { startWorkerForScope: () => Promise<unknown> }).startWorkerForScope = () => new Promise(() => {});
  const journal = vi.spyOn(console, "error").mockImplementation(() => {});
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"]) }));
  const fini = await Promise.race([p.synchroniser(etatExt({})).then(() => true), new Promise((ok) => setTimeout(() => ok(false), 1000))]);
  journal.mockRestore();
  expect(fini).toBe(true);
  expect(s.charges.size).toBe(0);
});

test("B un effacement de stockage en cours ne retient pas les synchronisations (file séparée)", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const autre = fausseSession("autre");
  autre.lent = new Promise(() => {});
  void p.effacerStockage(join(dossier, "copies", "x"), [autre as unknown as Electron.Session]).catch(() => undefined);
  const fini = await Promise.race([
    p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"]) })).then(() => true),
    new Promise((ok) => setTimeout(() => ok(false), 1000)),
  ]);
  expect(fini).toBe(true);
  expect(s.charges.size).toBe(1);
});

test("C M4 estOnglet : jamais vrai pour une extension de l'agent quand le profil de la session est privé (seconde barrière)", async () => {
  const s = fausseSession("defaut");
  vuesParId.set(1, { isDestroyed: () => false, session: s });
  try {
    const p = creer({ estOnglet: () => true });
    p.brancher(s as unknown as Electron.Session, "defaut");
    await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }), [`store:${ID_A}`]: entree("store", ["defaut"]) }));
    const sess = s as unknown as Electron.Session;
    expect(p.estOnglet(sess, "id-copies-fond", 1)).toBe(true);
    // Le profil devient privé (entre le chargement et la vérification de `appliquerProfil`).
    etat = etatNav([{ id: "e1", profil: "defaut", prive: true }]);
    expect(p.estOnglet(sess, "id-copies-fond", 1)).toBe(false);
    // Une extension du Store, si (la règle ne vise que l'agent).
    expect(p.estOnglet(sess, `id-${ID_A}-1.0.0_0`, 1)).toBe(true);
  } finally {
    vuesParId.clear();
  }
});

test("N1/N6 onglets suivis : gardés après un retrait sans rechargement, oubliés à la navigation et à la destruction ; rechargés quand le profil devient privé", async () => {
  const s = fausseSession("defaut");
  const onglet = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, session: s, reload: vi.fn() });
  const [reste, navigue, detruit] = [onglet(), onglet(), onglet()];
  [reste, navigue, detruit].forEach((v, i) => vuesParId.set(i + 1, v));
  try {
    const p = creer({ estOnglet: () => true });
    p.brancher(s as unknown as Electron.Session, "defaut");
    const ext = { "agent:fond": entree("agent", ["defaut"], { accord: ACCORD_AGENT }) };
    await p.synchroniser(etatExt(ext));
    const sess = s as unknown as Electron.Session;
    for (const n of [1, 2, 3]) expect(p.estOnglet(sess, "id-copies-fond", n)).toBe(true);
    // Désactivée : retirée sans rechargement, les onglets restent suivis.
    await p.synchroniser(etatExt({}));
    navigue.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    detruit.emit("destroyed");
    // Une navigation dans un cadre ou dans le même document ne compte pas.
    reste.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    reste.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    etat = etatNav([{ id: "e1", profil: "defaut", prive: true }]);
    p.retirerAgentsPrives(etat);
    expect(reste.reload).toHaveBeenCalledTimes(1);
    expect(navigue.reload).not.toHaveBeenCalled();
    expect(detruit.reload).not.toHaveBeenCalled();
    // Rechargé : oublié (pas de second rechargement).
    await p.synchroniser(etatExt({}));
    expect(reste.reload).toHaveBeenCalledTimes(1);
  } finally {
    vuesParId.clear();
  }
});

// ——— Plan 16 : la session d'une appli de site (`brancherSite`) ———

/** Une fausse vue (WebContents) de la session `s`, connue de `webContents.fromId`. */
function fausseVue(s: FausseSession, id: number, url = "https://vidola-a.localhost/pubs") {
  const wc = Object.assign(new EventEmitter(), {
    id,
    session: s,
    favicon: undefined,
    audioMuted: false,
    detruite: false,
    getType: () => "window",
    getURL: () => url,
    getTitle: () => "Pubs",
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    isDestroyed: () => wc.detruite,
    reload: () => {},
  });
  vuesParId.set(id, wc);
  return wc;
}
function fausseFenetre(id: number) {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getSize: () => [800, 600],
    getPosition: () => [0, 0],
    isFocused: () => true,
    isAlwaysOnTop: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
  });
}
type MagasinBib = {
  tabs: Set<unknown>;
  tabToWindow: Map<unknown, unknown>;
  windows: Set<unknown>;
};
const magasinDe = (s: FausseSession) => (rouages(s).ctx.store as unknown as MagasinBib);

/** Les options `site` d'un test : l'appli `vidola`, son empreinte, sa vue, et ce qui a été ouvert ou fermé. */
function optionsSite(o: { empreinte?: string | null; vue?: { wc: unknown; fenetre: unknown } | null; permis?: boolean } = {}) {
  const r = {
    empreinte: o.empreinte === undefined ? "E1" : o.empreinte,
    vue: o.vue ?? null,
    permis: o.permis ?? true,
    demandes: [] as [string, string, string][],
    /** `peutCharger` (tabs.update) : réponse, et les demandes reçues. */
    charge: true,
    chargements: [] as [string, unknown, string][],
    ouvertes: [] as [string, string][],
    fermees: [] as unknown[],
    /** Ce que rend `ouvrir` (sinon : lève). */
    rendu: null as [unknown, unknown] | null,
  };
  const site: NonNullable<ConstructorParameters<typeof ExtensionsProfils>[0]["site"]> = {
    vue: (id) => (id === "vidola" ? (r.vue as never) : null),
    empreinte: (id) => (id === "vidola" ? r.empreinte : null),
    urlPermise: (id, extensionId, url) => {
      r.demandes.push([id, extensionId, url]);
      return r.permis;
    },
    ouvrir: async (id, url) => {
      r.ouvertes.push([id, url]);
      if (!r.rendu) throw new Error("rien d'ouvert");
      return r.rendu as never;
    },
    fermer: (wc) => void r.fermees.push(wc),
    peutCharger: (id, wc, url) => {
      r.chargements.push([id, wc, url]);
      return r.charge;
    },
  };
  return { r, site };
}
const enSite = (applis: Record<string, string>, plus: Partial<EntreeExtension> = {}) => entree("store", [], { applis, ...plus });

test("brancherSite équipe la session de l'appli une fois, sans page du Store, avec les deux preloads des correctifs", async () => {
  const avant = vi.fn(() => async () => ({ action: "deny" as const }));
  const { site } = optionsSite();
  const p = creer({ site, avantInstallationStore: avant });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const instance = ElectronChromeExtensions.fromSession(s as unknown as Electron.Session);
  expect(instance).toBeDefined();
  expect(() => p.brancherSite("vidola", s as unknown as Electron.Session)).not.toThrow();
  expect(ElectronChromeExtensions.fromSession(s as unknown as Electron.Session)).toBe(instance);
  expect(avant).not.toHaveBeenCalled();
  const ids = (s.preloads as { id: string; type: string }[]).map((x) => `${x.id}:${x.type}`);
  expect(ids).toEqual(["crx-mv2-preload:frame", "crx-mv3-preload:service-worker", "webaios-extensions-fond:service-worker", "webaios-extensions-page:frame"]);
  expect(p.aLaSession(s as unknown as Electron.Session)).toBe(true);
  // Sans l'option `site` : rien n'est fait.
  const sans = creer();
  const s2 = fausseSession("persist:site-autre");
  sans.brancherSite("autre", s2 as unknown as Electron.Session);
  expect(ElectronChromeExtensions.fromSession(s2 as unknown as Electron.Session)).toBeUndefined();
});

test("synchroniser charge dans la session de l'appli les clés de chargeesDansSite pour l'empreinte de site.empreinte ; empreinte null (appli fermée) ou autre : rien, et ce qui l'était est retiré", async () => {
  const { r, site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const ext = etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }), [`store:${ID_B}`]: enSite({ autre: "E1" }) });
  await p.synchroniser(ext);
  expect(s.chargements.map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]);
  expect(p.chargeesProfil("site:vidola").map((c) => c.cle)).toEqual([`store:${ID_A}`]);
  // Les domaines ont changé : l'empreinte n'est plus la même, l'extension est retirée.
  r.empreinte = "E2";
  await p.synchroniser(ext);
  expect(s.charges.size).toBe(0);
  expect(s.retraits).toEqual([`id-${ID_A}-1.0.0_0`]);
  // Appli fermée : rien n'est chargé.
  r.empreinte = null;
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }) }));
  expect(s.charges.size).toBe(0);
  r.empreinte = "E1";
  await p.synchroniser(ext);
  expect(s.charges.size).toBe(1);
  r.empreinte = null;
  await p.synchroniser(ext);
  expect(s.charges.size).toBe(0);
});

test("activée dans l'appli seulement : rien dans la session du profil ; activée dans le profil seulement : rien dans la session de l'appli", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const profil = fausseSession("defaut");
  const app = fausseSession("persist:site-vidola");
  p.brancher(profil as unknown as Electron.Session, "defaut");
  p.brancherSite("vidola", app as unknown as Electron.Session);
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }), [`store:${ID_B}`]: entree("store", ["defaut"]) }));
  expect(profil.chargements.map((c) => c.chemin)).toEqual([join(dossier, "store", ID_B, "1.0.0_0")]);
  expect(app.chargements.map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "1.0.0_0")]);
  // Une extension de l'agent, même active dans le profil : jamais dans l'appli.
  await p.synchroniser(etatExt({ "agent:fond": entree("agent", ["defaut"], { applis: { vidola: "E1" } }) }));
  expect(app.charges.size).toBe(0);
});

test("toutesCoupees : rien dans la session de l'appli", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const ext = { [`store:${ID_A}`]: enSite({ vidola: "E1" }) };
  await p.synchroniser(etatExt(ext));
  expect(s.charges.size).toBe(1);
  await p.synchroniser(etatExt(ext, true));
  expect(s.charges.size).toBe(0);
});

test("brancherSite d'une appli ouverte : sa vue est ajoutée comme onglet avec la fenêtre de l'appli ; ongletCree d'une vue de cette session fait de même", async () => {
  const s = fausseSession("persist:site-vidola");
  const vue = fausseVue(s, 41);
  const fenetre = fausseFenetre(7);
  const activer = vi.fn();
  const { site } = optionsSite({ vue: { wc: vue, fenetre } });
  try {
    const p = creer({ site });
    (p as unknown as { o: { activer: unknown } }).o.activer = activer;
    p.brancherSite("vidola", s as unknown as Electron.Session);
    const m = magasinDe(s);
    expect([...m.tabs]).toEqual([vue]);
    expect(m.tabToWindow.get(vue)).toBe(fenetre);
    const extension = appelante();
    const actif = (await rouages(s).ctx.router.getHandler("tabs.query").callback({ extension }, { active: true })) as { id: number }[];
    expect(actif.map((t) => t.id)).toEqual([41]);
    // Une autre vue de la session (page de l'extension dans sa petite fenêtre) : ongletCree l'ajoute aussi.
    const page = fausseVue(s, 42, `chrome-extension://${"x".repeat(32)}/options.html`);
    const petite = fausseFenetre(8);
    p.ongletCree(page as unknown as Electron.WebContents, petite as unknown as Electron.BrowserWindow);
    expect(m.tabToWindow.get(page)).toBe(petite);
    // selectTab ne revient jamais vers les onglets de WebAiOs, même demandé par l'extension (hors écho) : une seconde
    // page dans la même petite fenêtre devient active (la bibliothèque active chaque onglet ajouté) ; rendre la première
    // active par tabs.update fait appeler selectTab par la bibliothèque.
    const seconde = fausseVue(s, 43, `chrome-extension://${"x".repeat(32)}/autre.html`);
    p.ongletCree(seconde as unknown as Electron.WebContents, petite as unknown as Electron.BrowserWindow);
    await rouages(s).ctx.router.getHandler("tabs.update").callback({ extension }, 42, { active: true });
    expect(activer).not.toHaveBeenCalled();
  } finally {
    vuesParId.clear();
  }
});

test("tabs.create et windows.create depuis la session de l'appli passent par site.ouvrir, jamais par ouvrirOnglet ; verifierUrl demande site.urlPermise avec l'id de l'extension appelante, et un refus fait échouer l'appel", async () => {
  const s = fausseSession("persist:site-vidola");
  const vue = fausseVue(s, 51);
  const fenetre = fausseFenetre(9);
  const { r, site } = optionsSite({ vue: { wc: vue, fenetre }, permis: false });
  try {
    const p = creer({ site });
    p.brancherSite("vidola", s as unknown as Electron.Session);
    const routeur = rouages(s).ctx.router;
    const extension = appelante();
    await expect(routeur.getHandler("tabs.create").callback({ extension }, { url: "http://pub.localhost/" })).rejects.toThrow(/refusée/);
    await expect(routeur.getHandler("windows.create").callback({ extension }, { url: "http://pub.localhost/f" })).rejects.toThrow(/refusée/);
    await expect(routeur.getHandler("tabs.update").callback({ extension }, 51, { url: "http://pub.localhost/u" })).rejects.toThrow(/refusée/);
    expect(r.demandes).toEqual([
      ["vidola", extension.id, "http://pub.localhost/"],
      ["vidola", extension.id, "http://pub.localhost/f"],
      ["vidola", extension.id, "http://pub.localhost/u"],
    ]);
    expect(r.ouvertes).toEqual([]);
    // Permis : l'appli ouvre (la vue va sur la page du site, ou une petite fenêtre pour une page de l'extension).
    r.permis = true;
    r.rendu = [vue, fenetre];
    await routeur.getHandler("tabs.create").callback({ extension }, { url: "https://vidola-a.localhost/autre", active: true });
    const page = fausseVue(s, 52, `chrome-extension://${extension.id}/options.html`);
    const petite = fausseFenetre(10);
    r.rendu = [page, petite];
    await routeur.getHandler("windows.create").callback({ extension }, { url: "options.html" });
    expect(r.ouvertes).toEqual([
      ["vidola", "https://vidola-a.localhost/autre"],
      ["vidola", `chrome-extension://${extension.id}/options.html`],
    ]);
    // La page ouverte par windows.create est un onglet de sa petite fenêtre (comme dans Chrome) ; la vue reste dans la sienne.
    expect(magasinDe(s).tabToWindow.get(page)).toBe(petite);
    expect(magasinDe(s).tabToWindow.get(vue)).toBe(fenetre);
    expect(ouvertures).toEqual([]);
  } finally {
    vuesParId.clear();
  }
});

test("tabs.remove de la vue du site : refusé (« Onglet protégé »), sans rien retirer ni diffuser ; une page de l'extension passe par site.fermer, jamais o.fermer", async () => {
  // I1 : le crochet `peutFermerOnglet` du correctif refuse avant que la bibliothèque ne retire la vue.
  const s = fausseSession("persist:site-vidola");
  const vue = fausseVue(s, 61);
  const fenetre = fausseFenetre(11);
  const fermer = vi.fn();
  const { r, site } = optionsSite({ vue: { wc: vue, fenetre } });
  try {
    const p = creer({ site, fermer });
    p.brancherSite("vidola", s as unknown as Electron.Session);
    const routeur = rouages(s).ctx.router as unknown as Rouages["ctx"]["router"] & { broadcastEvent(n: string, ...a: unknown[]): void };
    const diffuses: string[] = [];
    const diffuser = routeur.broadcastEvent.bind(routeur);
    routeur.broadcastEvent = (n: string, ...a: unknown[]) => {
      diffuses.push(n);
      diffuser(n, ...a);
    };
    const extension = appelante();
    const ecouteurs = () => vue.eventNames().map((n) => `${String(n)}:${vue.listenerCount(n)}`).sort();
    const avant = ecouteurs();
    await expect(Promise.resolve().then(() => routeur.getHandler("tabs.remove").callback({ extension }, 61))).rejects.toThrow(/Onglet protégé/);
    expect(ecouteurs()).toEqual(avant);
    expect(diffuses).not.toContain("tabs.onRemoved");
    expect(r.fermees).toEqual([]);
    expect(fermer).not.toHaveBeenCalled();
    const tous = (await routeur.getHandler("tabs.query").callback({ extension }, {})) as { id: number; active: boolean }[];
    expect(tous.map((t) => [t.id, t.active])).toEqual([[61, true]]);
    expect(magasinDe(s).tabToWindow.get(vue)).toBe(fenetre);
    // Une page de l'extension (onglet de sa petite fenêtre) : fermée par l'appli.
    const page = fausseVue(s, 62, `chrome-extension://${extension.id}/options.html`);
    p.ongletCree(page as unknown as Electron.WebContents, fausseFenetre(12) as unknown as Electron.BrowserWindow);
    await routeur.getHandler("tabs.remove").callback({ extension }, 62);
    expect(r.fermees).toEqual([page]);
    expect(fermer).not.toHaveBeenCalled();
    // Détruite par WebAiOs (ongletDetruit, sans écho) : rien n'est fermé.
    p.ongletDetruit(vue as unknown as Electron.WebContents);
    expect(magasinDe(s).tabs.has(vue)).toBe(false);
    expect(r.fermees).toEqual([page]);
  } finally {
    vuesParId.clear();
  }
});

test("windows.remove de la fenêtre de l'appli : refusé (« Fenêtre protégée »), windows.getAll la rend toujours ; dans un profil, rien ne change", async () => {
  const s = fausseSession("persist:site-vidola");
  const vue = fausseVue(s, 71);
  const fenetre = fausseFenetre(13);
  const { site } = optionsSite({ vue: { wc: vue, fenetre } });
  try {
    const p = creer({ site });
    p.brancherSite("vidola", s as unknown as Electron.Session);
    const routeur = rouages(s).ctx.router;
    const extension = appelante();
    await expect(routeur.getHandler("windows.remove").callback({ extension }, 13)).rejects.toThrow(/Fenêtre protégée/);
    const fenetres = (await routeur.getHandler("windows.getAll").callback({ extension })) as { id: number }[];
    expect(fenetres.map((f) => f.id)).toEqual([13]);
    // Profil : aucun crochet, la bibliothèque fait comme avant (la fenêtre quitte son magasin).
    const sp = fausseSession("defaut");
    p.brancher(sp as unknown as Electron.Session, "defaut");
    const onglet = fausseVue(sp, 72);
    p.ongletCree(onglet as unknown as Electron.WebContents, fausseFenetre(14) as unknown as Electron.BrowserWindow);
    await rouages(sp).ctx.router.getHandler("windows.remove").callback({ extension }, 14);
    expect((await rouages(sp).ctx.router.getHandler("windows.getAll").callback({ extension })) as unknown[]).toEqual([]);
    await rouages(sp).ctx.router.getHandler("tabs.remove").callback({ extension }, 72);
  } finally {
    vuesParId.clear();
  }
});

test("une nouvelle version (dossier changé) est rechargée dans la session de l'appli comme dans celle d'un profil", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }, { version: "1.0.0" }) }));
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }, { version: "2.0.0" }) }));
  expect(s.retraits).toEqual([`id-${ID_A}-1.0.0_0`]);
  expect([...s.charges.values()].map((c) => c.chemin)).toEqual([join(dossier, "store", ID_A, "2.0.0_0")]);
});

test("un démarrage dans la session de l'appli appelle noterVue avec « site:vidola »", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const chemin = join(dossier, "store", ID_A, "1.0.0_0");
  s.manifestes.set(chemin, {
    version: "1.0.0",
    background: { service_worker: "fond.js" },
    declarative_net_request: { rule_resources: [{ id: "regles", enabled: true, path: "regles.json" }] },
  });
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: enSite({ vidola: "E1" }) }));
  const id = [...s.charges.keys()][0]!;
  expect(await demarrerFond(s, id, 1)).toEqual({ installation: { reason: "install" }, rulesets: ["regles"], rulesetsInactifs: [], agent: false });
  expect([...vuesNotees.keys()]).toEqual([`store:${ID_A}|site:vidola`]);
});

test("C15 un profil dont l'id contient « : » n'est jamais équipé (journalisé) : il ne peut pas prendre la portée d'une appli", async () => {
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { site } = optionsSite();
    const p = creer({ site });
    const faux = fausseSession("site:vidola");
    const autre = fausseSession("a:b");
    p.brancher(faux as unknown as Electron.Session, "site:vidola");
    p.brancher(autre as unknown as Electron.Session, "a:b");
    expect(ElectronChromeExtensions.fromSession(faux as unknown as Electron.Session)).toBeUndefined();
    expect(ElectronChromeExtensions.fromSession(autre as unknown as Electron.Session)).toBeUndefined();
    expect(erreur).toHaveBeenCalledTimes(2);
    await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["site:vidola", "a:b"], { applis: { vidola: "E1" } }) }));
    expect(faux.chargements).toEqual([]);
    expect(autre.chargements).toEqual([]);
    // La vraie appli, elle, reste branchable.
    const app = fausseSession("persist:site-vidola");
    p.brancherSite("vidola", app as unknown as Electron.Session);
    await vi.waitFor(() => expect(app.chargements).toHaveLength(1));
  } finally {
    erreur.mockRestore();
  }
});

/** Une clé publique de manifeste (base64 du SPKI DER) et l'id Chromium qu'elle donne, calculé ici indépendamment. */
function cleEtId(): { cle: string; id: string } {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return { cle: der.toString("base64"), id: [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("") };
}

test("C6 effacerStockage d'une extension du Store : un talon de même key (sans fond, scripts de contenu ni règles) est chargé depuis un dossier temporaire, effacé ensuite", async () => {
  effacement.charger = () => Promise.resolve();
  effacement.executer = () => Promise.resolve(0);
  const p = creer({ delaiEffacementMs: 200 });
  const s = fausseSession("persist:site-vidola") as FausseSession & { effacees: unknown[] };
  const { cle, id } = cleEtId();
  const ecrire = (dossierId: string, manifeste: Record<string, unknown>) => {
    const v = join(dossier, "store", dossierId, "1.0.0_0");
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, "manifest.json"), JSON.stringify(manifeste));
    return v;
  };
  const complet = {
    manifest_version: 3,
    name: "uBlock factice",
    version: "1.0.0",
    key: cle,
    background: { service_worker: "fond.js" },
    content_scripts: [{ matches: ["<all_urls>"], js: ["contenu.js"] }],
    declarative_net_request: { rule_resources: [{ id: "regles", enabled: true, path: "regles.json" }] },
  };
  const version = ecrire(id, complet);
  const lus: { chemin: string; manifeste: Record<string, unknown> }[] = [];
  const charger = s.extensions.loadExtension as (c: string, o: unknown) => Promise<unknown>;
  s.extensions.loadExtension = async (c: string, o: unknown) => {
    lus.push({ chemin: c, manifeste: JSON.parse(readFileSync(join(c, "manifest.json"), "utf8")) });
    return charger(c, o);
  };
  await p.effacerStockage(version, [s as never]);
  expect(lus).toHaveLength(1);
  expect(lus[0]!.chemin.startsWith(join(dossier, "store"))).toBe(false);
  expect(lus[0]!.manifeste).toEqual({ manifest_version: 3, name: "uBlock factice", version: "1.0.0", key: cle, permissions: ["storage"] });
  expect(existsSync(lus[0]!.chemin)).toBe(false);
  expect(s.retraits).toHaveLength(1);
  expect(s.effacees).toHaveLength(1);
  // Le vrai dossier n'est pas touché.
  expect(existsSync(join(version, "manifest.json"))).toBe(true);

  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // Sans key : journalisé, rien n'est chargé, l'effacement est sauté sans lever.
    const sansCle = ecrire(ID_B, { manifest_version: 3, name: "x", version: "1.0.0" });
    await expect(p.effacerStockage(sansCle, [s as never])).resolves.toBeUndefined();
    expect(erreur).toHaveBeenCalledWith(expect.stringMatching(/sans key/));
    // M2 : une key qui ne donne pas l'id du dossier (manifeste abîmé) : sautée, journalisée ; jamais une autre extension.
    const autreId = ecrire("d".repeat(32), complet);
    await expect(p.effacerStockage(autreId, [s as never])).resolves.toBeUndefined();
    expect(erreur).toHaveBeenCalledWith(expect.stringMatching(/ne correspond pas/));
    expect(lus).toHaveLength(1);
  } finally {
    erreur.mockRestore();
  }
  // Aucun talon laissé dans le dossier temporaire.
  expect(readdirSync(tmpdir()).filter((n) => n.startsWith("webaios-talon-") && lus.some((l) => l.chemin.endsWith(n)))).toEqual([]);
});

test("M1 effacerStockage : l'extension encore chargée dans la session (même id) fait lever « extension encore chargée », sans rien charger", async () => {
  const p = creer({ delaiEffacementMs: 200 });
  const s = fausseSession("persist:site-vidola");
  const { cle, id } = cleEtId();
  const version = join(dossier, "store", id, "1.0.0_0");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "x", version: "1.0.0", key: cle }));
  s.charges.set(id, { id, chemin: version });
  await expect(p.effacerStockage(version, [s as never])).rejects.toThrow(/extension encore chargée/);
  expect(s.chargements).toEqual([]);
  expect(s.retraits).toEqual([]);
});

test("C5 attendreDemarrage : rend vrai quand le démarrage du fond de la clé a été répondu dans la portée de l'appli ; faux sans réponse dans le délai, pas chargée, ou retirée pendant l'attente ; vrai tout de suite sans fond", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const chemin = join(dossier, "store", ID_A, "1.0.0_0");
  s.manifestes.set(chemin, { version: "1.0.0", background: { service_worker: "fond.js" } });
  s.manifestes.set(join(dossier, "store", ID_B, "1.0.0_0"), { version: "1.0.0" });
  const cle = `store:${ID_A}`;
  await p.synchroniser(etatExt({ [cle]: enSite({ vidola: "E1" }), [`store:${ID_B}`]: enSite({ vidola: "E1" }) }));
  // Sans fond : rien à attendre.
  expect(await p.attendreDemarrage("site:vidola", `store:${ID_B}`, 1000)).toBe(true);
  // Pas chargée dans cette portée : faux tout de suite.
  expect(await p.attendreDemarrage("site:autre", cle, 1000)).toBe(false);
  expect(await p.attendreDemarrage("site:vidola", `store:${"c".repeat(32)}`, 1000)).toBe(false);
  // Aucun démarrage dans le délai : faux.
  expect(await p.attendreDemarrage("site:vidola", cle, 20)).toBe(false);
  // I2 : la réponse au preload ne suffit pas ; c'est son accusé (rulesets posés) qui termine l'attente. Ensuite, vrai
  // tout de suite.
  const attente = p.attendreDemarrage("site:vidola", cle, 5000);
  let finie = false;
  void attente.then(() => (finie = true));
  const id = [...s.charges.values()].find((c) => c.chemin === chemin)!.id;
  const { accuser } = await demarrerFondAccuse(s, id, 1);
  await new Promise((ok) => setTimeout(ok, 10));
  expect(finie).toBe(false);
  await accuser();
  expect(await attente).toBe(true);
  expect(await p.attendreDemarrage("site:vidola", cle, 20)).toBe(true);
  // Retirée puis rechargée : il faut un nouveau démarrage ; retirée pendant l'attente : faux.
  await p.synchroniser(etatExt({}));
  await p.synchroniser(etatExt({ [cle]: enSite({ vidola: "E1" }) }));
  const seconde = p.attendreDemarrage("site:vidola", cle, 5000);
  await p.synchroniser(etatExt({}));
  expect(await seconde).toBe(false);
});

test("M2 activer, désactiver, réactiver vite : l'accusé du fond de la première fois ne compte pas pour la nouvelle ; il faut celui du nouveau fond", async () => {
  const { site } = optionsSite();
  const p = creer({ site });
  const s = fausseSession("persist:site-vidola");
  p.brancherSite("vidola", s as unknown as Electron.Session);
  const chemin = join(dossier, "store", ID_A, "1.0.0_0");
  s.manifestes.set(chemin, { version: "1.0.0", background: { service_worker: "fond.js" } });
  const cle = `store:${ID_A}`;
  const actif = etatExt({ [cle]: enSite({ vidola: "E1" }) });
  await p.synchroniser(actif);
  const id = [...s.charges.values()].find((c) => c.chemin === chemin)!.id;
  const premier = await demarrerFondAccuse(s, id, 1);
  // Désactivée puis réactivée avant que le premier fond n'ait accusé son démarrage.
  await p.synchroniser(etatExt({}));
  await p.synchroniser(actif);
  await premier.accuser();
  expect(await p.attendreDemarrage("site:vidola", cle, 30)).toBe(false);
  // Le nouveau fond accuse : c'est fait.
  const second = await demarrerFondAccuse(s, id, 2);
  await second.accuser();
  expect(await p.attendreDemarrage("site:vidola", cle, 30)).toBe(true);
});

test("I2 un profil : l'accusé du fond ne change pas la réponse au preload (installation, rulesets)", async () => {
  const p = creer();
  const s = fausseSession("defaut");
  p.brancher(s as unknown as Electron.Session, "defaut");
  const chemin = join(dossier, "store", ID_A, "1.0.0_0");
  s.manifestes.set(chemin, { version: "1.0.0", background: { service_worker: "fond.js" }, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "r.json" }] } });
  await p.synchroniser(etatExt({ [`store:${ID_A}`]: entree("store", ["defaut"]) }));
  const id = [...s.charges.keys()][0]!;
  const { reponse, accuser } = await demarrerFondAccuse(s, id, 1);
  expect(reponse).toEqual({ installation: { reason: "install" }, rulesets: ["r"], rulesetsInactifs: [], agent: false });
  await expect(accuser()).resolves.toBeUndefined();
  expect(await p.attendreDemarrage("defaut", `store:${ID_A}`, 30)).toBe(true);
});

test("I1 : tabs.update dans la session d'une appli demande site.peutCharger (l'onglet, l'adresse) juste avant loadURL ; un refus fait échouer l'appel sans rien charger", async () => {
  const s = fausseSession("persist:site-vidola");
  const vue = Object.assign(fausseVue(s, 71), { loadURL: vi.fn(async () => {}) });
  const fenetre = fausseFenetre(12);
  const { r, site } = optionsSite({ vue: { wc: vue, fenetre } });
  try {
    const p = creer({ site });
    p.brancherSite("vidola", s as unknown as Electron.Session);
    const routeur = rouages(s).ctx.router;
    const extension = appelante();
    r.charge = false;
    await expect(routeur.getHandler("tabs.update").callback({ extension }, 71, { url: "https://vidola-a.localhost/x" })).rejects.toThrow("Chargement refusé par WebAiOs");
    expect(vue.loadURL).not.toHaveBeenCalled();
    expect(r.chargements).toEqual([["vidola", vue, "https://vidola-a.localhost/x"]]);
    r.charge = true;
    await routeur.getHandler("tabs.update").callback({ extension }, 71, { url: "https://vidola-a.localhost/y" });
    expect(vue.loadURL).toHaveBeenCalledWith("https://vidola-a.localhost/y");
    // Sans adresse (active, muted) : rien à vérifier.
    await routeur.getHandler("tabs.update").callback({ extension }, 71, { active: true });
    expect(r.chargements).toHaveLength(2);
  } finally {
    vuesParId.clear();
  }
});
