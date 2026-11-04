import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFakeAmo } from "../test/fake-amo";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";

/** Writes `<dataDir>/extensions/etat.json` (WebAiOs's registry) with a grant on `agent:<id>`, before a launch. */
export function grant(dataDir: string, id: string, accord: unknown, profils: string[] = ["defaut"]): void {
  mkdirSync(path.join(dataDir, "extensions"), { recursive: true });
  const entree = { source: "agent", idChrome: null, nom: id, version: "1.0.0", accord, profils, epinglee: false, modifieeLe: null, desactivee: null, majEnAttente: null, vues: {} };
  writeFileSync(path.join(dataDir, "extensions", "etat.json"), JSON.stringify({ version: 1, toutesCoupees: false, extensions: { [`agent:${id}`]: entree } }));
}

export type FakeAmo = Awaited<ReturnType<typeof startFakeAmo>>;

/** A fake AMO, then WebAiOs launched against it (fake keys), in the chrome context with its first window ready. close() stops both. */
export async function launchWithAmo(o: { amo?: Parameters<typeof startFakeAmo>[0]; dataDir: string; profile: string }): Promise<LaunchedWebAiOs & { amo: FakeAmo }> {
  const amo = await startFakeAmo(o.amo);
  let w: LaunchedWebAiOs;
  try {
    w = await launchWebAiOs({ dataDir: o.dataDir, profile: o.profile, env: { WEBAIOS_TEST_AMO_URL: amo.url, WEBAIOS_TEST_AMO_CLES: "user:1:abc:test-secret" } });
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
