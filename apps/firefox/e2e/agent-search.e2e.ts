import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/results.html?q=%s` } });
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
  const id = idOf((await callTool(w.dataDir, "search_web", { query: "x" })).text);
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openTab", windowId, url: `${server.url}/lien.html` });
  const before = (await state(m)).windows[0]!;
  const active = before.active[before.activeSpace];
  expect(active).not.toBe(id);
  expect((await callTool(w.dataDir, "navigate", { id, url: "https://ailleurs.example/" })).text).toContain("Adresse non lue");
  await callTool(w.dataDir, "navigate", { id, url: `${server.url}/b.html?q=x` });
  await titleOf(`${server.url}/b.html?q=x`);
  const after = await state(m);
  expect(after.tabs[id]!.url).toBe(`${server.url}/b.html?q=x`);
  expect(after.windows[0]!.active[after.windows[0]!.activeSpace]).toBe(active);
});

it("a second search_web returns the second page, never the first", async () => {
  const first = (await callTool(w.dataDir, "search_web", { query: "alpha" })).text;
  expect(first).toContain("Requête : alpha");
  const second = (await callTool(w.dataDir, "search_web", { query: "beta" })).text;
  expect(idOf(second)).toBe(idOf(first));
  expect(second).toContain("Requête : beta");
  expect(second).toContain("/a.html?q=beta");
  expect(second).not.toContain("alpha");
});

it("late results are returned", async () => {
  await w.close();
  w = await launchWebAiOs({ env: { WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/results-late.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  const r = (await callTool(w.dataDir, "search_web", { query: "x" })).text;
  expect(r).toContain(`Lien — ${server.url}/lien.html`);
});
