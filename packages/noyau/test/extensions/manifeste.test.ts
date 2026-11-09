import { expect, test } from "vitest";
import {
  accordRenforce,
  analyserManifeste,
  empreintePortee,
  fichiersMessages,
  libellesPortee,
  porteeElargie,
  type Portee,
} from "../../src/extensions/manifeste.js";

const base = { manifest_version: 3, name: "Ext", version: "1.0" };

test("a DNR blocker (storage, declarativeNetRequest, block rules): scope and labels", () => {
  const a = analyserManifeste(
    {
      ...base,
      permissions: ["storage", "declarativeNetRequest"],
      declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] },
    },
    { source: "store", regles: { "rules.json": [{ id: 1, action: { type: "block" }, condition: {} }] } },
  );
  expect(a.refus).toEqual([]);
  expect(a.portee.permissions).toEqual(["declarativeNetRequest", "storage"]);
  expect(libellesPortee(a.portee, "store")).toEqual([
    "Bloquer ou modifier des requêtes",
    "Garder ses réglages",
  ]);
});

test("content_scripts on <all_urls>: tousLesSites and scriptsTousLesSites", () => {
  const a = analyserManifeste(
    { ...base, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] },
    { source: "store" },
  );
  expect(a.portee.tousLesSites).toBe(true);
  expect(a.portee.scriptsTousLesSites).toBe(true);
  expect(libellesPortee(a.portee, "store")).toEqual(["Modifier l'apparence et le contenu des pages"]);
});

test("host_permissions *://*.youtube.com/*: hotes, not tousLesSites", () => {
  const a = analyserManifeste({ ...base, host_permissions: ["*://*.youtube.com/*"] }, { source: "store" });
  expect(a.portee.hotes).toEqual(["*://*.youtube.com/*"]);
  expect(a.portee.tousLesSites).toBe(false);
});

