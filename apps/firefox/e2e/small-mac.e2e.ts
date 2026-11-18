import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, waitUi } from "./ui";

// « Économiser la mémoire », on by default on a small Mac (RESSAC_TEST_SMALL_MAC=1): essentials lazy at launch and unloadable under memory pressure, Firefox's tab
// unloading on, scheduled harvests held back while macOS reports pressure (RESSAC_TEST_PRESSURE_FILE stands for the sysctl).

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let profile: string;
let pressure: string;
let w: LaunchedRessac | undefined;
let m: Marionette;

const widget = async (id: string, harvest: Record<string, unknown>) => {
  const folder = path.join(dataDir, "workspace", "home", "widgets", id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "widget.json"),
    JSON.stringify({ name: id, description: "", sizes: { min: { w: 2, h: 1 }, max: { w: 6, h: 4 }, default: { w: 3, h: 2 } }, sources: { account: [], public: [], web: false }, harvest }),
  );
  await writeFile(path.join(folder, "display.html"), "<p>ok</p>");
  await writeFile(path.join(folder, "harvest.mjs"), `export default async () => [{ n: 1 }];`);
  await mkdir(path.join(dataDir, "widgets", id), { recursive: true });
};
const data = (id: string) => existsSync(path.join(dataDir, "widgets", id, "data.json"));
const relieved = () => {
  const file = path.join(dataDir, "workspace", "fake-machine-calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l === "relieve").length : 0;
};

async function start(): Promise<void> {
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_SMALL_MAC: "1", RESSAC_TEST_PRESSURE_FILE: pressure, RESSAC_TEST_MACHINE: "running", RESSAC_D1_URL: "http://127.0.0.1:9", RESSAC_EMBED_URL: "http://127.0.0.1:9" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await waitFor(m, "return gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}
const win = async () => (await state(m)).windows[0]!;
const open = async (p: string, activate = false) => {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, { type: "openTab", windowId: (await win()).id, url: server.url + p, activate });
  return Object.keys(after.tabs).find((id) => !before.has(id))!;
};
/** The XUL tab of a Ressac tab: its page, whether Firefox unloaded it, whether it may. */
const xul = (id: string) =>
  m.execute<{ url: string; discarded: boolean; undiscardable: boolean } | null>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return t ? { url: t.linkedBrowser.currentURI?.spec ?? "", discarded: !t.linkedBrowser.isConnected, undiscardable: !!t.undiscardable } : null;`,
    [id],
  );

beforeAll(async () => {
  server = await startServer();
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  pressure = path.join(dataDir, "pressure-level");
  await writeFile(pressure, "1");
});
afterAll(async () => {
  await w?.close();
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
});

describe("small Mac", () => {
  let essential: string;
  let other: string;

  it("an essential does not load at launch: unloaded until first shown, then loaded and unloadable", async () => {
    await start();
    const a = await open("/a.html", true);
    await dispatch(m, { type: "addEssential", id: a });
    await open("/b.html", true);
    await w!.close();

    await start();
    const s = await state(m);
    expect(s.settings).toMatchObject({ saveMemory: true, saveMemoryChosen: false, auraMotion: false });
    expect(await m.execute(`return Services.prefs.getIntPref("dom.ipc.processPrelaunch.fission.number")`)).toBe(1);
    const fav = s.essentials[0]!.id;
    essential = Object.values(s.tabs).find((o) => o.link?.id === fav)!.id;
    expect(s.tabs[essential]!.unloaded).toBe(true);
    // No page for it, and its tile shows it unloaded.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await xul(essential)).toBeNull();
    await waitUi(m, `return !!doc.querySelector('[data-testid="favorite-${fav}"].unloaded')`);
    // The agent reads it without showing it (the bridge's path): it loads, and the next syncs keep it.
    const title = await m.execute<string>(`return (async () => {
      const b = await window.ressacWindow.ensure(arguments[0]);
      return b.contentTitle;
    })();`, [essential]);
    expect(title).toBe("Page A");
    await new Promise((r) => setTimeout(r, 1000));
    expect(await xul(essential)).toMatchObject({ url: expect.stringMatching(/\/a\.html$/), discarded: false });
    expect((await state(m)).tabs[essential]!.unloaded).toBeFalsy();
    await waitUi(m, `return !doc.querySelector('[data-testid="favorite-${fav}"].unloaded')`);
    // Shown: it loads, and Firefox may unload it later.
    await click(m, `[data-testid="favorite-${fav}"]`);
    const seen = await waitFor(m, "return true", () => true).then(async () => {
      const end = Date.now() + 10_000;
      let x = await xul(essential);
      while (!x?.url.endsWith("/a.html") && Date.now() < end) x = (await new Promise((r) => setTimeout(r, 100)), await xul(essential));
      return x;
    });
    expect(seen).toEqual({ url: expect.stringMatching(/\/a\.html$/), discarded: false, undiscardable: false });
    expect((await state(m)).tabs[essential]!.unloaded).toBeFalsy();
  });

  it("under a low-memory call Firefox unloads background tabs, essential included, never the blank parking tab; a click reloads them", async () => {
    other = await open("/texte.html", true);
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v.endsWith("/texte.html"));
    await open("/b.html", true);
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v.endsWith("/b.html"));
    expect(await m.execute(`return [Services.prefs.getIntPref("browser.lowMemoryResponseMask"), gBrowser.tabs.find((t) => t.hasAttribute("ressac-parking")).undiscardable]`)).toEqual([3, true]);
    // Marionette turns tab unloading off for its sessions: back on, as in use.
    await m.execute(`Services.prefs.setBoolPref("browser.tabs.unloadOnLowMemory", true);`);
    const relievedBefore = relieved();
    const unload = () =>
      m.execute(`return (async () => {
         const { TabUnloader } = ChromeUtils.importESModule("moz-src:///browser/components/tabbrowser/TabUnloader.sys.mjs");
         return TabUnloader.unloadLeastRecentlyUsedTab(0);
       })();`);
    for (let i = 0; i < 4 && !((await xul(other))?.discarded && (await state(m)).tabs[essential]!.unloaded); i++) await unload();
    expect((await xul(other))?.discarded).toBe(true);
    // The essential shows unloaded (its XUL tab goes); the regular tab stays listed as it was.
    const s = await state(m);
    expect(s.tabs[essential]!.unloaded).toBe(true);
    expect(s.tabs[other]).toMatchObject({ url: expect.stringMatching(/\/texte\.html$/) });
    expect(s.tabs[other]!.unloaded).toBeUndefined();
    // The host relieves memory at the first unload (models, idle machine), without waiting for « memory-pressure ».
    await waitFor(m, "return true", () => relieved() === relievedBefore + 1, 10_000);
    // A click on the tab brings its page back.
    await dispatch(m, { type: "activateTab", id: other });
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v.endsWith("/texte.html"));
    const end = Date.now() + 10_000;
    while ((await xul(other))?.discarded && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    expect(await xul(other)).toMatchObject({ discarded: false, url: expect.stringMatching(/\/texte\.html$/) });
    await dispatch(m, { type: "activateTab", id: essential });
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v.endsWith("/a.html"));
  });

  it("under memory pressure a scheduled harvest waits, « Mettre à jour maintenant » still runs; calm again, it runs at the next check", { timeout: 120_000 }, async () => {
    // The next launch shows the home page, where the widgets are.
    await dispatch(m, { type: "setStartOnHome", enabled: true });
    await w!.close();
    await widget("auto", { minutes: 60 });
    // Fresh: not due, it only runs when asked.
    await widget("manuel", { minutes: 60 });
    const now = new Date().toISOString();
    await writeFile(path.join(dataDir, "widgets", "manuel", "state.json"), JSON.stringify({ status: "ok", lastUpdate: now, lastAttempt: now }));
    // Data left by a widget whose folder is gone: the launch check erases it, which shows it ran.
    await mkdir(path.join(dataDir, "widgets", "gone"), { recursive: true });
    await writeFile(path.join(dataDir, "widgets", "gone", "data.json"), "{}");
    await writeFile(pressure, "4");
    await start();
    await waitUi(m, `return !!doc.querySelector('[data-testid="widget-manuel"]')`, [], 15_000);
    await click(m, `[data-testid="widget-manuel"] button[aria-label="Options du widget"]`);
    await click(m, '[role="menuitem"]', { text: "Mettre à jour maintenant" });
    await waitFor(m, "return true", () => data("manuel"), 20_000);
    // The launch check ran (it erased « gone »): the due one is held back, its state untouched.
    await waitFor(m, "return true", () => !existsSync(path.join(dataDir, "widgets", "gone")), 20_000);
    await new Promise((r) => setTimeout(r, 2000));
    expect(data("auto")).toBe(false);
    expect(existsSync(path.join(dataDir, "widgets", "auto", "state.json"))).toBe(false);
    // Calm again: the next check (every minute) runs it.
    await writeFile(pressure, "1");
    await waitFor(m, "return true", () => data("auto"), 75_000);
  });
});

describe("small Mac, essentials kept loaded for notifications", () => {
  // A messaging host stands in for WhatsApp: chat.test (resolved locally), listed by RESSAC_TEST_KEEP_LOADED_HOSTS.
  let dir: string;
  let prof: string;
  let x: LaunchedRessac | undefined;
  let n: Marionette;
  const launch = async () => {
    x = await launchRessac({
      dataDir: dir,
      profile: prof,
      prefs: { "network.dns.localDomains": "chat.test" },
      env: { RESSAC_TEST_SMALL_MAC: "1", RESSAC_TEST_KEEP_LOADED_HOSTS: "chat.test", RESSAC_TEST_MACHINE: "running", RESSAC_D1_URL: "http://127.0.0.1:9", RESSAC_EMBED_URL: "http://127.0.0.1:9" },
    });
    n = x.marionette;
    await n.setContext("chrome");
    await waitReady(n);
  };
  const tabOf = (id: string) =>
    n.execute<{ url: string; undiscardable: boolean } | null>(
      `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]); return t ? { url: t.linkedBrowser.currentURI?.spec ?? "", undiscardable: !!t.undiscardable } : null;`,
      [id],
    );
  const until = async (read: () => Promise<unknown>, ok: (v: any) => boolean) => {
    const end = Date.now() + 10_000;
    let v = await read();
    while (!ok(v) && Date.now() < end) v = (await new Promise((r) => setTimeout(r, 100)), await read());
    return v;
  };
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    prof = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  });
  afterAll(async () => {
    await x?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(prof, { recursive: true, force: true });
  });

  it("a messaging essential loads at launch and stays undiscardable while another waits; its menu flips either live", async () => {
    await launch();
    const windowId = (await state(n)).windows[0]!.id;
    const add = async (url: string) => {
      const before = new Set(Object.keys((await state(n)).tabs));
      const after = await dispatch(n, { type: "openTab", windowId, url, activate: true });
      const id = Object.keys(after.tabs).find((t) => !before.has(t))!;
      await dispatch(n, { type: "addEssential", id });
    };
    await add(`http://chat.test:${server.port}/a.html`);
    await add(server.url + "/b.html");
    await dispatch(n, { type: "openTab", windowId, url: server.url + "/texte.html", activate: true });
    await x!.close();

    await launch();
    const s = await state(n);
    const [chatFav, otherFav] = s.essentials.map((f) => f.id);
    const tabFor = (fav: string) => Object.values(s.tabs).find((o) => o.link?.id === fav)!.id;
    const [chat, other] = [tabFor(chatFav!), tabFor(otherFav!)];
    expect([s.tabs[chat]!.unloaded, s.tabs[other]!.unloaded]).toEqual([undefined, true]);
    expect(await until(() => tabOf(chat), (v) => v?.url.endsWith("/a.html"))).toEqual({ url: expect.stringMatching(/chat\.test:\d+\/a\.html$/), undiscardable: true });
    expect(await tabOf(other)).toBeNull();

    // « Garder chargé (notifications) » on the lazy one: it loads now, kept from Firefox's unloading.
    const toggle = async (fav: string) => {
      await click(n, `[data-testid="favorite-${fav}"]`, { button: 2 });
      await click(n, '[role="menuitemcheckbox"]', { text: "Garder chargé (notifications)" });
    };
    await toggle(otherFav!);
    expect(await until(() => tabOf(other), (v) => v?.url.endsWith("/b.html"))).toEqual({ url: expect.stringMatching(/\/b\.html$/), undiscardable: true });
    expect((await state(n)).essentials.find((f) => f.id === otherFav)!.keepLoaded).toBe(true);
    // Off again (the menu shows it ticked): Firefox may unload it now. Not on chat.test: the menu knows only the real hosts.
    expect(await (async () => (await click(n, `[data-testid="favorite-${otherFav}"]`, { button: 2 }), inUi(n, `return doc.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked")`)))()).toBe("true");
    await click(n, '[role="menuitemcheckbox"]', { text: "Garder chargé (notifications)" });
    expect(await until(() => tabOf(other), (v) => v?.undiscardable === false)).toMatchObject({ undiscardable: false });
    expect((await state(n)).essentials.find((f) => f.id === otherFav)!.keepLoaded).toBe(false);
  });
});
