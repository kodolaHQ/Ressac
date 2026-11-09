import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { expect, test, vi } from "vitest";
import type { Scope } from "@webaios/kernel";
import { agentAllowedHost, patternCovers, agentAllowedUrl } from "../../core/extensions/network";

const ID = "a".repeat(32);
const OTHER = "b".repeat(32);
const grant: Scope = {
  permissions: ["tabs"],
  hotes: ["https://*.hote.test/*", "http://127.0.0.1/*"],
  reseau: ["api.accorde.test"],
  tousLesSites: false,
  scriptsTousLesSites: false,
};

test("reseau host allowed; hotes host allowed; other host, data:, javascript:, file: refused; chrome-extension:// of another extension refused", () => {
  expect(agentAllowedUrl("https://api.accorde.test/x?y=1", grant, ID)).toBe(true);
  expect(agentAllowedUrl("http://api.accorde.test/", grant, ID)).toBe(true);
  expect(agentAllowedUrl("https://www.hote.test/page", grant, ID)).toBe(true);
  expect(agentAllowedUrl("https://hote.test/", grant, ID)).toBe(true);
  expect(agentAllowedUrl("http://127.0.0.1:8123/cache.html", grant, ID)).toBe(true);
  expect(agentAllowedUrl(`chrome-extension://${ID}/page.html`, grant, ID)).toBe(true);

  expect(agentAllowedUrl("https://autre.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl("https://accorde.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl("https://hote.test.autre.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl("https://www.hote.test@autre.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl("https://u:p@api.accorde.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl("data:text/html,<p>x</p>", grant, ID)).toBe(false);
  expect(agentAllowedUrl("javascript:alert(1)", grant, ID)).toBe(false);
  expect(agentAllowedUrl("file:///etc/passwd", grant, ID)).toBe(false);
  expect(agentAllowedUrl(`blob:chrome-extension://${ID}/x`, grant, ID)).toBe(false);
  expect(agentAllowedUrl("ftp://api.accorde.test/", grant, ID)).toBe(false);
  expect(agentAllowedUrl(`chrome-extension://${OTHER}/page.html`, grant, ID)).toBe(false);
  expect(agentAllowedUrl("pas une adresse", grant, ID)).toBe(false);
});

test("Chrome patterns: scheme, subdomain wildcard, port, path", () => {
  const u = (x: string) => new URL(x);
  expect(patternCovers("<all_urls>", u("https://x.test/"))).toBe(true);
  expect(patternCovers("*://x.test/*", u("http://x.test/a"))).toBe(true);
  expect(patternCovers("https://x.test/*", u("http://x.test/a"))).toBe(false);
  expect(patternCovers("https://x.test/docs/*", u("https://x.test/docs/a"))).toBe(true);
  expect(patternCovers("https://x.test/docs/*", u("https://x.test/autre"))).toBe(false);
  expect(patternCovers("https://x.test:8443/*", u("https://x.test:8443/"))).toBe(true);
  expect(patternCovers("https://x.test:8443/*", u("https://x.test/"))).toBe(false);
  expect(patternCovers("https://*/*", u("https://n.importe.quoi/"))).toBe(true);
  expect(patternCovers("<all_urls>", u("file:///x"))).toBe(false);
});

test("agentAllowedHost: only the granted hosts (not reseau)", () => {
  expect(agentAllowedHost("https://www.hote.test/", grant)).toBe(true);
  expect(agentAllowedHost("https://api.accorde.test/", grant)).toBe(false);
  expect(agentAllowedHost("about:blank", grant)).toBe(false);
});

// --- The guard (packages/kernel/extensions/webaios-garde-fond.js), run in a separate context.

const pathGuard = join(import.meta.dirname, "..", "..", "..", "..", "packages", "kernel", "extensions", "webaios-garde-fond.js");

/** The table the copy puts at the head of the background guard: the agent's .js and .css files (the index is the marker). */
const TABLE = `const __webaiosFichiers = ${JSON.stringify([["a.js", "js"], ["b.js", "js"], ["c/d.js", "js"], ["s.css", "css"], ["x.js", "js"]])};\n`;

function guardContext(
  allowed: { urls?: string[]; onglets?: number[]; nonOnglets?: number[] } = {},
  scripting: Record<string, unknown> = {},
  o: { page?: boolean } = {},
) {
  const calls: [string, unknown[]][] = [];
  const api = (name: string) =>
    vi.fn((...a: unknown[]) => {
      calls.push([name, a]);
      return Promise.resolve(`ok:${name}`);
    });
  /** What Chromium keeps from registerContentScripts (read by getRegisteredContentScripts). */
  const saved: { id: string; [k: string]: unknown }[] = [];
  const listeners: ((m: unknown, e: unknown, r: (x: unknown) => void) => unknown)[] = [];
  // Like Chromium's events: the methods are on the prototype.
  const onMessage = Object.create({
    addListener: (f: (typeof listeners)[number]) => void listeners.push(f),
    removeListener: (f: (typeof listeners)[number]) => {
      const i = listeners.indexOf(f);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (f: (typeof listeners)[number]) => listeners.includes(f),
    hasListeners: () => listeners.length > 0,
  }) as Record<string, (f?: unknown) => unknown>;
  /** A message as Chromium delivers it: each listener, the first answer wins; returns that answer. */
  const emit = (m: unknown, sender: unknown) =>
    new Promise((ok) => {
      let wait = false;
      for (const f of [...listeners]) if (f(m, sender, ok) === true) wait = true;
      if (!wait) setTimeout(() => ok("aucune réponse"), 50);
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
      getRegisteredContentScripts: vi.fn(async (f?: { ids?: string[] }) => saved.filter((x) => !f?.ids || f.ids.includes(x.id))),
      ...scripting,
    },
  };
  const ctx: Record<string, unknown> = {
    chrome,
    console: { error: () => {} },
    RTCPeerConnection: class {},
    RTCDataChannel: class {},
    __webaios: {
      urlPermise: async (u: string) => (allowed.urls ?? []).includes(u),
      hotePermis: async (o: number) => (allowed.onglets ?? []).includes(o),
      estOnglet: async (o: number) => !(allowed.nonOnglets ?? []).includes(o),
    },
    Promise,
    Error,
    Object,
    Array,
    String,
  };
  // An extension page (popup, options) has a document; the service worker does not.
  if (o.page) ctx.document = {};
  ctx.globalThis = ctx;
  runInNewContext(TABLE + readFileSync(pathGuard, "utf8"), ctx);
  return { ctx, chrome, appels: calls, ecouteurs: listeners, emettre: emit, enregistres: saved };
}

test("guard: updateDynamicRules / updateSessionRules refuse redirect, modifyHeaders, regexSubstitution, transform; block accepted", async () => {
  const { chrome, appels: calls } = guardContext();
  const dnr = chrome.declarativeNetRequest;
  const rule = (action: unknown) => ({ addRules: [{ id: 1, priority: 1, action, condition: { urlFilter: "x" } }] });
  await expect(dnr.updateDynamicRules(rule({ type: "redirect", redirect: { url: "https://x.test/" } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (redirect)",
  );
  await expect(dnr.updateSessionRules(rule({ type: "modifyHeaders", requestHeaders: [] }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (modifyHeaders)",
  );
  await expect(dnr.updateDynamicRules(rule({ type: "upgradeScheme", redirect: { regexSubstitution: "\\1" } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (regexSubstitution)",
  );
  await expect(dnr.updateDynamicRules(rule({ type: "upgradeScheme", redirect: { transform: {} } }))).rejects.toThrow(
    "Règle DNR refusée par WebAiOs (transform)",
  );
  expect(calls).toEqual([]);
  await expect(dnr.updateDynamicRules(rule({ type: "block" }))).resolves.toBe("ok:updateDynamicRules");
  await expect(dnr.updateDynamicRules({ removeRuleIds: [1] })).resolves.toBe("ok:updateDynamicRules");
  // Truly replaced: neither rewritten nor removed.
  const kept = dnr.updateDynamicRules;
  expect(() => {
    "use strict";
    delete (dnr as Record<string, unknown>).updateDynamicRules;
  }).toThrow();
  expect(dnr.updateDynamicRules).toBe(kept);
});

test("guard: a callback receives chrome.runtime.lastError during the call, then it is cleared", async () => {
  const { chrome } = guardContext();
  const seen = await new Promise((ok) =>
    chrome.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1, action: { type: "redirect" } }] }, () =>
      ok((chrome.runtime.lastError as { message: string } | undefined)?.message),
    ),
  );
  expect(seen).toBe("Règle DNR refusée par WebAiOs (redirect)");
  expect(chrome.runtime.lastError).toBeUndefined();
});

test("guard: tabs.create, tabs.update, windows.create ask the main process for the address; refusal « URL refusée par WebAiOs »", async () => {
  const { chrome, appels: calls } = guardContext({ urls: ["https://www.hote.test/"] });
  await expect(chrome.tabs.create({ url: "https://autre.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(chrome.tabs.update(3, { url: "data:text/html,x" })).rejects.toThrow("URL refusée par WebAiOs");
  await expect(chrome.windows.create({ url: ["https://www.hote.test/", "https://autre.test/"] })).rejects.toThrow("URL refusée par WebAiOs");
  expect(calls).toEqual([]);
  await chrome.tabs.create({ url: "https://www.hote.test/" });
  await chrome.tabs.update(3, { active: true });
  await chrome.tabs.update({ url: "https://www.hote.test/" });
  expect(calls.map(([n]) => n)).toEqual(["tabs.create", "tabs.update", "tabs.update"]);
});

test("guard: scripting.executeScript / insertCSS and tabs.insertCSS only in a tab of a granted site; WebRTC removed", async () => {
  const { ctx, chrome, appels: calls } = guardContext({ onglets: [4] });
  await expect(chrome.scripting.executeScript({ target: { tabId: 5 }, func: () => 1 })).rejects.toThrow("Site refusé par WebAiOs");
  await expect(chrome.scripting.insertCSS({ target: { tabId: 5 }, css: "p{}" })).rejects.toThrow("Site refusé par WebAiOs");
  // Without a tab: the active tab (here 9, not granted).
  await expect(chrome.tabs.insertCSS({ code: "p{}" })).rejects.toThrow("Site refusé par WebAiOs");
  expect(calls).toEqual([]);
  await chrome.scripting.executeScript({ target: { tabId: 4 }, files: ["x.js"] });
  await chrome.tabs.insertCSS(4, { code: "p{}" });
  expect(calls.map(([n]) => n)).toEqual(["scripting.executeScript", "tabs.insertCSS"]);
  expect(ctx.RTCPeerConnection).toBeUndefined();
  expect(ctx.RTCDataChannel).toBeUndefined();
});

test("guard: without __webaios (preload missing), every address and every tab are refused", async () => {
  const { ctx, chrome } = guardContext();
  delete ctx.__webaios;
  const kept = readFileSync(pathGuard, "utf8");
  const without: Record<string, unknown> = { ...ctx, chrome: { ...chrome, tabs: { create: vi.fn() }, scripting: { executeScript: vi.fn() } } };
  without.globalThis = without;
  runInNewContext(TABLE + kept, without);
  const c = without.chrome as { tabs: { create(d: unknown): Promise<unknown> }; scripting: { executeScript(d: unknown): Promise<unknown> } };
  await expect(c.tabs.create({ url: "https://www.hote.test/" })).rejects.toThrow("URL refusée par WebAiOs");
  // Without preload, no tab is recognized as one.
  await expect(c.scripting.executeScript({ target: { tabId: 4 } })).rejects.toThrow("Onglet refusé par WebAiOs");
});

test("guard: arguments are frozen once (copy), checked and passed as is: an accessor that changes its mind does not let a redirect through", async () => {
  const { chrome, appels: calls } = guardContext({ onglets: [4] });
  let reads = 0;
  const options = {
    get addRules() {
      return reads++ === 0 ? [] : [{ id: 1, priority: 1, action: { type: "redirect", redirect: { url: "https://autre.test/" } }, condition: {} }];
    },
  };
  await chrome.declarativeNetRequest.updateDynamicRules(options).catch(() => {});
  // What the native API received: the checked copy (without redirect), never the original object.
  for (const [, [received]] of calls) {
    expect(received).not.toBe(options);
    expect(JSON.stringify(received)).not.toContain("redirect");
  }
  let lu = 0;
  const target = {
    get tabId() {
      return lu++ === 0 ? 4 : 5;
    },
  };
  await chrome.scripting.executeScript({ target: target as unknown as { tabId: number }, files: ["x.js"] });
  expect((calls.at(-1)![1][0] as { target: { tabId: number } }).target.tabId).toBe(4);
});

test("guard: Object.prototype.get or .value added after its load break neither the copy nor the refusal with lastError", async () => {
  const received: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } } };`,
    Object.assign(ctx, { __noter: (x: string) => received.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(pathGuard, "utf8"), ctx);
  const result = await runInContext(
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
  expect(result).toEqual({ block: "acceptee", rappel: "Règle DNR refusée par WebAiOs (redirect)" });
  expect(received).toEqual([{ addRules: [{ id: 2, action: { type: "block" } }] }]);
});

test("guard: a sparse list is refused (an accessor on Array.prototype[0] is never read); a dense list is copied without holes", async () => {
  const received: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } },
       tabs: { create(o) { __noter(JSON.stringify(o)); return Promise.resolve({ id: 1 }); } } };`,
    Object.assign(ctx, { __noter: (x: string) => received.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(pathGuard, "utf8"), ctx);
  const result = await runInContext(
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
  expect(result).toEqual({
    dnr: "Règle DNR refusée par WebAiOs (tableau à trous)",
    long: "Règle DNR refusée par WebAiOs (tableau trop long)",
    tabs: "Arguments refusés par WebAiOs (tableau à trous)",
    lus: 0,
  });
  expect(received).toEqual([{ addRules: [{ id: 2, priority: 1, action: { type: "block" }, condition: {} }, { id: 2, priority: 1, action: { type: "block" }, condition: {} }] }]);
});

test("guard: replacing Promise.prototype.then, Function.prototype.apply, Array.isArray and the list iterator after its load lets no redirect through", async () => {
  // A separate context, with its own base objects: the extension can modify them without touching the test's.
  const received: unknown[] = [];
  const ctx = createContext({});
  runInContext(
    `globalThis.chrome = { runtime: {}, declarativeNetRequest: {
       updateDynamicRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); },
       updateSessionRules(o) { __noter(JSON.stringify(o)); return Promise.resolve("natif"); } } };`,
    Object.assign(ctx, { __noter: (x: string) => received.push(JSON.parse(x)) }),
  );
  runInContext(readFileSync(pathGuard, "utf8"), ctx);
  const result = await runInContext(
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
  expect(received).toEqual([]);
  expect(result).toEqual({ refus: "Règle DNR refusée par WebAiOs (redirect)", voles: 0 });
});

// --- Task 13: scripts placed by the background, content scripts' context.

const PAGE_GUARDS = ["webaios-correctifs-page.js", "webaios-garde-page.js", "webaios-portee.js"];
const marker = (n: number) => `webaios-fichiers/${n}.js`;

test("guard: executeScript / insertCSS to a view that is not a tab (invisible read): « Onglet refusé par WebAiOs »; documentIds, world MAIN, without tabId: refused", async () => {
  const { chrome, appels: calls } = guardContext({ onglets: [4, 6], nonOnglets: [6] });
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
  expect(calls).toEqual([]);
  const seen = await new Promise((ok) =>
    chrome.scripting.executeScript({ target: { tabId: 6 }, files: ["x.js"] }, () => ok((chrome.runtime.lastError as { message: string } | undefined)?.message)),
  );
  expect(seen).toBe("Onglet refusé par WebAiOs");
});

test("guard: executeScript({ files }): only files from the table, guards first; ({ func }): guards, then the function in the same documents; without a returned documentId, refused", async () => {
  let withoutDocument = false;
  const native = vi.fn(async (d: { files?: string[]; func?: unknown }) =>
    d.files ? [{ frameId: 0, ...(withoutDocument ? {} : { documentId: "D0" }) }, { frameId: 3, documentId: "D3" }] : [{ frameId: 0, result: 2 }],
  );
  const g = guardContext({ onglets: [4] }, { executeScript: native });
  for (const f of ["inconnu.js", "../a.js", "/a.js", "./a.js", "s.css", "webaios-garde-page.js"]) {
    await expect(g.chrome.scripting.executeScript({ target: { tabId: 4 }, files: [f] }), f).rejects.toThrow(`Arguments refusés par WebAiOs (fichier refusé : ${f})`);
  }
  expect(native).not.toHaveBeenCalled();
  await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, files: ["a.js", "c/d.js"] });
  expect(native.mock.calls[0]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: [...PAGE_GUARDS, "a.js", "c/d.js"] });
  const f = (x: number) => x * 2;
  expect(await g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, func: f, args: [1] })).toEqual([{ frameId: 0, result: 2 }]);
  expect(native.mock.calls[1]![0]).toEqual({ target: { tabId: 4, allFrames: true }, files: PAGE_GUARDS });
  expect(native.mock.calls[2]![0]).toEqual({ target: { tabId: 4, documentIds: ["D0", "D3"] }, func: f, args: [1] });
  expect(await new Promise((ok) => g.chrome.scripting.executeScript({ target: { tabId: 4 }, func: f }, ok))).toEqual([{ frameId: 0, result: 2 }]);
  // A document without an id: the function does not go (it could run in a fresh document, without a guard).
  withoutDocument = true;
  const before = native.mock.calls.length;
  await expect(g.chrome.scripting.executeScript({ target: { tabId: 4, allFrames: true }, func: f })).rejects.toThrow("Arguments refusés par WebAiOs (documentId absent)");
  expect(native.mock.calls.length).toBe(before + 1);
});

test("guard: registerContentScripts / updateContentScripts only register the guards and the markers (CSS first); paths outside the table refused, even with a poisoned split", async () => {
  const { ctx, chrome, appels: calls } = guardContext();
  await chrome.scripting.registerContentScripts([
    { id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"], allFrames: true },
    { id: "b", matches: ["https://hote.test/*"], css: ["s.css"] },
  ]);
  expect(calls).toEqual([
    [
      "scripting.registerContentScripts",
      [
        [
          { id: "a", matches: ["https://hote.test/*"], js: [...PAGE_GUARDS, marker(3), marker(0), marker(2)], allFrames: true },
          { id: "b", matches: ["https://hote.test/*"], js: [...PAGE_GUARDS, marker(3)] },
        ],
      ],
    ],
  ]);
  // The extension poisons what a split would consult, then tries to get a file outside the table registered.
  // The prototype of the guard world's strings (the context's `String` is vitest's: not touched).
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
  expect(calls).toHaveLength(1);
});

test("guard: getRegisteredContentScripts returns the agent's files; the round trip to updateContentScripts passes; a CSS-only update keeps the registered JS", async () => {
  const { chrome, appels: calls, enregistres: saved } = guardContext();
  await chrome.scripting.registerContentScripts([{ id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"] }]);
  saved.push(...(calls[0]![1][0] as { id: string }[]));
  const reads = await chrome.scripting.getRegisteredContentScripts();
  expect(reads).toEqual([{ id: "a", matches: ["https://hote.test/*"], js: ["a.js", "c/d.js"], css: ["s.css"] }]);
  expect(await new Promise((ok) => (chrome.scripting.getRegisteredContentScripts as (f: unknown, r: (x: unknown) => void) => void)({ ids: ["a"] }, ok))).toEqual(reads);
  await chrome.scripting.updateContentScripts(reads);
  expect(calls[1]).toEqual(["scripting.updateContentScripts", [[{ id: "a", matches: ["https://hote.test/*"], js: [...PAGE_GUARDS, marker(3), marker(0), marker(2)] }]]]);
  await chrome.scripting.updateContentScripts([{ id: "a", css: [] }]);
  expect(calls[2]).toEqual(["scripting.updateContentScripts", [[{ id: "a", js: [...PAGE_GUARDS, marker(0), marker(2)] }]]]);
  await chrome.scripting.updateContentScripts([{ id: "a", js: ["b.js"] }]);
  expect(calls[3]).toEqual(["scripting.updateContentScripts", [[{ id: "a", js: [...PAGE_GUARDS, marker(3), marker(1)] }]]]);
});

test("guard: tabs.executeScript (MV2) first passes the page guards in the same frames; a file outside the table is refused", async () => {
  const { chrome, appels: calls } = guardContext({ onglets: [4] });
  await chrome.tabs.executeScript(4, { file: "a.js", allFrames: true, runAt: "document_idle" });
  expect(calls).toEqual([
    ...PAGE_GUARDS.map((f) => ["tabs.executeScript", [4, { file: f, allFrames: true, runAt: "document_idle" }]]),
    ["tabs.executeScript", [4, { file: "a.js", allFrames: true, runAt: "document_idle" }]],
  ]);
  await expect(chrome.tabs.executeScript(4, { file: "../a.js" })).rejects.toThrow("Arguments refusés par WebAiOs (fichier refusé : ../a.js)");
  expect(calls).toHaveLength(4);
});

test("guard: on the context's request, the background injects the markers' files (CSS then JS, guards first) in the sender's exact document, only if it is a tab", async () => {
  const { chrome, appels: calls, emettre: emit } = guardContext({ nonOnglets: [6] });
  expect(await emit({ webaios: "contexte", fichiers: [3, 0, 2] }, { tab: { id: 4 }, frameId: 2, documentId: "D" })).toEqual({ onglet: true });
  const target = { tabId: 4, documentIds: ["D"] };
  expect(calls).toEqual([
    ["scripting.insertCSS", [{ target, files: ["s.css"] }]],
    ["scripting.executeScript", [{ target, files: [...PAGE_GUARDS, "a.js", "c/d.js"], injectImmediately: true }]],
  ]);
  // Without documentId: the sender's frame.
  calls.length = 0;
  expect(await emit({ webaios: "contexte", fichiers: [0] }, { tab: { id: 4 }, frameId: 2 })).toEqual({ onglet: true });
  expect(calls).toEqual([["scripting.executeScript", [{ target: { tabId: 4, frameIds: [2] }, files: [...PAGE_GUARDS, "a.js"], injectImmediately: true }]]]);
  // An invisible read, an unknown marker, an index that is not a number: nothing is injected.
  calls.length = 0;
  expect(await emit({ webaios: "contexte", fichiers: [0, 3] }, { tab: { id: 6 }, frameId: 0, documentId: "I" })).toEqual({ onglet: false });
  expect(await emit({ webaios: "contexte", fichiers: [99] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toEqual({ onglet: false });
  expect(await emit({ webaios: "contexte", fichiers: ["0"] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toEqual({ onglet: false });
  expect(await emit({ webaios: "contexte", fichiers: [0] }, {})).toEqual({ onglet: false });
  expect(calls).toEqual([]);
});

test("guard: in an agent page (popup, options), the context is neither answered nor injected: only the service worker does it; the agent's listeners do not see it either", async () => {
  const { chrome, appels: calls, emettre: emit } = guardContext({}, {}, { page: true });
  const seen: unknown[] = [];
  (chrome.runtime.onMessage as { addListener(f: unknown): void }).addListener((m: unknown) => void seen.push(m));
  expect(await emit({ webaios: "contexte", fichiers: [3, 0] }, { tab: { id: 4 }, frameId: 0, documentId: "D" })).toBe("aucune réponse");
  expect(await emit({ webaios: "contexte" }, { tab: { id: 4 } })).toBe("aucune réponse");
  expect(calls).toEqual([]);
  expect(seen).toEqual([]);
});

test("guard: an index outside the table (poisoned prototypes, negative, fractional) never injects anything", async () => {
  const { ctx, appels: calls, emettre: emit } = guardContext();
  // In the guard's world: what `table[n]` would read through the prototype chain for an n outside the table.
  runInContext('const faux = { genre: "js", chemin: "hors-liste.js" }; ({}).__proto__[999] = faux; [].__proto__[5] = faux; ({}).__proto__["-1"] = faux; ({}).__proto__["1.5"] = faux;', ctx as object);
  for (const n of [999, 5, -1, 1.5]) {
    expect(await emit({ webaios: "contexte", fichiers: [n] }, { tab: { id: 4 }, frameId: 0, documentId: "D" }), String(n)).toEqual({ onglet: false });
  }
  expect(calls).toEqual([]);
});

test("guard: onMessage answers { webaios: \"contexte\" } with estOnglet(sender.tab.id); the agent's listeners never see that message", async () => {
  const { chrome, emettre: emit } = guardContext({ nonOnglets: [6] });
  const seen: unknown[] = [];
  // The agent tries to answer « onglet » itself in the guard's place.
  const agent = (m: unknown, _e: unknown, reply: (x: unknown) => void) => {
    seen.push(m);
    reply({ onglet: true });
  };
  const onMessage = chrome.runtime.onMessage as { addListener(f: unknown): void; removeListener(f: unknown): void; hasListener(f: unknown): boolean };
  onMessage.addListener(agent);
  expect(onMessage.hasListener(agent)).toBe(true);
  expect(await emit({ webaios: "contexte" }, { tab: { id: 6 } })).toEqual({ onglet: false });
  expect(await emit({ webaios: "contexte" }, { tab: { id: 4 } })).toEqual({ onglet: true });
  expect(await emit({ webaios: "contexte" }, {})).toEqual({ onglet: false });
  // Through the prototype's method, taken apart: always wrapped.
  const byProto = (m: unknown, _e: unknown, reply: (x: unknown) => void) => {
    seen.push(m);
    reply({ onglet: true });
  };
  (Object.getPrototypeOf(onMessage) as { addListener: Function }).addListener.call(onMessage, byProto);
  expect(await emit({ webaios: "contexte" }, { tab: { id: 6 } })).toEqual({ onglet: false });
  expect(seen).toEqual([]);
  (Object.getPrototypeOf(onMessage) as { removeListener: Function }).removeListener.call(onMessage, byProto);
  // The other messages reach it.
  expect(await emit({ autre: 1 }, { tab: { id: 4 } })).toEqual({ onglet: true });
  expect(seen).toEqual([{ autre: 1 }]);
  onMessage.removeListener(agent);
  expect(onMessage.hasListener(agent)).toBe(false);
  // Truly replaced.
  expect(Object.getOwnPropertyDescriptor(chrome.runtime, "onMessage")?.writable).toBe(false);
});
