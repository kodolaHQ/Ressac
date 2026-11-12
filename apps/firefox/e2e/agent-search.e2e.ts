import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
/** No decision model (nothing listens there): the watcher lets every action pass, whatever model runs on this machine. */
const NO_WATCHER = { WEBAIOS_KEV_URL: "http://127.0.0.1:9" };
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/lent-longtemps.html": (_req, res) => {
        setTimeout(() => {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end("<title>Longue</title><p>Texte très tardif</p>");
        }, 5000);
      },
      "/lent.html": (_req, res) => {
        setTimeout(() => {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end("<title>Lente</title><p>Texte tardif</p>");
        }, 1500);
      },
    },
  });
});
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { ...NO_WATCHER, WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/results.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  // The kernel is up once its MCP config is written.
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // The home page's panel starts the agent's session, which takes back every access.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
});
afterEach(() => w?.close());

const titleOf = (url: string) =>
  waitFor<string>(m, `const t = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument); return t ? t.linkedBrowser.contentTitle : ""`, (v) => v !== "");

it("a tab in the agent's profile does not see the cookies of the user's tabs", async () => {
  const windowId = (await state(m)).windows[0]!.id;
  // The server sets the cookie as the user's tab loads /cookie; /lire-cookie shows what a tab sends.
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/cookie` });
  await titleOf(`${server.url}/cookie`);
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lire-cookie?user` });
  expect(await titleOf(`${server.url}/lire-cookie?user`)).toBe("essai=1");
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lire-cookie?agent`, profile: "agent" });
  expect(await titleOf(`${server.url}/lire-cookie?agent`)).toBe("aucun");
});

const idOf = (text: string) => /Onglet : (\S+)/.exec(text)![1]!;

it("search_web opens an agent tab on the engine, active, in the agent's profile, and returns the links", async () => {
  const r = (await callTool(w.dataDir, "search_web", { query: "vélo électrique", goal: "trouver un vélo" })).text;
  expect(r).toContain("Résultats de la recherche.");
  expect(r).toContain(`Annonce — ${server.url}/a.html?q=${encodeURIComponent("vélo électrique")}`);
  expect(r).toContain(`Autre — ${server.url}/b.html?q=${encodeURIComponent("vélo électrique")}`);
  const s = await state(m);
  const tab = s.tabs[idOf(r)]!;
  expect(tab.profile).toBe("agent");
  expect(tab.openedByAgent).toBe(true);
  expect(tab.url).toBe(`${server.url}/results.html?q=${encodeURIComponent("vélo électrique")}`);
  const win = s.windows[0]!;
  expect(win.active[win.activeSpace]).toBe(tab.id);
});

it("a search_web navigate follows a result in the same tab without activating it again", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lien.html` });
  const before = (await state(m)).windows[0]!;
  const active = before.active[before.activeSpace];
  expect(active).not.toBe(id);
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/b.html?q=x` });
  await titleOf(`${server.url}/b.html?q=x`);
  const after = await state(m);
  expect(after.tabs[id]!.url).toBe(`${server.url}/b.html?q=x`);
  expect(after.windows[0]!.active[after.windows[0]!.activeSpace]).toBe(active);
  // A fragment the agent adds is dropped (the page's script would read it): the address read opens, quickly.
  const t = Date.now();
  expect((await callTool(w.dataDir, "navigate", { id, url: `${server.url}/b.html?q=x#d=secret` })).text).toBe(`Onglet ${id} → ${server.url}/b.html?q=x`);
  expect(Date.now() - t).toBeLessThan(5000);
  expect((await state(m)).tabs[id]!.url).toBe(`${server.url}/b.html?q=x`);
});

const CARD = '[data-testid="address-request"]';

