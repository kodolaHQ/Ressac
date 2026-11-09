import { expect, test } from "vitest";
import {
  grantStrengthened,
  parseManifest,
  scopeHash,
  messageFiles,
  scopeLabels,
  widenedScope,
  type Scope,
} from "../../src/extensions/manifeste.js";

const base = { manifest_version: 3, name: "Ext", version: "1.0" };

test("a DNR blocker (storage, declarativeNetRequest, block rules): scope and labels", () => {
  const a = parseManifest(
    {
      ...base,
      permissions: ["storage", "declarativeNetRequest"],
      declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] },
    },
    { source: "store", regles: { "rules.json": [{ id: 1, action: { type: "block" }, condition: {} }] } },
  );
  expect(a.refus).toEqual([]);
  expect(a.portee.permissions).toEqual(["declarativeNetRequest", "storage"]);
  expect(scopeLabels(a.portee, "store")).toEqual([
    "Bloquer ou modifier des requêtes",
    "Garder ses réglages",
  ]);
});

test("content_scripts on <all_urls>: tousLesSites and scriptsTousLesSites", () => {
  const a = parseManifest(
    { ...base, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] },
    { source: "store" },
  );
  expect(a.portee.tousLesSites).toBe(true);
  expect(a.portee.scriptsTousLesSites).toBe(true);
  expect(scopeLabels(a.portee, "store")).toEqual(["Modifier l'apparence et le contenu des pages"]);
});

test("host_permissions *://*.youtube.com/*: hotes, not tousLesSites", () => {
  const a = parseManifest({ ...base, host_permissions: ["*://*.youtube.com/*"] }, { source: "store" });
  expect(a.portee.hotes).toEqual(["*://*.youtube.com/*"]);
  expect(a.portee.tousLesSites).toBe(false);
});

test("agent: downloads, webRequest, nativeMessaging, debugger, proxy refused, one refusal each", () => {
  const a = parseManifest(
    { ...base, permissions: ["downloads", "webRequest", "nativeMessaging", "debugger", "proxy", "storage"] },
    { source: "agent" },
  );
  expect(a.refus).toEqual([
    "Droit refusé : debugger",
    "Droit refusé : downloads",
    "Droit refusé : nativeMessaging",
    "Droit refusé : proxy",
    "Droit refusé : webRequest",
  ]);
});

test("agent: externally_connectable, sandbox, chrome_url_overrides refused", () => {
  const a = parseManifest(
    { ...base, externally_connectable: {}, sandbox: {}, chrome_url_overrides: { newtab: "n.html" } },
    { source: "agent" },
  );
  expect(a.refus).toHaveLength(3);
  for (const k of ["externally_connectable", "sandbox", "chrome_url_overrides"]) {
    expect(a.refus.some((r) => r.includes(k))).toBe(true);
  }
});

test("agent: static rule redirect, modifyHeaders, regexSubstitution refused, each named", () => {
  const a = parseManifest(
    { ...base, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] } },
    {
      source: "agent",
      regles: {
        "rules.json": [
          { id: 1, action: { type: "block" } },
          { id: 2, action: { type: "redirect", redirect: { url: "https://x.com" } } },
          { id: 3, action: { type: "modifyHeaders" } },
          { id: 4, action: { type: "allow", redirect: { regexSubstitution: "\\1" } } },
        ],
      },
    },
  );
  expect(a.refus).toEqual([
    "Règle DNR refusée (redirect) dans rules.json, règle 2",
    "Règle DNR refusée (modifyHeaders) dans rules.json, règle 3",
    "Règle DNR refusée (regexSubstitution) dans rules.json, règle 4",
  ]);
});

test("agent: webaios.json with 11 domains or a wildcard refused; reseau sorted", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `a${i}.exemple.com`);
  expect(parseManifest(base, { source: "agent", webaios: { reseau: eleven } }).refus).toHaveLength(1);
  const joker = parseManifest(base, { source: "agent", webaios: { reseau: ["*.x.com"] } });
  expect(joker.refus).toEqual(["webaios.json : domaine invalide « *.x.com »"]);
  const ok = parseManifest(base, { source: "agent", webaios: { reseau: ["b.com", "a.com"] } });
  expect(ok.refus).toEqual([]);
  expect(ok.portee.reseau).toEqual(["a.com", "b.com"]);
  expect(parseManifest(base, { source: "store", webaios: { reseau: ["a.com"] } }).portee.reseau).toEqual([]);
});

