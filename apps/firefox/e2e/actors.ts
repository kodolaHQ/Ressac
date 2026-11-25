import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dispatch, state, waitFor } from "./firefox";
import type { Marionette } from "./marionette";

const BUILT = path.resolve(import.meta.dirname, "../src/browser/base/content/ressac");

/**
 * The site, design, vim and other actors as `pnpm ui` built them, without their preprocessor line, in a folder of the profile:
 * the store loads them by a resource:// substitution, which the content sandbox reads with the testing_read_path1 pref
 * (spike S5). So these tests need no rebuild of the app.
 */
export function testActor(profile: string): { env: Record<string, string>; prefs: Record<string, string> } {
  // RESSAC_E2E_PACKAGED_ACTOR=1: use the actors packaged by build:ui instead (checked once after each build:ui).
  if (process.env.RESSAC_E2E_PACKAGED_ACTOR === "1") return { env: {}, prefs: {} };
  const dir = path.join(realpathSync(profile), "test-actors");
  mkdirSync(dir, { recursive: true });
  // Every actor module chrome/store/index.ts loads through actorModule: one missing fails to load in this setup only.
  for (const name of ["site-actor", "design-actor", "vim-actor", "frame-actor", "fill-actor", "hide-actor", "call-actor"])
    writeFileSync(path.join(dir, `${name}.sys.mjs`), readFileSync(path.join(BUILT, `${name}.sys.mjs`), "utf8").replace(/^#define .*\n/, ""));
  return { env: { RESSAC_TEST_EXTENSION_ACTOR: dir }, prefs: { "security.sandbox.content.mac.testing_read_path1": dir } };
}

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
