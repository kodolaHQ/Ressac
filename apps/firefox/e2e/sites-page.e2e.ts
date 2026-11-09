import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SITE_UNKNOWN, SITE_DENIED } from "../../../packages/kernel/src/mcp/server";
import { testActor } from "./agent-extensions";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { SITE_HOME, inSiteBar, inSiteView, resolveLocalHosts, siteWindowCount, startSitesServer, writeSite, type SiteTest } from "./sites";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 31 Task 6: the Applications page's « Sites » section and the agent's site
// tools.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startSitesServer>>;
const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
beforeAll(async () => (server = await startSitesServer()));
afterAll(async () => {
  await server?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

let w: LaunchedWebAiOs;
let m: Marionette;
afterEach(async () => {
  try {
    if (m) expect(await missingApi(m)).toEqual([]);
  } finally {
    for (const o of opened.splice(0)) await o.close();
  }
});

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const vidola = (home = true): SiteTest => ({
  declaration: { name: "Vidola", url: url("/"), domains: ["vidola-a.localhost"], login: [] },
  ...(home ? { files: { "accueil/index.html": SITE_HOME } } : {}),
});
const memory = (dataDir: string, id = "vidola") => path.join(dataDir, "sites", id, "memoire.json");
function writeMemory(dataDir: string, id = "vidola"): void {
  mkdirSync(path.join(dataDir, "sites", id), { recursive: true });
  writeFileSync(
    memory(dataDir, id),
    JSON.stringify({ version: 1, values: { "encours.the-bear": { value: { title: "The Bear" }, url: "/serie/the-bear?e=4", when: new Date().toISOString() } }, positions: {} }),
  );
}

/** WebAiOs on a data folder where `prepare` has written the apps; the Applications page open when `page`. */
async function launch(o: { prepare?: (dataDir: string) => void; page?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  o.prepare?.(dataDir);
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
  opened.push(w);
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(m, HOSTS);
  if (o.page !== false) await openPage();
  return { dataDir, profile };
}
async function openPage(): Promise<void> {
  await dispatch(m, { type: "ouvrirApplications", windowId: (await state(m)).windows[0]!.id });
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-applications\"]')");
}
const row = (id: string) => `[data-testid="site-${id}"]`;
const rowText = (id: string) => waitUi<string>(m, "return doc.querySelector(arguments[0])?.textContent ?? null", [row(id)]);
const gone = (id: string) => waitUi(m, "return !doc.querySelector(arguments[0])", [row(id)]);
const isOpen = (id: string, v: boolean) => waitUi(m, "return doc.querySelector(arguments[0])?.dataset.ouverte === arguments[1]", [row(id), String(v)]);
const windows = (id: string) => siteWindowCount(m, id);
const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);

/** The names and values of the app's container cookies for its host. */
const cookies = (id: string) =>
  m.execute<string[]>(
    `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
     const i = ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-" + arguments[0]);
     if (!i) return [];
     return Services.cookies.getCookiesFromHost("vidola-a.localhost", { userContextId: i.userContextId }).map((c) => c.name + "=" + c.value);`,
    [id],
  );

/** The home's `#series` text, or null while it is not shown. */
const series = (id: string) =>
  inSiteBar<string | null>(
    m,
    id,
    `const home = doc.querySelector('[data-testid="site-cadre-accueil"]');
     if (!String(home?.contentDocument?.documentURI).startsWith("resource://webaios-site-")) return null;
     return home.contentDocument.getElementById("series").textContent;`,
  );
/** A trusted click on a bar button. */
const barClick = (id: string, testid: string) =>
  inSiteBar(
    m,
    id,
    `for (let i = 0; i < 100 && !doc.querySelector('[data-testid="' + arguments[0] + '"]'); i++) await new Promise((r) => setTimeout(r, 100));
     const r = doc.querySelector('[data-testid="' + arguments[0] + '"]').getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
    [testid],
  );
/** « Entrer dans le site » and the site view's address. */
async function enter(id: string, address: string): Promise<void> {
  await barClick(id, "site-entrer");
  await waitFor(m, `const w = ${siteExpr(id)}; return w?.gBrowser.selectedBrowser.currentURI.spec;`, (v) => v === address, 15_000);
  await waitFor(m, `return ${siteExpr(id)}.gBrowser.selectedBrowser.contentDocument?.readyState ?? null;`, (v) => v === "complete").catch(() => {});
}
const siteExpr = (id: string) => `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.getAttribute("webaios-site") === ${JSON.stringify(id)})`;

/** Vidola (with a home), Autre (its current address kept in the profile), and a broken site.json. */
const section = (dataDir: string) => {
  writeSite(dataDir, "vidola", vidola());
  writeSite(dataDir, "autre", { declaration: { name: "Autre", url: url("/", "vidola-b.localhost"), domains: ["vidola-b.localhost"] } });
  writeSite(dataDir, "casse", { declaration: "{ pas du json" });
  mkdirSync(path.join(dataDir, "sites", "autre"), { recursive: true });
  writeFileSync(path.join(dataDir, "sites", "autre", "adresse.json"), JSON.stringify({ current: "vidola-c.localhost", previous: ["vidola-b.localhost"], since: new Date().toISOString() }));
};

describe("Applications page, Sites section", () => {
  it("two sites listed with their current domain; a broken site.json: « Sans fiche » and the error; the field filters", async () => {
    await launch({ prepare: section });
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"section-sites\"]')");
    expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"section-sites\"] h2')?.textContent")).toBe("Sites");
    expect(await rowText("vidola")).toContain("Vidola");
    expect(await rowText("vidola")).toContain("vidola-a.localhost");
    expect(await rowText("autre")).toContain("vidola-c.localhost");
    expect(await rowText("casse")).toContain("Sans fiche");
    expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"site-casse-erreur\"]')?.textContent")).toContain("site.json");
    await inUi(m, `const f = doc.querySelector('[data-testid="recherche-applications"]'); f.value = "autre"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
    await waitUi(m, `return doc.querySelectorAll('[data-testid^="site-"][data-ouverte]').length === 1`);
    expect(await rowText("autre")).toContain("Autre");
  });

  it("the Sites section has no Docker banner and its buttons are enabled", async () => {
    await launch({ prepare: section });
    await rowText("vidola");
    expect(await inUi<string>(m, "return doc.querySelector('[data-testid=\"section-sites\"]').textContent")).not.toContain("Docker");
    const disabled = await inUi<string[]>(
      m,
      `return [...doc.querySelectorAll('[data-testid="site-vidola"] button')].filter((b) => b.disabled).map((b) => b.textContent);`,
    );
    expect(disabled).toEqual([]);
    const names = await inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="site-vidola"] button')].map((b) => b.textContent);`);
    for (const b of ["Ouvrir", "Modifier avec l'agent", "Oublier ce que l'appli a retenu", "Afficher le dossier", "Supprimer"]) expect(names).toContain(b);
  });

  it("Ouvrir opens the app's window; the row turns « Ouverte »", async () => {
    await launch({ prepare: section });
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await waitFor(m, `return ${siteExpr("vidola")} !== undefined;`, (v) => v === true);
    await isOpen("vidola", true);
    expect(await windows("vidola")).toBe(1);
  });

  it("Modifier avec l'agent: the agent panel opens and its terminal holds « Appli de site ~/WebAiOs/sites/vidola/ : »", async () => {
    await launch({ prepare: section });
    await click(m, '[data-testid="site-vidola-modifier"]');
    const text = "Appli de site ~/WebAiOs/sites/vidola/ :";
    await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes(arguments[0])", [text], 20_000, "agent");
  });

  it("Oublier ce que l'appli a retenu (confirmed): memoire.json gone, the open home no longer shows the series", async () => {
    const { dataDir } = await launch({ prepare: (d) => (section(d), writeMemory(d)) });
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await waitFor(m, `return ${siteExpr("vidola")} !== undefined;`, (v) => v === true);
    await waitFor(m, "return 1", () => true);
    await expect.poll(() => series("vidola").catch(() => null), { timeout: 15_000 }).toBe("encours.the-bear : The Bear /serie/the-bear?e=4");
    // Cancel changes nothing.
    await click(m, '[data-testid="site-vidola-oublier"]');
    expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"confirmation-oubli-site\"]')?.textContent")).toContain("Oublier tout ce que « Vidola » a retenu");
    await click(m, '[data-testid="confirmation-oubli-site"] button', { text: "Annuler" });
    await waitUi(m, "return !doc.querySelector('[data-testid=\"confirmation-oubli-site\"]')");
    expect(existsSync(memory(dataDir))).toBe(true);
    await click(m, '[data-testid="site-vidola-oublier"]');
    await click(m, '[data-testid="confirmer-oubli-site"]');
    await expect.poll(() => existsSync(memory(dataDir)), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => series("vidola"), { timeout: 10_000 }).toBe("");
    // The app's folder is not touched.
    expect(existsSync(path.join(dataDir, "espace", "sites", "vidola", "site.json"))).toBe(true);
  });

  it("Supprimer (confirmed): cookie and memory gone, window closed, folder in sites/.corbeille, the row goes; an app recreated under the same id starts empty", async () => {
    const { dataDir } = await launch({ prepare: (d) => writeSite(d, "vidola", vidola(false)) });
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await waitFor(m, `return ${siteExpr("vidola")}?.gBrowser.selectedBrowser.currentURI.spec;`, (v) => v === url("/"), 15_000);
    await inSiteView(m, "vidola", "location.href = '/cookie'; return 1;");
    await expect.poll(() => cookies("vidola"), { timeout: 10_000 }).toContain("essai=vidola-a.localhost");
    writeMemory(dataDir);
    mkdirSync(path.join(dataDir, "sites", "vidola"), { recursive: true });
    writeFileSync(path.join(dataDir, "sites", "vidola", "adresse.json"), JSON.stringify({ current: "vidola-a.localhost", previous: [], since: null }));
    await click(m, '[data-testid="site-vidola-supprimer"]');
    expect(await waitUi<string>(m, "return doc.querySelector('[data-testid=\"confirmation-suppression-site\"]')?.textContent")).toContain("Supprimer « Vidola » ?");
    await click(m, '[data-testid="confirmation-suppression-site"] button', { text: "Annuler" });
    await waitUi(m, "return !doc.querySelector('[data-testid=\"confirmation-suppression-site\"]')");
    expect(existsSync(path.join(dataDir, "espace", "sites", "vidola"))).toBe(true);
    await click(m, '[data-testid="site-vidola-supprimer"]');
    await click(m, '[data-testid="confirmer-suppression-site"]');
    await gone("vidola");
    expect(await windows("vidola")).toBe(0);
    expect(await cookies("vidola")).toEqual([]);
    expect(existsSync(path.join(dataDir, "espace", "sites", "vidola"))).toBe(false);
    expect(readdirSync(path.join(dataDir, "espace", "sites", ".corbeille")).filter((n) => /^vidola-\d+$/.test(n))).toHaveLength(1);
    expect(existsSync(memory(dataDir))).toBe(false);
    expect(existsSync(path.join(dataDir, "sites", "vidola", "adresse.json"))).toBe(false);
    // Recreated under the same id: no cookie, no memory, no kept address.
    writeSite(dataDir, "vidola", vidola(false));
    await rowText("vidola");
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await waitFor(m, `return ${siteExpr("vidola")}?.gBrowser.selectedBrowser.currentURI.spec;`, (v) => v === url("/"), 15_000);
    expect(await cookies("vidola")).toEqual([]);
    expect(existsSync(memory(dataDir))).toBe(false);
  });

  it("deleting an app: session (cookie, localStorage, IndexedDB) and memory gone; recreated, no cookie is sent, the storage is empty, the home has no series", async () => {
    const { dataDir } = await launch({ prepare: (d) => (writeSite(d, "vidola", vidola()), writeMemory(d)) });
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await expect.poll(() => series("vidola").catch(() => null), { timeout: 15_000 }).toContain("The Bear");
    await enter("vidola", url("/"));
    await inSiteView(m, "vidola", "location.href = '/cookie'; return 1;");
    await expect.poll(() => cookies("vidola"), { timeout: 10_000 }).toContain("essai=vidola-a.localhost");
    await sleep(500);
    await inSiteView(m, "vidola", `localStorage.setItem("reglage", "sombre"); return localStorage.length;`);
    await inSiteView(
      m,
      "vidola",
      `return new Promise((ok, ko) => { const r = indexedDB.open("essai", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onerror = () => ko(String(r.error)); r.onsuccess = () => { const t = r.result.transaction("s", "readwrite"); t.objectStore("s").put("v", "k"); t.oncomplete = () => { r.result.close(); ok(true); }; t.onerror = () => ko(String(t.error)); }; });`,
    );
    expect(await inSiteView(m, "vidola", `return indexedDB.databases().then((d) => d.map((x) => x.name));`)).toEqual(["essai"]);
    expect(existsSync(memory(dataDir))).toBe(true);

    await click(m, '[data-testid="site-vidola-supprimer"]');
    await click(m, '[data-testid="confirmer-suppression-site"]');
    await gone("vidola");
    expect(await windows("vidola")).toBe(0);
    expect(await cookies("vidola")).toEqual([]);
    expect(existsSync(memory(dataDir))).toBe(false);

    writeSite(dataDir, "vidola", vidola());
    await rowText("vidola");
    server.requests.splice(0);
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    // The new home shows no series (the memory is new, empty).
    await expect.poll(() => series("vidola").catch(() => null), { timeout: 15_000 }).toBe("");
    await enter("vidola", url("/"));
    const seen = server.requests.filter((r) => r.host === "vidola-a.localhost");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.cookie === undefined)).toBe(true);
    expect(await inSiteView(m, "vidola", `return localStorage.length;`)).toBe(0);
    expect(await inSiteView(m, "vidola", `return indexedDB.databases().then((d) => d.length);`)).toBe(0);
    expect(await cookies("vidola")).toEqual([]);
  });

  it("after a host restart the open app stays Ouverte, its home keeps getting memory changes, and Supprimer still closes it", async () => {
    const { dataDir } = await launch({ prepare: (d) => (writeSite(d, "vidola", vidola()), writeMemory(d)) });
    await click(m, '[data-testid="site-vidola-ouvrir"]');
    await expect.poll(() => series("vidola").catch(() => null), { timeout: 15_000 }).toContain("The Bear");
    await isOpen("vidola", true);
    // « Réessayer »: the host stops, then starts again on the same data.
    await inStore(`await store.agent.stop(); await store.agent.ensure();`);
    await isOpen("vidola", true);
    expect(await windows("vidola")).toBe(1);
    // The home's memory feed is back: forgetting what the app kept reaches the open home.
    await click(m, '[data-testid="site-vidola-oublier"]');
    await click(m, '[data-testid="confirmer-oubli-site"]');
    await expect.poll(() => series("vidola"), { timeout: 15_000 }).toBe("");
    expect(existsSync(memory(dataDir))).toBe(false);
    await click(m, '[data-testid="site-vidola-supprimer"]');
    await click(m, '[data-testid="confirmer-suppression-site"]');
    await gone("vidola");
    await waitFor(m, `return ${siteExpr("vidola")} === undefined;`, (v) => v === true);
    expect(await windows("vidola")).toBe(0);
  });
});

