import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeAmo } from "../test/fake-amo";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";

/** Writes `<dataDir>/extensions/state.json` (Ressac's registry) with a grant on `agent:<id>`, before a launch. */
export function grant(dataDir: string, id: string, grant: unknown, profiles: string[] = ["default"]): void {
  mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
  const entry = { source: "agent", addonId: null, name: id, version: "1.0.0", grant: grant, profiles: profiles, pinned: false, modifiedAt: null, disabled: null, pendingUpdate: null, seenVersions: {} };
  writeFileSync(path.join(dataDir, "extensions", "state.json"), JSON.stringify({ version: 1, allCut: false, extensions: { [`agent:${id}`]: entry } }));
}

export type FakeAmo = Awaited<ReturnType<typeof startFakeAmo>>;

const BUILT = path.resolve(import.meta.dirname, "../src/browser/base/content/ressac");

/**
 * The extension, site, design and vim actors as `pnpm ui` built them, without their preprocessor line, in a folder of the profile:
 * the store loads them by a resource:// substitution, which the content sandbox reads with the testing_read_path1 pref
 * (spike S5). So these tests need no rebuild of the app.
 */
export function testActor(profile: string): { env: Record<string, string>; prefs: Record<string, string> } {
  // RESSAC_E2E_PACKAGED_ACTOR=1: use the actors packaged by build:ui instead (checked once after each build:ui).
  if (process.env.RESSAC_E2E_PACKAGED_ACTOR === "1") return { env: {}, prefs: {} };
  const dir = path.join(realpathSync(profile), "extension-actor");
  mkdirSync(dir, { recursive: true });
  // Every actor module chrome/store/index.ts loads through actorModule: one missing fails to load in this setup only.
  for (const name of ["extension-actor", "site-actor", "design-actor", "vim-actor", "frame-actor", "fill-actor", "hide-actor", "call-actor"])
    writeFileSync(path.join(dir, `${name}.sys.mjs`), readFileSync(path.join(BUILT, `${name}.sys.mjs`), "utf8").replace(/^#define .*\n/, ""));
  return { env: { RESSAC_TEST_EXTENSION_ACTOR: dir }, prefs: { "security.sandbox.content.mac.testing_read_path1": dir } };
}

/**
 * A fake AMO, then Ressac launched against it (fake keys), in the chrome context with its first window ready. close() stops both.
 * The agent in `mode` (Atelier by default: its extensions run only there, masking Task 15).
 */
export async function launchWithAmo(o: { amo?: Parameters<typeof startFakeAmo>[0]; dataDir: string; profile: string; prefs?: Record<string, string | number | boolean>; env?: Record<string, string>; mode?: "browser" | "workshop" }): Promise<LaunchedRessac & { amo: FakeAmo }> {
  const amo = await startFakeAmo(o.amo);
  let w: LaunchedRessac;
  try {
    const actor = testActor(o.profile);
    w = await launchRessac({
      dataDir: o.dataDir,
      profile: o.profile,
      env: { RESSAC_TEST_AMO_URL: amo.url, RESSAC_TEST_AMO_KEYS: "user:1:abc:test-secret", ...actor.env, ...o.env },
      prefs: { ...actor.prefs, ...o.prefs },
    });
  } catch (e) {
    await amo.close();
    throw e;
  }
  await w.marionette.setContext("chrome");
  await waitFor(w.marionette, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await dispatch(w.marionette, { type: "chooseAgentMode", mode: o.mode ?? "workshop" });
  return { ...w, amo, close: () => w.close().finally(() => amo.close()) };
}

/** The agent's add-ons installed in Firefox (chrome context). */
export const agentAddons = (m: Marionette) =>
  m.execute<{ id: string; version: string; isActive: boolean }[]>(`return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonsByTypes(["extension"])).filter((a) => a.id.endsWith("@agent.ressac")).map((a) => ({ id: a.id, version: a.version, isActive: a.isActive }));
  })();`);

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

/** Opens `url` in a Ressac tab, waits until it is loaded; returns the tab id. */
export async function openTab(m: Marionette, url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument && gBrowser.selectedBrowser.currentURI.spec !== 'about:blank'", (v) => v === true);
  return Object.keys(s.tabs).find((id) => !before.has(id))!;
}

/** Runs `script` in the content page of Ressac tab `id`, then comes back to the chrome context. */
export async function inPage<T>(m: Marionette, id: string, script: string): Promise<T> {
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
