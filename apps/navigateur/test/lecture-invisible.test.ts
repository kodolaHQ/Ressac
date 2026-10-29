import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { Menagement, ProfilRefuse } from "@webaios/noyau";
import type { EtatNavigateur } from "../src/commun/modele";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  BrowserWindow: vi.fn(),
}));

const { cumulerParties, lirePageInvisible, lireHtmlInvisible, profilsLisibles, urlPermise } = await import("../src/main/agent/lecture-invisible");

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

test("signal levé pendant la lecture : fenêtre fermée, promesse rejetée avec la raison, plus rien de lu", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  const arret = new AbortController();
  const r = lirePageInvisible("https://exemple.test/", { profil: null, signal: arret.signal }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(1_000);
  const raison = new Error("Exécution arrêtée");
  arret.abort(raison);
  await expect(r).rejects.toBe(raison);
  expect(f.destroy).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(wc.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
});

test("signal levé pendant la préparation (session vidée, page préparée) : rejetée tout de suite, fenêtre fermée", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  wc.debugger.sendCommand.mockImplementation(() => new Promise(() => {})); // le débogueur ne répond jamais
  const arret = new AbortController();
  const r = lireHtmlInvisible("https://exemple.test/", { signal: arret.signal }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  arret.abort(new Error("Exécution arrêtée"));
  await expect(r).rejects.toThrow("Exécution arrêtée");
  expect(f.destroy).toHaveBeenCalled();
  expect(wc.loadURL.mock.calls.map((c) => c[0])).not.toContain("https://exemple.test/");
});

test("signal déjà levé : rien n'est créé", async () => {
  const deps = { etat: () => etatLibre, sessionProfil: vi.fn(), sessionPublique: vi.fn(), creerFenetre: vi.fn() };
  const arret = new AbortController();
  arret.abort(new Error("Exécution arrêtée"));
  await expect(lirePageInvisible("https://exemple.test/", { profil: null, signal: arret.signal }, deps)).rejects.toThrow("Exécution arrêtée");
  await expect(lireHtmlInvisible("https://exemple.test/", { signal: arret.signal }, deps)).rejects.toThrow("Exécution arrêtée");
  expect(deps.sessionPublique).not.toHaveBeenCalled();
  expect(deps.creerFenetre).not.toHaveBeenCalled();
});

test("une lecture annulée en attente d'une place quitte la file ; les autres, d'une autre exécution, ne sont pas touchées", async () => {
  vi.useFakeTimers();
  const a = fausseFenetre(() => "https://exemple.test/a");
  const b = fausseFenetre(() => "https://exemple.test/b");
  const c = fausseFenetre(() => "https://exemple.test/c");
  const d = fausseFenetre(() => "https://exemple.test/d");
  const autre = new AbortController();
  const arret = new AbortController();
  const ra = lirePageInvisible("https://exemple.test/a", { profil: null, signal: autre.signal }, depsAvec(a.f));
  const rb = lirePageInvisible("https://exemple.test/b", { profil: null, signal: autre.signal }, depsAvec(b.f));
  const depsC = depsAvec(c.f);
  const rc = lirePageInvisible("https://exemple.test/c", { profil: null, signal: arret.signal }, depsC);
  rc.catch(() => {});
  const rd = lirePageInvisible("https://exemple.test/d", { profil: null, signal: autre.signal }, depsAvec(d.f));
  await vi.advanceTimersByTimeAsync(0);
  // Deux places : c et d attendent.
  expect(depsC.creerFenetre).not.toHaveBeenCalled();
  arret.abort(new Error("Exécution arrêtée"));
  await expect(rc).rejects.toThrow("Exécution arrêtée");
  for (const x of [a, b]) x.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(ra).resolves.toMatchObject({ url: "https://exemple.test/a" });
  await expect(rb).resolves.toMatchObject({ url: "https://exemple.test/b" });
  // La place de c n'est jamais prise : d passe à la place rendue.
  await vi.advanceTimersByTimeAsync(0);
  d.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(rd).resolves.toMatchObject({ url: "https://exemple.test/d" });
  expect(depsC.creerFenetre).not.toHaveBeenCalled();
  expect(a.f.destroy).toHaveBeenCalled();
});

/** Des fenêtres factices créées à la demande, chacune avec sa propre URL ; la session publique compte ses vidages. */
function plusieursFenetres() {
  const liste: ReturnType<typeof fausseFenetre>[] = [];
  const vidages = vi.fn(async () => {});
  const deps = {
    ...depsAvec(null),
    sessionPublique: vi.fn(() => ({ clearStorageData: vidages, clearCache: async () => {} }) as never),
    creerFenetre: vi.fn(() => {
      const x = {} as ReturnType<typeof fausseFenetre>;
      Object.assign(x, fausseFenetre(() => x.wc.url));
      liste.push(x);
      return x.f as never;
    }),
  };
  return { liste, deps, vidages };
}
const urls = (x: ReturnType<typeof fausseFenetre>) => x.wc.loadURL.mock.calls.map((c) => c[0]);

test("lecture ménagée : une redirection vers un autre site ferme la fenêtre et rend sa place, attend changerHote, puis lit la cible dans une nouvelle fenêtre", async () => {
  vi.useFakeTimers();
  const { liste, deps, vidages } = plusieursFenetres();
  let ouvrir!: () => void;
  const changerHote = vi.fn(() => new Promise<void>((r) => (ouvrir = r)));
  const r = lirePageInvisible("https://exemple.test/", { profil: null, changerHote }, deps);
  await vi.advanceTimersByTimeAsync(0);
  const e = { url: "https://www.Autre.test/x", isMainFrame: true, preventDefault: vi.fn() };
  liste[0]!.wc.emit("will-redirect", e);
  expect(e.preventDefault).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(liste[0]!.f.destroy).toHaveBeenCalled();
  expect(changerHote).toHaveBeenCalledWith("www.autre.test");
  // Rien d'autre pendant l'attente : ni fenêtre, ni chargement.
  await vi.advanceTimersByTimeAsync(5_000);
  expect(liste).toHaveLength(1);
  ouvrir();
  await vi.advanceTimersByTimeAsync(0);
  expect(liste).toHaveLength(2);
  expect(urls(liste[1]!)).toEqual(["about:blank", "https://www.Autre.test/x"]);
  liste[1]!.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ url: "https://www.Autre.test/x" });
  // La session publique n'est vidée qu'une fois : la cible voit les cookies du redirecteur.
  expect(vidages).toHaveBeenCalledTimes(1);
  expect(liste[1]!.f.destroy).toHaveBeenCalled();
});

