import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, keyDown, keyUp, pressKeys, typeText, waitUi } from "./ui";

/**
 * The website's pictures, in one language per run, on a throwaway profile with the machine's real agent tools (its own
 * container and ports). Run by hand only: RESSAC_SITE_SHOTS=en|fr, RESSAC_SITE_STEP=shots|film|all.
 * Output: dist/site-shots/<lang>/. Only Wikipedia pages and a weather widget fed with sample data: no third-party news or logos.
 */
const lang = process.env.RESSAC_SITE_SHOTS as "en" | "fr" | undefined;
const step = process.env.RESSAC_SITE_STEP ?? "all";
const OUT = path.resolve(import.meta.dirname, "../dist/site-shots", lang ?? "none");
const TEMPLATES = path.resolve(import.meta.dirname, "../../../packages/kernel/templates");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = {
  en: {
    wiki: "en", pages: ["Bordeaux", "Garonne", "Tidal_bore", "Dune_of_Pilat"], search: "bordeaux",
    spaces: [["Personal", "🏠"], ["Work", "💼", "lagon"], ["Travel", "🌍", "glacier"]],
    prompt: "Compare the three biggest tidal bores in the world (height, speed, best season) and make me a recap.",
  },
  fr: {
    wiki: "fr", pages: ["Bordeaux", "Garonne", "Mascaret", "Dune_du_Pilat"], search: "bordeaux",
    spaces: [["Perso", "🏠"], ["Travail", "💼", "lagon"], ["Voyage", "🌍", "glacier"]],
    prompt: "Compare les trois plus grands mascarets du monde (hauteur, vitesse, meilleure saison) et fais-moi un récap.",
  },
}[lang ?? "fr"];

/** The starter weather widget of the run's language, without its harvest: the home shows its sample data. */
function seedWeather(dataDir: string): void {
  const dir = path.join(dataDir, "workspace/home/widgets/meteo");
  cpSync(path.join(TEMPLATES, lang ?? "fr", "widgets/meteo"), dir, { recursive: true });
  const { harvest: _, ...widget } = JSON.parse(readFileSync(path.join(dir, "widget.json"), "utf8"));
  // The largest size shows the hours and the days, not only the current weather.
  widget.sizes.default = widget.sizes.max;
  writeFileSync(path.join(dir, "widget.json"), JSON.stringify(widget, null, 2));
}

let w: LaunchedRessac | undefined;
afterAll(async () => w?.close());

async function shoot(m: Marionette, name: string): Promise<void> {
  await sleep(900);
  const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, "base64"));
}

