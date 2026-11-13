import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import {
  actionsDataDir,
  adPhoto,
  chained,
  LAYOUT_PROMPT,
  openAction,
  runsOnDisk,
  runStatuses,
  startActionServers,
  tid,
  uiQueries,
  waitKernel,
  writeAction,
  writePagesAction,
  writeRunnableAction,
} from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Whole scenarios of an action: Gemma's plan, the results' images through
// the test hook (RESSAC_TEST_ACTION_IMAGES: `https://<host><path>` is asked from the local image server, which notes
// each request with its Cookie and Referer). One launch for the file; the actions are written before it.

const SECRET = "jeton-du-compte-4242";

/** `extraire.mjs` of the ads: each ad and its photo (a link of the page), the price as a number (actions.spec.ts:1316). */
const EXTRACT_ADS = `export default async (page) => {
  const photos = new Map();
  for (const l of page.links) {
    const p = /\\/photos\\/(\\d+)\\.jpg$/.exec(l.url);
    if (p) photos.set(p[1], l.url);
  }
  const annonces = [];
  for (const l of page.links) {
    const m = /\\/ad\\/(\\d+)$/.exec(l.url);
    if (!m) continue;
    const [titre, prix, ville] = l.text.split(" – ");
    annonces.push({ titre, prix: Number(prix), ville, url: l.url, ...(photos.has(m[1]) ? { photo: photos.get(m[1]) } : {}) });
  }
  return { annonces };
};
`;

/** `extraire.mjs` of the GitLab tickets (actions.spec.ts:1160). */
const EXTRACT_TICKETS = `export default async (page) => {
  const tickets = [];
  for (const l of page.links) {
    const m = /^#(\\d+) (.+) \\[([\\w-]+)\\] \\(([\\w-]+)\\)$/.exec(l.text.trim());
    if (m) tickets.push({ titre: m[2], projet: m[4], priorite: m[3], url: l.url });
  }
  return { tickets };
};
`;
const TICKETS_LAYOUT = "un chiffre clé, les tickets par priorité, les trois plus urgents en encadré";
const TICKETS = "tickets-gitlab";
/** Gemma's plan for the tickets: a key figure, the most urgent in a box, the table by priority (actions.spec.ts:1193). */
const TICKETS_PLAN = {
  blocks: [
    { component: "figure", props: { value: "count(filter(tickets, priorite = urgent))", label: "Tickets urgents" } },
    { component: "callout", props: { level: "warning", title: "À traiter d'abord", items: "keep(filter(tickets, priorite = urgent), 3)", field: "titre" } },
    {
      component: "table",
      props: { items: "group(tickets, priorite)", columns: [{ field: "titre", label: "Ticket" }, { field: "projet", label: "Projet" }], link: "url" },
    },
  ],
};

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
const layoutPrompts = (from: number) => servers.ollama.prompts.slice(from).filter((p) => p.startsWith(LAYOUT_PROMPT));
/** The statuses of the runs written since `before` (the runs of earlier tests stay on disk). */
const newStatuses = async (id: string, before: number) => (await runStatuses(w.dataDir, id)).slice(before);

/** What the tickets page shows: a figure, the box, one table section per priority (actions.spec.ts:1205). */
async function waitTicketsPage(): Promise<void> {
  const page = tid("page-render");
  await visible(page, 60_000);
  await q.waitText(`${page} ${tid("block-figure")} .value`, "2", 30_000);
  expect(await q.text(`${page} ${tid("block-figure")}`)).toContain("Tickets urgents");
  const box = (await q.text(`${page} ${tid("block-callout")}`)) ?? "";
  for (const t of ["À traiter d'abord", "Connexion impossible", "Fuite mémoire du worker"]) expect(box).toContain(t);
  expect(box).not.toContain("Facture en double");
  const table = `${page} ${tid("block-table")}`;
  expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent.trim());", [`${table} th[scope="rowgroup"]`])).toEqual(["urgent", "normale", "basse"]);
  const second = await inUi<string>(m, "return doc.querySelectorAll(arguments[0])[1]?.textContent ?? '';", [`${table} tbody`]);
  expect(second).toContain("Facture en double");
  expect(second).toContain("Export CSV lent");
  expect(await q.count(`${page} ${tid("fallback-mention")}`)).toBe(0);
}

const tabUrls = async () => Object.values((await state(m)).tabs).map((o) => o.url);

