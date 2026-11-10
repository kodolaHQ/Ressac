import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { openAction, runsOnDisk, startActionServers, tid, uiQueries, waitKernel, writePagesAction, writeResult, writeRunnableAction } from "./actions";
import { dispatch, state, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// An action page's outcomes: a stopped workshop, empty results, an account
// grant, a private space, a closed tab, a run or an action that no longer exists.

let servers: Awaited<ReturnType<typeof startActionServers>>;
const launched: LaunchedWebAiOs[] = [];

async function launch(env: Record<string, string> = {}) {
  const w = await launchWebAiOs({ env: { WEBAIOS_OLLAMA_URL: servers.ollama.url, WEBAIOS_KEV_URL: servers.kev.url, WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...env } });
  launched.push(w);
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await waitKernel(m);
  return { w, m, q: uiQueries(m) };
}

beforeAll(async () => {
  servers = await startActionServers();
});
beforeEach(() => servers.reset());
afterAll(async () => {
  for (const w of launched) {
    expect(await missingApi(w.marionette)).toEqual([]);
    await w.close();
  }
  await servers?.close();
});

// actions.spec.ts:641
it("workshop stopped (no Docker): « Relancer » shows the error instead of nothing", { timeout: 90_000 }, async () => {
  const { w, m, q } = await launch({ FAKE_DOCKER_ABSENT: "1" });
  await writePagesAction(w.dataDir, servers.site.url);
  await openAction(m, "pages", "Pages");
  await click(m, tid("relaunch-action"));
  await q.waitText(tid("action-error"), "Mise à jour impossible : atelier arrêté", 30_000);
  await q.waitCount(tid("nothing-found"), 0);
  expect(await runsOnDisk(w.dataDir, "pages")).toEqual([]);
});

describe("action results", () => {
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let q: ReturnType<typeof uiQueries>;
  beforeAll(async () => {
    ({ w, m, q } = await launch());
  }, 60_000);

  // actions.spec.ts:663
  it("empty results: « Aucun résultat », no prompt", { timeout: 60_000 }, async () => {
    await writeRunnableAction(w.dataDir, "vide", { name: "Vide", code: "export default async () => ({ tickets: [] });" });
    const prompts = servers.ollama.prompts.length;
    await openAction(m, "vide", "Vide");
    await click(m, tid("relaunch-action"));
    await q.waitText(tid("no-result"), "Aucun résultat", 30_000);
    expect(servers.ollama.prompts.length).toBe(prompts);
    expect(await runsOnDisk(w.dataDir, "vide")).toHaveLength(1);
  });

  // actions.spec.ts:682
  it("an account action without grant: the card, then the run after the grant", { timeout: 60_000 }, async () => {
    await writeRunnableAction(w.dataDir, "courrier", { name: "Courrier", account: ["127.0.0.1"], code: `export default async () => ({ messages: [{ sujet: "Bonjour" }] });` });
    await openAction(m, "courrier", "Courrier");
    const card = tid("grant-card");
    await q.waitText(`${card} :is(h1, h2, h3, h4)`, "Autoriser l'action « Courrier » à lire avec ton compte");
    expect((await q.text(`${card} ${tid("grant-account")}`))?.trim()).toBe("Cette action veut lire 127.0.0.1 avec ton compte, connecté avec le profil choisi.");
    expect(await q.value(`${card} input[type="radio"]:checked`)).toBe("default");
    // Nothing runs until the grant.
    await new Promise((r) => setTimeout(r, 500));
    expect(await runsOnDisk(w.dataDir, "courrier")).toEqual([]);
    await click(m, `${card} button`, { text: "Autoriser" });
    await q.waitCount(card, 0);
    await q.waitContains(tid("page-render"), "Bonjour", 30_000);
    expect(await runsOnDisk(w.dataDir, "courrier")).toHaveLength(1);
  });

  // actions.spec.ts:734
  it("closing the tab while running: the result shows in the previous results", { timeout: 120_000 }, async () => {
    servers.settings.siteSlownessMs = 1500;
    await writePagesAction(w.dataDir, servers.site.url);
    await openAction(m, "pages", "Pages");
    await click(m, tid("relaunch-action"));
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("action-progress")], 30_000);
    // Closing the tab does not stop the run.
    const tab = Object.values((await state(m)).tabs).find((o) => o.url.startsWith("webaios://action/pages"))!;
    await dispatch(m, { type: "closeTab", id: tab.id });
    // The tabs of this file's earlier tests stay open: another action's page may show now, never this one.
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent !== 'Pages';", [tid("action-title")]);
    expect(Object.values((await state(m)).tabs).some((o) => o.url.startsWith("webaios://action/pages"))).toBe(false);
    for (const deadline = Date.now() + 60_000; (await runsOnDisk(w.dataDir, "pages")).length !== 1; ) {
      if (Date.now() > deadline) throw new Error("no run written");
      await new Promise((r) => setTimeout(r, 200));
    }
    const execution = (await runsOnDisk(w.dataDir, "pages"))[0]!.replace(/\.json$/, "");
    await waitUi(m, "return ui.webaios.actions.live().then((d) => d.running.length === 0);", [], 30_000);
    await openAction(m, "pages", "Pages");
    await waitUi(m, "return !!doc.querySelector(arguments[0]);", [tid("page-render")], 30_000);
    await click(m, tid("previous-results"));
    await q.waitContains(tid(`result-${execution}`), "réussie");
  });

  // actions.spec.ts:773
  it("a run that no longer exists: « Ce résultat n'existe plus » and the last result one click away; an unknown action says so", async () => {
    await writeRunnableAction(w.dataDir, "annonces", { name: "Annonces", code: "export default async () => ({});" });
    const LAST = "2026-10-31T08-00-00-000Z";
    await writeResult(w.dataDir, "annonces", LAST, "2026-10-31T08:00:00.000Z", "Dernier");
    const prompts = servers.ollama.prompts.length;
    await openAction(m, "annonces", "Annonces", "2026-10-01T08-00-00-000Z");
    await q.waitContains(tid("result-gone"), "Ce résultat n'existe plus");
    expect(await q.count(tid("page-render"))).toBe(0);
    await click(m, tid("show-latest-result"));
    await q.waitText(tid("block-title"), "Dernier");
    await q.waitCount(tid("result-gone"), 0);
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "webaios://action/inconnue" });
    await q.waitText(tid("action-error"), "Action inconnue");
    expect(servers.ollama.prompts.length).toBe(prompts);
    expect(await runsOnDisk(w.dataDir, "annonces")).toEqual([`${LAST}.json`]);
  });

  // actions.spec.ts:712 (last: it leaves the window's space private)
  it("a webaios://action/x tab in a private space: ACTIONS_IN_PRIVATE_SPACE, nothing launched", async () => {
    await writeRunnableAction(w.dataDir, "x", { name: "X", code: "export default async () => ({ a: 1 });" });
    await writeResult(w.dataDir, "x", "2026-10-31T08-00-00-000Z", "2026-10-31T08:00:00.000Z", "Secret");
    const prompts = servers.ollama.prompts.length;
    const s = await state(m);
    const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
    await dispatch(m, { type: "openTab", windowId: s.windows[0]!.id, url: "webaios://action/x" });
    await q.waitText(tid("action-private-space"), "Les actions ne sont pas disponibles dans un espace privé");
    expect(await q.count(tid("page-action"))).toBe(0);
    expect(await inUi(m, "return doc.body.textContent.includes('Secret');")).toBe(false);
    await new Promise((r) => setTimeout(r, 500));
    expect(await runsOnDisk(w.dataDir, "x")).toEqual(["2026-10-31T08-00-00-000Z.json"]);
    expect(servers.ollama.prompts.length).toBe(prompts);
  });
});
