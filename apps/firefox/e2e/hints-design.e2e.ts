import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTab, testActor } from "./actors";
import { startDesignServers } from "./design";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, pressKeys, waitUi } from "./ui";

// Plan 47 Task 4: the one-time note of design mode. The demo is 127.0.0.1:15340, in this file's block 15340-15344.

const NOTE = '[data-testid="first-time-design"]';
let demo: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedRessac;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  demo = await startDesignServers({ port: 15340 });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  w = await launchRessac({ dataDir, profile, env: { ...a.env, RESSAC_APP_PORTS: "15340-15344" }, prefs: a.prefs, firstTimeNotes: true });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await demo?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("design first time", () => {
  it("shows once when the mode starts; Compris; never again", async () => {
    await openTab(m, `${demo.page}/`);
    await waitUi(m, "const b = doc.querySelector('[data-testid=\"design-button\"]'); return !!b && !b.disabled;");
    await click(m, '[data-testid="design-button"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [NOTE], 20_000);
    await click(m, '[data-testid="first-time-ok"]');
    await waitUi(m, "return !doc.querySelector(arguments[0])", [NOTE]);
    // The mode goes off and on: no note.
    await pressKeys(m, "Meta+Shift+d");
    await pressKeys(m, "Meta+Shift+d");
    await waitUi(m, "return doc.querySelector('[data-testid=\"design-button\"]').getAttribute('aria-pressed') === 'true'");
    expect(await waitUi(m, "return !doc.querySelector(arguments[0])", [NOTE])).toBe(true);
  });
});