beforeAll(async () => {
  servers = await startActionServers();
  const site = servers.site.url;
  w = await launchRessac({
    env: { RESSAC_OLLAMA_URL: servers.ollama.url, RESSAC_KEV_URL: servers.kev.url, RESSAC_TEST_LOCAL_ADDRESSES: "1", RESSAC_TEST_ACTION_IMAGES: servers.images.url },
  });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitKernel(m);
  const d = w.dataDir;
  await writeAction(d, "annonces-leboncoin", {
    name: "Annonces Leboncoin",
    input: { label: "Recherche" },
    sources: { web: true },
    layout: "des cartes avec le prix et la ville, les moins chères en premier",
    workflow: chained([
      { id: "recherche", type: "source.page", params: { url: `${site}/leboncoin/recherche?text={input}` } },
      { id: "extraire", type: "code", params: { source: "extraire.mjs" } },
      { id: "sortie", type: "output", params: { to: "page" } },
    ]),
    files: { "extraire.mjs": EXTRACT_ADS },
  });
  const leak = `${site}/tiers?d=${SECRET}`;
  await writeRunnableAction(d, "hostile", {
    name: "Hostile",
    account: ["127.0.0.1"],
    code: `export default async () => ({
      compte: { jeton: ${JSON.stringify(SECRET)} },
      tickets: [{ titre: "Connexion impossible", photo: "https://img.exemple.org/avatar.png", fuite: ${JSON.stringify(leak)} }],
    });`,
  });
  // AGENTS.md's « Tickets GitLab »: source.page with the account, then extraire, then the page (actions.spec.ts:1173).
  await writeAction(d, TICKETS, {
    name: "Tickets GitLab",
    keywords: ["gitlab", "tickets"],
    sources: { account: ["127.0.0.1"] },
    layout: TICKETS_LAYOUT,
    workflow: chained([
      { id: "tickets", type: "source.page", params: { url: `${site}/gitlab/tickets`, account: true } },
      { id: "extraire", type: "code", params: { source: "extraire.mjs" } },
      { id: "sortie", type: "output", params: { to: "page" } },
    ]),
    files: { "extraire.mjs": EXTRACT_TICKETS },
  });
  await writeRunnableAction(d, "taches", {
    name: "Tâches",
    code: `export default async () => ({ taches: [{ nom: "Alpha", etat: "ouvert" }, { nom: "Bravo", etat: "fermé" }] });`,
  });
  for (const id of ["un", "deux", "trois"]) await writePagesAction(d, site, id, `Pages ${id}`);
  const grant = { domains: ["127.0.0.1"], public: [], profile: "default" };
  await mkdir(actionsDataDir(d), { recursive: true });
  await writeFile(path.join(actionsDataDir(d), "grants.json"), JSON.stringify({ hostile: grant, [TICKETS]: grant }));
  for (const id of ["annonces-leboncoin", "hostile", TICKETS, "taches", "un", "deux", "trois"]) await waitUi(m, "return (await ui.ressac.actions.list()).some((a) => a.id === arguments[0]);", [id], 30_000);
}, 90_000);
beforeEach(async () => {
  servers.reset();
  for (const id of Object.keys((await state(m)).tabs)) await dispatch(m, { type: "closeTab", id } as Action);
});
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
});

