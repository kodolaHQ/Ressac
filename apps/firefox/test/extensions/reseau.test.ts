import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import type { Portee } from "@webaios/noyau";
import { hotePermisAgent, motifCouvre, urlPermiseAgent } from "../../core/extensions/reseau";

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

// --- Le garde (packages/noyau/extensions/webaios-garde-fond.js), exécuté dans un contexte à part.

const cheminGarde = join(import.meta.dirname, "..", "..", "..", "..", "packages", "noyau", "extensions", "webaios-garde-fond.js");

/** La table que la copie met en tête du garde de fond : les fichiers .js et .css de l'agent (l'indice est le repère). */
const TABLE = `const __webaiosFichiers = ${JSON.stringify([["a.js", "js"], ["b.js", "js"], ["c/d.js", "js"], ["s.css", "css"], ["x.js", "js"]])};\n`;

function contexteGarde(
  permises: { urls?: string[]; onglets?: number[]; nonOnglets?: number[] } = {},
  scripting: Record<string, unknown> = {},
  o: { page?: boolean } = {},
) {
  const appels: [string, unknown[]][] = [];
  const api = (nom: string) =>
    vi.fn((...a: unknown[]) => {
      appels.push([nom, a]);
      return Promise.resolve(`ok:${nom}`);
    });
  /** Ce que Chromium garde de registerContentScripts (lu par getRegisteredContentScripts). */
  const enregistres: { id: string; [k: string]: unknown }[] = [];
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
    tabs: {
      create: api("tabs.create"),
      update: api("tabs.update"),
      query: vi.fn(async () => [{ id: 9 }]),
      insertCSS: api("tabs.insertCSS"),
      executeScript: api("tabs.executeScript"),
    },
    windows: { create: api("windows.create") },
    scripting: {
      executeScript: api("scripting.executeScript"),
      insertCSS: api("scripting.insertCSS"),
      registerContentScripts: api("scripting.registerContentScripts"),
      updateContentScripts: api("scripting.updateContentScripts"),
      getRegisteredContentScripts: vi.fn(async (f?: { ids?: string[] }) => enregistres.filter((x) => !f?.ids || f.ids.includes(x.id))),
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
  // Une page de l'extension (popup, options) a un document ; le service worker, non.
  if (o.page) ctx.document = {};
  ctx.globalThis = ctx;
  runInNewContext(TABLE + readFileSync(cheminGarde, "utf8"), ctx);
  return { ctx, chrome, appels, ecouteurs, emettre, enregistres };
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
  runInNewContext(TABLE + garde, sans);
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
const repere = (n: number) => `webaios-fichiers/${n}.js`;

test("garde : executeScript / insertCSS vers une vue qui n'est pas un onglet (lecture invisible) : « Onglet refusé par WebAiOs » ; documentIds, world MAIN, sans tabId : refusés", async () => {
  const { chrome, appels } = contexteGarde({ onglets: [4, 6], nonOnglets: [6] });
  await expect(chrome.scripting.executeScript({ target: { tabId: 6 }, files: ["x.js"] })).rejects.toThrow("Onglet refusé par WebAiOs");
  await expect(chrome.scripting.insertCSS({ target: { tabId: 6 }, css: "p{}" })).rejects.toThrow("Onglet refusé par WebAiOs");
  await expect(chrome.tabs.insertCSS(6, { code: "p{}" })).rejects.toThrow("Onglet refusé par WebAiOs");
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

test("garde : executeScript({ files }) : seulement des fichiers de la table, gardes d'abord ; ({ func }) : gardes, puis la fonction dans les mêmes documents ; sans documentId rendu, refusé", async () => {
  let sansDocument = false;
  const natif = vi.fn(async (d: { files?: string[]; func?: unknown }) =>
    d.files ? [{ frameId: 0, ...(sansDocument ? {} : { documentId: "D0" }) }, { frameId: 3, documentId: "D3" }] : [{ frameId: 0, result: 2 }],
  );
  const g = contexteGarde({ onglets: [4] }, { executeScript: natif });
  for (const f of ["inconnu.js", "../a.js", "/a.js", "./a.js", "s.css", "webaios-garde-page.js"]) {
    await expect(g.chrome.scripting.executeScript({ target: { tabId: 4 }, files: [f] }), f).rejects.toThrow(`Arguments refusés par WebAiOs (fichier refusé : ${f})`);
  }
  expect(natif).not.toHaveBeenCalled();
  await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, files: ["a.js", "c/d.js"] });
  expect(natif.mock.calls[0]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: [...GARDES_PAGE, "a.js", "c/d.js"] });
  const f = (x: number) => x * 2;
  expect(await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, func: f, args: [1] })).toEqual([{ frameId: 0, result: 2 }]);
  expect(natif.mock.calls[1]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: GARDES_PAGE });
  expect(natif.mock.calls[2]![0]).toEqual({ target: { tabId: 4, documentIds: ["D0", "D3"] }, func: f, args: [1] });
  expect(await new Promise((ok) => g.chrome.scripting.executeScript({ target: { tabId: 4 }, func: f }, ok))).toEqual([{ frameId: 0, result: 2 }]);
  // Un document sans id : la fonction ne part pas (elle pourrait tourner dans un document neuf, sans garde).
  sansDocument = true;
  const avant = natif.mock.calls.length;
  await expect(g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, func: f })).rejects.toThrow("Arguments refusés par WebAiOs (documentId absent)");
  expect(natif.mock.calls.length).toBe(avant + 1);
});