test("lecture ménagée : le même site (www.) passe sans attendre ; deux navigations vers d'autres sites à la suite : seule la première est suivie", async () => {
  vi.useFakeTimers();
  const { liste, deps } = plusieursFenetres();
  const changerHote = vi.fn(async () => {});
  const r = lirePageInvisible("https://exemple.test/", { profil: null, changerHote }, deps);
  await vi.advanceTimersByTimeAsync(0);
  const meme = { url: "https://WWW.exemple.test/a", isMainFrame: true, preventDefault: vi.fn() };
  liste[0]!.wc.emit("will-redirect", meme);
  expect(meme.preventDefault).not.toHaveBeenCalled();
  const premiere = { url: "https://autre.test/", preventDefault: vi.fn() };
  const seconde = { url: "https://troisieme.test/", preventDefault: vi.fn() };
  liste[0]!.wc.emit("will-navigate", premiere);
  liste[0]!.wc.emit("will-navigate", seconde);
  expect(premiere.preventDefault).toHaveBeenCalled();
  expect(seconde.preventDefault).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(changerHote.mock.calls).toEqual([["autre.test"]]);
  expect(liste).toHaveLength(2);
  expect(urls(liste[1]!)).toEqual(["about:blank", "https://autre.test/"]);
  // De retour vers le site d'origine : attendu de nouveau.
  liste[1]!.wc.emit("will-redirect", { url: "https://exemple.test/fin", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(changerHote).toHaveBeenLastCalledWith("exemple.test");
  liste[2]!.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ url: "https://exemple.test/fin" });
});