describe("the agent's site tools", () => {
  async function withAgent(prepare: (dataDir: string) => void = (d) => writeSite(d, "vidola", vidola())) {
    const l = await launch({ prepare, page: false });
    const config = path.join(l.dataDir, "espace", ".webaios", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await sleep(100)) if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
    await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
    return l;
  }

  it("lister_sites and ouvrir_site", async () => {
    const { dataDir } = await withAgent();
    await expect.poll(async () => (await callTool(dataDir, "lister_sites")).text, { timeout: 15_000 }).toBe("vidola · Vidola · vidola-a.localhost · fermée");
    expect(await callTool(dataDir, "ouvrir_site", { id: "vidola" })).toEqual({ text: "site:vidola", error: false });
    await waitFor(m, `return ${siteExpr("vidola")} !== undefined;`, (v) => v === true);
    expect((await callTool(dataDir, "lister_sites")).text).toBe("vidola · Vidola · vidola-a.localhost · ouverte");
    expect(await callTool(dataDir, "ouvrir_site", { id: "inconnu" })).toEqual({ text: SITE_UNKNOWN, error: true });
  });

  // Plan 32 Task 5 brought the app's « donnees-widget » card (before it, no card and an immediate refusal). Refused, the
  // memory is not given (sites.spec.ts:1792); the accorded path is sites-agent.e2e.ts's port of :1799.
  it("memoire_site shows the app's card; Refuser answers SITE_DENIED (sites.spec.ts:1792)", async () => {
    const { dataDir } = await withAgent((d) => (writeSite(d, "vidola", vidola()), writeMemory(d)));
    await expect.poll(async () => (await callTool(dataDir, "lister_sites")).text, { timeout: 15_000 }).toContain("vidola");
    const memory = callTool(dataDir, "memoire_site", { id: "vidola" });
    const card = '[data-testid="demande-donnees-widget"]';
    expect(await waitUi<string>(m, `return doc.querySelector(${JSON.stringify(`${card} [data-testid="demande-site"]`)})?.textContent`, [], 15_000)).toContain("« Vidola »");
    await click(m, `${card} button`, { text: "Refuser" });
    expect(await memory).toEqual({ text: SITE_DENIED, error: false });
    await waitUi(m, "return !doc.querySelector('[data-testid=\"modale-demande\"]')");
  });
});
