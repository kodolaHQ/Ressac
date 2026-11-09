import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { actionsDataDir, EXECUTION, openAction, runsOnDisk, runStatuses, startActionServers, tid, uiQueries, waitKernel, writePagesAction, writeResult, writeRunnableAction } from "./actions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";
import { writeWidget } from "./workflows";

// Action scenarios across launches, or beside widgets: each test has its
// own data and profile folders, kept between its launches.

let servers: Awaited<ReturnType<typeof startActionServers>>;
let dirs: { dataDir: string; profile: string };
let w: LaunchedWebAiOs | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  servers = await startActionServers();
});
beforeEach(async () => {
  servers.reset();
  dirs = { dataDir: await mkdtemp(path.join(os.tmpdir(), "webaios-data-")), profile: await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-")) };
});
afterEach(async () => {
  await w?.close();
  w = undefined;
  await rm(dirs.dataDir, { recursive: true, force: true });
  await rm(dirs.profile, { recursive: true, force: true });
});
afterAll(() => servers?.close());

/** Launches on the test's folders (kept); `height` tall enough for the home page's widgets. */
async function launch(height?: number): Promise<{ m: Marionette; q: ReturnType<typeof uiQueries> }> {
  w = await launchWebAiOs({
    ...dirs,
    ...(height ? { height } : {}),
    env: { WEBAIOS_OLLAMA_URL: servers.ollama.url, WEBAIOS_KEV_URL: servers.kev.url, WEBAIOS_TEST_LOCAL_ADDRESSES: "1" },
  });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  return { m, q: uiQueries(m) };
}
/** Quits as a user would (the folders stay for the next launch). */
async function quit(m: Marionette): Promise<void> {
  expect(await missingApi(m)).toEqual([]);
  await w!.close();
  w = undefined;
}

const direct = (m: Marionette) => inUi<{ running: { action: string }[]; waiting: { action: string }[] }>(m, "return JSON.parse(JSON.stringify(await ui.webaios.actions.direct()));");

/** Polls `read` until `ok` accepts it; fails with the last value. */
async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await sleep(200);
  }
}
const untilEqual = <T>(read: () => T | Promise<T>, expected: T, ms?: number) => until(read, (v) => JSON.stringify(v) === JSON.stringify(expected), ms);

// actions.spec.ts:1505
it("session restore with an action tab: the last result shows, no run launched", { timeout: 120_000 }, async () => {
  await writeRunnableAction(dirs.dataDir, "annonces", { name: "Annonces", code: "export default async () => ({ titre: 'Nouveau' });" });
  await writeResult(dirs.dataDir, "annonces", EXECUTION, "2026-10-31T08:00:00.000Z", "Résultat gardé");
  const prompts = servers.ollama.prompts.length;
  let { m, q } = await launch();
  await waitKernel(m);
  await openAction(m, "annonces", "Annonces");
  await q.waitText(tid("bloc-titre"), "Résultat gardé", 30_000);
  await quit(m);

  ({ m, q } = await launch());
  await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("page-action")], 30_000);
  await q.waitText(tid("bloc-titre"), "Résultat gardé", 30_000);
  expect(await q.count(tid("avancement-action"))).toBe(0);
  await sleep(1000);
  expect(await runsOnDisk(dirs.dataDir, "annonces")).toEqual([`${EXECUTION}.json`]);
  expect(await direct(m)).toEqual({ running: [], waiting: [] });
  expect(servers.ollama.prompts.length).toBe(prompts);
});

/**
 * A widget display that shows the data it gets (JSON) and its status (actions.spec.ts:1529), without an
 * `e.source !== parent` check: inside Firefox's sandboxed resource:// frame it is always true (plan 27, AGENTS.md).
 */
const WIDGET_DISPLAY = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span>
<script>
  addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "widget") return;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
    document.getElementById("statut").textContent = e.data.etat.statut;
  });
</script>`;
const widgetsDir = (id: string) => path.join(dirs.dataDir, "widgets", id);
/** The `#donnees` text of the widget's display (opaque origin: read from the chrome context). */
const shown = (m: Marionette, id: string) =>
  inUi<string>(m, `return doc.querySelector('[data-testid="widget-' + arguments[0] + '"] iframe')?.contentDocument?.getElementById("donnees")?.textContent ?? "";`, [id]);
