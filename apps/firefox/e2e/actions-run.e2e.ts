import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openAction, runsOnDisk, startActionServers, tid, uiQueries, waitKernel, writeAction, writePagesAction, writeResult, writeRunnableAction } from "./actions";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// Real runs of an action from its page: the fake docker (the engine runs
// on the Mac), a slow local site and a fake Ollama (Gemma) noting each prompt. Reopening a page launches nothing.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
/** The kernel's message for an action without workflow.json (actions/run.ts). */
const WITHOUT_WORKFLOW = "Cette action n'a pas de workflow.json";

let servers: Awaited<ReturnType<typeof startActionServers>>;
let w: LaunchedRessac;
let m: Marionette;
let q: ReturnType<typeof uiQueries>;
const visible = (selector: string, ms = 30_000) => waitUi(m, "const e = doc.querySelector(arguments[0]); return !!e && e.getBoundingClientRect().height > 0;", [selector], ms);
const disabled = (selector: string) => inUi<boolean>(m, "return doc.querySelector(arguments[0]).disabled;", [selector]);

beforeAll(async () => {
  servers = await startActionServers();
  w = await launchRessac({ env: { RESSAC_OLLAMA_URL: servers.ollama.url, RESSAC_KEV_URL: servers.kev.url, RESSAC_TEST_LOCAL_ADDRESSES: "1" } });
  m = w.marionette;
  q = uiQueries(m);
  await m.setContext("chrome");
  await waitReady(m);
  await waitKernel(m);
}, 60_000);
beforeEach(() => servers.reset());
afterAll(async () => {
  expect(await missingApi(m)).toEqual([]);
  await w?.close();
  await servers?.close();
});

