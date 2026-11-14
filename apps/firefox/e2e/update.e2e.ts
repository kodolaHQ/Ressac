import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inWindow, newWindow, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, waitUi } from "./ui";

// Plan 62 Task 3: the « Ressac x est prête » card and the update status in Réglages › À propos.
// RESSAC_TEST_UPDATE sets the updater's state (the dev app's policy disables the real one).

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function launch(env: Record<string, string> = {}): Promise<void> {
  w = await launchRessac({ env });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const openAbout = async () => {
  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-about"]');
  await waitUi(m, `return !!doc.querySelector('[data-testid="app-version"]')?.textContent.trim()`);
};
const has = (testid: string) => inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="${testid}"]`]);

it("ready: the card in every window, « Plus tard » hides it everywhere; À propos restarts", { timeout: 60_000 }, async () => {
  const reveals = join(mkdtempSync(join(tmpdir(), "ressac-update-")), "reveals.txt");
  await launch({ RESSAC_TEST_UPDATE: "ready:0.1.5", RESSAC_TEST_REVEAL: reveals });
  await waitUi(m, `return doc.querySelector('[data-testid="update-card"]')?.textContent.includes("Ressac 0.1.5 est prête")`);
  const other = await newWindow(m);
  await inWindow(m, other, () => waitUi(m, `return !!doc.querySelector('[data-testid="update-card"]')`));
  await click(m, '[data-testid="update-later"]');
  await waitUi(m, `return !doc.querySelector('[data-testid="update-card"]')`);
  await inWindow(m, other, () => waitUi(m, `return !doc.querySelector('[data-testid="update-card"]')`));

  await openAbout();
  await waitUi(m, `return doc.querySelector('[data-testid="update-status"]')?.textContent.trim() === "0.1.5 prête, installée au redémarrage"`);
  await click(m, '[data-testid="settings-about"] [data-testid="update-restart"]');
  await waitFor(m, "return true", () => {
    try {
      return readFileSync(reveals, "utf8").includes("restart");
    } catch {
      return false;
    }
  });
});

it("failed: no card, À propos offers the latest version's download", async () => {
  await launch({ RESSAC_TEST_UPDATE: "failed:" });
  await openAbout();
  await waitUi(m, `return doc.querySelector('[data-testid="update-status"]')?.textContent.trim() === "La mise à jour a échoué"`);
  expect(await has("update-download")).toBe(true);
  expect(await has("update-card")).toBe(false);
});

it("updater disabled (the dev app's policy): no card, no status", async () => {
  await launch();
  await openAbout();
  expect(await has("update-card")).toBe(false);
  expect(await has("update-status")).toBe(false);
});