test("agent: content_script world MAIN refused; the Store accepts it", () => {
  const m = { ...base, content_scripts: [{ matches: ["https://a.com/*"], js: ["a.js"], world: "MAIN" }] };
  expect(parseManifest(m, { source: "agent" }).refus).toHaveLength(1);
  expect(parseManifest(m, { source: "store" }).refus).toEqual([]);
});

test("agent: devtools_page, background.scripts and background.page refused; the Store keeps them", () => {
  for (const addition of [
    { devtools_page: "d.html" },
    { background: { scripts: ["a.js"] } },
    { background: { page: "fond.html" } },
    { background: { service_worker: 3 } },
  ]) {
    const m = { ...base, ...addition };
    expect(parseManifest(m, { source: "agent" }).refus, JSON.stringify(addition)).toHaveLength(1);
    expect(parseManifest(m, { source: "store" }).refus).toEqual([]);
  }
  expect(parseManifest({ ...base, background: { service_worker: "sw.js", type: "module" } }, { source: "agent" }).refus).toEqual([]);
});

test("Store: webRequest accepted with the label « Observer les requêtes des pages »", () => {
  const a = parseManifest({ ...base, permissions: ["webRequest"] }, { source: "store" });
  expect(a.refus).toEqual([]);
  expect(scopeLabels(a.portee, "store")).toEqual(["Observer les requêtes des pages"]);
});

test("manifest_version 2 refused for both sources", () => {
  for (const source of ["store", "agent"] as const) {
    const a = parseManifest({ ...base, manifest_version: 2 }, { source });
    expect(a.refus).toEqual(["Seules les extensions Manifest V3 sont prises en charge"]);
  }
});

test("unreadable manifest or without name/version: a refusal", () => {
  expect(parseManifest("x", { source: "store" }).refus).toHaveLength(1);
  expect(parseManifest({ manifest_version: 3 }, { source: "store" }).refus).toHaveLength(2);
});

test("name __MSG_x__ resolved by the messages (case-insensitive key): fr first, then fr_FR, then default_locale", () => {
  const m = { ...base, name: "__MSG_extName__", default_locale: "en" };
  expect(messageFiles(m)).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json", "_locales/en/messages.json"]);
  const fr = { autre: { message: "x" } };
  const frFR = { EXTNAME: { message: "Nom fr_FR" } };
  const en = { extName: { message: "Nom en" } };
  expect(parseManifest(m, { source: "store", messages: [fr, frFR, en] }).nom).toBe("Nom fr_FR");
  expect(parseManifest(m, { source: "store", messages: [fr, undefined, en] }).nom).toBe("Nom en");
  expect(parseManifest(m, { source: "agent", messages: [{ extname: { message: "Nom fr" } }, en] }).nom).toBe("Nom fr");
  // default_locale absent or doubtful (path): only fr and fr_FR.
  expect(messageFiles({ ...base, default_locale: "../x" })).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json"]);
  expect(messageFiles({ ...base, default_locale: "fr" })).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json"]);
});

test("name __MSG_x__ without a message: the message id", () => {
  expect(parseManifest({ ...base, name: "__MSG_appName__" }, { source: "store" }).nom).toBe("appName");
});

test("porteeElargie", () => {
  const p: Scope = {
    permissions: ["a", "b"], hotes: ["h1", "h2"], reseau: ["x.com"], tousLesSites: false, scriptsTousLesSites: false,
  };
  expect(widenedScope(p, { ...p, permissions: ["b", "a"] })).toBe(false);
  expect(widenedScope(p, { ...p, hotes: ["h1", "h2", "h3"] })).toBe(true);
  expect(widenedScope(p, { ...p, permissions: ["a", "b", "c"] })).toBe(true);
  expect(widenedScope(p, { ...p, reseau: ["x.com", "y.com"] })).toBe(true);
  expect(widenedScope(p, { ...p, tousLesSites: true })).toBe(true);
  expect(widenedScope(p, { ...p, scriptsTousLesSites: true })).toBe(true);
  expect(widenedScope(p, { ...p, permissions: ["a"], hotes: [] })).toBe(false);
  expect(widenedScope({ ...p, tousLesSites: true }, p)).toBe(false);
});