test("lecture ménagée : changerHote rejeté (exécution arrêtée) fait échouer la lecture, rien n'est chargé", async () => {
  vi.useFakeTimers();
  const { liste, deps } = plusieursFenetres();
  const changerHote = vi.fn(async () => {
    throw new Error("Exécution arrêtée");
  });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, changerHote }, deps);
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  liste[0]!.wc.emit("will-redirect", { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() });
  await expect(r).rejects.toThrow("Exécution arrêtée");
  expect(liste).toHaveLength(1);
  expect(liste[0]!.f.destroy).toHaveBeenCalled();
});

test("lecture ménagée : l'attente compte dans les 30 s ; dépassées, « Page trop lente »", async () => {
  vi.useFakeTimers();
  const { liste, deps } = plusieursFenetres();
  const changerHote = vi.fn(() => new Promise<void>(() => {}));
  const r = lirePageInvisible("https://exemple.test/", { profil: null, changerHote }, deps);
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(10_000);
  liste[0]!.wc.emit("will-redirect", { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(19_000);
  expect(liste).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(r).rejects.toThrow("Page trop lente : 30 s dépassées");
});

/** Deux lectures ordinaires prennent les deux places ; rendues quand on le dit. */
async function deuxPlacesPrises() {
  const a = plusieursFenetres();
  const b = plusieursFenetres();
  const ra = lirePageInvisible("https://p.test/a", { profil: null }, a.deps);
  const rb = lirePageInvisible("https://p.test/b", { profil: null }, b.deps);
  await vi.advanceTimersByTimeAsync(0);
  return {
    async rendre() {
      for (const x of [a, b]) x.liste[0]!.wc.emit("did-finish-load");
      await vi.advanceTimersByTimeAsync(2_000);
      await ra;
      await rb;
    },
  };
}

test("lecture ménagée : un arrêt pendant l'attente du site ou d'une nouvelle place rend tout, une seule fois", async () => {
  vi.useFakeTimers();
  // Arrêt pendant l'attente du site : aucune place n'est tenue.
  const un = plusieursFenetres();
  let ouvrir!: () => void;
  const arret1 = new AbortController();
  const r1 = lirePageInvisible("https://exemple.test/", { profil: null, signal: arret1.signal, changerHote: () => new Promise<void>((ok) => (ouvrir = ok)) }, un.deps);
  r1.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  un.liste[0]!.wc.emit("will-redirect", { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  arret1.abort(new Error("Exécution arrêtée"));
  await expect(r1).rejects.toThrow("Exécution arrêtée");
  ouvrir();
  await vi.advanceTimersByTimeAsync(0);
  expect(un.liste).toHaveLength(1);

  // Arrêt pendant l'attente d'une nouvelle place (les deux sont prises) : la lecture quitte la file.
  const deux = plusieursFenetres();
  const arret2 = new AbortController();
  let ouvrir2!: () => void;
  const r2 = lirePageInvisible("https://exemple.test/", { profil: null, signal: arret2.signal, changerHote: () => new Promise<void>((ok) => (ouvrir2 = ok)) }, deux.deps);
  r2.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  deux.liste[0]!.wc.emit("will-redirect", { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  const places = await deuxPlacesPrises();
  ouvrir2();
  await vi.advanceTimersByTimeAsync(0);
  arret2.abort(new Error("Exécution arrêtée"));
  await expect(r2).rejects.toThrow("Exécution arrêtée");
  await places.rendre();
  expect(deux.liste).toHaveLength(1);

  // Les deux places sont libres, ni plus ni moins : deux lectures partent tout de suite, une troisième attend.
  const trois = [plusieursFenetres(), plusieursFenetres(), plusieursFenetres()];
  const lectures = trois.map((x, i) => lirePageInvisible(`https://q.test/${i}`, { profil: null }, x.deps));
  await vi.advanceTimersByTimeAsync(0);
  expect(trois.map((x) => x.liste.length)).toEqual([1, 1, 0]);
  for (const x of trois.slice(0, 2)) x.liste[0]!.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  trois[2]!.liste[0]!.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await Promise.all(lectures);
});

test("lecture ménagée : deux lectures redirigées vers le site d'une troisième, qui attend une place, ne bloquent rien", async () => {
  vi.useFakeTimers();
  const menagement = new Menagement();
  const lire = (url: string, x: ReturnType<typeof plusieursFenetres>) =>
    menagement.lire(new URL(url).hostname, (changerHote) => lirePageInvisible(url, { profil: null, changerHote }, x.deps));
  const [un, deux, trois] = [plusieursFenetres(), plusieursFenetres(), plusieursFenetres()];
  const r1 = lire("https://t.test/x", un);
  const r2 = lire("https://c.test/y", deux);
  await vi.advanceTimersByTimeAsync(0);
  // R3 prend la voie b.test, puis attend une place (R1 et R2 tiennent les deux).
  const r3 = lire("https://b.test/", trois);
  await vi.advanceTimersByTimeAsync(0);
  expect(trois.liste).toHaveLength(0);
  un.liste[0]!.wc.emit("will-redirect", { url: "https://b.test/1", isMainFrame: true, preventDefault: vi.fn() });
  deux.liste[0]!.wc.emit("will-redirect", { url: "https://b.test/2", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  // R1 et R2 ont rendu leur place en attendant la voie b.test : R3 lit tout de suite.
  expect(trois.liste).toHaveLength(1);
  trois.liste[0]!.wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r3).resolves.toMatchObject({ url: "https://b.test/" });
  // Puis R1 et R2, chacune à son tour sur b.test (1 s d'écart), bien avant les 30 s.
  for (const x of [un, deux]) {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(x.liste).toHaveLength(2);
    x.liste[1]!.wc.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(2_000);
  }
  await expect(r1).resolves.toMatchObject({ url: "https://b.test/1" });
  await expect(r2).resolves.toMatchObject({ url: "https://b.test/2" });
});

test("sans changerHote (lecture non ménagée) : une redirection permise vers un autre site part comme avant", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://autre.test/");
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  const e = { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() };
  wc.emit("will-redirect", e);
  expect(e.preventDefault).not.toHaveBeenCalled();
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ url: "https://autre.test/" });
});

test("lecture ménagée : une boucle entre deux sites s'arrête au 6e saut, « Trop de redirections »", async () => {
  vi.useFakeTimers();
  const { liste, deps } = plusieursFenetres();
  const changerHote = vi.fn(async () => {});
  const r = lirePageInvisible("https://a.test/", { profil: null, changerHote }, deps);
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 6; i++) {
    const vers = i % 2 === 0 ? "https://b.test/" : "https://a.test/";
    liste[i]!.wc.emit("will-redirect", { url: vers, isMainFrame: true, preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
  }
  await expect(r).rejects.toThrow("Trop de redirections");
  // 5 sauts suivis (6 fenêtres), pas un de plus.
  expect(liste).toHaveLength(6);
  expect(changerHote).toHaveBeenCalledTimes(5);
});

test("une page qui finit de charger après l'heure de la lecture forcée est lue tout de suite", async () => {
  vi.useFakeTimers();
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(27_000);
  wc.emit("did-finish-load");
  wc.emit("did-start-loading"); // un cadre qui charge tard
  await vi.advanceTimersByTimeAsync(0);
  expect(wc.executeJavaScriptInIsolatedWorld).toHaveBeenCalled();
  await expect(r).resolves.toMatchObject({ url: "https://exemple.test/" });
});

test("lecture ménagée : une place obtenue après l'échéance n'ouvre aucune fenêtre, « Page trop lente »", async () => {
  vi.useFakeTimers();
  const { liste, deps } = plusieursFenetres();
  let ouvrir!: () => void;
  const r = lirePageInvisible("https://exemple.test/", { profil: null, changerHote: () => new Promise<void>((ok) => (ouvrir = ok)) }, deps);
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  liste[0]!.wc.emit("will-redirect", { url: "https://autre.test/", isMainFrame: true, preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(20_000);
  const places = await deuxPlacesPrises();
  await vi.advanceTimersByTimeAsync(5_000);
  ouvrir();
  // L'échéance (30 s) passe pendant l'attente d'une place.
  await vi.advanceTimersByTimeAsync(10_000);
  await places.rendre();
  await expect(r).rejects.toThrow("Page trop lente : 30 s dépassées");
  expect(liste).toHaveLength(1);
});

// ——— Défilement (`defiler`) ———

/**
 * Une fausse page qu'on peut faire défiler : `hauteur` de la page, écran de 900 px. Les scripts sont reconnus à leur
 * texte (défilement : `scrollBy`, rend la hauteur d'avant ; mesure : le reste ; lecture : `querySelectorAll`). `apresDefilement(n)` est
 * appelé après le n-ième défilement (pour faire grandir la page).
 */
function pageDefilante(o: {
  hauteur: number;
  apresDefilement?: (n: number, p: { hauteur: number }) => void;
  avantMesure?: (p: { hauteur: number }) => void;
  lu?: (defilements: number) => unknown;
  /** Le défilement échoue (page en train de naviguer, cadre détruit). */
  echec?: boolean;
}) {
  const p = { hauteur: o.hauteur, haut: 0, defilements: 0, mondes: [] as number[], scripts: [] as string[] };
  const bas = () => p.haut + 900 >= p.hauteur - 2;
  const { wc, f } = fausseFenetre(() => "https://exemple.test/");
  wc.executeJavaScriptInIsolatedWorld.mockImplementation((async (monde: number, scripts: { code: string }[]) => {
    const code = scripts[0]!.code;
    p.mondes.push(monde);
    if (code.includes("scrollBy")) {
      // Une lecture juste avant un défilement est un relevé (liste virtualisée), pas la lecture finale.
      if (p.scripts.at(-1) === "lire") p.scripts[p.scripts.length - 1] = "releve";
      p.scripts.push("defiler");
      if (o.echec) throw new Error("Script failed to execute");
      // La hauteur d'avant le défilement : ce qui charge ensuite fait grandir la page.
      const avant = p.hauteur;
      p.haut = Math.max(0, Math.min(p.haut + 900, p.hauteur - 900));
      p.defilements++;
      o.apresDefilement?.(p.defilements, p);
      return { hauteur: avant, bas: bas() };
    }
    if (code.includes("querySelectorAll")) {
      p.scripts.push("lire");
      return o.lu ? o.lu(p.defilements) : { titre: "T", texte: `lu après ${p.defilements} défilements`, liens: [] };
    }
    p.scripts.push("mesurer");
    o.avantMesure?.(p);
    return { hauteur: p.hauteur, bas: bas() };
  }) as never);
  return { p, wc, f };
}

test("sans defiler : la page est lue sans défiler, comme avant", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 5_000 });
  const r = lirePageInvisible("https://exemple.test/", { profil: null }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  await expect(r).resolves.toMatchObject({ texte: "lu après 0 défilements" });
  expect(p.scripts).toEqual(["lire"]);
});

test("defiler : un écran à la fois dans le monde 999, jusqu'au bas d'une page qui ne grandit plus, puis lecture", async () => {
  vi.useFakeTimers();
  // 1 800 px : chaque défilement qui touche le bas en charge 900 de plus, deux fois.
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: (n, q) => void (n <= 2 && (q.hauteur += 900)) });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 8 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(p.scripts).toEqual([]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await r).texte.split("\n").at(-1)).toBe("lu après 3 défilements");
  expect(p.scripts.filter((s) => s === "defiler")).toHaveLength(3);
  expect(p.scripts.at(-1)).toBe("lire");
  expect(new Set(p.mondes)).toEqual(new Set([999]));
});

test("defiler : une page longue mais fixe est défilée jusqu'en bas (détails montrés à l'écran), pas au-delà", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 3_600 });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 20 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(15_000);
  // 3 600 − 900 = 2 700 : trois écrans pour atteindre le bas.
  expect((await r).texte.split("\n").at(-1)).toBe("lu après 3 défilements");
});

