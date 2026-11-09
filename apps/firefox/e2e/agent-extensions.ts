import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeAmo } from "../test/fake-amo";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";

/** Writes `<dataDir>/extensions/etat.json` (WebAiOs's registry) with a grant on `agent:<id>`, before a launch. */
export function grant(dataDir: string, id: string, accord: unknown, profiles: string[] = ["defaut"]): void {
  mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
  const entree = { source: "agent", idChrome: null, nom: id, version: "1.0.0", accord, profils: profiles, epinglee: false, modifieeLe: null, desactivee: null, majEnAttente: null, vues: {} };
  writeFileSync(path.join(dataDir, "extensions", "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`agent:${id}`]: entree } }));
}

export type FakeAmo = Awaited<ReturnType<typeof startFakeAmo>>;

const BUILT = path.resolve(import.meta.dirname, "../src/browser/base/content/webaios");

/**
 * The extension, site and design actors as `pnpm ui` built them, without their preprocessor line, in a folder of the profile:
 * the store loads them by a resource:// substitution, which the content sandbox reads with the testing_read_path1 pref
 * (spike S5). So these tests need no rebuild of the app.
 */
export function testActor(profile: string): { env: Record<string, string>; prefs: Record<string, string> } {
  // WEBAIOS_E2E_PACKAGED_ACTOR=1: use the actors packaged by build:ui instead (checked once after each build:ui).
  if (process.env.WEBAIOS_E2E_PACKAGED_ACTOR === "1") return { env: {}, prefs: {} };
  const dir = path.join(realpathSync(profile), "extension-actor");
  mkdirSync(dir, { recursive: true });
  for (const name of ["extension-actor", "site-actor", "design-actor"])
    writeFileSync(path.join(dir, `${name}.sys.mjs`), readFileSync(path.join(BUILT, `${name}.sys.mjs`), "utf8").replace(/^#define .*\n/, ""));
  return { env: { WEBAIOS_TEST_EXTENSION_ACTOR: dir }, prefs: { "security.sandbox.content.mac.testing_read_path1": dir } };
}

/** A fake AMO, then WebAiOs launched against it (fake keys), in the chrome context with its first window ready. close() stops both. */
export async function launchWithAmo(o: { amo?: Parameters<typeof startFakeAmo>[0]; dataDir: string; profile: string; prefs?: Record<string, string | number | boolean>; env?: Record<string, string> }): Promise<LaunchedWebAiOs & { amo: FakeAmo }> {
  const amo = await startFakeAmo(o.amo);
  let w: LaunchedWebAiOs;
  try {
    const actor = testActor(o.profile);
    w = await launchWebAiOs({
      dataDir: o.dataDir,
      profile: o.profile,
      env: { WEBAIOS_TEST_AMO_URL: amo.url, WEBAIOS_TEST_AMO_CLES: "user:1:abc:test-secret", ...actor.env, ...o.env },
      prefs: { ...actor.prefs, ...o.prefs },
    });
  } catch (e) {
    await amo.close();
    throw e;
  }
  await w.marionette.setContext("chrome");
  await waitFor(w.marionette, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  return { ...w, amo, close: () => w.close().finally(() => amo.close()) };
}

/** The agent's add-ons installed in Firefox (chrome context). */
export const agentAddons = (m: Marionette) =>
  m.execute<{ id: string; version: string; isActive: boolean }[]>(`return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return (await AddonManager.getAddonsByTypes(["extension"])).filter((a) => a.id.endsWith("@agent.webaios")).map((a) => ({ id: a.id, version: a.version, isActive: a.isActive }));
  })();`);

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

/** Opens `url` in a WebAiOs tab, waits until it is loaded; returns the tab id. */
export async function openTab(m: Marionette, url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
  await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument && gBrowser.selectedBrowser.currentURI.spec !== 'about:blank'", (v) => v === true);
  return Object.keys(s.onglets).find((id) => !before.has(id))!;
}

/** Runs `script` in the content page of WebAiOs tab `id`, then comes back to the chrome context. */
export async function inPage<T>(m: Marionette, id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
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
