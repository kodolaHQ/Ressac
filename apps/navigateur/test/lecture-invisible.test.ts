import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { ProfilRefuse } from "@webaios/noyau";
import type { EtatNavigateur } from "../src/commun/modele";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  BrowserWindow: vi.fn(),
}));

const { lirePageInvisible, lireHtmlInvisible, profilsLisibles, urlPermise } = await import("../src/main/agent/lecture-invisible");

const etat = (profils: string[], espaces: { profil: string; prive: boolean }[]) =>
  ({ profils: profils.map((id) => ({ id })), espaces: espaces.map((e, i) => ({ id: `e${i}`, ...e })) }) as unknown as EtatNavigateur;

test("profilsLisibles exclut les profils d'un espace privé, même partagés avec un espace non privé", () => {
  const e = etat(
    ["defaut", "travail", "secret", "libre"],
    [
      { profil: "defaut", prive: false },
      { profil: "travail", prive: false },
      { profil: "travail", prive: true },
      { profil: "secret", prive: true },
    ],
  );
  expect(profilsLisibles(e)).toEqual(["defaut", "libre"]);
});

test("lirePageInvisible refuse un profil privé ou inconnu (ProfilRefuse) sans créer de vue", async () => {
  const e = etat(["defaut", "secret"], [
    { profil: "defaut", prive: false },
    { profil: "secret", prive: true },
  ]);
  const deps = { etat: () => e, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  for (const profil of ["secret", "inconnu"]) {
    const r = lirePageInvisible("https://exemple.test/", { profil }, deps);
    await expect(r).rejects.toBeInstanceOf(ProfilRefuse);
    await expect(r).rejects.toMatchObject({ profil });
  }
  expect(deps.sessionProfil).not.toHaveBeenCalled();
  expect(deps.sessionPublique).not.toHaveBeenCalled();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("lirePageInvisible refuse une URL qui n'est pas http(s), ou hors des domaines, sans créer de vue", async () => {
  const e = etat(["defaut"], [{ profil: "defaut", prive: false }]);
  const deps = { etat: () => e, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  await expect(lirePageInvisible("file:///etc/passwd", { profil: null }, deps)).rejects.toThrow();
  await expect(lirePageInvisible("https://ailleurs.test/", { profil: "defaut", domaines: ["exemple.test"] }, deps)).rejects.toThrow();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("urlPermise : http(s) seulement ; avec domaines, l'hôte exact (point final ignoré), comme le noyau", () => {
  expect(urlPermise("https://exemple.test/a", undefined)).toBe(true);
  expect(urlPermise("javascript:alert(1)", undefined)).toBe(false);
  expect(urlPermise("pas une url", undefined)).toBe(false);
  expect(urlPermise("https://exemple.test./a", ["exemple.test"])).toBe(true);
  expect(urlPermise("https://EXEMPLE.test/a", ["exemple.test."])).toBe(true);
  expect(urlPermise("https://autre.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("https://exemple.test.autre.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("https://www.exemple.test/", ["exemple.test"])).toBe(false);
  expect(urlPermise("data:text/html,x", ["exemple.test"])).toBe(false);
});

test("urlPermise refuse les adresses locales, sauf option des tests", () => {
  for (const u of ["http://localhost./", "http://localhost:11434/api", "http://127.0.0.1:11434/", "http://192.168.1.1/", "http://[::1]/", "http://10.0.0.2/", "http://box.local/"]) {
    expect(urlPermise(u, undefined), u).toBe(false);
    expect(urlPermise(u, undefined, true), u).toBe(true);
  }
  expect(urlPermise("http://127.0.0.1/", ["127.0.0.1"])).toBe(false);
  expect(urlPermise("http://127.0.0.1/", ["127.0.0.1"], true)).toBe(true);
  expect(urlPermise("https://exemple.test/", undefined, false)).toBe(true);
});

/** Une fausse page : les événements de navigation sont émis à la main. */
function fausseFenetre(urlFinale: () => string, lecture: () => Promise<unknown> = async () => ({ titre: "T", texte: "texte", liens: [] })) {
  const wc = Object.assign(new EventEmitter(), {
    url: "about:blank",
    commandes: [] as string[],
    arrets: 0,
    loadURL: vi.fn(async (u: string) => {
      wc.url = u;
    }),
    getURL: () => (wc.url === "about:blank" ? wc.url : urlFinale()),
    isDestroyed: () => false,
    stop: () => void wc.arrets++,
    setAudioMuted: () => {},
    executeJavaScriptInIsolatedWorld: vi.fn(lecture),
    debugger: Object.assign(new EventEmitter(), {
      attach: vi.fn(),
      isAttached: () => true,
      detach: vi.fn(),
      sendCommand: vi.fn(async (m: string) => void wc.commandes.push(m)),
    }),
  });
  const f = { webContents: wc, isDestroyed: vi.fn(() => false), destroy: vi.fn() };
  return { wc, f };
}

const etatLibre = etat(["defaut"], [{ profil: "defaut", prive: false }]);
const depsAvec = (f: unknown) => ({ etat: () => etatLibre, sessionProfil: vi.fn(() => ({}) as never), sessionPublique: vi.fn(() => ({ clearStorageData: async () => {}, clearCache: async () => {} }) as never), creerFenetre: vi.fn(() => f as never) });

afterEach(() => void vi.useRealTimers());

test("window.print neutralisé avant les scripts de la page, cadres compris", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  expect(wc.debugger.attach).toHaveBeenCalled();
  expect(wc.commandes).toEqual(expect.arrayContaining(["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "Target.setAutoAttach"]));
  // Le script est posé avant le chargement de la page.
  expect(wc.loadURL.mock.calls.map((c) => c[0])).toEqual(["about:blank", "https://exemple.test/"]);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ url: "https://exemple.test/", titre: "T" });
  expect(f.destroy).toHaveBeenCalled();
});

test("un cadre qui charge tard repousse la lecture à 2 s après la fin de tout chargement, pas à la lecture forcée", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(1_000);
  wc.emit("did-start-loading"); // une publicité dans un cadre
  await vi.advanceTimersByTimeAsync(3_000);
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  wc.emit("did-stop-loading");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalled();
  await expect(r).resolves.toMatchObject({ texte: "texte" });
});

test("pushState pendant la lecture : l'URL finale, si permise, est rendue ; hors domaines, refusée", async () => {
  vi.useFakeTimers();
  let url = "https://exemple.test/";
  const { wc, f } = fausseFenetre(() => url, async () => {
    url = "https://exemple.test/fil";
    return { titre: "T", texte: "x", liens: [] };
  });
  const r = lirePageInvisible("https://exemple.test/", { profil: "defaut", domaines: ["exemple.test"] }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ url: "https://exemple.test/fil" });

  let url2 = "https://exemple.test/";
  const b = fausseFenetre(() => url2, async () => {
    url2 = "https://ailleurs.test/";
    return { titre: "T", texte: "x", liens: [] };
  });
  const r2 = lirePageInvisible("https://exemple.test/", { profil: "defaut", domaines: ["exemple.test"] }, depsAvec(b.f));
  r2.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  b.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r2).rejects.toThrow(/hors des domaines/);
});

test("une redirection vers une adresse locale est annulée avant de partir, et la lecture échoue", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  const e = { url: "http://127.0.0.1:11434/api/tags", isMainFrame: true, preventDefault: vi.fn() };
  wc.emit("will-redirect", e);
  expect(e.preventDefault).toHaveBeenCalled();
  await expect(r).rejects.toThrow(/Navigation bloquée/);
  // L'arrêt de la page est différé : jamais dans le gestionnaire d'un événement de navigation.
  expect(wc.arrets).toBe(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.destroy).toHaveBeenCalled();
});

test("lirePageInvisible refuse une URL locale sans créer de vue, sauf adressesLocales", async () => {
  const deps = { etat: () => etatLibre, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  await expect(lirePageInvisible("http://127.0.0.1:11434/", { profil: null }, deps)).rejects.toThrow();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("lireHtmlInvisible vide la session publique puis lit le HTML de la page", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/final", async () => "<html><body>x</body></html>");
  const ordre: string[] = [];
  const deps = {
    ...depsAvec(f),
    sessionPublique: vi.fn(() => ({ clearStorageData: async () => void ordre.push("storage"), clearCache: async () => void ordre.push("cache") }) as never),
    creerFenetre: vi.fn(() => (ordre.push("fenetre"), f) as never),
  };
  const r = lireHtmlInvisible("https://exemple.test/", {}, deps);
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toEqual({ url: "https://exemple.test/final", html: "<html><body>x</body></html>" });
  expect(ordre).toEqual(["storage", "cache", "fenetre"]);
  expect(deps.sessionProfil).not.toHaveBeenCalled();
  const appel = wc.executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as [number, unknown];
  expect(appel[0]).toBe(999);
  expect(JSON.stringify(appel[1])).toContain("outerHTML");
  expect(f.destroy).toHaveBeenCalled();
});

test("lireHtmlInvisible refuse une adresse locale sans créer de fenêtre", async () => {
  const deps = { etat: () => etatLibre, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  await expect(lireHtmlInvisible("http://127.0.0.1:11434/", {}, deps)).rejects.toThrow(/Adresse refusée/);
  expect(deps.creerFenetre).not.toHaveBeenCalled();
  expect(deps.sessionPublique).not.toHaveBeenCalled();
});

test("le HTML lu est coupé à 2 Mo", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/", async () => "a".repeat(2 * 1024 * 1024 + 500));
  const r = lireHtmlInvisible("https://exemple.test/", {}, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await r).html).toHaveLength(2 * 1024 * 1024);
});