test("defiler : au plus le nombre d'écrans demandé, même si la page grandit encore", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: (_n, q) => void (q.hauteur += 900) });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 2 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await r).texte.split("\n").at(-1)).toBe("lu après 2 défilements");
  expect(p.defilements).toBe(2);
});

test("defiler : l'attente après un défilement finit dès 1 s sans croissance ; une page qui grandit sans cesse est lue à l'heure forcée, dans les 30 s", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, avantMesure: (q) => void (q.hauteur += 10) });
  const debut = Date.now();
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 20 }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(25_000);
  expect(p.scripts).not.toContain("lire");
  await vi.advanceTimersByTimeAsync(1_500);
  await expect(r).resolves.toMatchObject({ titre: "T" });
  expect(Date.now() - debut).toBeLessThan(30_000);
  expect(p.defilements).toBe(1);
});

test("defiler : un chargement en cours (cadre, navigation interne) prolonge l'attente après un défilement", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: () => void wc.emit("did-start-loading") });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 1 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(p.defilements).toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(p.scripts).not.toContain("lire");
  wc.emit("did-stop-loading");
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await r).texte.split("\n").at(-1)).toBe("lu après 1 défilements");
});

test("defiler : signal levé pendant le défilement : rejetée avec la raison, rien n'est lu, plus aucun script", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: (_n, q) => void (q.hauteur += 900) });
  const arret = new AbortController();
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 20, signal: arret.signal }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(3_500);
  expect(p.defilements).toBeGreaterThan(0);
  const raison = new Error("Exécution arrêtée");
  arret.abort(raison);
  await expect(r).rejects.toBe(raison);
  const vus = p.scripts.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(p.scripts).toHaveLength(vus);
  expect(p.scripts).not.toContain("lire");
  expect(f.destroy).toHaveBeenCalled();
});

