import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { keyDown, keyUp, pressKeys, typeText, waitUi } from "./ui";

/**
 * A walk through the chrome surfaces that saves a PNG of each, light and dark, in dist/aura-tour/ (to look at, not compared).
 * Later surfaces append their own steps. The only assertion: no capture is blank.
 */
const OUT = path.resolve(import.meta.dirname, "../dist/aura-tour");
const shots: string[] = [];

const page = (title: string, body: string) => (_: unknown, res: import("node:http").ServerResponse) =>
  res
    .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    .end(`<!doctype html><title>${title}</title><body style="font:16px/1.5 system-ui;margin:40px;max-width:640px"><h1>${title}</h1>${body}</body>`);
let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs | undefined;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  server = await startServer({
    routes: {
      "/vols": page("Vols Paris – Lisbonne", "<p>Mer. 12 mars · direct · 124 €</p><p>Ven. 14 mars · direct · 89 €</p><p>Sam. 15 mars · 1 escale · 97 €</p>"),
      "/recette": page("Tarte aux figues", "<p>Une pâte sablée, des figues mûres, un filet de miel.</p>"),
      "/notes": page("Notes de lecture", "<p>Chapitre 3 : la lumière du soir sur la baie.</p>"),
    },
  });
});
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shoot(m: Marionette, name: string): Promise<void> {
  // Let springs and the aura settle.
  await sleep(700);
  const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(png, "base64"));
  shots.push(file);
}

describe("aura tour", () => {
  for (const [theme, dark] of [["sombre", 1], ["clair", 0]] as const) {
    it(`captures the chrome surfaces (${theme})`, async () => {
      w = await launchWebAiOs({ prefs: { "ui.systemUsesDarkTheme": dark } });
      const m = w.marionette;
      await m.setContext("chrome");
      await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
      const windowId = (await state(m)).windows[0]!.id;
      for (const p of ["/notes", "/recette", "/vols"]) await dispatch(m, { type: "openTab", windowId, url: server.url + p });
      await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (u: string) => u.endsWith("/vols"));
      await waitUi(m, "return doc.querySelectorAll('[data-testid^=\"tab-\"][role=\"tab\"]').length === 3");
      await shoot(m, `1-window-${theme}`);

      await pressKeys(m, "Meta+t");
      await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
      await typeText(m, "no");
      await shoot(m, `2-command-${theme}`);
      await pressKeys(m, "Escape");
      await waitUi(m, "return !doc.querySelector('[data-testid=\"command-bar\"]')");

      await m.execute("gBrowser.selectedBrowser.focus()");
      await keyDown(m, "Control");
      await pressKeys(m, "Tab");
      await waitUi(m, "return doc.querySelectorAll('[data-testid=\"tab-card\"]').length === 3");
      await shoot(m, `3-ctrl-tab-${theme}`);
      await pressKeys(m, "Escape");
      await keyUp(m, "Control");
      await waitUi(m, "return !doc.querySelector('[data-testid=\"tabs-panel\"]')");

      await dispatch(m, { type: "toggleCompact", windowId });
      await m.execute(
        `const ratio = window.devicePixelRatio;
         window.windowUtils.sendNativeMouseEvent((window.mozInnerScreenX + 5) * ratio, (window.mozInnerScreenY + 300) * ratio, window.windowUtils.NATIVE_MOUSE_MESSAGE_MOVE, 0, 0, document.documentElement);`,
      );
      await waitUi(m, "return !doc.querySelector('[data-testid=\"sidebar\"]').parentElement.inert");
      await shoot(m, `4-compact-${theme}`);
    });
  }

  it("no capture is blank", () => {
    expect(shots.length).toBeGreaterThan(0);
    for (const f of shots) expect(statSync(f).size, f).toBeGreaterThan(10_000);
  });
});
