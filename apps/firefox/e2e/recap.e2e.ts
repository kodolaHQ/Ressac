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
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { ICON, startServer } from "./server";
import { click, inUi, missingApi, waitUi, agentPanelReady } from "./ui";

// The agent's recap: published with show_recap, drawn as a ressac://recap/<id> tab. A link is clickable only if the
// agent read its address. exemple.invalide resolves to the machine, so an opened link leaves nothing.

const READ = "https://exemple.invalide/velo-1";
const NEVER_READ = "https://exemple.invalide/jamais";
// Photos load through the action images' test hook: https://<host><path> is asked from <server>/<host><path>.
const PHOTO = "https://exemple.invalide/photos/yuba.png";
const PHOTO_NEVER_READ = "https://exemple.invalide/photos/babboe.png";
// A card linking twice (title, then photo), the photo after a data: placeholder.
const TERN = "https://exemple.invalide/velo-2";
const PHOTO_TERN = "https://exemple.invalide/photos/tern.png";
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
// A Leboncoin card: textless links laid over the card and its photo, the name only in a hidden title.
const RIESE = "https://exemple.invalide/velo-3";
const PHOTO_RIESE = "https://exemple.invalide/photos/riese.png";
const RIESE_CARD = `<article style="position:relative;width:500px;height:140px"><div style="position:relative;width:160px;height:120px"><img src="${PHOTO_RIESE}" width="160" height="120" alt=""><a style="position:absolute;inset:0" aria-hidden="true" href="${RIESE}"></a></div><p>Riese & Müller Load 75, 2 900 €</p><a style="position:absolute;inset:0" aria-label="Voir l’annonce" href="${RIESE}"><span aria-hidden="true" style="position:absolute;inset:0;opacity:0" title="Voir l’annonce: Riese & Müller Load 75"></span></a></article>`;
// recherche.invalide: the search page is served by the test server but must not look local, as a real engine's is not
// (a local page's web links never become free to open).
const PREFS = { "network.dns.localDomains": "exemple.invalide,recherche.invalide" };
const searchUrl = () => `${server.url.replace(/\/\/[^:/]+/, "//recherche.invalide")}/annonces.html?q=%s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/annonces.html": (_req, res) => {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<title>Annonces</title><main><h1>Vélos cargo</h1><p>Deux annonces autour de Lyon, lues pour le récap.</p><a href="${READ}"><img src="${PHOTO}" width="160" height="120" alt="">Yuba Spicy Curry</a> <a href="${TERN}">Tern GSD</a><a href="${TERN}"><img src="${PIXEL}" width="160" height="120" alt=""><img src="${PHOTO_TERN}" width="160" height="120" alt=""></a>${RIESE_CARD}</main>`);
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
async function ready(w: LaunchedRessac): Promise<Marionette> {
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await sleep(100)) if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  await agentPanelReady(m);
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
async function publish(w: LaunchedRessac, title: string, id?: string): Promise<string> {
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
  let w: LaunchedRessac;
  let m: Marionette;
  let q: ReturnType<typeof uiQueries>;
  let id: string;
  beforeAll(async () => {
    w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: searchUrl(), RESSAC_TEST_ACTION_IMAGES: server.url }, prefs: PREFS });
    m = await ready(w);
    q = uiQueries(m);
  }, 60_000);
  afterAll(async () => {
    if (m) expect(await missingApi(m)).toEqual([]);
    await w?.close();
  });

  it("a published recap opens as a tab, links read are clickable, others are text", async () => {
    const tab = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "vélo cargo", goal: "lire" })).text)![1]!;
    // The search tab shows the results page (RESSAC_TEST_SEARCH_URL): read it with its links and their photos.
    const read = (await callTool(w.dataDir, "read_tab", { id: tab, links: true })).text;
    expect(read).toContain(`${READ} — photo : ${PHOTO}`);
    expect(read).toContain(`${TERN} — photo : ${PHOTO_TERN}`);
    expect(read).toMatch(/\d+\. Voir l’annonce: Riese & Müller Load 75 — https:\/\/exemple\.invalide\/velo-3 — photo : https:\/\/exemple\.invalide\/photos\/riese\.png/);
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
    // The old version faded out of the shared grid cell: one version left.
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1;", [`${tid("page-recap")} > .version`]);
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

  it("a live recap shows its count and the agent's view; a live update keeps its cards", async () => {
    // The agent acts on a tab: its view exists (it stays 20 s after the last tool).
    const tab = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "vélo cargo", goal: "lire" })).text)![1]!;
    await callTool(w.dataDir, "read_tab", { id: tab });
    const show = async (names: string[], live: boolean, id?: string) => {
      const r = await callTool(w.dataDir, "show_recap", {
        ...(id ? { id } : {}),
        title: "En cours",
        results: { items: names.map((name) => ({ name })) },
        plan: { blocks: [{ component: "title", props: { text: "En cours" } }, { component: "cards", props: { items: "items", title: "name" } }] },
        ...(live ? { live } : {}),
      });
      const found = /Récap (\S+) ouvert/.exec(r.text)?.[1];
      if (!found) throw new Error(`show_recap: ${r.text}`);
      return found;
    };
    const live = await show(["Yuba"], true);
    for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(live); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
    await q.waitText(tid("recap-live"), "en direct · 1 retenue", 15_000);
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("recap-agent-view")]);
    const card = `${tid("block-cards")} .pa-card`;
    // A re-created card would lose this mark.
    await inUi(m, "doc.querySelector(arguments[0]).setAttribute('data-e2e-first', '1');", [card]);

    expect(await show(["Yuba", "Babboe"], true, live)).toBe(live);
    await q.waitText(tid("recap-live"), "en direct · 2 retenues");
    await q.waitCount(card, 2);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('data-e2e-first');", [card])).toBe("1");
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1;", [`${tid("page-recap")} > .version`], 5_000);

    await show(["Yuba", "Babboe"], false, live);
    await waitUi(m, "return !doc.querySelector(arguments[0]) && !doc.querySelector(arguments[1]);", [tid("recap-live"), tid("recap-agent-view")]);
    await q.waitCount(card, 2);
  }, 45_000);
});

