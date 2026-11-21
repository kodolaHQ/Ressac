import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blocker, cleanupXpis, hider, installAddon, installed, uninstallAddon } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
// Add-on scenarios: a blocker, a hider, onInstalled.

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(async () => {
  await server?.close();
  await cleanupXpis();
});

const ready = (m: Marionette) =>
  waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);

/** Opens `path` in a Ressac tab, waits until it is loaded; returns the tab id. */
async function open(m: Marionette, path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: server.url + path });
  await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument && gBrowser.selectedBrowser.currentURI.spec !== 'about:blank'", (v) => v === true);
  return Object.keys(s.tabs).find((id) => !before.has(id))!;
}

/** Runs `script` in the content page of Ressac tab `id`, then comes back to the chrome context. */
async function inPage<T>(m: Marionette, id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<T>(script);
  } finally {
    await m.setContext("chrome");
  }
}

describe("add-ons in pages", () => {
  let w: LaunchedRessac;
  let m: Marionette;
  beforeAll(async () => {
    w = await launchRessac();
    m = w.marionette;
    await m.setContext("chrome");
    await ready(m);
  });
  afterAll(() => w?.close());

  it("a blocker add-on blocks /pub.js on a local page", async () => {
    const id = await installAddon(m, blocker());
    const tab = await open(m, "/pub.html");
    // The rules are live a moment after install: reload until they act.
    const deadline = Date.now() + 10_000;
    while ((await state(m)).tabs[tab]?.title !== "pub bloquée") {
      expect(Date.now()).toBeLessThan(deadline);
      await m.execute("gBrowser.selectedBrowser.reload()");
      await new Promise((r) => setTimeout(r, 700));
    }
    await uninstallAddon(m, id);
    expect(await m.execute<boolean>("return WebExtensionPolicy.getByID(arguments[0]) === null", [id])).toBe(true);
  });

  it("a hider add-on hides #cache-moi", async () => {
    await installAddon(m, hider());
    const tab = await open(m, "/cache.html");
    const display = "return [getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()";
    // The add-on's sheet can land after the load the tab waited for.
    await expect.poll(() => inPage(m, tab, display)).toBe("none,block");
  });
});

describe("runtime.onInstalled", () => {
  it("fires once at install, not at restart", async () => {
    const prefs = { "xpinstall.signatures.required": false, "security.turn_off_all_security_so_that_viruses_can_take_over_this_computer": true };
    const o = { prefs, env: { MOZ_DISABLE_NONLOCAL_CONNECTIONS: "1" } };
    const notes = (what: string) => server.paths.filter((p) => p === `/note/${what}`).length;
    const until = async (read: () => number, n: number) => {
      const deadline = Date.now() + 10_000;
      while (read() < n) {
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    // Kept across the restart, so we own them.
    const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    let w = await launchRessac({ ...o, profile, dataDir });
    try {
      await w.marionette.setContext("chrome");
      await ready(w.marionette);
      await installAddon(w.marionette, installed(server.url), { temporary: false });
      await until(() => notes("started"), 1);
      await until(() => notes("installed-install"), 1);
    } finally {
      await w.close();
    }
    w = await launchRessac({ ...o, profile, dataDir });
    try {
      await until(() => notes("started"), 2);
      await new Promise((r) => setTimeout(r, 1000));
      expect(notes("started")).toBe(2);
      expect(notes("installed-install")).toBe(1);
      expect(server.paths.filter((p) => p.startsWith("/note/installed-") && p !== "/note/installed-install")).toEqual([]);
    } finally {
      await w.close();
      await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
    }
  });
});