test("agent: downloads, webRequest, nativeMessaging, debugger, proxy refused, one refusal each", () => {
  const a = analyserManifeste(
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
  const a = analyserManifeste(
    { ...base, externally_connectable: {}, sandbox: {}, chrome_url_overrides: { newtab: "n.html" } },
    { source: "agent" },
  );
  expect(a.refus).toHaveLength(3);
  for (const k of ["externally_connectable", "sandbox", "chrome_url_overrides"]) {
    expect(a.refus.some((r) => r.includes(k))).toBe(true);
  }
});

test("agent: static rule redirect, modifyHeaders, regexSubstitution refused, each named", () => {
  const a = analyserManifeste(
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
  const onze = Array.from({ length: 11 }, (_, i) => `a${i}.exemple.com`);
  expect(analyserManifeste(base, { source: "agent", webaios: { reseau: onze } }).refus).toHaveLength(1);
  const joker = analyserManifeste(base, { source: "agent", webaios: { reseau: ["*.x.com"] } });
  expect(joker.refus).toEqual(["webaios.json : domaine invalide « *.x.com »"]);
  const ok = analyserManifeste(base, { source: "agent", webaios: { reseau: ["b.com", "a.com"] } });
  expect(ok.refus).toEqual([]);
  expect(ok.portee.reseau).toEqual(["a.com", "b.com"]);
  expect(analyserManifeste(base, { source: "store", webaios: { reseau: ["a.com"] } }).portee.reseau).toEqual([]);
});

test("agent: content_script world MAIN refused; the Store accepts it", () => {
  const m = { ...base, content_scripts: [{ matches: ["https://a.com/*"], js: ["a.js"], world: "MAIN" }] };
  expect(analyserManifeste(m, { source: "agent" }).refus).toHaveLength(1);
  expect(analyserManifeste(m, { source: "store" }).refus).toEqual([]);
});

test("agent: devtools_page, background.scripts and background.page refused; the Store keeps them", () => {
  for (const ajout of [
    { devtools_page: "d.html" },
    { background: { scripts: ["a.js"] } },
    { background: { page: "fond.html" } },
    { background: { service_worker: 3 } },
  ]) {
    const m = { ...base, ...ajout };
    expect(analyserManifeste(m, { source: "agent" }).refus, JSON.stringify(ajout)).toHaveLength(1);
    expect(analyserManifeste(m, { source: "store" }).refus).toEqual([]);
  }
  expect(analyserManifeste({ ...base, background: { service_worker: "sw.js", type: "module" } }, { source: "agent" }).refus).toEqual([]);
});

test("Store: webRequest accepted with the label « Observer les requêtes des pages »", () => {
  const a = analyserManifeste({ ...base, permissions: ["webRequest"] }, { source: "store" });
  expect(a.refus).toEqual([]);
  expect(libellesPortee(a.portee, "store")).toEqual(["Observer les requêtes des pages"]);
});

test("manifest_version 2 refused for both sources", () => {
  for (const source of ["store", "agent"] as const) {
    const a = analyserManifeste({ ...base, manifest_version: 2 }, { source });
    expect(a.refus).toEqual(["Seules les extensions Manifest V3 sont prises en charge"]);
  }
});

test("unreadable manifest or without name/version: a refusal", () => {
  expect(analyserManifeste("x", { source: "store" }).refus).toHaveLength(1);
  expect(analyserManifeste({ manifest_version: 3 }, { source: "store" }).refus).toHaveLength(2);
});

test("name __MSG_x__ resolved by the messages (case-insensitive key): fr first, then fr_FR, then default_locale", () => {
  const m = { ...base, name: "__MSG_extName__", default_locale: "en" };
  expect(fichiersMessages(m)).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json", "_locales/en/messages.json"]);
  const fr = { autre: { message: "x" } };
  const frFR = { EXTNAME: { message: "Nom fr_FR" } };
  const en = { extName: { message: "Nom en" } };
  expect(analyserManifeste(m, { source: "store", messages: [fr, frFR, en] }).nom).toBe("Nom fr_FR");
  expect(analyserManifeste(m, { source: "store", messages: [fr, undefined, en] }).nom).toBe("Nom en");
  expect(analyserManifeste(m, { source: "agent", messages: [{ extname: { message: "Nom fr" } }, en] }).nom).toBe("Nom fr");
  // default_locale absent or doubtful (path): only fr and fr_FR.
  expect(fichiersMessages({ ...base, default_locale: "../x" })).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json"]);
  expect(fichiersMessages({ ...base, default_locale: "fr" })).toEqual(["_locales/fr/messages.json", "_locales/fr_FR/messages.json"]);
});

test("name __MSG_x__ without a message: the message id", () => {
  expect(analyserManifeste({ ...base, name: "__MSG_appName__" }, { source: "store" }).nom).toBe("appName");
});

test("porteeElargie", () => {
  const p: Portee = {
    permissions: ["a", "b"], hotes: ["h1", "h2"], reseau: ["x.com"], tousLesSites: false, scriptsTousLesSites: false,
  };
  expect(porteeElargie(p, { ...p, permissions: ["b", "a"] })).toBe(false);
  expect(porteeElargie(p, { ...p, hotes: ["h1", "h2", "h3"] })).toBe(true);
  expect(porteeElargie(p, { ...p, permissions: ["a", "b", "c"] })).toBe(true);
  expect(porteeElargie(p, { ...p, reseau: ["x.com", "y.com"] })).toBe(true);
  expect(porteeElargie(p, { ...p, tousLesSites: true })).toBe(true);
  expect(porteeElargie(p, { ...p, scriptsTousLesSites: true })).toBe(true);
  expect(porteeElargie(p, { ...p, permissions: ["a"], hotes: [] })).toBe(false);
  expect(porteeElargie({ ...p, tousLesSites: true }, p)).toBe(false);
});

test("optional_permissions ignored for the Store", () => {
  const a = analyserManifeste(
    { ...base, permissions: ["storage"], optional_permissions: ["tabs"], optional_host_permissions: ["https://z.com/*"] },
    { source: "store" },
  );
  expect(a.refus).toEqual([]);
  expect(a.portee.permissions).toEqual(["storage"]);
  expect(a.portee.hotes).toEqual([]);
});

test("reinforced: scripts everywhere, or all sites with scripting", () => {
  const p: Portee = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  expect(accordRenforce({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "agent")).toBe(true);
  expect(accordRenforce({ ...p, tousLesSites: true, permissions: ["scripting"] }, "agent")).toBe(true);
  expect(accordRenforce({ ...p, tousLesSites: true }, "agent")).toBe(false);
  expect(accordRenforce({ ...p, permissions: ["scripting"] }, "agent")).toBe(false);
  expect(accordRenforce({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "store")).toBe(false);
});

test("labels: unknown right and order", () => {
  const a = analyserManifeste(
    { ...base, permissions: ["idle", "tabs", "scripting", "activeTab"] },
    { source: "agent" },
  );
  expect(libellesPortee(a.portee, "agent")).toEqual([
    "Modifier l'apparence et le contenu des pages",
    "Voir la liste des onglets et leurs adresses",
    "Agir sur l'onglet affiché quand tu cliques sur son bouton (non pris en charge par WebAiOs)",
    "Droit « idle »",
  ]);
});

const dnr = { ...base, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path: "rules.json" }] } };

test("R3-1 agent: rules file missing, not an array, absolute path or with ..: refused", () => {
  const refus = (path: string, regles: Record<string, unknown>) =>
    analyserManifeste(
      { ...base, declarative_net_request: { rule_resources: [{ id: "r", enabled: true, path }] } },
      { source: "agent", regles },
    ).refus;
  expect(refus("rules.json", {})).toHaveLength(1);
  expect(refus("rules.json", { "rules.json": { id: 1 } })).toHaveLength(1);
  expect(refus("/rules.json", { "/rules.json": [] })).toHaveLength(1);
  expect(refus("a/../rules.json", { "a/../rules.json": [] })).toHaveLength(1);
  expect(refus("rules.json", { "rules.json": [] })).toEqual([]);
  expect(refus("rules.json", {})[0]).toContain("rules.json");
  // the Store is not concerned
  expect(analyserManifeste(dnr, { source: "store" }).refus).toEqual([]);
});

test("R3-2 agent: optional_permissions and optional_host_permissions refused; Store unchanged", () => {
  const a = analyserManifeste({ ...base, optional_permissions: ["downloads"] }, { source: "agent" });
  expect(a.refus).toHaveLength(1);
  expect(a.refus[0]).toContain("permissions");
  const b = analyserManifeste({ ...base, optional_host_permissions: ["<all_urls>"] }, { source: "agent" });
  expect(b.refus).toHaveLength(1);
  expect(b.refus[0]).toContain("host_permissions");
  expect(analyserManifeste({ ...base, optional_permissions: [] }, { source: "agent" }).refus).toEqual([]);
});

test("R3-3/R3-4 all sites, in host_permissions and in permissions", () => {
  for (const m of ["*://*/*", "http://*/*", "https://*/*", "*://*", "<all_urls>", "https://*", "*://*.com/*", "https://*.fr/*"]) {
    const h = analyserManifeste({ ...base, host_permissions: [m] }, { source: "store" });
    expect(h.portee.tousLesSites, `host_permissions ${m}`).toBe(true);
    const p = analyserManifeste({ ...base, permissions: [m] }, { source: "store" });
    expect(p.portee.tousLesSites, `permissions ${m}`).toBe(true);
  }
  for (const m of ["*://*.exemple.com/*", "https://exemple.com/*", "https://a.b.fr/*"]) {
    expect(analyserManifeste({ ...base, host_permissions: [m] }, { source: "store" }).portee.tousLesSites, m).toBe(false);
  }
});

test("I3 all sites: ports, public-suffix wildcards, scripts", () => {
  const tous = ["*://*:*/*", "https://*:443/*", "*://*:8080/*", "*://*.co.uk/*", "https://*.com.au/*", "*://*.gouv.fr:*/*",
    "*://*.ac.jp/*", "*://*.com:443/*", "*://*.ne.jp/*", "*://*.or.jp/*", "*://*.edu.au/*", "*://*.gov.uk/*", "*://*.net.br/*", "*://*.org.uk/*"];
  for (const m of tous) {
    const h = analyserManifeste({ ...base, host_permissions: [m] }, { source: "agent" });
    expect(h.portee.tousLesSites, `host_permissions ${m}`).toBe(true);
    const s = analyserManifeste({ ...base, content_scripts: [{ matches: [m], js: ["a.js"] }] }, { source: "agent" });
    expect(s.portee.scriptsTousLesSites, `content_scripts ${m}`).toBe(true);
    expect(accordRenforce(s.portee, "agent"), `renforcé ${m}`).toBe(true);
  }
  for (const m of ["*://*.exemple.co.uk/*", "https://exemple.com:443/*", "*://*.exemple.com:*/*", "*://*.abc.uk/*", "*://*.co.fra/*"]) {
    expect(analyserManifeste({ ...base, host_permissions: [m] }, { source: "agent" }).portee.tousLesSites, m).toBe(false);
  }
});

test("R3-3 reinforced grant end to end", () => {
  const renforce = (m: object) => {
    const a = analyserManifeste({ ...base, ...m }, { source: "agent" });
    expect(a.refus).toEqual([]);
    return accordRenforce(a.portee, "agent");
  };
  expect(renforce({ content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] })).toBe(true);
  expect(renforce({ permissions: ["scripting"], host_permissions: ["*://*/*"] })).toBe(true);
  expect(renforce({ permissions: ["scripting"], host_permissions: ["https://a.com/*"] })).toBe(false);
  expect(renforce({ host_permissions: ["<all_urls>"] })).toBe(false);
});

