import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { urlRecap } from "../shared/model";
import { tid, uiQueries } from "./actions";
import { dispatch, state, waitFor } from "./firefox";
import { callTool } from "./mcp";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { ICON, startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// The agent's recap: published with show_recap, drawn as a webaios://recap/<id> tab. A link is clickable only if the
// agent read its address. exemple.invalide resolves to the machine, so an opened link leaves nothing.

const READ = "https://exemple.invalide/velo-1";
const NEVER_READ = "https://exemple.invalide/jamais";
// Photos load through the action images' test hook: https://<host><path> is asked from <server>/<host><path>.
const PHOTO = "https://exemple.invalide/photos/yuba.png";
const PHOTO_NEVER_READ = "https://exemple.invalide/photos/babboe.png";
const PREFS = { "network.dns.localDomains": "exemple.invalide" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/annonces.html": (_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<title>Annonces</title><main><h1>Vélos cargo</h1><p>Deux annonces autour de Lyon, lues pour le récap.</p><a href="${READ}"><img src="${PHOTO}" width="160" height="120" alt="">Yuba Spicy Curry</a> <a href="https://exemple.invalide/velo-2">Tern GSD</a></main>`);
      },
      ...Object.fromEntries(
        [PHOTO, PHOTO_NEVER_READ].map((u) => [
          `/${u.slice("https://".length)}`,
          (_req: IncomingMessage, res: ServerResponse) => {
            res.setHeader("content-type", "image/png");
            res.end(ICON);
          },
        ]),
      ),
    },
  });
});
afterAll(() => server?.close());

/** Waits for the kernel's MCP config and the agent. */
async function ready(w: LaunchedWebAiOs): Promise<Marionette> {
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await sleep(100)) if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  return m;
}

const plan = (title: string) => ({
  blocks: [
    { component: "title", props: { text: title } },
    { component: "highlight", props: { object: "best", label: "Meilleure affaire", title: "name", value: "price", link: "url" } },
    { component: "cards", props: { items: "others", title: "name", value: "price", warnings: "warnings", link: "url" } },
  ],
});
const RESULTS = {
  best: { name: "Yuba Spicy Curry", price: "1 850 €", url: READ },
  others: [{ name: "Babboe Curve", price: "1 400 €", url: NEVER_READ, warnings: ["batterie 70 %"] }],
};
async function publish(w: LaunchedWebAiOs, title: string, id?: string): Promise<string> {
  const r = await callTool(w.dataDir, "show_recap", { ...(id ? { id } : {}), title, results: RESULTS, plan: plan(title) });
  const found = /Récap (\S+) ouvert/.exec(r.text);
  if (!found) throw new Error(`show_recap: ${r.text}`);
  return found[1]!;
}
const activeTab = async (m: Marionette) => {
  const s = await state(m);
  const win = s.windows[0]!;
  return s.tabs[win.active[win.activeSpace]!];
};
const recapTabs = async (m: Marionette, id: string) => Object.values((await state(m)).tabs).filter((t) => t.url === urlRecap(id));