it("a composed address shows the card with the full address; Autoriser loads it, Refuser does not", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  // An address not read in this search (the engine's own origin is not free either).
  const before = (await state(m)).tabs[id]!.url;
  const composed = `${server.url.replace("127.0.0.1", "localhost")}/b.html?composed=${"y".repeat(150)}`;
  const refusing = callTool(w.dataDir, "navigate", { id, url: composed, reason: "pour voir" });
  const card = await waitUi<string>(m, `return doc.querySelector(${JSON.stringify(CARD)})?.textContent`);
  expect(card).toContain("L'agent veut ouvrir une adresse qu'il a écrite lui-même");
  expect(card).toContain(composed);
  expect(card).toContain("Sa raison : pour voir");
  await click(m, `${CARD} button`, { text: "Refuser" });
  expect((await refusing).text).toBe("Accès refusé par l'utilisateur à cet onglet.");
  expect((await state(m)).tabs[id]!.url).toBe(before);
  const allowing = callTool(w.dataDir, "navigate", { id, url: composed, reason: "pour voir" });
  await waitUi(m, `return !!doc.querySelector(${JSON.stringify(CARD)})`);
  await click(m, `${CARD} button`, { text: "Autoriser" });
  expect((await allowing).text).toBe(`Onglet ${id} → ${composed}`);
  expect((await state(m)).tabs[id]!.url).toBe(composed);
});

it("a second search_web returns the second page, never the first", async () => {
  const first = (await callTool(w.dataDir, "search_web", { query: "alpha", goal: "but" })).text;
  expect(first).toContain("Requête : alpha");
  const second = (await callTool(w.dataDir, "search_web", { query: "beta", goal: "but" })).text;
  expect(idOf(second)).toBe(idOf(first));
  expect(second).toContain("Requête : beta");
  expect(second).toContain("/a.html?q=beta");
  expect(second).not.toContain("alpha");
});

it("late results are returned", async () => {
  await w.close();
  w = await launchWebAiOs({ env: { ...NO_WATCHER, WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/results-late.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  const r = (await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text;
  expect(r).toContain(`Lien — ${server.url}/lien.html`);
});

it("read_pages returns both pages and leaves no extra tab", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const before = Object.keys((await state(m)).tabs).sort();
  const a = `${server.url}/a.html?q=x`;
  const b = `${server.url}/b.html?q=x`;
  const r = (await callTool(w.dataDir, "read_pages", { urls: [a, b] })).text;
  expect(r).toContain(`## ${a}\nTitre :`);
  expect(r).toContain(`## ${b}\nTitre :`);
  expect(r).not.toContain("Erreur");
  const after = await state(m);
  expect(Object.keys(after.tabs).sort()).toEqual(before);
  expect(after.tabs[id]!.url).toBe(`${server.url}/results.html?q=x`);
});

it("read_pages waits for a slow background page to load before reading it (readText ensures the tab)", async () => {
  await callTool(w.dataDir, "search_web", { query: "x", goal: "but" });
  const slow = `${server.url}/lent.html`;
  // Not a link read: its card first.
  const t = Date.now();
  const reading = callTool(w.dataDir, "read_pages", { urls: [slow], reason: "lire" });
  await click(m, `${CARD} button`, { text: "Autoriser" });
  const r = (await reading).text;
  expect(r).toContain("Texte tardif");
  expect(Date.now() - t).toBeGreaterThan(1000);
});

it("a target=_blank link in the search tab opens a tab in the agent's profile", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/a.html?q=x` });
  await titleOf(`${server.url}/a.html?q=x`);
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: "#lien" });
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: found.value, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.setContext("chrome");
  }
  for (const deadline = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 100))) {
    const t = Object.values((await state(m)).tabs).find((x) => x.url === `${server.url}/b.html`);
    if (t) {
      expect(t.profile).toBe("agent");
      break;
    }
    if (Date.now() > deadline) throw new Error("the link's tab did not open");
  }
});

// --- the band, « à vous » and hand_over ---

const BAND = '[data-testid="search-band"]';
/** The band as the window shows it (chrome context). */
const READ = `const b = document.querySelector('${BAND}'); if (!b) return null;
  return { shown: b.hasAttribute("data-shown"), state: b.dataset.state, text: b.querySelector('[data-testid="search-band-text"]').textContent, stats: b.querySelector("small").textContent, hasB: !!b.querySelector("b"), buttons: [...b.querySelectorAll("button")].filter((x) => !x.hidden).map((x) => x.textContent), label: b.getAttribute("aria-label") };`;
type Band = { shown: boolean; state: string; text: string; stats: string; hasB: boolean; buttons: string[]; label: string | null };
const band = () => m.execute<Band | null>(READ);
const waitBand = async (ok: (b: Band) => boolean) => (await waitFor<Band | null>(m, READ, (v) => !!v && ok(v)))!;
const press = (testid: string) => m.execute(`document.querySelector('${BAND} [data-testid="${testid}"]').click();`);
const halo = () => m.execute<boolean>(`return document.documentElement.hasAttribute("webaios-agent-working")`);
const otherTab = async () => {
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lien.html` });
};

it("during a read the band shows on the search tab only, with Arrêter", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const reading = callTool(w.dataDir, "read_pages", { urls: [`${server.url}/lent-longtemps.html`], reason: "lire" });
  await click(m, `${CARD} button`, { text: "Autoriser" });
  const b = (await waitBand((v) => v.state === "working" && v.text.startsWith("Lecture")))!;
  expect(b).toMatchObject({ shown: true, label: "Recherche de l'agent", buttons: ["Arrêter"] });
  expect(b.text).toBe("Lecture de 1 page, 0 faite");
  await waitFor(m, `return document.documentElement.hasAttribute("webaios-agent-working")`, (v) => v === true);
  expect(b.stats).toMatch(/^\d+ pages? lues? · \d+ s$/);
  // Another tab shown: the band is not (the search goes on).
  await otherTab();
  await waitBand((v) => !v.shown);
  await dispatch(m, { type: "activateTab", id });
  await waitBand((v) => v.shown);
  await press("search-stop");
  expect((await reading).text).toContain("L'utilisateur a arrêté la recherche");
  await waitBand((v) => !v.shown);
});