test("defiler : une navigation hors des domaines pendant le défilement arrête la lecture, rien n'est lu", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: (_n, q) => void (q.hauteur += 900) });
  const r = lirePageInvisible("https://exemple.test/", { profil: "defaut", domaines: ["exemple.test"], defiler: 20 }, depsAvec(f));
  r.catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_500);
  const e = { url: "https://ailleurs.test/", preventDefault: vi.fn() };
  wc.emit("will-navigate", e);
  expect(e.preventDefault).toHaveBeenCalled();
  await expect(r).rejects.toThrow(/Navigation bloquée/);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(p.scripts).not.toContain("lire");
});

test("plafonds : 20 000 caractères et 400 liens sans défiler, 100 000 et 1 000 avec defiler", async () => {
  vi.useFakeTimers();
  const lu = () => ({ titre: "T", texte: "a".repeat(150_000), liens: Array.from({ length: 1_200 }, (_, i) => ({ texte: "l", url: `https://exemple.test/${i}` })) });
  for (const [defiler, texte, liens] of [[undefined, 20_000, 400], [3, 100_000, 1_000]] as const) {
    const { p, wc, f } = pageDefilante({ hauteur: 900, lu });
    const r = lirePageInvisible("https://exemple.test/", { profil: null, ...(defiler ? { defiler } : {}) }, depsAvec(f));
    await vi.advanceTimersByTimeAsync(0);
    wc.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(5_000);
    const page = await r;
    expect(page.texte).toHaveLength(texte);
    expect(page.liens).toHaveLength(liens);
    const appels = wc.executeJavaScriptInIsolatedWorld.mock.calls as unknown as [number, { code: string }[]][];
    const script = appels.map((a) => a[1][0]!.code).find((c) => c.includes("querySelectorAll"))!;
    expect(script).toContain(`slice(0, ${texte})`);
    expect(script).toContain(`>= ${liens}`);
    expect(p.scripts.at(-1)).toBe("lire");
  }
});

