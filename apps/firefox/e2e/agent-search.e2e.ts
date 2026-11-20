import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, waitUi, agentPanelReady } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
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
      // A results page whose link goes through an engine redirect on another origin (DuckDuckGo's /l/?uddg=).
      "/results-l.html": (_req, res) => {
        const target = encodeURIComponent(`${server.url}/a.html`);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<title>Résultats</title><a href="${server.url.replace("127.0.0.1", "localhost")}/l/?uddg=${target}">Annonce</a>`);
      },
      "/l/": (_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<title>…</title><script>setTimeout(() => location.replace(new URLSearchParams(location.search).get("uddg")), 300)</script>`);
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
  w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${server.url}/results.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  // The kernel is up once its MCP config is written.
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // Opening the agent panel starts the window's session, which takes back every access.
  await agentPanelReady(m);
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

it("search_web opens an agent tab on the engine, in the background, in the agent's profile and section, and returns the links", async () => {
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
  expect(win.active[win.activeSpace]).not.toBe(tab.id);
  // Listed apart, in the « Agent » section, not among the user's tabs.
  await waitUi(m, `return !!doc.querySelector('[aria-label="Onglets de l\\'agent"] [data-testid="tab-${tab.id}"]')`);
  expect(await inUi(m, `return doc.querySelector('[data-testid="agent-tabs"]').textContent`)).toBe("Agent1");
  // A result followed by its number in the list.
  expect((await callTool(w.dataDir, "navigate", { id: tab.id, link: 0 })).text).toBe(`Onglet ${tab.id} → ${server.url}/a.html?q=${encodeURIComponent("vélo électrique")}`);
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
  // « Pourquoi on me demande ça ? » opens the explanation, closed by default.
  const WHY = `doc.querySelector('${CARD} .why')`;
  expect(await inUi(m, `return getComputedStyle(${WHY}).visibility`)).toBe("hidden");
  await click(m, '[data-testid="address-request-why"]');
  await waitUi(m, `const e = ${WHY}; return getComputedStyle(e).opacity === "1" && e.getBoundingClientRect().height > 30 && e.textContent.includes("page piégée")`);
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
  w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${server.url}/results-late.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // Opening the agent panel starts the agent's session, which resets the searches: the agent searches only once it is ready.
  await agentPanelReady(m);
  const r = (await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text;
  expect(r).toContain(`Lien — ${server.url}/lien.html`);
});

it("the engine redirecting to another origin: search_web, then read_tab right after a redirect link, read the landed page", async () => {
  await w.close();
  const local = server.url.replace("127.0.0.1", "localhost");
  w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${local}/redirige?vers=${server.url}/results-l.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // Opening the agent panel starts the agent's session, which resets the searches: the agent searches only once it is ready.
  await agentPanelReady(m);
  const r = (await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text;
  expect(r).not.toContain("changé de site");
  const link = `${local}/l/?uddg=${encodeURIComponent(`${server.url}/a.html`)}`;
  expect(r).toContain(`Annonce — ${link}`);
  const id = idOf(r);
  await callTool(w.dataDir, "navigate", { id, url: link });
  const read = (await callTool(w.dataDir, "read_tab", { id, links: true })).text;
  expect(read).not.toContain("changé de site");
  expect(read).toContain("Page A");
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
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
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
const halo = () => m.execute<boolean>(`return document.documentElement.hasAttribute("ressac-agent-working")`);
const otherTab = async () => {
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lien.html` });
};

it("during a read the band shows on the search tab only, with Arrêter", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await dispatch(m, { type: "activateTab", id });
  const reading = callTool(w.dataDir, "read_pages", { urls: [`${server.url}/lent-longtemps.html`], reason: "lire" });
  await click(m, `${CARD} button`, { text: "Autoriser" });
  const b = (await waitBand((v) => v.state === "working" && v.text.startsWith("Lecture")))!;
  expect(b).toMatchObject({ shown: true, label: "Recherche de l'agent", buttons: ["Arrêter"] });
  expect(b.text).toBe("Lecture de 1 page, 0 faite");
  await waitFor(m, `return document.documentElement.hasAttribute("ressac-agent-working")`, (v) => v === true);
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

it("hand_over: the tab comes to the front, the band says the reason, the tab is marked « à vous » while another tab is active, the halo is off; the user navigates in the tab, Continuer returns the path", async () => {
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await otherTab();
  const handing = callTool(w.dataDir, "hand_over", { id, reason: "Résolvez le captcha", kind: "verification" });
  for (const deadline = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 100))) {
    const win = (await state(m)).windows[0]!;
    if (win.active[win.activeSpace] === id) break;
    if (Date.now() > deadline) throw new Error("the search tab did not come to the front");
  }
  await otherTab();
  await waitUi(m, `return !!doc.querySelector('[data-testid="tab-yours"]')`);
  expect(await halo()).toBe(false);
  expect((await band())!.shown).toBe(false);
  await dispatch(m, { type: "activateTab", id });
  const b = (await waitBand((v) => v.shown && v.state === "yours"))!;
  expect(b.text).toBe("Bloqué par une vérification. À vous : Résolvez le captcha");
  expect(b.buttons).toEqual(["Continuer", "Arrêter"]);
  expect(await halo()).toBe(false);
  const next = `${server.url}/b.html?q=user`;
  await m.execute(`const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]); t.linkedBrowser.fixupAndLoadURIString(arguments[1], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [id, next]);
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
  await dispatch(m, { type: "activateTab", id });
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
  w = await launchRessac({ prefs: { "ui.prefersReducedMotion": 0 }, env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${server.url}/results.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // Every transition started in the window. Not frames: a hidden window under load paints a few frames a second,
  // which misses a 150 ms fade and catches the page's inset frozen mid-way.
  await m.execute(`window.__runs = []; window.addEventListener("transitionrun", (e) => window.__runs.push((e.target === document.documentElement ? "root" : e.target.id) + " " + e.propertyName), true);`);
  const runs = () => m.execute<string[]>(`return window.__runs.splice(0);`);
  const moved = ["ressac-search-band opacity", "root --ressac-search-band"];
  // Opening the agent panel starts the agent's session, which resets the searches: the agent searches only once it is ready.
  await agentPanelReady(m);
  await runs();
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x", goal: "but" })).text);
  await dispatch(m, { type: "activateTab", id });
  await waitBand((v) => v.shown);
  // In: the page goes down to the band's room on a transition, the band fades in.
  const inset = `const room = parseFloat(document.documentElement.style.getPropertyValue("--ressac-search-band"));
    return { room, inset: document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top - 8 };`;
  await waitFor<{ room: number; inset: number }>(m, inset, (v) => v.room > 0 && Math.abs(v.inset - v.room) < 0.5);
  expect(await runs()).toEqual(expect.arrayContaining(moved));
  // Out: it comes back on a transition, the band fades out.
  await otherTab();
  await waitBand((v) => !v.shown);
  await waitFor<{ room: number; inset: number }>(m, inset, (v) => v.room === 0 && v.inset === 0);
  expect(await runs()).toEqual(expect.arrayContaining(moved));
  await dispatch(m, { type: "activateTab", id });
});