test("optional_permissions ignored for the Store", () => {
  const a = parseManifest(
    { ...base, permissions: ["storage"], optional_permissions: ["tabs"], optional_host_permissions: ["https://z.com/*"] },
    { source: "store" },
  );
  expect(a.refus).toEqual([]);
  expect(a.portee.permissions).toEqual(["storage"]);
  expect(a.portee.hotes).toEqual([]);
});

test("reinforced: scripts everywhere, or all sites with scripting", () => {
  const p: Scope = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  expect(grantStrengthened({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "agent")).toBe(true);
  expect(grantStrengthened({ ...p, tousLesSites: true, permissions: ["scripting"] }, "agent")).toBe(true);
  expect(grantStrengthened({ ...p, tousLesSites: true }, "agent")).toBe(false);
  expect(grantStrengthened({ ...p, permissions: ["scripting"] }, "agent")).toBe(false);
  expect(grantStrengthened({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "store")).toBe(false);
});

test("labels: unknown right and order", () => {
  const a = parseManifest(
    { ...base, permissions: ["idle", "tabs", "scripting", "activeTab"] },
    { source: "agent" },
  );
  expect(scopeLabels(a.portee, "agent")).toEqual([
    "Modifier l'apparence et le contenu des pages",
    "Voir la liste des onglets et leurs adresses",
    "Agir sur l'onglet affiché quand tu cliques sur son bouton (non pris en charge par WebAiOs)",
    "Droit « idle »",
  ]);
});

const dnr = { ...base, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] } };

test("R3-1 agent: rules file missing, not an array, absolute path or with ..: refused", () => {
  const denial = (path: string, regles: Record<string, unknown>) =>
    parseManifest(
      { ...base, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path }] } },
      { source: "agent", regles },
    ).refus;
  expect(denial("rules.json", {})).toHaveLength(1);
  expect(denial("rules.json", { "rules.json": { id: 1 } })).toHaveLength(1);
  expect(denial("/rules.json", { "/rules.json": [] })).toHaveLength(1);
  expect(denial("a/../rules.json", { "a/../rules.json": [] })).toHaveLength(1);
  expect(denial("rules.json", { "rules.json": [] })).toEqual([]);
  expect(denial("rules.json", {})[0]).toContain("rules.json");
  // the Store is not concerned
  expect(parseManifest(dnr, { source: "store" }).refus).toEqual([]);
});

test("R3-2 agent: optional_permissions and optional_host_permissions refused; Store unchanged", () => {
  const a = parseManifest({ ...base, optional_permissions: ["downloads"] }, { source: "agent" });
  expect(a.refus).toHaveLength(1);
  expect(a.refus[0]).toContain("permissions");
  const b = parseManifest({ ...base, optional_host_permissions: ["<all_urls>"] }, { source: "agent" });
  expect(b.refus).toHaveLength(1);
  expect(b.refus[0]).toContain("host_permissions");
  expect(parseManifest({ ...base, optional_permissions: [] }, { source: "agent" }).refus).toEqual([]);
});

test("R3-3/R3-4 all sites, in host_permissions and in permissions", () => {
  for (const m of ["*://*/*", "http://*/*", "https://*/*", "*://*", "<all_urls>", "https://*", "*://*.com/*", "https://*.fr/*"]) {
    const h = parseManifest({ ...base, host_permissions: [m] }, { source: "store" });
    expect(h.portee.tousLesSites, `host_permissions ${m}`).toBe(true);
    const p = parseManifest({ ...base, permissions: [m] }, { source: "store" });
    expect(p.portee.tousLesSites, `permissions ${m}`).toBe(true);
  }
  for (const m of ["*://*.exemple.com/*", "https://exemple.com/*", "https://a.b.fr/*"]) {
    expect(parseManifest({ ...base, host_permissions: [m] }, { source: "store" }).portee.tousLesSites, m).toBe(false);
  }
});