describe("recap after a restart", () => {
  it("a recap survives a restart", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
    const profile = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
    let w: LaunchedRessac | undefined;
    try {
      w = await launchRessac({ dataDir, profile, env: { RESSAC_MEMORY_LOOP: "1" }, prefs: PREFS });
      let m = await ready(w);
      const id = await publish(w, "Vélos cargo");
      for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
      await waitUi(m, "return doc.querySelector(arguments[0])?.textContent === 'Vélos cargo';", [tid("block-title")], 15_000);
      await w.close();
      w = undefined;
      expect(existsSync(join(dataDir, "recaps", `${id}.json`))).toBe(true);

      w = await launchRessac({ dataDir, profile, env: { RESSAC_MEMORY_LOOP: "1" }, prefs: PREFS });
      m = w.marionette;
      await m.setContext("chrome");
      await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
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

describe("forgotten recap", () => {
  it("a recap not shown during 7 days of use closes by itself", async () => {
    const w = await launchRessac({ env: { RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_RECAP_DAY_MS: "300", RESSAC_TEST_SEARCH_URL: searchUrl(), RESSAC_TEST_ACTION_IMAGES: server.url }, prefs: PREFS });
    try {
      const m = await ready(w);
      const q = uiQueries(m);
      const tab = /Onglet : (\S+)/.exec((await callTool(w.dataDir, "search_web", { query: "vélo cargo", goal: "lire" })).text)![1]!;
      await callTool(w.dataDir, "read_tab", { id: tab, links: true });
      const id = await publish(w, "Vélos cargo");
      for (const deadline = Date.now() + 10_000; (await activeTab(m))?.url !== urlRecap(id); await sleep(100)) if (Date.now() > deadline) throw new Error("the recap tab is not active");
      await q.waitText(tid("block-title"), "Vélos cargo", 15_000);
      // Another tab comes to the front: the recap is no longer on screen.
      await click(m, `${tid("block-highlight")} button.pa-link`, { text: "Yuba Spicy Curry" });
      const file = join(w.dataDir, "recaps", `${id}.json`);
      for (const deadline = Date.now() + 20_000; existsSync(file); await sleep(200)) if (Date.now() > deadline) throw new Error("the recap file stays");
      expect(await recapTabs(m, id)).toHaveLength(0);
    } finally {
      await w.close();
    }
  }, 90_000);
});
