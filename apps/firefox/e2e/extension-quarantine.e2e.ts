import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { click, waitUi } from "./ui";

// Réglages › Confidentialité: Firefox's quarantine keeps every extension off the sensitive sites, on by default. And the
// one-time cleanup of the agent-written extensions (removed in 0.1.27).

const LIST = "extensions.quarantinedDomains.list";
const ENABLED = "extensions.quarantinedDomains.enabled";
/** An entry the user typed in about:config: never Ressac's to remove. */
const MINE = "perso.exemple.test";
const SWITCH = '[data-testid="extension-quarantine"]';
const HAS_OURS = `return Services.prefs.getStringPref(${JSON.stringify(LIST)}, "").split(",").includes("mail.google.com")`;

let w: LaunchedRessac | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const list = (l: LaunchedRessac) => l.marionette.execute<string[]>(`return Services.prefs.getStringPref(${JSON.stringify(LIST)}, "").split(",")`);

it("on by default; off in Réglages removes Ressac's hosts and keeps the user's own; on puts them back", async () => {
  w = await launchRessac({ prefs: { [LIST]: MINE } });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await waitFor(m, HAS_OURS, (v) => v === true, 15_000);
  expect(await list(w)).toContain(MINE);
  expect(await m.execute(`return Services.prefs.getBoolPref(${JSON.stringify(ENABLED)}, false)`)).toBe(true);

  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-privacy"]');
  await waitUi(m, "const s = doc.querySelector(arguments[0]); return !!s && s.checked", [SWITCH]);
  await click(m, SWITCH);
  await waitFor(m, `return Services.prefs.getStringPref(${JSON.stringify(LIST)}, "")`, (v) => v === MINE, 15_000);
  expect(await m.execute(`return Services.prefs.prefHasUserValue(${JSON.stringify(ENABLED)})`)).toBe(false);
  // Off holds: an edit of the list no longer brings Ressac's hosts back (the pref observer runs synchronously on the edit).
  await m.execute(`Services.prefs.setStringPref(${JSON.stringify(LIST)}, ${JSON.stringify(`${MINE},autre.exemple.test`)})`);
  expect(await list(w)).toEqual([MINE, "autre.exemple.test"]);

  await click(m, SWITCH);
  await waitFor(m, HAS_OURS, (v) => v === true, 15_000);
  expect(await list(w)).toEqual(expect.arrayContaining([MINE, "autre.exemple.test"]));
});

it("the first launch removes the agent extensions' leftovers once: registry, workspace sources, Mozilla account, their quarantine exemptions", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ressac-data-"));
  dirs.push(dataDir);
  const keychain = path.join(dataDir, "keychain");
  mkdirSync(path.join(dataDir, "extensions", "signed"), { recursive: true });
  writeFileSync(path.join(dataDir, "extensions", "state.json"), "{}");
  mkdirSync(path.join(dataDir, "workspace", "extensions", "cacheur"), { recursive: true });
  writeFileSync(path.join(dataDir, "workspace", "extensions", "cacheur", "manifest.json"), "{}");
  writeFileSync(`${keychain}.amo`, "user:1:2:secret");
  const agentExemption = "extensions.quarantineIgnoredByUser.cacheur@agent.ressac";
  const userExemption = "extensions.quarantineIgnoredByUser.button@ressac.test";
  w = await launchRessac({ dataDir, env: { RESSAC_TEST_KEYCHAIN: keychain }, prefs: { [agentExemption]: true, [userExemption]: true } });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await expect.poll(() => existsSync(path.join(dataDir, "agent-extensions-removed")), { timeout: 30_000 }).toBe(true);
  expect(existsSync(path.join(dataDir, "extensions"))).toBe(false);
  expect(existsSync(path.join(dataDir, "workspace", "extensions"))).toBe(false);
  expect(existsSync(`${keychain}.amo`)).toBe(false);
  await waitFor(m, `return Services.prefs.getBoolPref("ressac.agentExtensionsRemoved", false)`, (v) => v === true, 15_000);
  expect(await m.execute(`return Services.prefs.prefHasUserValue(${JSON.stringify(agentExemption)})`)).toBe(false);
  expect(await m.execute(`return Services.prefs.getBoolPref(${JSON.stringify(userExemption)}, false)`)).toBe(true);
});