test("defiler : un script de défilement qui échoue (page qui navigue) : la page est lue sans défiler au calme suivant", async () => {
  vi.useFakeTimers();
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, echec: true });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 8 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(p.scripts).toEqual(["releve", "defiler"]);
  await vi.advanceTimersByTimeAsync(2_000);
  // Le relevé d'avant l'échec et la lecture finale montrent la même page : elle n'est gardée qu'une fois.
  await expect(r).resolves.toMatchObject({ texte: "lu après 0 défilements" });
  expect(p.scripts).toEqual(["releve", "defiler", "lire"]);
});

test("defiler : une liste virtualisée (les éléments sortis de l'écran disparaissent) est gardée au fur et à mesure", async () => {
  vi.useFakeTimers();
  // Chaque écran ne montre que ses 3 annonces ; deux annonces différentes ont le même prix.
  const ecran = (n: number) => ({
    titre: "Recherche",
    texte: ["Leboncoin", ...[1, 2, 3].flatMap((i) => [`Annonce ${n * 3 + i}`, "4 500 €"]), "Pied de page"].join("\n"),
    liens: [1, 2, 3].map((i) => ({ texte: `Annonce ${n * 3 + i} 4 500 €`, url: `https://exemple.test/a/${n * 3 + i}` })),
  });
  const { p, wc, f } = pageDefilante({ hauteur: 1_800, apresDefilement: (n, q) => void (n <= 2 && (q.hauteur += 900)), lu: ecran });
  const r = lirePageInvisible("https://exemple.test/", { profil: null, defiler: 8 }, depsAvec(f));
  await vi.advanceTimersByTimeAsync(0);
  wc.emit("did-finish-load");
  await vi.advanceTimersByTimeAsync(15_000);
  const page = await r;
  expect(p.scripts.filter((s) => s === "releve").length).toBeGreaterThan(0);
  for (let i = 1; i <= 12; i++) expect(page.texte).toContain(`Annonce ${i}\n4 500 €`);
  expect(page.texte.match(/4 500 €/g)).toHaveLength(12);
  expect(page.texte.match(/Leboncoin/g)).toHaveLength(1);
  expect(page.texte.match(/Pied de page/g)).toHaveLength(1);
  expect(page.liens.map((l) => l.url)).toEqual(Array.from({ length: 12 }, (_, i) => `https://exemple.test/a/${i + 1}`));
});