it("hand_over: the band says the reason, the tab is marked « à vous » while another tab is active, the halo is off; the user navigates in the tab, Continuer returns the path", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await otherTab();
  const handing = callTool(w.dataDir, "hand_over", { id, reason: "Résolvez le captcha", kind: "verification" });
  await waitUi(m, `return !!doc.querySelector('[data-testid="tab-yours"]')`);
  expect(await halo()).toBe(false);
  expect((await band())!.shown).toBe(false);
  await dispatch(m, { type: "activateTab", id });
  const b = (await waitBand((v) => v.shown && v.state === "yours"))!;
  expect(b.text).toBe("Bloqué par une vérification. À vous : Résolvez le captcha");
  expect(b.buttons).toEqual(["Continuer", "Arrêter"]);
  expect(await halo()).toBe(false);
  const next = `${server.url}/b.html?q=user`;
  await m.execute(`const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]); t.linkedBrowser.fixupAndLoadURIString(arguments[1], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [id, next]);
  await titleOf(next);
  await press("search-continue");
  const r = (await handing).text;
  expect(r).toContain("La page est de nouveau à toi : relis-la.");
  expect(r).toContain(`Chemin suivi par l'utilisateur :\n${next}`);
  await waitBand((v) => v.state !== "yours");
  await waitUi(m, `return !doc.querySelector('[data-testid="tab-yours"]')`);
});

it("Arrêter during a hand-over ends it and removes the band", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const handing = callTool(w.dataDir, "hand_over", { id, reason: "Aidez-moi", kind: "lost" });
  await waitBand((v) => v.state === "yours");
  expect((await band())!.text).toBe("Je ne trouve pas mon chemin. À vous : Aidez-moi");
  await press("search-stop");
  expect((await handing).text).toContain("L'utilisateur a arrêté la recherche");
  await waitBand((v) => !v.shown);
  expect((await state(m)).tabs[id]!.agentSearch).toBeUndefined();
});