/** « Mettre à jour maintenant » from the widget's menu. */
async function harvest(m: Marionette, id: string): Promise<void> {
  await click(m, `[data-testid="widget-${id}"] button[aria-label="Options du widget"]`);
  await click(m, '[role="menuitem"]', { text: "Mettre à jour maintenant" });
}
/** The widget's finished runs, oldest first. */
const widgetRuns = (id: string) => {
  const dir = path.join(widgetsDir(id), "executions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { status: string; owner: unknown });
};

// actions.spec.ts:1558
it("the Gmail widget (account, recolte.mjs) and a watch update as before while an action runs", { timeout: 150_000 }, async () => {
  servers.settings.siteSlownessMs = 8000;
  const site = servers.site.url;
  // An account, a harvest written by hand (recolte.mjs), no workflow.
  await writeWidget(dirs.dataDir, "gmail", {
    name: "Gmail",
    harvest: { minutes: 60 },
    declaration: { sources: { account: ["127.0.0.1"], public: [] }, config: { url: `${site}/court` } },
    files: {
      "recolte.mjs": "export default async (webaios) => ({ titre: (await webaios.lirePage(webaios.config.url, { compte: true })).titre });",
      "exemple.json": JSON.stringify({ example: "gmail" }),
      "affichage.html": WIDGET_DISPLAY,
    },
  });
  // A watch: the list, what is new, one opinion of Gemma per ad, shown as they come.
  await writeWidget(dirs.dataDir, "veille", {
    name: "Veille vélos",
    harvest: { hours: ["07:00"], maxDurationMinutes: 30 },
    workflow: {
      version: 1,
      blocks: [
        { id: "recherche", type: "source.page", params: { url: `${site}/veille` } },
        { id: "annonces", type: "code", params: { source: "annonces.mjs" } },
        { id: "nouvelles", type: "liste.nouveaux", params: { key: "url" } },
        { id: "avis", type: "ia.rediger", params: { perItem: true, field: "avis", prompt: "Avis sur l'annonce : --- DÉBUT --- {titre} --- FIN ---" } },
        { id: "sortie", type: "sortie", params: { to: "widget", live: true } },
      ],
      links: [
        { from: "recherche", to: "annonces" },
        { from: "annonces", to: "nouvelles" },
        { from: "nouvelles", to: "avis" },
        { from: "avis", to: "sortie" },
      ],
    },
    files: {
      "annonces.mjs": "export default async (page) => page.liens.filter((l) => l.url.includes('/annonce/')).map((l) => ({ titre: l.texte, url: l.url }));",
      "exemple.json": "[]",
      "affichage.html": WIDGET_DISPLAY,
    },
  });
  // « Up to date, hour of the day done »: the watch does not harvest by itself.
  const now = new Date().toISOString();
  await writeFile(path.join(widgetsDir("veille"), "etat.json"), JSON.stringify({ status: "ok", lastUpdate: now, lastAttempt: now, hours: { done: "9999-12-31T23:59", failures: null } }));
  await writeFile(path.join(dirs.dataDir, "widgets", "accords.json"), JSON.stringify({ gmail: { domains: ["127.0.0.1"], public: [], profile: "defaut" } }));
  await writePagesAction(dirs.dataDir, site);
  const { m } = await launch(1400);
  await untilEqual(() => shown(m, "gmail"), '{"exemple":"gmail"}');
  await waitKernel(m);
  await inUi(m, "void ui.webaios.actions.lancer('pages', null);");
  const running = async () => (await direct(m)).running.map((c) => c.action);
  await untilEqual(running, ["pages"]);

  await harvest(m, "gmail");
  await harvest(m, "veille");
  await untilEqual(() => shown(m, "gmail"), '{"titre":"Court"}');
  await untilEqual(() => widgetRuns("veille").map((e) => e.status), ["reussie"]);
  const watch = JSON.parse((await shown(m, "veille")) || "null") as { title: string; notice: string }[];
  expect(watch.map((a) => [a.title, a.notice])).toEqual([
    ["Vélo de course", "Bonne affaire."],
    ["Vélo pliant", "Bonne affaire."],
  ]);
  // The action was still running during both updates.
  expect(await running()).toEqual(["pages"]);
  // The widgets' runs stayed a widget's.
  expect(widgetRuns("gmail").map((e) => e.status)).toEqual(["reussie"]);
  for (const id of ["gmail", "veille"]) expect(widgetRuns(id)[0]!.owner).toEqual({ type: "widget", id });
  expect(JSON.parse(readFileSync(path.join(widgetsDir("gmail"), "etat.json"), "utf8")).statut).toBe("ok");
  await untilEqual(() => runStatuses(dirs.dataDir, "pages"), ["reussie"], 60_000);
});

// actions.spec.ts:1635
it("quitting during an action: after relaunch its run is « interrompue » in previous results", { timeout: 120_000 }, async () => {
  servers.settings.siteSlownessMs = 6000;
  await writePagesAction(dirs.dataDir, servers.site.url);
  let { m, q } = await launch();
  await waitKernel(m);
  await openAction(m, "pages", "Pages");
  await click(m, tid("relancer-action"));
  await q.waitContains(tid("avancement-action"), "Lecture de 127.0.0.1…", 30_000);
  await quit(m);
  // The run is written « interrompue » on the stop; no result is kept for it.
  expect(await runStatuses(dirs.dataDir, "pages")).toEqual(["interrompue"]);
  const [execution] = (await runsOnDisk(dirs.dataDir, "pages")).map((f) => f.replace(/\.json$/, ""));
  expect(existsSync(path.join(actionsDataDir(dirs.dataDir), "pages", "resultats", `${execution}.json`))).toBe(false);

  servers.settings.siteSlownessMs = 0;
  ({ m, q } = await launch());
  // The action's tab is restored: it shows the interrupted run, without launching it again.
  await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("page-action")], 30_000);
  await click(m, tid("resultats-precedents"));
  await q.waitContains(tid(`resultat-${execution}`), "interrompue", 30_000);
  await sleep(500);
  expect(await runStatuses(dirs.dataDir, "pages")).toEqual(["interrompue"]);
});