test("garde : registerContentScripts / updateContentScripts n'enregistrent que les gardes et les repères (CSS d'abord) ; chemins hors de la table refusés, même avec split empoisonné", async () => {
  const { ctx, chrome, appels } = contexteGarde();
  await chrome.scripting.registerContentScripts([
    { id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"], allFrames: true },
    { id: "b", matches: ["https://hote.test/*"], css: ["s.css"] },
  ]);
  expect(appels).toEqual([
    [
      "scripting.registerContentScripts",
      [
        [
          { id: "a", matches: ["https://hote.test/*"], js: [...GARDES_PAGE, repere(3), repere(0), repere(2)], allFrames: true },
          { id: "b", matches: ["https://hote.test/*"], js: [...GARDES_PAGE, repere(3)] },
        ],
      ],
    ],
  ]);
  // L'extension empoisonne ce qu'un découpage consulterait, puis tente de faire enregistrer un fichier hors table.
  // Le prototype des chaînes du monde de la garde (le `String` du contexte est celui de vitest : on n'y touche pas).
  runInContext('const S = "".__proto__; S[Symbol.split] = () => ["a.js"]; S.split = () => ["a.js"]; S.indexOf = () => -1; S.slice = () => "a.js";', ctx as object);
  for (const js of ["../a.js", "x/../../a.js", "/a.js", "./a.js", "a\\b.js", "", "webaios-garde-page.js", "inconnu.js", "s.css"]) {
    await expect(chrome.scripting.registerContentScripts([{ id: "x", matches: ["https://hote.test/*"], js: [js] }]), js).rejects.toThrow(
      `Arguments refusés par WebAiOs (fichier refusé : ${js})`,
    );
  }
  await expect(chrome.scripting.registerContentScripts([{ id: "x", matches: ["https://hote.test/*"], css: ["a.js"] }])).rejects.toThrow(
    "Arguments refusés par WebAiOs (fichier refusé : a.js)",
  );
  await expect(chrome.scripting.registerContentScripts([{ id: "x", matches: ["https://hote.test/*"], js: ["a.js"], world: "MAIN" }])).rejects.toThrow(
    "Arguments refusés par WebAiOs (world MAIN)",
  );
  expect(appels).toHaveLength(1);
});

test("garde : getRegisteredContentScripts rend les fichiers de l'agent ; l'aller-retour vers updateContentScripts passe ; une mise à jour du seul CSS garde le JS enregistré", async () => {
  const { chrome, appels, enregistres } = contexteGarde();
  await chrome.scripting.registerContentScripts([{ id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"] }]);
  enregistres.push(...(appels[0]![1][0] as { id: string }[]));
  const lus = await chrome.scripting.getRegisteredContentScripts();
  expect(lus).toEqual([{ id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"] }]);
  expect(await new Promise((ok) => (chrome.scripting.getRegisteredContentScripts as (f: unknown, r: (x: unknown) => void) => void)({ ids: ["a"] }, ok))).toEqual(lus);
  await chrome.scripting.updateContentScripts(lus);
  expect(appels[1]).toEqual(["scripting.updateContentScripts", [[{ id: "a", matches: ["https://hote.test/*"], js: [...GARDES_PAGE, repere(3), repere(0), repere(2)] }]]]);
  await chrome.scripting.updateContentScripts([{ id: "a", css: [] }]);
  expect(appels[2]).toEqual(["scripting.updateContentScripts", [[{ id: "a", js: [...GARDES_PAGE, repere(0), repere(2)] }]]]);
  await chrome.scripting.updateContentScripts([{ id: "a", js: ["b.js"] }]);
  expect(appels[3]).toEqual(["scripting.updateContentScripts", [[{ id: "a", js: [...GARDES_PAGE, repere(3), repere(1)] }]]]);
});

test("garde : tabs.executeScript (MV2) passe d'abord les gardes de page dans les mêmes cadres ; un fichier hors de la table est refusé", async () => {
  const { chrome, appels } = contexteGarde({ onglets: [4] });
  await chrome.tabs.executeScript(4, { file: "a.js", allFrames: true, runAt: "document_idle" });
  expect(appels).toEqual([
    ...GARDES_PAGE.map((f) => ["tabs.executeScript", [4, { file: f, allFrames: true, runAt: "document_idle" }]]),
    ["tabs.executeScript", [4, { file: "a.js", allFrames: true, runAt: "document_idle" }]],
  ]);
  await expect(chrome.tabs.executeScript(4, { file: "../a.js" })).rejects.toThrow("Arguments refusés par WebAiOs (fichier refusé : ../a.js)");
  expect(appels).toHaveLength(4);
});

test("garde : à la demande du contexte, le fond injecte les fichiers des repères (CSS puis JS, gardes en tête) dans le document exact de l'expéditeur, seulement si c'est un onglet", async () => {
  const { chrome, appels, emettre } = contexteGarde({ nonOnglets: [6] });
  expect(await emettre({ webaios: "contexte", fichiers: [3, 0, 2] }, { tab: { id: 4 }, frameId: 2, documentId: "D" })).toEqual({ onglet: true });
  const cible = { tabId: 4, documentIds: ["D"] };
  expect(appels).toEqual([
    ["scripting.insertCSS", [{ target: cible, files: ["s.css"] }]],
    ["scripting.executeScript", [{ target: cible, files: [...GARDES_PAGE, "a.js", "c/d.js"], injectImmediately: true }]],
  ]);
  // Sans documentId : le cadre de l'expéditeur.
  appels.length = 0;
  expect(await emettre({ webaios: "contexte", fichiers: [0] }, { tab: { id: 4 }, frameId: 2 })).toEqual({ onglet: true });
  expect(appels).toEqual([["scripting.executeScript", [{ target: { tabId: 4, frameIds: [2] }, files: [...GARDES_PAGE, "a.js"], injectImmediately: true }]]]);
  // Une lecture invisible, un repère inconnu, un indice qui n'est pas un nombre : rien n'est injecté.
  appels.length = 0;
  expect(await emettre({ webaios: "contexte", fichiers: [0, 3] }, { tab: { id: 6 }, frameId: 0, documentId: "I" })).toEqual({ onglet: false });
  expect(await emettre({ webaios: "contexte", fichiers: [99] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toEqual({ onglet: false });
  expect(await emettre({ webaios: "contexte", fichiers: ["0"] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toEqual({ onglet: false });
  expect(await emettre({ webaios: "contexte", fichiers: [0] }, {})).toEqual({ onglet: false });
  expect(appels).toEqual([]);
});

test("garde : dans une page de l'agent (popup, options), le contexte n'est ni répondu ni injecté : seul le service worker le fait ; les écouteurs de l'agent ne le voient pas non plus", async () => {
  const { chrome, appels, emettre } = contexteGarde({}, {}, { page: true });
  const vus: unknown[] = [];
  (chrome.runtime.onMessage as { addListener(f: unknown): void }).addListener((m: unknown) => void vus.push(m));
  expect(await emettre({ webaios: "contexte", fichiers: [3, 0] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toBe("aucune réponse");
  expect(await emettre({ webaios: "contexte" }, { tab: { id: 4 } })).toBe("aucune réponse");
  expect(appels).toEqual([]);
  expect(vus).toEqual([]);
});

test("garde : un indice hors de la table (prototypes empoisonnés, négatif, fractionnaire) n'injecte jamais rien", async () => {
  const { ctx, appels, emettre } = contexteGarde();
  // Dans le monde du garde : ce que `table[n]` lirait par la chaîne de prototypes pour un n hors de la table.
  runInContext('const faux = { genre: "js", chemin: "hors-liste.js" }; ({}).__proto__[999] = faux; [].__proto__[5] = faux; ({}).__proto__["-1"] = faux; ({}).__proto__["1.5"] = faux;', ctx as object);
  for (const n of [999, 5, -1, 1.5]) {
    expect(await emettre({ webaios: "contexte", fichiers: [n] }, { tab: { id: 4 }, frameId: 0, documentId: "D" }), String(n)).toEqual({ onglet: false });
  }
  expect(appels).toEqual([]);
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