test("I3 all sites: ports, public-suffix wildcards, scripts", () => {
  const tous = ["*://*:*/*", "https://*:443/*", "*://*:8080/*", "*://*.co.uk/*", "https://*.com.au/*", "*://*.gouv.fr:*/*",
    "*://*.ac.jp/*", "*://*.com:443/*", "*://*.ne.jp/*", "*://*.or.jp/*", "*://*.edu.au/*", "*://*.gov.uk/*", "*://*.net.br/*", "*://*.org.uk/*"];
  for (const m of tous) {
    const h = parseManifest({ ...base, host_permissions: [m] }, { source: "agent" });
    expect(h.portee.tousLesSites, `host_permissions ${m}`).toBe(true);
    const s = parseManifest({ ...base, content_scripts: [{ matches: [m], js: ["a.js"] }] }, { source: "agent" });
    expect(s.portee.scriptsTousLesSites, `content_scripts ${m}`).toBe(true);
    expect(grantStrengthened(s.portee, "agent"), `renforcé ${m}`).toBe(true);
  }
  for (const m of ["*://*.exemple.co.uk/*", "https://exemple.com:443/*", "*://*.exemple.com:*/*", "*://*.abc.uk/*", "*://*.co.fra/*"]) {
    expect(parseManifest({ ...base, host_permissions: [m] }, { source: "agent" }).portee.tousLesSites, m).toBe(false);
  }
});

test("R3-3 reinforced grant end to end", () => {
  const strengthened = (m: object) => {
    const a = parseManifest({ ...base, ...m }, { source: "agent" });
    expect(a.refus).toEqual([]);
    return grantStrengthened(a.portee, "agent");
  };
  expect(strengthened({ content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] })).toBe(true);
  expect(strengthened({ permissions: ["scripting"], host_permissions: ["*://*/*"] })).toBe(true);
  expect(strengthened({ permissions: ["scripting"], host_permissions: ["https://a.com/*"] })).toBe(false);
  expect(strengthened({ host_permissions: ["<all_urls>"] })).toBe(false);
});

test("R3-3 webRequestBlocking and redirect.transform refused", () => {
  expect(parseManifest({ ...base, permissions: ["webRequestBlocking"] }, { source: "agent" }).refus).toEqual([
    "Droit refusé : webRequestBlocking",
  ]);
  const a = parseManifest(dnr, {
    source: "agent",
    regles: { "rules.json": [{ id: 7, action: { type: "allow", redirect: { transform: { scheme: "https" } } } }] },
  });
  expect(a.refus).toEqual(["Règle DNR refusée (transform) dans rules.json, règle 7"]);
});

test("R3-5 porteeElargie: scripts false→true widens, true→false does not", () => {
  const p: Scope = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: false };
  expect(widenedScope(p, { ...p, scripts: true })).toBe(true);
  expect(widenedScope({ ...p, scripts: true }, p)).toBe(false);
});

test("empreintePortee: stable whatever the order of keys and lists; changes with the scope", () => {
  const p: Scope = { permissions: ["tabs", "storage"], hotes: ["https://b.com/*", "https://a.com/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  const shuffled = { scriptsTousLesSites: false, tousLesSites: false, reseau: [], hotes: ["https://a.com/*", "https://b.com/*"], permissions: ["storage", "tabs"] } as Scope;
  expect(scopeHash(p)).toMatch(/^[0-9a-f]{64}$/);
  expect(scopeHash(shuffled)).toBe(scopeHash(p));
  // `scripts` absent vaut faux.
  expect(scopeHash({ ...p, scripts: false })).toBe(scopeHash(p));
  expect(scopeHash({ ...p, scripts: true })).not.toBe(scopeHash(p));
  expect(scopeHash({ ...p, permissions: ["storage"] })).not.toBe(scopeHash(p));
  expect(scopeHash({ ...p, reseau: ["api.a.com"] })).not.toBe(scopeHash(p));
  expect(scopeHash({ ...p, tousLesSites: true })).not.toBe(scopeHash(p));
  // One list is not confused with another (element boundaries).
  expect(scopeHash({ ...p, permissions: ["a,b"] })).not.toBe(scopeHash({ ...p, permissions: ["a", "b"] }));
});

test("I1 declarativeNetRequestFeedback has its own label", () => {
  const a = parseManifest({ ...base, permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"] }, { source: "agent" });
  expect(scopeLabels(a.portee, "agent")).toEqual([
    "Bloquer ou modifier des requêtes",
    "Voir quelles requêtes de tous les onglets ses règles ont touchées",
  ]);
});