describe("action runs", () => {
  // actions.spec.ts:453
  it("while running, « Lecture de 127.0.0.1… », then « 3 / 3 », then « Mise en page… », then the page", { timeout: 90_000 }, async () => {
    servers.settings.siteSlownessMs = 1500;
    servers.settings.gemmaSlownessMs = 2500;
    await writePagesAction(w.dataDir, servers.site.url, "pages-a");
    const prompts = servers.ollama.prompts.length;
    await openAction(m, "pages-a", "Pages");
    // Opening the page launches nothing.
    await q.waitText(tid("nothing-found"), "Pas encore de résultat");
    await q.waitText(tid("action-title"), "Pages");
    await new Promise((r) => setTimeout(r, 500));
    expect(await runsOnDisk(w.dataDir, "pages-a")).toEqual([]);
    await click(m, tid("relaunch-action"));
    const progress = tid("action-progress");
    await q.waitContains(progress, "Lecture de 127.0.0.1…", 30_000);
    // A block that reads no page: the catalogue's label (« Code »), never its id (« liste »).
    await q.waitText(`${progress} ${tid("block-row")} .label`, "Code");
    await q.waitText(`${progress} ${tid("block-counter")}`, "3 / 3", 30_000);
    await q.waitText(`${progress} ${tid("layout")}`, "Mise en page…", 30_000);
    await visible(tid("page-render"));
    await q.waitText(tid("block-title"), "Pages lues");
    expect(await q.text(tid("block-list"))).toContain("Page 2");
    await q.waitCount(progress, 0);
    expect(await q.text(tid("result-time"))).not.toBe("");
    expect(servers.ollama.prompts.length).toBe(prompts + 1);
    expect(await runsOnDisk(w.dataDir, "pages-a")).toHaveLength(1);
  });

  // actions.spec.ts:489
  it("Stop: the page says « Arrêtée à ta demande »", { timeout: 90_000 }, async () => {
    servers.settings.siteSlownessMs = 4000;
    await writePagesAction(w.dataDir, servers.site.url, "pages-b");
    await openAction(m, "pages-b", "Pages");
    await click(m, tid("relaunch-action"));
    await q.waitContains(tid("action-progress"), "Lecture de 127.0.0.1…", 30_000);
    await click(m, tid("stop-action"));
    await q.waitText(tid("action-error"), "Arrêtée à ta demande", 30_000);
    await q.waitCount(tid("action-progress"), 0);
  });

  // actions.spec.ts:509
  it("relaunching while running starts no second run (one run written)", { timeout: 90_000 }, async () => {
    servers.settings.siteSlownessMs = 1500;
    await writePagesAction(w.dataDir, servers.site.url, "pages-c");
    await openAction(m, "pages-c", "Pages");
    await click(m, tid("relaunch-action"));
    await visible(tid("action-progress"));
    // The button is greyed while it runs; one more launch (the agent, another window) gives the same run.
    expect(await disabled(tid("relaunch-action"))).toBe(true);
    // Each lancer resolves at the run's end (15-38 s): started in the page, awaited outside the 30 s script timeout.
    await inUi(m, "ui.__r = null; Promise.all([ui.ressac.actions.launch('pages-c', null), ui.ressac.actions.launch('pages-c', null)]).then((r) => (ui.__r = JSON.parse(JSON.stringify(r))));");
    const [a, b] = await waitUi<{ run?: string }[]>(m, "return ui.__r;", [], 90_000);
    expect(a!.run).toBeTruthy();
    expect(b!.run).toBe(a!.run);
    await visible(tid("page-render"), 90_000);
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false;", [tid("relaunch-action")]);
    expect(await runsOnDisk(w.dataDir, "pages-c")).toHaveLength(1);
  });

  // actions.spec.ts:568
  it("the previous results menu: reopening yesterday's run launches nothing (no extra prompt to the fake Ollama)", async () => {
    await writeRunnableAction(w.dataDir, "annonces", { name: "Annonces", input: "Recherche", code: "export default async () => ({});" });
    const YESTERDAY = "2026-10-30T08-00-00-000Z";
    const TODAY = "2026-10-31T08-00-00-000Z";
    await writeResult(w.dataDir, "annonces", YESTERDAY, "2026-10-30T08:00:00.000Z", "Hier", "clio lyon");
    await writeResult(w.dataDir, "annonces", TODAY, "2026-10-31T08:00:00.000Z", "Aujourd'hui", "208 paris");
    const prompts = servers.ollama.prompts.length;
    await openAction(m, "annonces", "Annonces");
    await q.waitText(tid("block-title"), "Aujourd'hui");
    expect(await q.value(tid("action-input-box"))).toBe("208 paris");
    await click(m, tid("previous-results"));
    const yesterday = tid(`result-${YESTERDAY}`);
    await q.waitContains(yesterday, "clio lyon");
    expect(await q.text(yesterday)).toContain("réussie");
    await click(m, yesterday);
    await q.waitText(tid("block-title"), "Hier");
    await waitUi(m, "return doc.querySelector(arguments[0])?.value === 'clio lyon';", [tid("action-input-box")]);
    await new Promise((r) => setTimeout(r, 500));
    expect(servers.ollama.prompts.length).toBe(prompts);
    expect(await runsOnDisk(w.dataDir, "annonces")).toEqual([`${YESTERDAY}.json`, `${TODAY}.json`]);
  });

  // actions.spec.ts:598
  it("a failed workflow shows its message", { timeout: 60_000 }, async () => {
    await writeRunnableAction(w.dataDir, "cassee", { name: "Cassée", code: `export default async () => { throw new Error("Site indisponible"); };` });
    const prompts = servers.ollama.prompts.length;
    await openAction(m, "cassee", "Cassée");
    await click(m, tid("relaunch-action"));
    await q.waitContains(tid("action-error"), "Site indisponible", 30_000);
    expect(servers.ollama.prompts.length).toBe(prompts);
  });

  // actions.spec.ts:616 (its first half, opening through a suggestion, comes with `ouvrir` in Task 4)
  it("a refused launch with no run written (no workflow.json) shows the error, again after a reload", { timeout: 60_000 }, async () => {
    await writeAction(w.dataDir, "sans-workflow", { name: "Sans workflow" });
    await openAction(m, "sans-workflow", "Sans workflow");
    await click(m, tid("relaunch-action"));
    await q.waitText(tid("action-error"), WITHOUT_WORKFLOW, 30_000);
    await q.waitCount(tid("nothing-found"), 0);
    // Reloaded, the page still shows it (nothing is written on disk).
    await inUi(m, "ui.location.reload();");
    await q.waitText(tid("action-error"), WITHOUT_WORKFLOW, 30_000);
    await click(m, tid("relaunch-action"));
    await q.waitText(tid("action-error"), WITHOUT_WORKFLOW);
    expect(await runsOnDisk(w.dataDir, "sans-workflow")).toEqual([]);
  });

  // Review Focus 5
  it("after a host restart the action page and the feed come back", { timeout: 120_000 }, async () => {
    await writePagesAction(w.dataDir, servers.site.url, "pages-r");
    await writeResult(w.dataDir, "pages-r", "2026-10-31T08-00-00-000Z", "2026-10-31T08:00:00.000Z", "Avant");
    await openAction(m, "pages-r", "Pages");
    await q.waitText(tid("block-title"), "Avant");
    // A run in progress when the host crashes: it goes with the host, and no feed says so.
    servers.settings.siteSlownessMs = 4000;
    await click(m, tid("relaunch-action"));
    await q.waitContains(tid("action-progress"), "Lecture de 127.0.0.1…", 30_000);
    // The host crashes under the open page (killed: no last notification), then starts again (the agent panel's
    // Réessayer, as builder-runs.e2e.ts does).
    process.kill((await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`))!, "SIGKILL");
    await waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (pid) => pid === null);
    // While no host runs, the page keeps its last read (its launch's end, refused, reads it again): the action and the
    // progress stay, no « Action inconnue ».
    await new Promise((r) => setTimeout(r, 1000));
    expect(await q.text(tid("action-title"))).toBe("Pages");
    expect(await q.count(tid("action-progress"))).toBe(1);
    await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.ensure(); })();`);
    // Once the kernel runs again (`acces`), the feed is read again: nothing runs. Only that read clears the progress.
    await q.waitCount(tid("action-progress"), 0, 30_000);
    // The page works again without reopening the tab: a new run shows its progress, then its page.
    servers.settings.siteSlownessMs = 1500;
    await waitUi(m, "return doc.querySelector(arguments[0])?.disabled === false;", [tid("relaunch-action")]);
    await click(m, tid("relaunch-action"));
    await q.waitContains(tid("action-progress"), "Lecture de 127.0.0.1…", 30_000);
    await q.waitText(tid("block-title"), "Pages lues", 30_000);
    await q.waitCount(tid("action-progress"), 0);
  });
});