describe("action scenarios", () => {
  // actions.spec.ts:1232
  it("spec success: type « git », validate, see the progress, then a key figure, a table by priority and a « à traiter d'abord » box", { timeout: 120_000 }, async () => {
    servers.settings.siteSlownessMs = 1500;
    servers.settings.plan = TICKETS_PLAN;
    const before = (await runsOnDisk(w.dataDir, TICKETS)).length;
    const from = servers.ollama.prompts.length;
    await click(m, tid("new-tab"));
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("empty-page")]);
    await click(m, tid("empty-page-input"));
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.focus(); f.value = arguments[1]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [tid("empty-page-input"), "git"]);
    await q.waitContains(tid("suggestions-actions"), "Tickets GitLab");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    await q.waitContains(tid("action-progress"), "Lecture de 127.0.0.1…", 30_000);
    await waitTicketsPage();
    await q.waitCount(tid("action-progress"), 0);
    // One layout request: the (bounded) results and the action's instruction, between their marks.
    const prompts = layoutPrompts(from);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Connexion impossible");
    expect(prompts[0]).toContain(`<<<CONSIGNE\n${TICKETS_LAYOUT}\nCONSIGNE>>>`);
    expect(await newStatuses(TICKETS, before)).toEqual(["succeeded"]);
  });

  // actions.spec.ts:1264
  it("the next day, no ticket: « Aucun résultat », no prompt; yesterday's result reopens without relaunching", { timeout: 120_000 }, async () => {
    servers.settings.plan = TICKETS_PLAN;
    const before = await runsOnDisk(w.dataDir, TICKETS);
    await openAction(m, TICKETS, "Tickets GitLab");
    await click(m, tid("relaunch-action"));
    // The page may already show an earlier test's tickets: wait for this run's end on disk.
    for (const deadline = Date.now() + 60_000; JSON.stringify(await newStatuses(TICKETS, before.length)) !== '["succeeded"]'; await sleep(200))
      if (Date.now() > deadline) throw new Error(`no finished run: ${JSON.stringify(await newStatuses(TICKETS, before.length))}`);
    await waitTicketsPage();
    const [yesterday] = (await runsOnDisk(w.dataDir, TICKETS)).filter((f) => !before.includes(f)).map((f) => f.replace(/\.json$/, ""));

    // The next day, no ticket left: the page says so, without asking Gemma anything.
    servers.settings.tickets = [];
    const from = servers.ollama.prompts.length;
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false;", [tid("relaunch-action")]);
    await click(m, tid("relaunch-action"));
    await q.waitText(tid("no-result"), "Aucun résultat", 60_000);
    expect(await runsOnDisk(w.dataDir, TICKETS)).toHaveLength(before.length + 2);
    expect(servers.ollama.prompts.length).toBe(from);

    // Yesterday's result, reopened from the previous results: nothing is launched, Gemma is not called again.
    await click(m, tid("previous-results"));
    await click(m, tid(`result-${yesterday}`));
    await waitTicketsPage();
    await sleep(500);
    expect(servers.ollama.prompts.length).toBe(from);
    expect(await runsOnDisk(w.dataDir, TICKETS)).toHaveLength(before.length + 2);
  });

  // actions.spec.ts:1385
  it("Gemma returns invalid JSON twice: fallback page with « mise en page simple »", { timeout: 90_000 }, async () => {
    servers.settings.plan = "Voici la page : { blocs: [titre";
    const from = servers.ollama.prompts.length;
    await openAction(m, "taches", "Tâches");
    await click(m, tid("relaunch-action"));
    const page = tid("page-render");
    await visible(page, 60_000);
    await q.waitText(`${page} ${tid("fallback-mention")}`, "mise en page simple", 30_000);
    expect(await q.text(page)).toContain("Alpha");
    expect(await q.text(page)).toContain("Bravo");
    // Two attempts, the second with the refusal's reason.
    const prompts = layoutPrompts(from);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("la réponse n'est pas du JSON valide");
    expect(await runStatuses(w.dataDir, "taches")).toEqual(["succeeded"]);
  });

  // actions.spec.ts:1474
  it("three actions launched: the third says « En attente : deux actions tournent déjà », then runs", { timeout: 150_000 }, async () => {
    servers.settings.siteSlownessMs = 3000;
    // The first two, launched as the agent or the Actions page would (without waiting for their end).
    await inUi(m, "void ui.ressac.actions.launch('un', null); void ui.ressac.actions.launch('deux', null);");
    await waitUi(m, "return (await ui.ressac.actions.live()).running.length === 2;", [], 30_000);
    await openAction(m, "trois", "Pages trois");
    await click(m, tid("relaunch-action"));
    await q.waitText(tid("pending"), "En attente : deux actions tournent déjà", 30_000);
    const feed = await inUi<{ running: { action: string }[]; waiting: { action: string }[] }>(m, "return JSON.parse(JSON.stringify(await ui.ressac.actions.live()));");
    expect(feed.waiting.map((a) => a.action)).toEqual(["trois"]);
    expect(feed.running.map((a) => a.action).sort()).toEqual(["deux", "un"]);
    // A slot frees up: the third runs, then shows its page.
    await q.waitCount(tid("pending"), 0, 60_000);
    await visible(tid("page-render"), 60_000);
    await q.waitContains(tid("block-list"), "Page 3", 30_000);
    for (const id of ["un", "deux", "trois"])
      for (const deadline = Date.now() + 60_000; JSON.stringify(await runStatuses(w.dataDir, id)) !== '["succeeded"]'; await sleep(200))
        if (Date.now() > deadline) throw new Error(`${id}: ${JSON.stringify(await runStatuses(w.dataDir, id))}`);
  });

  // actions.spec.ts:1334
  it("Leboncoin « leboncoin clio lyon »: the input reaches the URL read, cards with photos loaded", { timeout: 120_000 }, async () => {
    servers.settings.plan = {
      blocks: [{ component: "cards", props: { items: "sort(annonces, prix)", title: "titre", subtitle: "ville", value: "prix", image: "photo", link: "url" } }],
    };
    // A cookie on the image host (127.0.0.1), set by a tab of the default container: an image load must not send it.
    await m.execute(
      `return (async () => {
        const url = arguments[0] + "/cookie?v=default";
        const tab = gBrowser.addTab(url, { userContextId: 0, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 500));
        gBrowser.removeTab(tab);
      })();`,
      [servers.images.url],
    );
    expect(await m.execute<string[]>(`return Services.cookies.getCookiesFromHost("127.0.0.1", {}).map((c) => c.name + "=" + c.value);`)).toContain("seen=default");
    servers.images.seen.length = 0;
    const since = servers.site.log.length;
    // The empty page: type, ↓, Enter.
    await click(m, tid("new-tab"));
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("empty-page")]);
    await click(m, tid("empty-page-input"));
    await inUi(m, `const f = doc.querySelector(arguments[0]); f.focus(); f.value = arguments[1]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [
      tid("empty-page-input"),
      "leboncoin clio lyon",
    ]);
    await q.waitContains(tid("suggestions-actions"), "Annonces Leboncoin");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await visible(tid("page-action"));
    const cards = tid("block-cards");
    await visible(cards, 60_000);
    // The input, encoded, in the address read; and kept in the header.
    expect(servers.site.log.slice(since)).toContain("/leboncoin/recherche?text=clio%20lyon");
    expect(await q.value(tid("action-input-box"))).toBe("clio lyon");
    // The cheapest first, each with its photo, loaded through the anonymous channel.
    expect(await inUi(m, "return [...doc.querySelectorAll(arguments[0])].map((e) => e.textContent);", [`${cards} .pa-card .title`])).toEqual(["Renault Clio 3", "Renault Clio 4"]);
    await waitUi(
      m,
      "const i = [...doc.querySelectorAll(arguments[0])]; return i.length === 2 && i.every((x) => x.src.startsWith('data:image/') && x.complete && x.naturalWidth === 1);",
      [`${cards} img`],
      15_000,
    );
    expect(await q.count(`${cards} ${tid("neutral-image")}`)).toBe(0);
    const seen = servers.images.seen.filter((s) => s.path !== "/cookie");
    expect(seen.map((s) => `https:/${s.path}`).sort()).toEqual([adPhoto(1), adPhoto(2)]);
    // Neither the default container's cookie nor a referrer went with them.
    expect(seen.map((s) => [s.cookie, s.referer])).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  // actions.spec.ts:1415
  it("hostile plan: no request reaches the server with the data, inert link, neutral image, title as text", { timeout: 90_000 }, async () => {
    const site = servers.site.url;
    const title = `<img src=${site}/tiers?d=titre>Tickets`;
    servers.settings.plan = {
      blocks: [
        { component: "title", props: { text: title } },
        // An address composed by Gemma: a field is only a name, this block is dropped.
        { component: "link", props: { object: "compte", url: `"${site}/tiers?d=" + jeton`, text: "Ouvrir" } },
        // A field holding no address: the link stays text.
        { component: "link", props: { object: "compte", url: "jeton", text: "Voir le jeton" } },
        // A results address to the (local) test server: inert. An action with an account's image: neutral.
        { component: "cards", props: { items: "tickets", title: "titre", image: "photo", link: "fuite" } },
      ],
    };
    const since = servers.site.log.length;
    await dispatch(m, { type: "openAction", windowId: (await state(m)).windows[0]!.id, id: "hostile", name: "Hostile" });
    await visible(tid("page-action"), 10_000);
    await click(m, tid("relaunch-action"));
    const page = tid("page-render");
    await visible(page, 60_000);
    expect(await q.count(`${page} ${tid("fallback-mention")}`)).toBe(0);
    // The title as text, no HTML element.
    await q.waitText(`${page} ${tid("block-title")}`, title);
    expect(await q.count(`${page} img`)).toBe(0);
    // The composed link is dropped; the other is only text; the card has neither link nor image.
    expect(await q.count(`${page} ${tid("block-link")}`)).toBe(1);
    expect(await q.text(`${page} ${tid("block-link")}`)).toBe("Voir le jeton");
    expect(await q.count(`${page} a, ${page} button.pa-link`)).toBe(0);
    const cards = `${page} ${tid("block-cards")}`;
    expect(await q.text(cards)).toContain("Connexion impossible");
    await visible(`${cards} ${tid("neutral-image")}`);
    await click(m, `${cards} *`, { text: "Connexion impossible" });
    await sleep(1000);
    // Nothing left: neither to the test server, nor to the image's address, and no tab opened to the leak.
    expect(servers.site.log.slice(since).filter((c) => c.includes("/tiers") || c.includes(SECRET))).toEqual([]);
    expect(servers.images.seen).toEqual([]);
    expect((await tabUrls()).filter((u) => u.includes("/tiers"))).toEqual([]);
    // Firefox's own tabs too (gBrowser), not only the state's.
    expect(await m.execute<string[]>("return gBrowser.browsers.map((b) => b.currentURI.spec).filter((u) => u.includes('/tiers'));")).toEqual([]);
  });
});
