import { beforeEach, expect, test, vi } from "vitest";

type Gestionnaire = (...a: unknown[]) => unknown;
interface FausseSession {
  partition: string;
  demande?: Gestionnaire;
  verification?: Gestionnaire;
  peripherique?: Gestionnaire;
  evenements: Record<string, Gestionnaire>;
  preloads: unknown[];
  efface: string[];
}
const sessions = new Map<string, FausseSession>();

vi.mock("electron", () => ({
  session: {
    fromPartition(partition: string) {
      let s = sessions.get(partition);
      if (!s) {
        const f: FausseSession = { partition, evenements: {}, preloads: [], efface: [] };
        s = Object.assign(f, {
          setPermissionRequestHandler: (h: Gestionnaire) => (f.demande = h),
          setPermissionCheckHandler: (h: Gestionnaire) => (f.verification = h),
          setDevicePermissionHandler: (h: Gestionnaire) => (f.peripherique = h),
          on: (e: string, h: Gestionnaire) => (f.evenements[e] = h),
          registerPreloadScript: (p: unknown) => f.preloads.push(p),
          clearStorageData: async () => void f.efface.push("stockage"),
          clearCache: async () => void f.efface.push("cache"),
          clearAuthCache: async () => void f.efface.push("authentification"),
          closeAllConnections: async () => void f.efface.push("connexions"),
        });
        sessions.set(partition, s);
      }
      return s;
    },
  },
}));

// vues.ts (preferencesWeb) importe electron-chrome-extensions, qui touche à `app` dès son chargement.
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));

const { effacerSessionSite, fixerPreloadSite, partitionSite, preferencesSite, sessionSite } = await import("../../src/main/sites/session");

const PRELOAD = "/app/out/preload/site.js";
fixerPreloadSite(PRELOAD);

beforeEach(() => sessions.clear());

const fausse = (id: string) => sessions.get(partitionSite(id))!;
const demander = (s: FausseSession, permission: string) =>
  new Promise((ok) => s.demande!(null, permission, ok, { requestingUrl: "https://vidola-a.example/" }));

test("partitionSite : une partition persistante par id", () => {
  expect(partitionSite("vidola")).toBe("persist:site-vidola");
  sessionSite("vidola");
  sessionSite("youtube");
  expect([...sessions.keys()]).toEqual(["persist:site-vidola", "persist:site-youtube"]);
  expect(sessionSite("vidola")).not.toBe(sessionSite("youtube"));
});

test("un id invalide ne donne aucune session", () => {
  for (const id of ["", "Vidola", "../webaios", "a b", "x".repeat(61)]) expect(() => sessionSite(id)).toThrow();
  expect(sessions.size).toBe(0);
});

test("sessionSite enregistre le preload une seule fois, sur le cadre", () => {
  const s = sessionSite("vidola");
  expect(sessionSite("vidola")).toBe(s);
  expect(fausse("vidola").preloads).toEqual([{ id: "webaios-site", type: "frame", filePath: PRELOAD }]);
});

test("permissions : plein écran seulement ; notifications, médias, position et presse-papiers refusés", async () => {
  sessionSite("vidola");
  const s = fausse("vidola");
  expect(await demander(s, "fullscreen")).toBe(true);
  expect(s.verification!(null, "fullscreen", "https://vidola-a.example", {})).toBe(true);
  for (const p of ["notifications", "media", "geolocation", "clipboard-sanitized-write", "clipboard-read", "openExternal", "midiSysex", "hid"]) {
    expect(await demander(s, p)).toBe(false);
    expect(s.verification!(null, p, "https://vidola-a.example", {})).toBe(false);
  }
  expect(s.peripherique!()).toBe(false);
  const empeche = vi.fn();
  const rappel = vi.fn();
  s.evenements["select-hid-device"]!({ preventDefault: empeche }, {}, rappel);
  expect(empeche).toHaveBeenCalled();
  expect(rappel).toHaveBeenCalledWith();
});

test("un téléchargement est annulé", () => {
  sessionSite("vidola");
  const empeche = vi.fn();
  const annule = vi.fn();
  fausse("vidola").evenements["will-download"]!({ preventDefault: empeche }, { cancel: annule }, null);
  expect(empeche).toHaveBeenCalled();
  expect(annule).toHaveBeenCalled();
});

test("preferencesSite : celles d'un onglet, vidéos lancées sans geste", () => {
  const s = sessionSite("vidola");
  expect(preferencesSite(s)).toEqual({
    session: s,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true,
    autoplayPolicy: "no-user-gesture-required",
  });
});

test("effacerSessionSite : connexions fermées, puis stockage, cache et identifiants HTTP, de la seule partition de l'appli", async () => {
  sessionSite("youtube");
  await effacerSessionSite("vidola");
  expect(fausse("vidola").efface).toEqual(["connexions", "stockage", "cache", "authentification"]);
  expect(fausse("youtube").efface).toEqual([]);
});