test("R3-3 webRequestBlocking and redirect.transform refused", () => {
  expect(analyserManifeste({ ...base, permissions: ["webRequestBlocking"] }, { source: "agent" }).refus).toEqual([
    "Droit refusé : webRequestBlocking",
  ]);
  const a = analyserManifeste(dnr, {
    source: "agent",
    regles: { "rules.json": [{ id: 7, action: { type: "allow", redirect: { transform: { scheme: "https" } } } }] },
  });
  expect(a.refus).toEqual(["Règle DNR refusée (transform) dans rules.json, règle 7"]);
});

test("R3-5 porteeElargie: scripts false→true widens, true→false does not", () => {
  const p: Portee = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false, scripts: false };
  expect(porteeElargie(p, { ...p, scripts: true })).toBe(true);
  expect(porteeElargie({ ...p, scripts: true }, p)).toBe(false);
});

test("empreintePortee: stable whatever the order of keys and lists; changes with the scope", () => {
  const p: Portee = { permissions: ["tabs", "storage"], hotes: ["https://b.com/*", "https://a.com/*"], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  const melangee = { scriptsTousLesSites: false, tousLesSites: false, reseau: [], hotes: ["https://a.com/*", "https://b.com/*"], permissions: ["storage", "tabs"] } as Portee;
  expect(empreintePortee(p)).toMatch(/^[0-9a-f]{64}$/);
  expect(empreintePortee(melangee)).toBe(empreintePortee(p));
  // `scripts` absent vaut faux.
  expect(empreintePortee({ ...p, scripts: false })).toBe(empreintePortee(p));
  expect(empreintePortee({ ...p, scripts: true })).not.toBe(empreintePortee(p));
  expect(empreintePortee({ ...p, permissions: ["storage"] })).not.toBe(empreintePortee(p));
  expect(empreintePortee({ ...p, reseau: ["api.a.com"] })).not.toBe(empreintePortee(p));
  expect(empreintePortee({ ...p, tousLesSites: true })).not.toBe(empreintePortee(p));
  // One list is not confused with another (element boundaries).
  expect(empreintePortee({ ...p, permissions: ["a,b"] })).not.toBe(empreintePortee({ ...p, permissions: ["a", "b"] }));
});

test("I1 declarativeNetRequestFeedback has its own label", () => {
  const a = analyserManifeste({ ...base, permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"] }, { source: "agent" });
  expect(libellesPortee(a.portee, "agent")).toEqual([
    "Bloquer ou modifier des requêtes",
    "Voir quelles requêtes de tous les onglets ses règles ont touchées",
  ]);
});
