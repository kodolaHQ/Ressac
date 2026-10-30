import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { afterAll, expect, test, vi } from "vitest";
import type { Portee } from "@webaios/noyau";

vi.mock("electron", () => ({ app: { on: () => {} } }));

const { urlPermiseAgent, hotePermisAgent, motifCouvre, equiperPagesAgent, idChromeDeDossier } = await import(
  "../../src/main/extensions/reseau"
);

const ID = "a".repeat(32);
const AUTRE = "b".repeat(32);
const accord: Portee = {
  permissions: ["tabs"],
  hotes: ["https://*.hote.test/*", "http://127.0.0.1/*"],
  reseau: ["api.accorde.test"],
  tousLesSites: false,
  scriptsTousLesSites: false,
};

test("hôte de reseau permis ; hôte de hotes permis ; autre hôte, data:, javascript:, file: refusés ; chrome-extension:// d'une autre extension refusé", () => {
  expect(urlPermiseAgent("https://api.accorde.test/x?y=1", accord, ID)).toBe(true);
  expect(urlPermiseAgent("http://api.accorde.test/", accord, ID)).toBe(true);
  expect(urlPermiseAgent("https://www.hote.test/page", accord, ID)).toBe(true);
  expect(urlPermiseAgent("https://hote.test/", accord, ID)).toBe(true);
  expect(urlPermiseAgent("http://127.0.0.1:8123/cache.html", accord, ID)).toBe(true);
  expect(urlPermiseAgent(`chrome-extension://${ID}/page.html`, accord, ID)).toBe(true);

  expect(urlPermiseAgent("https://autre.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent("https://accorde.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent("https://hote.test.autre.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent("https://www.hote.test@autre.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent("https://u:p@api.accorde.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent("data:text/html,<p>x</p>", accord, ID)).toBe(false);
  expect(urlPermiseAgent("javascript:alert(1)", accord, ID)).toBe(false);
  expect(urlPermiseAgent("file:///etc/passwd", accord, ID)).toBe(false);
  expect(urlPermiseAgent(`blob:chrome-extension://${ID}/x`, accord, ID)).toBe(false);
  expect(urlPermiseAgent("ftp://api.accorde.test/", accord, ID)).toBe(false);
  expect(urlPermiseAgent(`chrome-extension://${AUTRE}/page.html`, accord, ID)).toBe(false);
  expect(urlPermiseAgent("pas une adresse", accord, ID)).toBe(false);
});

test("motifs de Chrome : schéma, joker de sous-domaine, port, chemin", () => {
  const u = (x: string) => new URL(x);
  expect(motifCouvre("<all_urls>", u("https://x.test/"))).toBe(true);
  expect(motifCouvre("*://x.test/*", u("http://x.test/a"))).toBe(true);
  expect(motifCouvre("https://x.test/*", u("http://x.test/a"))).toBe(false);
  expect(motifCouvre("https://x.test/docs/*", u("https://x.test/docs/a"))).toBe(true);
  expect(motifCouvre("https://x.test/docs/*", u("https://x.test/autre"))).toBe(false);
  expect(motifCouvre("https://x.test:8443/*", u("https://x.test:8443/"))).toBe(true);
  expect(motifCouvre("https://x.test:8443/*", u("https://x.test/"))).toBe(false);
  expect(motifCouvre("https://*/*", u("https://n.importe.quoi/"))).toBe(true);
  expect(motifCouvre("<all_urls>", u("file:///x"))).toBe(false);
});

test("hotePermisAgent : seulement les hôtes accordés (pas reseau)", () => {
  expect(hotePermisAgent("https://www.hote.test/", accord)).toBe(true);
  expect(hotePermisAgent("https://api.accorde.test/", accord)).toBe(false);
  expect(hotePermisAgent("about:blank", accord)).toBe(false);
});

const accordDe = (id: string) => (id === ID ? accord : id === "c".repeat(32) ? null : undefined);

/** Une fausse vue : événements, gestionnaire d'ouverture, politique WebRTC. */
function fausseVue(url: string) {
  const ecouteurs = new Map<string, ((...a: unknown[]) => void)[]>();
  const vue = {
    url,
    gestionnaire: null as null | ((d: unknown) => unknown),
    politiques: [] as string[],
    getURL: () => vue.url,
    on(n: string, f: (...a: unknown[]) => void) {
      ecouteurs.set(n, [...(ecouteurs.get(n) ?? []), f]);
    },
    setWindowOpenHandler(g: (d: unknown) => unknown) {
      vue.gestionnaire = g;
    },
    setWebRTCIPHandlingPolicy(p: string) {
      vue.politiques.push(p);
    },
    emettre(n: string, ...a: unknown[]) {
      for (const f of ecouteurs.get(n) ?? []) f(...a);
    },
  };
  return vue;
}

test("pages de l'agent : navigations hors accord refusées, ouvertures refusées (gestionnaire posé ensuite enveloppé), WebRTC sans UDP direct", () => {
  const vue = fausseVue("");
  equiperPagesAgent(vue as unknown as Electron.WebContents, accordDe);
  // WebAiOs pose ensuite son gestionnaire d'onglet : il reste en vigueur pour les autres pages.
  vue.setWindowOpenHandler(() => ({ action: "allow", tag: "onglets" }));
  vue.url = "https://www.hote.test/";
  expect(vue.gestionnaire!({ url: "https://autre.test/" })).toEqual({ action: "allow", tag: "onglets" });

  vue.emettre("did-start-navigation", { url: `chrome-extension://${ID}/page.html`, isMainFrame: true, isSameDocument: false });
  vue.url = `chrome-extension://${ID}/page.html`;
  expect(vue.politiques).toEqual(["disable_non_proxied_udp"]);
  expect(vue.gestionnaire!({ url: "https://api.accorde.test/" })).toEqual({ action: "deny" });

  const naviguer = (evenement: string, url: string, ...plus: unknown[]) => {
    let refusee = false;
    const e = { preventDefault: () => (refusee = true), url, ...Object.assign({}, ...plus) };
    if (evenement === "will-navigate") vue.emettre(evenement, e, url);
    else vue.emettre(evenement, e);
    return refusee;
  };
  expect(naviguer("will-navigate", "https://autre.test/?donnees=1")).toBe(true);
  expect(naviguer("will-navigate", "data:text/html,x")).toBe(true);
  expect(naviguer("will-navigate", "https://www.hote.test/")).toBe(false);
  expect(naviguer("will-navigate", `chrome-extension://${ID}/autre.html`)).toBe(false);
  expect(naviguer("will-frame-navigate", "https://autre.test/", { frame: { url: `chrome-extension://${ID}/page.html` } })).toBe(true);
  expect(naviguer("will-frame-navigate", "https://api.accorde.test/", { frame: { url: `chrome-extension://${ID}/page.html` } })).toBe(false);

  // L'utilisateur tape une autre adresse : la page n'est plus de l'agent, la politique revient.
  vue.emettre("did-start-navigation", { url: "https://autre.test/", isMainFrame: true, isSameDocument: false });
  vue.url = "https://autre.test/";
  expect(vue.politiques).toEqual(["disable_non_proxied_udp", "default"]);
  expect(naviguer("will-navigate", "https://n.importe.quoi/")).toBe(false);
});

test("pages de l'agent : une vue sans gestionnaire (popup d'action) en reçoit un qui refuse ; une page du Store n'est pas touchée", () => {
  const popup = fausseVue("");
  equiperPagesAgent(popup as unknown as Electron.WebContents, accordDe);
  popup.emettre("did-start-navigation", { url: `chrome-extension://${ID}/popup.html`, isMainFrame: true, isSameDocument: false });
  popup.url = `chrome-extension://${ID}/popup.html`;
  expect(popup.gestionnaire!({ url: "https://www.hote.test/" })).toEqual({ action: "deny" });

  const store = fausseVue("");
  equiperPagesAgent(store as unknown as Electron.WebContents, accordDe);
  store.emettre("did-start-navigation", { url: `chrome-extension://${AUTRE}/popup.html`, isMainFrame: true, isSameDocument: false });
  store.url = `chrome-extension://${AUTRE}/popup.html`;
  expect(store.gestionnaire).toBeNull();
  expect(store.politiques).toEqual([]);
  let refusee = false;
  store.emettre("will-navigate", { preventDefault: () => (refusee = true) }, "https://autre.test/");
  expect(refusee).toBe(false);
});

const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

test("idChromeDeDossier : 32 lettres de a à p, stable, propre au chemin réel", () => {
  const d = mkdtempSync(join(tmpdir(), "webaios-id-"));
  temporaires.push(d);
  const id = idChromeDeDossier(d);
  expect(id).toMatch(/^[a-p]{32}$/);
  expect(idChromeDeDossier(d + "/")).toBe(id);
  expect(idChromeDeDossier(join(d, "x"))).not.toBe(id);
});

// --- Le garde (packages/noyau/extensions/webaios-garde-fond.js), exécuté dans un contexte à part.

const cheminGarde = join(import.meta.dirname, "..", "..", "..", "..", "packages", "noyau", "extensions", "webaios-garde-fond.js");

function contexteGarde(permises: { urls?: string[]; onglets?: number[]; nonOnglets?: number[] } = {}, scripting: Record<string, unknown> = {}) {
  const appels: [string, unknown[]][] = [];
  const api = (nom: string) =>
    vi.fn((...a: unknown[]) => {
      appels.push([nom, a]);
      return Promise.resolve(`ok:${nom}`);
    });
  const ecouteurs: ((m: unknown, e: unknown, r: (x: unknown) => void) => unknown)[] = [];
  // Comme les événements de Chromium : les méthodes sont sur le prototype.
  const onMessage = Object.create({
    addListener: (f: (typeof ecouteurs)[number]) => void ecouteurs.push(f),
    removeListener: (f: (typeof ecouteurs)[number]) => {
      const i = ecouteurs.indexOf(f);
      if (i >= 0) ecouteurs.splice(i, 1);
    },
    hasListener: (f: (typeof ecouteurs)[number]) => ecouteurs.includes(f),
    hasListeners: () => ecouteurs.length > 0,
  }) as Record<string, (f?: unknown) => unknown>;
  /** Un message comme Chromium le remet : chaque écouteur, la première réponse gagne ; rend cette réponse. */
  const emettre = (m: unknown, expediteur: unknown) =>
    new Promise((ok) => {
      let attendre = false;
      for (const f of [...ecouteurs]) if (f(m, expediteur, ok) === true) attendre = true;
      if (!attendre) setTimeout(() => ok("aucune réponse"), 50);
    });
  const chrome = {
    runtime: { id: ID, onMessage } as Record<string, unknown>,
    declarativeNetRequest: { updateDynamicRules: api("updateDynamicRules"), updateSessionRules: api("updateSessionRules") },
    tabs: { create: api("tabs.create"), update: api("tabs.update"), query: vi.fn(async () => [{ id: 9 }]), insertCSS: api("tabs.insertCSS") },
    windows: { create: api("windows.create") },
    scripting: {
      executeScript: api("scripting.executeScript"),
      insertCSS: api("scripting.insertCSS"),
      registerContentScripts: api("scripting.registerContentScripts"),
      updateContentScripts: api("scripting.updateContentScripts"),
      ...scripting,
    },
  };
  const ctx: Record<string, unknown> = {
    chrome,
    console: { error: () => {} },
    RTCPeerConnection: class {},
    RTCDataChannel: class {},
    __webaios: {
      urlPermise: async (u: string) => (permises.urls ?? []).includes(u),
      hotePermis: async (o: number) => (permises.onglets ?? []).includes(o),
      estOnglet: async (o: number) => !(permises.nonOnglets ?? []).includes(o),
    },
    Promise,
    Error,
    Object,
    Array,
    String,
  };
  ctx.globalThis = ctx;
  runInNewContext(readFileSync(cheminGarde, "utf8"), ctx);
  return { ctx, chrome, appels, ecouteurs, emettre };
}

test("garde : updateDynamicRules / updateSessionRules refusent redirect, modifyHeaders, regexSubstitution, transform ; block accepté", async () => {
  const { chrome, appels } = contexteGarde();
  const dnr = chrome.declarativeNetRequest;
  const regle = (action: unknown) => ({ addRules: [{ id: 1, priority: 1, action, condition: { urlFilter: "x" } }] });
  await expect(dnr.updateDynamicRules(regle({ type: "redirect", redirect: { url: "https://x.test/" } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (redirect)",
  );
  await expect(dnr.updateSessionRules(regle({ type: "modifyHeaders", requestHeaders: [] }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (modifyHeaders)",
  );
  await expect(dnr.updateDynamicRules(regle({ type: "upgradeScheme", redirect: { regexSubstitution: "\\1" } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (regexSubstitution)",
  );
  await expect(dnr.updateDynamicRules(regle({ type: "upgradeScheme", redirect: { transform: {} } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (transform)",
  );
  expect(appels).toEqual([]);
  await expect(dnr.updateDynamicRules(regle({ type: "block" }))).resolves.toBe("ok:updateDynamicRules");
  await expect(dnr.updateDynamicRules({ removeRuleIds: [1] })).resolves.toBe("ok:updateDynamicRules");
  // Remplacé pour de bon : ni réécrit, ni supprimé.
  const garde = dnr.updateDynamicRules;
  expect(() => {
    "use strict";
    delete (dnr as Record<string, unknown>).updateDynamicRules;
  }).toThrow();
  expect(dnr.updateDynamicRules).toBe(garde);
});

test("garde : un rappel reçoit chrome.runtime.lastError pendant l'appel, puis il est effacé", async () => {
  const { chrome } = contexteGarde();
  const vu = await new Promise((ok) =>
    chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, action: { type: "redirect" } }] }, () =>
      ok((chrome.runtime.lastError as { message: string } | undefined)?.message),
    ),
  );
  expect(vu).toBe("Règle DNR refusée par WebAiOs (redirect)");
  expect(chrome.runtime.lastError).toBeUndefined();
});

test("garde : tabs.create, tabs.update, windows.create demandent l'adresse au processus principal ; refus « URL refusée par WebAiOs »", async () => {
  const { chrome, appels } = contexteGarde({ urls: ["https://www.hote.test/"] });
  await expect(chrome.tabs.create({ url: "https://autre.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(chrome.tabs.update(3, { url: "data:text/html,x" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(chrome.windows.create({ url: ["https://www.hote.test/", "https://autre.test/"] })).rejects.toThrow("URL refusée par WebAiOs");
  expect(appels).toEqual([]);
  await chrome.tabs.create({ url: "https://www.hote.test/" });
  await chrome.tabs.update(3, { active: true });
  await chrome.tabs.update({ url: "https://www.hote.test/" });
  expect(appels.map(([n]) => n)).toEqual(["tabs.create", "tabs.update", "tabs.update"]);
});

test("garde : scripting.executeScript / insertCSS et tabs.insertCSS seulement dans un onglet d'un site accordé ; WebRTC retiré", async () => {
  const { ctx, chrome, appels } = contexteGarde({ onglets: [4] });
  await expect(chrome.scripting.executeScript({ target: { tabId: 5 }, func: () => 1 })).rejects.toThrow("Site refusé par WebAiOs");
  await expect(chrome.scripting.insertCSS({ target: { tabId: 5 }, css: "p{}" })).rejects.toThrow("Site refusé par WebAiOs");
  // Sans onglet : l'onglet actif (ici 9, non accordé).
  await expect(chrome.tabs.insertCSS({ code: "p{}" })).rejects.toThrow("Site refusé par WebAiOs");
  expect(appels).toEqual([]);
  await chrome.scripting.executeScript({ target: { tabId: 4 }, files: ["x.js"] });
  await chrome.tabs.insertCSS(4, { code: "p{}" });
  expect(appels.map(([n]) => n)).toEqual(["scripting.executeScript", "tabs.insertCSS"]);
  expect(ctx.RTCPeerConnection).toBeUndefined();
  expect(ctx.RTCDataChannel).toBeUndefined();
});

test("garde : sans __webaios (preload absent), toute adresse et tout onglet sont refusés", async () => {
  const { ctx, chrome } = contexteGarde();
  delete ctx.__webaios;
  const garde = readFileSync(cheminGarde, "utf8");
  const sans: Record<string, unknown> = { ...ctx, chrome: { ...chrome, tabs: { create: vi.fn() }, scripting: { executeScript: vi.fn() } } };
  sans.globalThis = sans;
  runInNewContext(garde, sans);
  const c = sans.chrome as { tabs: { create(d: unknown): Promise<unknown> }; scripting: { executeScript(d: unknown): Promise<unknown> } };
  await expect(c.tabs.create({ url: "https://www.hote.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  // Sans preload, aucun onglet n'est reconnu comme tel.
  await expect(c.scripting.executeScript({ target: { tabId: 4 } })).rejects.toThrow("Onglet refusé par WebAiOs");
});

test("garde : les arguments sont figés une fois (copie), vérifiés et passés tels quels : un accesseur qui change d'avis ne fait pas passer une redirection", async () => {
  const { chrome, appels } = contexteGarde({ onglets: [4] });
  let lectures = 0;
  const options = {
    get addRules() {
      return lectures++ === 0 ? [] : [{ id: 1, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/" } }, condition: {} }];
    },
  };
  await chrome.declarativeNetRequest.updateDynamicRules(options).catch(() => {});
  // Ce qu'a reçu l'API native : la copie vérifiée (sans redirection), jamais l'objet d'origine.
  for (const [, [recu]] of appels) {
    expect(recu).not.toBe(options);
    expect(JSON.stringify(recu)).not.toContain("redirect");
  }
  let lu = 0;
  const cible = {
    get tabId() {
      return lu++ === 0 ? 4 : 5;
    },
  };
  await chrome.scripting.executeScript({ target: cible as unknown as { tabId: number }, files: ["x.js"] });
  expect((appels.at(-1)![1][0] as { target: { tabId: number } }).target.tabId).toBe(4);
});

test("garde : Object.prototype.get ou .value ajoutés après son chargement ne cassent ni la copie, ni le refus avec lastError", async () => {
  const recus: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } } };`,
    Object.assign(ctx, { __noter: (x: string) => recus.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(cheminGarde, "utf8"), ctx);
  const resultat = await runInContext(
    `(async () => {
      Object.prototype.get = function () { return "pollue"; };
      Object.prototype.value = "pollue";
      const r = {};
      try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 2, action: { type: "block" } }] }); r.block = "acceptee"; } catch (e) { r.block = e.message; }
      r.rappel = await new Promise((ok) => chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, action: { type: "redirect" } }] }, () => ok(chrome.runtime.lastError && chrome.runtime.lastError.message)));
      delete Object.prototype.get;
      delete Object.prototype.value;
      return r;
    })()`,
    ctx,
  );
  expect(resultat).toEqual({ block: "acceptee", rappel: "Règle DNR refusée par WebAiOs (redirect)" });
  expect(recus).toEqual([{ addRules: [{ id: 2, action: { type: "block" } }] }]);
});

test("garde : une liste à trous est refusée (un accesseur sur Array.prototype[0] n'est jamais lu) ; une liste dense est recopiée sans trou", async () => {
  const recus: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } },
       tabs: { create(o) { __noter(JSON.stringify(o)); return Promise.resolve({ id: 1 }); } } };`,
    Object.assign(ctx, { __noter: (x: string) => recus.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(cheminGarde, "utf8"), ctx);
  const resultat = await runInContext(
    `(async () => {
      const block = { id: 2, priority: 1, action: { type: "block" }, condition: {} };
      const redirect = { id: 1, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/" } }, condition: {} };
      let lus = 0;
      Object.defineProperty(Array.prototype, "0", { get() { lus++; return lus > 1 ? redirect : block; }, configurable: true });
      const trous = [];
      trous[1] = block;
      const r = {};
      try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: trous }); r.dnr = "acceptee"; } catch (e) { r.dnr = e.message; }
      try { await chrome.declarativeNetRequest.updateSessionRules({ addRules: new Array(6000) }); r.long = "acceptee"; } catch (e) { r.long = e.message; }
      const autres = [];
      autres[2] = "x";
      try { await chrome.tabs.create({ url: undefined, liste: autres }); r.tabs = "acceptee"; } catch (e) { r.tabs = e.message; }
      delete Array.prototype[0];
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [block, block] });
      r.lus = lus;
      return r;
    })()`,
    ctx,
  );
  expect(resultat).toEqual({
    dnr: "Règle DNR refusée par WebAiOs (tableau à trous)",
    long: "Règle DNR refusée par WebAiOs (tableau trop long)",
    tabs: "Arguments refusés par WebAiOs (tableau à trous)",
    lus: 0,
  });
  expect(recus).toEqual([{ addRules: [{ id: 2, priority: 1, action: { type: "block" }, condition: {} }, { id: 2, priority: 1, action: { type: "block" }, condition: {} }] }]);
});

test("garde : remplacer Promise.prototype.then, Function.prototype.apply, Array.isArray et l'itérateur des listes après son chargement ne fait passer aucune redirection", async () => {
  // Un contexte à part, avec ses propres objets de base : l'extension peut les modifier sans toucher ceux du test.
  const recus: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } } };`,
    Object.assign(ctx, { __noter: (x: string) => recus.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(cheminGarde, "utf8"), ctx);
  const resultat = await runInContext(
    `(async () => {
      const redirection = { addRules: [{ id: 1, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/" } }, condition: {} }] };
      const vrai = Promise.prototype.then;
      // (a) then : toute suite reçoit true.
      Promise.prototype.then = function (ok, ko) { return vrai.call(this, ok && ((v) => ok(v === false || typeof v === "string" ? true : v)), ko); };
      // (b) apply : l'original de l'API est volé et rappelé.
      const vole = [];
      const appliquer = Function.prototype.apply;
      Function.prototype.apply = function (t, a) { vole.push(this); return appliquer.call(this, t, a); };
      // (c) Array.isArray qui change d'avis, itérateur de liste vide.
      let n = 0;
      Array.isArray = () => n++ % 2 === 0;
      Array.prototype[Symbol.iterator] = function* () {};
      Object.keys = () => [];
      let refus = "aucun";
      try {
        await chrome.declarativeNetRequest.updateDynamicRules(redirection);
      } catch (e) {
        refus = e.message;
      }
      Promise.prototype.then = vrai;
      Function.prototype.apply = appliquer;
      return { refus, voles: vole.length };
    })()`,
    ctx,
  );
  expect(recus).toEqual([]);
  expect(resultat).toEqual({ refus: "Règle DNR refusée par WebAiOs (redirect)", voles: 0 });
});

// --- Tâche 13 : scripts posés par le fond, contexte des scripts de contenu.

const GARDES_PAGE = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-portee.js"];

test("garde : executeScript / insertCSS vers une vue qui n'est pas un onglet (lecture invisible) : « Onglet refusé par WebAiOs » ; documentIds, world MAIN, sans tabId : refusés", async () => {
  const { chrome, appels } = contexteGarde({ onglets: [4, 6], nonOnglets: [6] });
  await expect(chrome.scripting.executeScript({ target: { tabId: 6 }, files: ["x.js"] })).rejects.toThrow("Onglet refusé par WebAiOs");
  await expect(chrome.scripting.insertCSS({ target: { tabId: 6 }, css: "p{}" })).rejects.toThrow("Onglet refusé par WebAiOs");
  await expect(chrome.tabs.insertCSS(6, { code: "p{}" })).rejects.toThrow("Onglet refusé par WebAiOs");
  // documentIds : le garde ne saurait pas quel onglet est visé ; frameIds : l'onglet donné est vérifié.
  await expect(chrome.scripting.executeScript({ target: { tabId: 4, documentIds: ["D"] }, files: ["x.js"] })).rejects.toThrow(
    "Arguments refusés par WebAiOs (documentIds)",
  );
  await expect(chrome.scripting.executeScript({ target: { tabId: 6, frameIds: [0] }, files: ["x.js"] })).rejects.toThrow("Onglet refusé par WebAiOs");
  await expect(chrome.scripting.executeScript({ target: { frameIds: [0] }, files: ["x.js"] })).rejects.toThrow("Site refusé par WebAiOs");
  await expect(chrome.scripting.executeScript({ target: { tabId: 4 }, files: ["x.js"], world: "MAIN" })).rejects.toThrow(
    "Arguments refusés par WebAiOs (world MAIN)",
  );
  expect(appels).toEqual([]);
  const vu = await new Promise((ok) =>
    chrome.scripting.executeScript({ target: { tabId: 6 }, files: ["x.js"] }, () => ok((chrome.runtime.lastError as { message: string } | undefined)?.message)),
  );
  expect(vu).toBe("Onglet refusé par WebAiOs");
});

test("garde : executeScript({ files }) injecte d'abord correctifs, garde de page, portée ; ({ func }) : ces fichiers, puis la fonction dans les mêmes documents", async () => {
  const appels: unknown[] = [];
  const natif = vi.fn(async (d: { files?: string[]; func?: unknown }) => {
    appels.push(d);
    return d.files ? [{ frameId: 0, documentId: "D0", result: undefined }, { frameId: 3, documentId: "D3", result: undefined }] : [{ frameId: 0, result: 2 }];
  });
  const g = contexteGarde({ onglets: [4] }, { executeScript: natif });
  const r = await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, files: ["a.js", "b.js"] });
  expect(r).toEqual([{ frameId: 0, documentId: "D0", result: undefined }, { frameId: 3, documentId: "D3", result: undefined }]);
  expect(natif.mock.calls[0]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: [...GARDES_PAGE, "a.js", "b.js"] });
  const f = (x: number) => x * 2;
  const r2 = await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, func: f, args: [1] });
  expect(r2).toEqual([{ frameId: 0, result: 2 }]);
  expect(natif.mock.calls[1]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: GARDES_PAGE });
  expect(natif.mock.calls[2]![0]).toEqual({ target: { tabId: 4, documentIds: ["D0", "D3"] }, func: f, args: [1] });
  // Avec un rappel : appelé avec le résultat de la fonction.
  const r3 = await new Promise((ok) => g.chrome.scripting.executeScript({ target: { tabId: 4 }, func: f }, ok));
  expect(r3).toEqual([{ frameId: 0, result: 2 }]);
  expect(appels).toHaveLength(5);
});

test("garde : registerContentScripts / updateContentScripts : gardes d'abord, puis le double enveloppé de chaque fichier ; `..`, webaios-…, world MAIN refusés", async () => {
  const { chrome, appels } = contexteGarde();
  await chrome.scripting.registerContentScripts([
    { id: "a", matches: ["https://hote.test/*"], js: ["/a.js", "./c/d.js"], css: ["s.css"], allFrames: true },
    { id: "b", matches: ["https://hote.test/*"], css: ["s.css"] },
  ]);
  expect(appels).toEqual([
    [
      "scripting.registerContentScripts",
      [
        [
          { id: "a", matches: ["https://hote.test/*"], js: [...GARDES_PAGE, "webaios-env/a.js", "webaios-env/c/d.js"], css: ["s.css"], allFrames: true },
          { id: "b", matches: ["https://hote.test/*"], css: ["s.css"] },
        ],
      ],
    ],
  ]);
  await chrome.scripting.updateContentScripts([{ id: "a", js: ["e.js"] }]);
  expect(appels[1]).toEqual(["scripting.updateContentScripts", [[{ id: "a", js: [...GARDES_PAGE, "webaios-env/e.js"] }]]]);
  for (const js of ["../x.js", "c/../../x.js", "webaios-garde-page.js", "a\\b.js", ""]) {
    await expect(chrome.scripting.registerContentScripts([{ id: "x", matches: ["https://hote.test/*"], js: [js] }]), js).rejects.toThrow(
      "Arguments refusés par WebAiOs (fichier",
    );
  }
  await expect(chrome.scripting.registerContentScripts([{ id: "x", matches: ["https://hote.test/*"], js: ["a.js"], world: "MAIN" }])).rejects.toThrow(
    "Arguments refusés par WebAiOs (world MAIN)",
  );
  expect(appels).toHaveLength(2);
});

test("garde : onMessage répond à { webaios: \"contexte\" } par estOnglet(sender.tab.id) ; les écouteurs de l'agent ne voient jamais ce message", async () => {
  const { chrome, emettre } = contexteGarde({ nonOnglets: [6] });
  const vus: unknown[] = [];
  // L'agent tente de répondre lui-même « onglet » à la place du garde.
  const agent = (m: unknown, _e: unknown, repondre: (x: unknown) => void) => {
    vus.push(m);
    repondre({ onglet: true });
  };
  const onMessage = chrome.runtime.onMessage as { addListener(f: unknown): void; removeListener(f: unknown): void; hasListener(f: unknown): boolean };
  onMessage.addListener(agent);
  expect(onMessage.hasListener(agent)).toBe(true);
  expect(await emettre({ webaios: "contexte" }, { tab: { id: 6 } })).toEqual({ onglet: false });
  expect(await emettre({ webaios: "contexte" }, { tab: { id: 4 } })).toEqual({ onglet: true });
  expect(await emettre({ webaios: "contexte" }, {})).toEqual({ onglet: false });
  // Par la méthode du prototype, prise à part : toujours enveloppé.
  const parProto = (m: unknown, _e: unknown, repondre: (x: unknown) => void) => {
    vus.push(m);
    repondre({ onglet: true });
  };
  (Object.getPrototypeOf(onMessage) as { addListener: Function }).addListener.call(onMessage, parProto);
  expect(await emettre({ webaios: "contexte" }, { tab: { id: 6 } })).toEqual({ onglet: false });
  expect(vus).toEqual([]);
  (Object.getPrototypeOf(onMessage) as { removeListener: Function }).removeListener.call(onMessage, parProto);
  // Les autres messages lui parviennent.
  expect(await emettre({ autre: 1 }, { tab: { id: 4 } })).toEqual({ onglet: true });
  expect(vus).toEqual([{ autre: 1 }]);
  onMessage.removeListener(agent);
  expect(onMessage.hasListener(agent)).toBe(false);
  // Remplacé pour de bon.
  expect(Object.getOwnPropertyDescriptor(chrome.runtime, "onMessage")?.writable).toBe(false);
});