test("cumulerParties : lignes gardées une fois dans l'ordre d'apparition, liens par adresse avec le plus long texte", () => {
  const r = cumulerParties([
    { titre: "A", texte: "en-tête\nx\n10 €\ny", liens: [{ url: "https://e.test/1", texte: "court" }] },
    { titre: "B", texte: "en-tête\nx\n10 €\ny", liens: [{ url: "https://e.test/1", texte: "plus long" }] },
    { titre: "C", texte: "en-tête\nz\n10 €\nw", liens: [{ url: "https://e.test/2", texte: "deux" }, { url: 3 }] },
  ]);
  expect(r.titre).toBe("C");
  expect(r.texte).toBe("en-tête\nx\n10 €\ny\nz\n10 €\nw");
  expect(r.liens).toEqual([
    { url: "https://e.test/1", texte: "plus long" },
    { url: "https://e.test/2", texte: "deux" },
  ]);
});

test("cumulerParties : une liste qui avance (virtualisée) est recalée sur ce qu'elle partage avec le relevé d'avant, prix identiques gardés", () => {
  const r = cumulerParties([
    { titre: "T", texte: "En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…", liens: [] },
    // A1 est sorti de la page ; A2 est encore là ; A3 et A4 arrivent, au même prix.
    { titre: "T", texte: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", liens: [] },
    // Rien de nouveau : la page n'a plus bougé.
    { titre: "T", texte: "En-tête\nA2\n4 500 €\nA3\n4 500 €\nA4\n4 500 €", liens: [] },
  ]);
  expect(r.texte).toBe("En-tête\nA1\n4 500 €\nA2\n4 500 €\nChargement…\nA3\n4 500 €\nA4\n4 500 €");
});
