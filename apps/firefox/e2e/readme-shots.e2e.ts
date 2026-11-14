import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { dispatch, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, siteWindowExpr, writeSite } from "./sites";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";
import { openBuilder } from "./workflows";

/**
 * The README's pictures, on a throwaway profile with real sites and the machine's real agent tools (its own container
 * and ports, never the installed app's). Run by hand only: RESSAC_README_SHOTS=1. Output: dist/readme-shots/.
 */
const OUT = path.resolve(import.meta.dirname, "../dist/readme-shots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let w: LaunchedRessac | undefined;
afterAll(async () => w?.close());

async function shoot(m: Marionette, name: string): Promise<void> {
  await sleep(900);
  const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, "base64"));
}

const step = process.env.RESSAC_README_STEP ?? "all";
describe.skipIf(!process.env.RESSAC_README_SHOTS)("README shots", () => {
  it.runIf(step !== "surfaces")("captures the overview", { timeout: 300_000 }, async () => {
    mkdirSync(OUT, { recursive: true });
    w = await launchRessac({
      width: 1440,
      height: 900,
      realTools: true,
      prefs: { "ui.systemUsesDarkTheme": 1, "ui.prefersReducedMotion": 0 },
      env: { RESSAC_CONTAINER: "ressac-workshop-readme", RESSAC_CONTAINER_PORTS: "5340-5359", RESSAC_KEV_URL: undefined },
    });
    const m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.ressacWindow", (v) => v === true, 30_000);
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
    const s0 = await state(m);
    const windowId = s0.windows[0]!.id;
    const open = async (url: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const s = await dispatch(m, { type: "openTab", windowId, url });
      return Object.keys(s.tabs).find((id) => !before.has(id))!;
    };
    for (const url of ["https://en.wikipedia.org", "https://github.com", "https://www.youtube.com"]) await dispatch(m, { type: "addEssential", id: await open(url) });
    for (const url of ["https://developer.mozilla.org/en-US/", "https://news.ycombinator.com"]) await dispatch(m, { type: "pinTab", id: await open(url) });
    await open("https://fr.wikipedia.org/wiki/Mascaret");
    await open("https://en.wikipedia.org/wiki/Bordeaux");
    await sleep(8000);
    await shoot(m, "overview");
  });

  it.runIf(step !== "surfaces")("films the live recap", { timeout: 40 * 60_000 }, async () => {
    const m = w!.marionette;
    const windowId = (await state(m)).windows[0]!.id;
    // A fresh headless profile gets Google's captcha after a few searches.
    await dispatch(m, { type: "chooseEngine", engine: "duckduckgo" });
    await dispatch(m, { type: "openTab", windowId, url: "https://fr.wikipedia.org/wiki/Aspirateur_robot" });
    await sleep(4000);
    const terminal = () => inUi<string>(m, "return (doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')", [], "agent");
    await click(m, '[data-testid="agent-button"]');
    // Claude Code's prompt box is ready when its footer shows.
    for (const end = Date.now() + 120_000; !/❯/.test(await terminal().catch(() => "")); await sleep(1000))
      if (Date.now() > end) break;
    await sleep(3000);
    await shoot(m, "agent-ready");
    writeFileSync(path.join(OUT, "agent-ready.txt"), await terminal().catch(() => ""));
    if (process.env.RESSAC_README_STEP === "ready") return;
    await click(m, ".xterm-screen", { frame: "agent" });
    // Accents and € are not keys the test keyboard knows: send the request down the panel's own terminal channel.
    await inUi(m, "ui.ressac.agent.write(arguments[0]); return true;", [" Je cherche un aspirateur robot à moins de 400 €. Compare les trois meilleurs et fais-moi un récap."], "agent");
    await sleep(1500);
    await shoot(m, "agent-prompt");
    await inUi(m, "ui.ressac.agent.write('\\r'); return true;", [], "agent");
    await sleep(15_000);
    await shoot(m, "agent-working");
    const frames = path.join(OUT, "recap-frames");
    mkdirSync(frames, { recursive: true });
    let n = 0, onRecap = false, last = "", still = 0;
    for (const end = Date.now() + 35 * 60_000; Date.now() < end; await sleep(1500)) {
      const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
      writeFileSync(path.join(frames, `${String(n++).padStart(5, "0")}.png`), Buffer.from(png, "base64"));
      const recap = Object.values((await state(m)).tabs).find((t) => t.url.startsWith("ressac://recap/"));
      if (recap && !onRecap) {
        onRecap = true;
        await dispatch(m, { type: "activateTab", id: recap.id });
      }
      // Done: the recap is shown, Claude Code's « Thinking… (12s · …) » line is gone and the terminal has not changed for a minute.
      const t = await terminal().catch(() => last);
      still = t === last && !/…\s*\(\d+[sm]|MCP task/.test(t) ? still + 1 : 0;
      last = t;
      if (onRecap && still > 40) break;
    }
    writeFileSync(path.join(OUT, "agent-end.txt"), last);
    await shoot(m, "recap-final");
  });

  it.runIf(step === "surfaces" || step === "all")("captures the other surfaces", { timeout: 10 * 60_000 }, async () => {
    await w?.close();
    mkdirSync(OUT, { recursive: true });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-readme-"));
    const excalidraw = { name: "Excalidraw", url: "https://excalidraw.com/", domains: ["excalidraw.com"] };
    writeSite(dataDir, "excalidraw", { declaration: excalidraw });
    await grantSite(dataDir, "excalidraw", excalidraw);
    w = await launchRessac({
      dataDir,
      width: 1440,
      height: 900,
      realTools: true,
      starterHarvests: true,
      prefs: { "ui.systemUsesDarkTheme": 1, "ui.prefersReducedMotion": 0 },
      env: { RESSAC_CONTAINER: "ressac-workshop-readme", RESSAC_CONTAINER_PORTS: "5340-5359", RESSAC_KEV_URL: undefined },
    });
    const m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    const windowId = (await state(m)).windows[0]!.id;
    await dispatch(m, { type: "setHintsEnabled", enabled: false });
    await dispatch(m, { type: "homeAgentPanel", windowId, open: false });

    // Home: the starter widgets harvest the real web, then the local models sort and write.
    for (const end = Date.now() + 180_000; Date.now() < end; await sleep(3000))
      if (await inUi<boolean>(m, "return [...doc.querySelectorAll('[data-testid^=\"widget-\"]')].every((e) => e.textContent.trim().length > 80)").catch(() => false)) break;
    await shoot(m, "home");
    await openBuilder(m, "actus-tech");
    await sleep(1500);
    await sleep(1500);
    await shoot(m, "workflow-builder");
    const builderTab = Object.values((await state(m)).tabs).find((t) => t.url.startsWith("ressac://workflow/"));
    if (builderTab) await dispatch(m, { type: "closeTab", id: builderTab.id });

    // Spaces, essentials, pinned tabs (pinned once loaded, so they keep their title).
    const perso = (await state(m)).windows[0]!.activeSpace;
    for (const [name, icon, aura] of [["Travail", "💼", "lagon"], ["Voyage", "🌍", "glacier"]] as const)
      await dispatch(m, { type: "createSpace", name, icon, aura, private: false, profile: "default", windowId });
    await dispatch(m, { type: "activateSpace", windowId, id: perso });
    const open = async (url: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const s = await dispatch(m, { type: "openTab", windowId, url });
      return Object.keys(s.tabs).find((id) => !before.has(id))!;
    };
    const essentials = [];
    for (const url of ["https://fr.wikipedia.org", "https://github.com", "https://www.youtube.com"]) essentials.push(await open(url));
    const pinned = [];
    for (const url of ["https://developer.mozilla.org/fr/", "https://news.ycombinator.com"]) pinned.push(await open(url));
    await open("https://fr.wikipedia.org/wiki/Mascaret");
    const bordeaux = await open("https://fr.wikipedia.org/wiki/Bordeaux");
    await sleep(8000);
    for (const id of essentials) await dispatch(m, { type: "addEssential", id });
    for (const id of pinned) await dispatch(m, { type: "pinTab", id });
    await sleep(3000);
    await shoot(m, "overview");

    await pressKeys(m, "Meta+t");
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
    await typeText(m, "wiki");
    await sleep(1500);
    await shoot(m, "command-bar");
    await pressKeys(m, "Escape");

    // A call: the bar at the foot of the sidebar keeps the mic, the camera and the way back.
    const call = await open("https://meet.jit.si/");
    await sleep(5000);
    await dispatch(m, { type: "setCall", id: call, call: { mic: true, camera: true } });
    await dispatch(m, { type: "activateTab", id: bordeaux });
    await shoot(m, "call-bar");

    const before = await windowHandles(m);
    await m.execute(
      `return (async () => { const store = await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready;
        await store.agent.request("sites.act", { id: "excalidraw", action: "open", window: store.state.windows[0].id }); })();`,
    );
    await waitFor(m, `const w = ${siteWindowExpr("excalidraw")}; return !!w && w.gBrowser.selectedBrowser.currentURI.spec.includes("excalidraw.com");`, (v) => v === true, 20_000);
    await sleep(6000);
    const handle = (await windowHandles(m)).find((h) => !before.includes(h));
    if (handle) {
      await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
      await shoot(m, "site-app");
      await m.command("WebDriver:SwitchToWindow", { handle: before[0], focus: false });
    }
  });
});