describe("recap tab", () => {
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let q: ReturnType<typeof uiQueries>;
  let id: string;
  beforeAll(async () => {
    w = await launchWebAiOs({ env: { WEBAIOS_MEMORY_LOOP: "1", WEBAIOS_TEST_SEARCH_URL: `${server.url}/annonces.html?q=%s`, WEBAIOS_TEST_ACTION_IMAGES: server.url }, prefs: PREFS });
    m = await ready(w);
    q = uiQueries(m);
  }, 60_000);
  afterAll(async () => {
    if (m) expect(await missingApi(m)).toEqual([]);
    await w?.close();
  });

  it("a published recap opens as a tab, links read are clickable, others are text", async () => {
    const tab = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "vélo cargo", goal: "lire" })).text)![1]!;
    // The search tab shows the results page (WEBAIOS_TEST_SEARCH_URL): read it with its links and their photos.
    const read = (await callTool(w.dataDir, "read_tab", { id: tab, links: true })).text;
    expect(read).toContain(`${READ} — photo : ${PHOTO}`);
    id = await publish(w, "Vélos cargo");
    for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
    expect((await activeTab(m))!.title).toBe("Vélos cargo");
    await q.waitText(tid("block-title"), "Vélos cargo", 15_000);
    expect(await q.text(tid("page-recap"))).toContain("Récap de l'agent");
    expect(await q.text(tid("page-recap"))).toContain("Ce récap disparaît quand tu fermes l'onglet.");
    const highlight = tid("block-highlight");
    expect(await q.text(highlight)).toContain("Meilleure affaire");
    // The card's address was never read: text, not a button.
    expect(await q.text(tid("block-cards"))).toContain("Babboe Curve");
    expect(await q.count(`${tid("block-cards")} button`)).toBe(0);
    expect(await q.text(`${tid("block-cards")} .pa-warning`)).toBe("batterie 70 %");
    // The read one opens a tab.
    await click(m, `${highlight} button.pa-link`, { text: "Yuba Spicy Curry" });
    const urls = async () => Object.values((await state(m)).tabs).map((t) => t.url);
    for (const deadline = Date.now() + 10_000; !(await urls()).includes(READ); await sleep(100)) if (Date.now() > deadline) throw new Error("the link opened no tab");
    expect(await urls()).not.toContain(NEVER_READ);
  }, 60_000);

  it("republishing updates the open tab", async () => {
    // Back on the recap (the link's tab is active).
    const [tab] = await recapTabs(m, id);
    await dispatch(m, { type: "activateTab", id: tab!.id } as Action);
    await q.waitText(tid("block-title"), "Vélos cargo");
    expect(await publish(w, "Vélos cargo, sans les pros", id)).toBe(id);
    await q.waitText(tid("block-title"), "Vélos cargo, sans les pros");
    const tabs = await recapTabs(m, id);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.title).toBe("Vélos cargo, sans les pros");
    expect((await activeTab(m))!.id).toBe(tab!.id);
  }, 30_000);

  it("closing the tab deletes the recap; reopening shows it is gone", async () => {
    const file = join(w.dataDir, "recaps", `${id}.json`);
    expect(existsSync(file)).toBe(true);
    const [tab] = await recapTabs(m, id);
    await dispatch(m, { type: "closeTab", id: tab!.id } as Action);
    for (const deadline = Date.now() + 10_000; existsSync(file); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap file stays");
    await dispatch(m, { type: "reopenClosedTab", windowId: (await state(m)).windows[0]!.id } as Action);
    for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab did not come back");
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("recap-gone")]);
    expect(await q.text(tid("recap-gone"))).toBe("Ce récap a été fermé.");
    expect(await inUi(m, "return !!doc.querySelector(arguments[0]);", [tid("block-title")])).toBe(false);
  }, 30_000);

  it("a photo seen in a read shows, an unseen one is left out", async () => {
    const r = await callTool(w.dataDir, "show_recap", {
      title: "Photos",
      results: { items: [{ name: "Yuba", url: READ, photo: PHOTO }, { name: "Babboe", url: NEVER_READ, photo: PHOTO_NEVER_READ }] },
      plan: { blocks: [{ component: "cards", props: { items: "items", title: "name", link: "url", image: "photo" } }] },
    });
    const photos = /Récap (\S+) ouvert/.exec(r.text)?.[1];
    if (!photos) throw new Error(`show_recap: ${r.text}`);
    for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(photos); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
    const cards = tid("block-cards");
    await q.waitCount(`${cards} img.pa-image`, 1, 15_000);
    expect(await inUi<string>(m, "return doc.querySelector(arguments[0]).src;", [`${cards} img.pa-image`])).toMatch(/^data:image\/png;base64,/);
    // An unseen photo resolves to no image at all (pages/resolve.ts imageOf): no placeholder, never fetched.
    expect(await q.count(`${cards} img`)).toBe(1);
    expect(await q.count(`${cards} ${tid("neutral-image")}`)).toBe(0);
    expect(server.paths).not.toContain(`/${PHOTO_NEVER_READ.slice("https://".length)}`);
  }, 30_000);
});

describe("recap after a restart", () => {
  it("a recap survives a restart", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "webaios-data-"));
    const profile = await mkdtemp(join(os.tmpdir(), "webaios-firefox-"));
    let w: LaunchedWebAiOs | undefined;
    try {
      w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_MEMORY_LOOP: "1" }, prefs: PREFS });
      let m = await ready(w);
      const id = await publish(w, "Vélos cargo");
      for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
      await waitUi(m, "return doc.querySelector(arguments[0])?.textContent === 'Vélos cargo';", [tid("block-title")], 15_000);
      await w.close();
      w = undefined;
      expect(existsSync(join(dataDir, "recaps", `${id}.json`))).toBe(true);

      w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_MEMORY_LOOP: "1" }, prefs: PREFS });
      m = w.marionette;
      await m.setContext("chrome");
      await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
      for (const deadline = Date.now() + 15_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab was not restored");
      await waitUi(m, "return doc.querySelector(arguments[0])?.textContent === 'Vélos cargo';", [tid("block-title")], 20_000);
      expect(await inUi(m, "return !!doc.querySelector(arguments[0]);", [tid("recap-gone")])).toBe(false);
    } finally {
      await w?.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(profile, { recursive: true, force: true });
    }
  }, 120_000);
});
