import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openTab, testActor } from "./agent-extensions";
import { startDesignServers } from "./design";
import { dispatch, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { click, inUi, keyDown, keyUp, pressKeys, typeText, waitUi } from "./ui";
import { openBuilder, writeWidget } from "./workflows";

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
let design: Awaited<ReturnType<typeof startDesignServers>>;
let sites: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  // This file's app port block: 15335-15339.
  design = await startDesignServers({ port: 15338 });
  sites = await startSitesServer();
  sites.define("carnet.localhost", "/", `<title>Carnet</title><body style="font:16px/1.5 system-ui;margin:40px"><h1>Carnet de recettes</h1><p>Tarte aux figues, pâte sablée.</p></body>`);
  server = await startServer({
    routes: {
      "/vols": page("Vols Paris – Lisbonne", "<p>Mer. 12 mars · direct · 124 €</p><p>Ven. 14 mars · direct · 89 €</p><p>Sam. 15 mars · 1 escale · 97 €</p>"),
      "/recette": page("Tarte aux figues", "<p>Une pâte sablée, des figues mûres, un filet de miel.</p>"),
      "/notes": page("Notes de lecture", "<p>Chapitre 3 : la lumière du soir sur la baie.</p>"),
    },
  });
});
afterAll(async () => {
  server?.close();
  await design?.close();
  await sites?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
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
      w = await launchWebAiOs({ prefs: { "ui.systemUsesDarkTheme": dark, "ui.prefersReducedMotion": 0 } });
      const m = w.marionette;
      await m.setContext("chrome");
      await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
      const windowId = (await state(m)).windows[0]!.id;
      // The home page's panel starts the agent's session, which takes back every access: tools are called after it.
      await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
      for (const p of ["/notes", "/recette", "/vols"]) await dispatch(m, { type: "openTab", windowId, url: server.url + p });
      await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (u: string) => u.endsWith("/vols"));
      await waitUi(m, "return doc.querySelectorAll('[data-testid^=\"tab-\"][role=\"tab\"]').length === 3");
      await shoot(m, `1-window-${theme}`);

      await click(m, '[data-testid="agent-button"]');
      await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
      await shoot(m, `5-agent-${theme}`);

      // An access card: the agent asks to read a tab it was not given (opening the panel shared the shown one).
      const tabs = Object.values((await state(m)).tabs);
      const vols = tabs.find((t) => t.url.endsWith("/vols"))!.id;
      const reading = callTool(w.dataDir, "read_tab", { id: tabs.find((t) => t.url.endsWith("/notes"))!.id });
      reading.catch(() => {});
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"request-modal\"][data-armed]')");
      await shoot(m, `6-access-card-${theme}`);
      await click(m, '[data-testid="request-modal"] button', { text: "Autoriser une fois" });
      await reading;
      await click(m, `[data-testid="tab-${vols}"] [data-testid="access-pill"]`);
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"access-bubble\"]')");
      await shoot(m, `7-access-bubble-${theme}`);
      await pressKeys(m, "Escape");
      await click(m, '[data-testid="agent-button"]');
      await waitFor(m, "return document.getElementById('webaios-agent').hidden", (v) => v === true);

      await click(m, '[data-testid="new-space"]');
      await waitUi(m, "return doc.querySelector('[data-testid=\"space-modal\"] h2')?.textContent === 'Nouvel espace'");
      await shoot(m, `8-space-modal-${theme}`);
      await click(m, '[data-testid="space-modal"] [aria-label="Icône"]');
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"emoji-grid\"]')");
      await shoot(m, `8b-emoji-grid-${theme}`);
      await pressKeys(m, "Escape");
      await pressKeys(m, "Escape");
      await waitUi(m, "return !doc.querySelector('[data-testid=\"space-modal\"]')");

      await click(m, `[data-testid="tab-${vols}"]`, { button: 2 });
      await waitUi(m, "return !!doc.querySelector('[role=\"menu\"]')");
      await shoot(m, `9-menu-${theme}`);
      await pressKeys(m, "Escape");

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

      // Last (more than two spaces fold the tools): a few spaces, each chip glowing with its own aura, the first active.
      await dispatch(m, { type: "toggleCompact", windowId });
      const first = (await state(m)).windows[0]!.activeSpace;
      for (const [name, icon, aura, priv] of [["Travail", "💼", "lagon", false], ["Jardin", "🌱", "verger", false], ["Secret", "🎁", "braise", true]] as const)
        await dispatch(m, { type: "createSpace", name, icon, aura, private: priv, profile: "default", windowId });
      await dispatch(m, { type: "activateSpace", windowId, id: first });
      await waitUi(m, "return doc.querySelectorAll('footer nav [data-testid^=\"space-\"]').length === 4");
      await shoot(m, `4b-spaces-${theme}`);
    });
  }

  for (const [theme, dark] of [["sombre", 1], ["clair", 0]] as const) {
    it(`captures the internal pages (${theme})`, async () => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
      const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
      dirs.push(dataDir, profile);
      await writeWidget(dataDir, "veille", {
        name: "Veille",
        harvest: { minutes: 60 },
        declaration: { config: { url: `${server.url}/notes` } },
        workflow: {
          version: 1,
          blocks: [
            { id: "page", type: "source.page", params: { url: "{config.url}" } },
            { id: "tri", type: "ai.sort", name: "Tri par Kev", params: { question: "Parle de figues ?", text: "{text}", threshold: 0.5 } },
            { id: "sortie", type: "output", params: { to: "widget" } },
          ],
          links: [
            { from: "page", to: "tri" },
            { from: "tri", to: "sortie" },
          ],
        },
      });
      writeSite(dataDir, "carnet", { declaration: { name: "Carnet", url: sites.url("carnet.localhost", "/"), domains: ["carnet.localhost"] } });
      const actor = testActor(profile);
      w = await launchWebAiOs({
        dataDir,
        profile,
        env: { ...actor.env, WEBAIOS_APP_PORTS: "15335-15339", WEBAIOS_TEST_LOCAL_ADDRESSES: "1", WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9" },
        prefs: { ...actor.prefs, "ui.systemUsesDarkTheme": dark, "ui.prefersReducedMotion": 0 },
      });
      const m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
      await resolveLocalHosts(m, ["localhost", "carnet.localhost"]);
      const windowId = (await state(m)).windows[0]!.id;

      await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-veille\"]')", [], 15_000);
      await shoot(m, `10-home-${theme}`);

      await openBuilder(m, "veille");
      await waitUi(m, "return doc.querySelectorAll('.svelte-flow__node').length === 3");
      await shoot(m, `11-builder-${theme}`);

      await click(m, '[data-testid="settings-button"]');
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"settings-page\"]')");
      await shoot(m, `12-settings-${theme}`);
      await click(m, '[data-testid="settings-nav-privacy"]');
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"telemetry-switch\"]')");
      await shoot(m, `12b-settings-privacy-${theme}`);

      await click(m, '[data-testid="applications-button"]');
      await waitUi(m, `return !!doc.querySelector('[data-testid="page-applications"]')`);
      await shoot(m, `13-applications-${theme}`);

      for (const p of ["/notes", "/recette", "/vols"]) await openTab(m, server.url + p);
      await pressKeys(m, "Meta+y");
      await waitUi(m, "return doc.querySelector('[data-testid=\"content-zone\"]').textContent.includes('Vols Paris')");
      await shoot(m, `14-history-${theme}`);
      await pressKeys(m, "Escape");

      await dispatch(m, { type: "openTab", windowId, url: "http://127.0.0.1:1/" });
      await waitUi(m, "return doc.querySelector('[data-testid=\"content-zone\"]').textContent.includes(\"Impossible d'ouvrir cette page.\")");
      await shoot(m, `15-error-${theme}`);

      // Design mode on the demo page: the cart column beside the page.
      await openTab(m, `${design.page}/`);
      await inUi(m, "ui.webaios.design.toggle(); return 1;");
      await waitFor(m, "const f = document.getElementById('webaios-design-volet'); return !!f && f.getBoundingClientRect().width > 0;", (v) => v === true, 15_000);
      await shoot(m, `16-design-${theme}`);
      await inUi(m, "ui.webaios.design.toggle(); return 1;");

      // A site app's own window: its bar over the site.
      const before = await windowHandles(m);
      await m.execute(
        `return (async () => { const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
          await store.agent.request("sites.act", { id: "carnet", action: "open", window: store.state.windows[0].id }); })();`,
      );
      await waitFor(m, `const w = ${siteWindowExpr("carnet")}; return !!w && w.gBrowser.selectedBrowser.currentURI.spec.includes("carnet.localhost");`, (v) => v === true, 15_000);
      const handle = (await windowHandles(m)).find((h) => !before.includes(h));
      if (handle) {
        await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
        await shoot(m, `17-site-window-${theme}`);
        await m.command("WebDriver:SwitchToWindow", { handle: before[0], focus: false });
      }
    });
  }

  it("no capture is blank", () => {
    expect(shots.length).toBeGreaterThan(0);
    for (const f of shots) expect(statSync(f).size, f).toBeGreaterThan(10_000);
  });
});