it("a reason with <b> and 5,000 characters shows as text, cut", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const handing = callTool(w.dataDir, "hand_over", { id, reason: `<b>gras</b>${"z".repeat(5000)}`, kind: "verification" });
  const b = (await waitBand((v) => v.state === "yours"))!;
  expect(b.hasB).toBe(false);
  expect(b.text.startsWith("Bloqué par une vérification. À vous : <b>gras</b>zzz")).toBe(true);
  expect(b.text.length).toBe("Bloqué par une vérification. À vous : ".length + 200);
  // The sentence wraps, whole, and the page moves down by the band's full height.
  const fit = `const b = document.querySelector('${BAND}'), w = b.querySelector(".what"), h = b.getBoundingClientRect().height;
    return { whole: w.scrollWidth <= w.clientWidth, lines: w.getBoundingClientRect().height / parseFloat(getComputedStyle(w).lineHeight), gap: document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top - 8 - (h + 8) };`;
  const shape = (await waitFor<{ whole: boolean; lines: number; gap: number }>(m, fit, (v) => Math.abs(v.gap) < 1))!;
  expect(shape.whole).toBe(true);
  expect(shape.lines).toBeGreaterThan(1.5);
  await press("search-stop");
  await handing;
});

it("closing the search tab during a hand-over answers the tool", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  const handing = callTool(w.dataDir, "hand_over", { id, reason: "Aidez-moi", kind: "lost" });
  await waitBand((v) => v.state === "yours");
  await dispatch(m, { type: "closeTab", id });
  expect((await handing).text).toBe("Onglet fermé par l'utilisateur : la recherche est finie.");
});

it("hand_over is refused on a tab that is not the search tab", async () => {
  await callTool(w.dataDir, "search_web", { query: "x", goal: "but" });
  await otherTab();
  const other = Object.values((await state(m)).tabs).find((t) => t.url.endsWith("/lien.html"))!.id;
  expect((await callTool(w.dataDir, "hand_over", { id: other, reason: "x", kind: "lost" })).text).toBe("hand_over ne vaut que pour l'onglet de recherche en cours.");
});

it("the band enters and leaves with a transition", async () => {
  await w.close();
  w = await launchWebAiOs({ prefs: { "ui.prefersReducedMotion": 0 }, env: { ...NO_WATCHER, WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/results.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // Samples of the band's opacity and the page's top inset at every frame, from before the band exists.
  await m.execute(`window.__samples = []; window.__sampling = true;
    const tick = () => { const b = document.querySelector('${BAND}'); window.__samples.push({ o: b ? +getComputedStyle(b).opacity : 0, inset: document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top - 8 }); if (window.__sampling) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);`);
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await waitBand((v) => v.shown);
  // Settled: the inset no longer moves.
  const inset = () => m.execute<number>(`return document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top - 8`);
  let settled = -1;
  for (let before = -2; settled < 0; await new Promise((r) => setTimeout(r, 300))) {
    const now = await inset();
    if (now > 0 && now === before) settled = now;
    before = now;
  }
  await otherTab();
  await waitBand((v) => !v.shown);
  await waitFor(m, `return document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top - 8`, (v) => v === 0);
  expect(await inset()).toBe(0);
  const samples = await m.execute<{ o: number; inset: number }[]>(`window.__sampling = false; return window.__samples;`);
  const lastFull = samples.findLastIndex((x) => x.inset >= settled - 0.5);
  const firstFull = samples.findIndex((x) => x.inset >= settled - 0.5);
  const mid = (xs: typeof samples) => xs.some((x) => x.inset > 0.5 && x.inset < settled - 0.5);
  // In: the page goes down by steps (not at once) and the band fades in; out: it comes back by steps.
  expect(mid(samples.slice(0, firstFull))).toBe(true);
  expect(samples.slice(0, firstFull).some((x) => x.o > 0.02 && x.o < 0.98)).toBe(true);
  expect(mid(samples.slice(lastFull))).toBe(true);
  expect(samples.slice(lastFull).some((x) => x.o > 0.02 && x.o < 0.98)).toBe(true);
  await dispatch(m, { type: "activateTab", id });
});