describe.skipIf(!lang)("site shots", () => {
  it("captures and films", { timeout: 45 * 60_000 }, async () => {
    mkdirSync(OUT, { recursive: true });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-site-"));
    seedWeather(dataDir);
    w = await launchRessac({
      dataDir,
      width: 1440,
      height: 900,
      realTools: true,
      prefs: { "ui.systemUsesDarkTheme": 1, "ui.prefersReducedMotion": 0 },
      env: { RESSAC_CONTAINER: "ressac-workshop-readme", RESSAC_CONTAINER_PORTS: "5340-5359", RESSAC_TEST_MAC_LANGUAGES: lang === "en" ? "en-US" : "fr-FR" },
    });
    const m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await dispatch(m, { type: "chooseLanguage", language: lang! });
    await dispatch(m, { type: "setHintsEnabled", enabled: false });
    await dispatch(m, { type: "chooseEngine", engine: "duckduckgo" });
    const s0 = await state(m);
    const windowId = s0.windows[0]!.id;
    const home = s0.spaces[0]!;
    const [first, ...others] = T.spaces;
    await dispatch(m, { type: "updateSpace", id: home.id, name: first![0]!, icon: first![1]!, private: false, profile: home.profile, aura: "aube" });
    for (const [name, icon, aura] of others) await dispatch(m, { type: "createSpace", name: name!, icon: icon!, aura: aura as "lagon" | "glacier", private: false, profile: "default", windowId });
    await dispatch(m, { type: "activateSpace", windowId, id: home.id });
    const open = async (url: string) => {
      const before = new Set(Object.keys((await state(m)).tabs));
      const s = await dispatch(m, { type: "openTab", windowId, url });
      return Object.keys(s.tabs).find((id) => !before.has(id))!;
    };

    if (step !== "film") {
      // Your way: the space's home (shown only while it has no tab) and its spaces at the foot of the sidebar.
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"widget-meteo\"]')", [], 30_000);
      await sleep(3000);
      await shoot(m, `your-way-${lang}`);

      // Day one: a calm page, a few tabs, ⌘T with a search.
      const wiki = (p: string) => `https://${T.wiki}.wikipedia.org/wiki/${p}?vectornightmode=1`;
      const pinned = await open(`https://${T.wiki}.wikipedia.org/?vectornightmode=1`);
      for (const p of T.pages.slice(1)) await open(wiki(p));
      const bordeaux = await open(wiki(T.pages[0]!));
      await sleep(8000);
      await dispatch(m, { type: "pinTab", id: pinned });
      // Each tab shown once, so the ⌃Tab switcher has a preview of it.
      for (const id of Object.keys((await state(m)).tabs).filter((id) => id !== bordeaux)) {
        await dispatch(m, { type: "activateTab", id });
        await sleep(1500);
      }
      await dispatch(m, { type: "activateTab", id: bordeaux });
      await sleep(2000);
      await shoot(m, `day-one-plain-${lang}`);
      await pressKeys(m, "Meta+t");
      await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
      await typeText(m, T.search);
      await sleep(1500);
      await shoot(m, `day-one-${lang}`);
      await pressKeys(m, "Escape");

      // Bonus: the ⌃Tab switcher, held open.
      await keyDown(m, "Control");
      await pressKeys(m, "Tab");
      await sleep(600);
      await pressKeys(m, "Tab");
      await shoot(m, `your-way-ctrltab-${lang}`);
      await pressKeys(m, "Escape");
      await keyUp(m, "Control");
      for (const id of Object.keys((await state(m)).tabs)) await dispatch(m, { type: "closeTab", id });
    }

    if (step === "shots") return;
    // The live recap: the agent searches in its tab, its thumbnail turns, the recap fills in.
    const terminal = () => inUi<string>(m, "return (doc.querySelector('.xterm-rows')?.textContent ?? '').replace(/\\u00a0/g, ' ')", [], "agent");
    // The agent starts beside a page; past two spaces its button is folded into ⋯, so the panel opens by its action.
    await open(`https://${T.wiki}.wikipedia.org/wiki/${T.pages[2]}?vectornightmode=1`);
    await sleep(4000);
    await dispatch(m, { type: "toggleAgentPanel", windowId });
    for (const end = Date.now() + 120_000; !/❯/.test(await terminal().catch(() => "")) && Date.now() < end; ) await sleep(1000);
    await sleep(3000);
    await click(m, ".xterm-screen", { frame: "agent" });
    // Accents are not keys the test keyboard knows: the request goes down the panel's own terminal channel.
    await inUi(m, "ui.ressac.agent.write(arguments[0]); return true;", [T.prompt], "agent");
    const frames = path.join(OUT, "frames");
    mkdirSync(frames, { recursive: true });
    let n = 0, onRecap = false, last = "", turnsBefore = -1, still = 0;
    const frame = async () => {
      const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
      writeFileSync(path.join(frames, `${String(n++).padStart(5, "0")}.png`), Buffer.from(png, "base64"));
    };
    for (let i = 0; i < 3; i++, await sleep(700)) await frame();
    await inUi(m, "ui.ressac.agent.write('\\r'); return true;", [], "agent");
    for (const end = Date.now() + 35 * 60_000; Date.now() < end; await sleep(1500)) {
      await frame();
      // No decision model here: the agent asks before an address it wrote itself; the viewer would say yes.
      if (await inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"request-modal\"][data-armed] button.allow')").catch(() => false))
        await click(m, "[data-testid=\"request-modal\"] button.allow").catch(() => {});
      const recap = Object.values((await state(m)).tabs).find((t) => t.url.startsWith("ressac://recap/"));
      if (recap && !onRecap) {
        onRecap = true;
        await dispatch(m, { type: "activateTab", id: recap.id });
      }
      // Done: the recap is shown, no « Thinking… (12s · …) » spinner, and no new « done 5:20 PM » turn for 30 s (the rest of the terminal keeps moving).
      const t = await terminal().catch(() => last);
      const turns = (t.match(/done \d+:\d+/g) ?? []).length;
      still = turns > 0 && turns === turnsBefore && !/…\s*\(\d+[sm]/.test(t) ? still + 1 : 0;
      [last, turnsBefore] = [t, turns];
      if (onRecap && still > 20) break;
    }
    writeFileSync(path.join(OUT, "agent-end.txt"), last);
  });
});
