import { expect, test } from "vitest";
import {
  accordRenforce,
  analyserManifeste,
  libellesPortee,
  porteeElargie,
  type Portee,
} from "../../src/extensions/manifeste.js";

const base = { manifest_version: 3, name: "Ext", version: "1.0" };

test("un bloqueur DNR (storage, declarativeNetRequest, règles block) : portée et libellés", () => {
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

test("content_scripts sur <all_urls> : tousLesSites et scriptsTousLesSites", () => {
  const a = analyserManifeste(
    { ...base, content_scripts: [{ matches: ["<all_urls>"], js: ["a.js"] }] },
    { source: "store" },
  );
  expect(a.portee.tousLesSites).toBe(true);
  expect(a.portee.scriptsTousLesSites).toBe(true);
  expect(libellesPortee(a.portee, "store")).toEqual(["Modifier l'apparence et le contenu des pages"]);
});

test("host_permissions *://*.youtube.com/* : hotes, pas tousLesSites", () => {
  const a = analyserManifeste({ ...base, host_permissions: ["*://*.youtube.com/*"] }, { source: "store" });
  expect(a.portee.hotes).toEqual(["*://*.youtube.com/*"]);
  expect(a.portee.tousLesSites).toBe(false);
});

test("agent : downloads, webRequest, nativeMessaging, debugger, proxy refusés, un refus chacun", () => {
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

test("agent : externally_connectable, sandbox, chrome_url_overrides refusés", () => {
  const a = analyserManifeste(
    { ...base, externally_connectable: {}, sandbox: {}, chrome_url_overrides: { newtab: "n.html" } },
    { source: "agent" },
  );
  expect(a.refus).toHaveLength(3);
  for (const k of ["externally_connectable", "sandbox", "chrome_url_overrides"]) {
    expect(a.refus.some((r) => r.includes(k))).toBe(true);
  }
});

test("agent : règle statique redirect, modifyHeaders, regexSubstitution refusées, chacune nommée", () => {
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

test("agent : webaios.json avec 11 domaines ou un joker refusé ; reseau trié", () => {
  const onze = Array.from({ length: 11 }, (_, i) => `a${i}.exemple.com`);
  expect(analyserManifeste(base, { source: "agent", webaios: { reseau: onze } }).refus).toHaveLength(1);
  const joker = analyserManifeste(base, { source: "agent", webaios: { reseau: ["*.x.com"] } });
  expect(joker.refus).toEqual(["webaios.json : domaine invalide « *.x.com »"]);
  const ok = analyserManifeste(base, { source: "agent", webaios: { reseau: ["b.com", "a.com"] } });
  expect(ok.refus).toEqual([]);
  expect(ok.portee.reseau).toEqual(["a.com", "b.com"]);
  expect(analyserManifeste(base, { source: "store", webaios: { reseau: ["a.com"] } }).portee.reseau).toEqual([]);
});

test("agent : content_script world MAIN refusé ; le Store l'accepte", () => {
  const m = { ...base, content_scripts: [{ matches: ["https://a.com/*"], js: ["a.js"], world: "MAIN" }] };
  expect(analyserManifeste(m, { source: "agent" }).refus).toHaveLength(1);
  expect(analyserManifeste(m, { source: "store" }).refus).toEqual([]);
});

test("Store : webRequest accepté avec le libellé « Observer les requêtes des pages »", () => {
  const a = analyserManifeste({ ...base, permissions: ["webRequest"] }, { source: "store" });
  expect(a.refus).toEqual([]);
  expect(libellesPortee(a.portee, "store")).toEqual(["Observer les requêtes des pages"]);
});

test("manifest_version 2 refusé pour les deux sources", () => {
  for (const source of ["store", "agent"] as const) {
    const a = analyserManifeste({ ...base, manifest_version: 2 }, { source });
    expect(a.refus).toEqual(["Seules les extensions Manifest V3 sont prises en charge"]);
  }
});

test("manifeste illisible ou sans name/version : un refus", () => {
  expect(analyserManifeste("x", { source: "store" }).refus).toHaveLength(1);
  expect(analyserManifeste({ manifest_version: 3 }, { source: "store" }).refus).toHaveLength(2);
});

test("nom __MSG_x__ remplacé par l'id du message", () => {
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

test("optional_permissions ignorées", () => {
  const a = analyserManifeste(
    { ...base, permissions: ["storage"], optional_permissions: ["tabs"], optional_host_permissions: ["https://z.com/*"] },
    { source: "store" },
  );
  expect(a.portee.permissions).toEqual(["storage"]);
  expect(a.portee.hotes).toEqual([]);
});

test("renforce : scripts partout, ou tous les sites avec scripting", () => {
  const p: Portee = { permissions: [], hotes: [], reseau: [], tousLesSites: false, scriptsTousLesSites: false };
  expect(accordRenforce({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "agent")).toBe(true);
  expect(accordRenforce({ ...p, tousLesSites: true, permissions: ["scripting"] }, "agent")).toBe(true);
  expect(accordRenforce({ ...p, tousLesSites: true }, "agent")).toBe(false);
  expect(accordRenforce({ ...p, permissions: ["scripting"] }, "agent")).toBe(false);
  expect(accordRenforce({ ...p, scriptsTousLesSites: true, tousLesSites: true }, "store")).toBe(false);
});

test("libellés : droit inconnu et ordre", () => {
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
