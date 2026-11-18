import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 51 Task 1: the Mozilla account in Settings › Agent.

const PAGE = '[data-testid="settings-page"]';
const CARD = '[data-testid="mozilla-account"]';
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const SHOTS = join(import.meta.dirname, "../../../.superpowers/sdd/2026-11-11-ressac-plan-51-extensions-explications/shots");
const SECRET = "e2e-mozilla-secret";
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };

let w: LaunchedRessac | undefined;
let m: Marionette;
const temp = mkdtempSync(join(os.tmpdir(), "ressac-mozilla-"));
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const inCard = (id: string) => `${CARD} [data-testid="${id}"]`;
const shows = (selector: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [selector, wanted], ms);
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true }));", [inCard(id), value]);
function filesWith(dir: string, text: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    const s = statSync(f, { throwIfNoEntry: false });
    if (s?.isDirectory()) found.push(...filesWith(f, text));
    else if (s?.isFile() && readFileSync(f).includes(text)) found.push(f);
  }
  return found;
}

describe("Mozilla account in Settings", () => {
  it("not connected, connect, never shows the secret, remove; the link opens the keys page", { timeout: 90_000 }, async () => {
    const keyFile = join(temp, "keychain");
    w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_TEST_KEYCHAIN: keyFile }, prefs: NO_WEB });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
    await click(m, '[data-testid="settings-nav-agent"]');
    await shows(CARD, "Compte Mozilla (extensions de l'agent)");
    await shows(CARD, "Non branché");
    await shows(CARD, "Connectez-vous ou créez un compte, acceptez l'accord développeur, puis générez des identifiants.");

    await click(m, inCard("mozilla-link"));
    await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`, (st) => Object.values(st.tabs).some((t) => t.url === "https://addons.mozilla.org/developers/addon/api/key/"));
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
    await click(m, '[data-testid="settings-nav-agent"]');

    await fill("mozilla-issuer-input", "user:12345:678");
    await fill("mozilla-secret-input", SECRET);
    await click(m, inCard("mozilla-save"));
    await shows(CARD, "Compte branché");
    await shows(CARD, "user:12345:678");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).textContent", [CARD])).not.toContain(SECRET);
    expect(readFileSync(`${keyFile}.amo`, "utf8")).toBe(`user:12345:678:${SECRET}`);
    // The secret reaches no file of the profile or the data folder (the stand-in keychain apart).
    expect(filesWith(w.dataDir, SECRET)).toEqual([]);
    if (process.env.RESSAC_E2E_SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await inUi(m, "doc.querySelector(arguments[0]).scrollIntoView({ block: 'center' })", [CARD]);
      const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
      writeFileSync(join(SHOTS, "mozilla-account.png"), Buffer.from(png, "base64"));
    }

    await click(m, inCard("mozilla-delete"));
    await shows(CARD, "Non branché");
    expect(existsSync(`${keyFile}.amo`)).toBe(false);
  });
});
