import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 51 Task 2: the Extensions page explains how the agent's extensions work.

const PAGE = '[data-testid="page-extensions"]';
const HELP = '[data-testid="extensions-help"]';
const SHOTS = join(import.meta.dirname, "../../../.superpowers/sdd/2026-11-11-ressac-plan-51-extensions-explications/shots");
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };

let w: LaunchedRessac | undefined;
let m: Marionette;
const temp = mkdtempSync(join(os.tmpdir(), "ressac-ext-explained-"));
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const text = (selector: string) => inUi<string>(m, "return (doc.querySelector(arguments[0])?.textContent ?? '').replace(/\\s+/g, ' ')", [selector]);
const has = (selector: string) => inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [selector]);
const seen = async () => (await state(m)).settings.hints.seen;
async function openExtensions(): Promise<void> {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "ressac://extensions", activate: true });
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
}

describe("the Extensions page explains itself", () => {
  it("shows the three steps, no store field, vous; Fermer sticks across a reload; the link brings it back", { timeout: 90_000 }, async () => {
    w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_TEST_KEYCHAIN: join(temp, "keychain") }, prefs: NO_WEB, firstTimeNotes: true });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await openExtensions();
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [HELP]);
    const help = await text(HELP);
    for (const wanted of [
      "Comment ça marche",
      "Branchez votre compte Mozilla",
      "Demandez à l'agent",
      "écris-moi une extension qui",
      "quelques minutes",
      "votre accord pour l'installer",
      "Gérez-la ici",
      "La signature envoie le code de l'extension à Mozilla ; elle n'est pas publiée sur le catalogue public.",
    ]) expect(help).toContain(wanted);
    expect(await has('[data-testid="extensions-connect"]')).toBe(true);
    expect(await has('[data-testid="store-add"]')).toBe(false);
    await waitUi(m, "return doc.querySelector(arguments[0]).textContent.includes('Aucune extension.')", [PAGE]);
    expect(await text(PAGE)).toContain("Aucune extension. Demandez à l'agent d'en écrire une, ou installez-en depuis addons.mozilla.org.");
    expect(await text(PAGE)).not.toMatch(/\b(tu|ton|tes|Ajoute)\b/);
    if (process.env.RESSAC_E2E_SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await new Promise((r) => setTimeout(r, 800)); // the entrance spring
      const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
      writeFileSync(join(SHOTS, "extensions-explained.png"), Buffer.from(png, "base64"));
    }

    // The button opens Réglages on the Agents section, on the Mozilla card.
    await click(m, '[data-testid="extensions-connect"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="mozilla-account"]']);
    await openExtensions();

    await click(m, '[data-testid="extensions-help-close"]');
    await waitUi(m, "return !doc.querySelector(arguments[0])", [HELP]);
    expect(await seen()).toContain("extensions");
    // The page remounts (and the state is what the session keeps): the block stays closed.
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="settings-page"]']);
    await openExtensions();
    expect(await has(HELP)).toBe(false);
    await click(m, '[data-testid="extensions-help-link"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [HELP]);
    expect(await seen()).toContain("extensions");
  });

  it("step 1 reads « Compte branché » once the account is saved", { timeout: 90_000 }, async () => {
    w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_TEST_KEYCHAIN: join(temp, "keychain2") }, prefs: NO_WEB, firstTimeNotes: true });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await openExtensions();
    await click(m, '[data-testid="extensions-connect"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="mozilla-account"]']);
    for (const [id, value] of [["mozilla-issuer-input", "user:1:2"], ["mozilla-secret-input", "e2e-secret"]])
      await inUi(m, "const f = doc.querySelector(`[data-testid=${arguments[0]}]`); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true }));", [id, value]);
    await click(m, '[data-testid="mozilla-save"]');
    await waitUi(m, "return doc.querySelector('[data-testid=mozilla-state]')?.textContent === 'Compte branché'");
    await openExtensions();
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [HELP]);
    await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('Compte branché')", [HELP]);
    expect(await has('[data-testid="extensions-connect"]')).toBe(false);
  });
});
