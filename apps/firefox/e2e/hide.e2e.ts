import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { center, trustedMouse } from "./design";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { readPassport, writePassport, type PassportEntry } from "./passport-file";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { agentPanelReady, click, inUi, waitUi } from "./ui";

// « Cacher pour l'agent » Task 4: the toolbar button arms Ressac's viewfinder over the page, a click freezes the text,
// the bubble confirms it, « Cacher » writes a passport entry, the layer plays the honest ending and the toast offers
// « Annuler » for 8 s. Every check waits for its final state.

const B = "gBrowser.selectedBrowser";
const CARDS = '[data-testid="permission-request"] button';
const PAGE = `<!doctype html><meta charset="utf-8"><title>Fiche</title><body style="margin:0;font:16px/20px sans-serif">
<span id="name" style="position:absolute;left:100px;top:100px">Camille Aubrac</span>
<span id="known" style="position:absolute;left:100px;top:160px">Jeanne Durand</span>
<span id="swap" style="position:absolute;left:100px;top:220px">Lucie Martin</span>
<p id="words" style="position:absolute;left:100px;top:280px;margin:0">Rendez-vous lundi matin avec Paul</p>`;

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
let server: Awaited<ReturnType<typeof startServer>>;
// Another site: the passport entry written before the launch names it, so it is a source of the conversation.
let known: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
let profile: string | undefined;

beforeAll(async () => {
  server = await startServer({ routes: { "/fiche.html": (_req: unknown, res: ServerResponse) => html(res, PAGE) } });
  known = await startServer({ routes: { "/fiche.html": (_req: unknown, res: ServerResponse) => html(res, PAGE) } });
});
afterAll(() => Promise.all([server?.close(), known?.close()]));
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of [dataDir, profile]) if (d) await rm(d, { recursive: true, force: true });
  dataDir = profile = undefined;
});

const knownEntry = (): PassportEntry => ({ id: "0000000000000001", field: "nom", value: { given: "Jeanne", family: "Durand" }, origins: [new URL(known.url).host] });

/** Launches with the passport on disk (memory cipher), the agent's session open; `relaunch` keeps the profile and its passport. */
async function start(o: { reauth?: "pass" | "fail"; relaunch?: boolean; prefs?: Record<string, number> } = {}): Promise<void> {
  dataDir ??= await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  profile ??= await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  if (!o.relaunch) await writePassport(profile, [knownEntry()]);
  w = await launchRessac({
    dataDir,
    profile,
    env: { RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_LOCAL_ADDRESSES: "1", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_TEST_REAUTH: o.reauth ?? "pass" },
    ...(o.prefs ? { prefs: o.prefs } : {}),
  });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  await expect.poll(() => existsSync(config), { timeout: 20_000 }).toBe(true);
  await agentPanelReady(m);
}

/** A tab opened from Ressac's UI (`agentReached`: as if the agent had opened it), shown and loaded. */
async function tab(url: string, agentReached = false): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached });
  await waitFor(m, `return ${B}.currentURI.spec === ${JSON.stringify(url)} && !${B}.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}

/** The toolbar button, then the outline over `selector` (moved to until the layer draws it), then the click. */
async function pick(selector: string): Promise<void> {
  await click(m, '[data-testid="hide-button"]');
  await waitFor(m, "return document.getElementById('ressac-hide-layer')?.style.pointerEvents", (v) => v === "auto");
  const at = await center(m, B, selector);
  // The layer listens once its document has loaded: moved over the target until it draws the outline.
  await expect
    .poll(async () => {
      await trustedMouse(m, B, at, { move: true });
      return inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"hide-aim\"]')", [], "hide");
    }, { timeout: 15_000 })
    .toBe(true);
  await trustedMouse(m, B, at);
}

// inUi looks its frame up once: the bubble frame is made on the first pick, after the gesture.
const bubbleText = async (testid: string) => (await waitFor(m, "return !!document.getElementById('ressac-hide-bubble')", (v) => v === true, 15_000)) && waitUi<string>(m, `return doc.querySelector('[data-testid="${testid}"]')?.textContent?.trim()`, [], 15_000, "hideBubble");
const has = (testid: string) => inUi<boolean>(m, `return !!doc.querySelector('[data-testid="${testid}"]')`, [], "hideBubble");
const value = (testid: string) => inUi<string>(m, `return doc.querySelector('[data-testid="${testid}"]').value`, [], "hideBubble");
const endingShown = () => waitFor(m, "return document.getElementById('ressac-hide-layer')?.dataset.ending ?? ''", (v) => v !== "", 20_000);
const entryOf = async (given: string) => (await readPassport(profile!)).find((e) => e.value.given === given || e.value.text === given);

/** A tool call through the newest conversation's token (passport-masking.e2e.ts), every card it raises allowed. */
async function allowing(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const config = readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => join(folder, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!config) throw new Error("no session config");
  let done = false;
  const call = callMcpTool(join(w!.dataDir, "workspace"), name, args, config).finally(() => (done = true));
  while (!done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => x.textContent.trim().startsWith("Autoriser")); return b ? b.textContent.trim() : null;`, [CARDS]);
    if (label) await click(m, CARDS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return call;
}

it("a picked name: the bubble prefills Nom, Prénom(s) and Nom; Cacher writes it from the page's site; ending next; a new conversation reads it as a label", { timeout: 180_000 }, async () => {
  await start();
  const url = `${server.url}/fiche.html`;
  // A first read: the conversation's sources are fixed from it (masker.originsOf), so the site added after counts next time.
  expect((await allowing("read_tab", { id: await tab(url) })).error).toBe(false);
  await pick("#name");
  expect(await bubbleText("hide-question")).toBe("Cacher « Camille Aubrac » pour l'agent ?");
  expect(await value("hide-type")).toBe("nom");
  expect(await value("hide-given")).toBe("Camille");
  expect(await value("hide-family")).toBe("Aubrac");
  const host = new URL(server.url).host;
  expect(await bubbleText("hide-site")).toBe(`Sur ${host} et vos autres sources`);
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  // The site was no source of this conversation: it counts from the next one.
  expect(await endingShown()).toBe("next");
  expect(await bubbleText("hide-toast")).toContain("Masqué pour l'agent");
  await expect.poll(async () => (await entryOf("Camille"))?.origins, { timeout: 15_000 }).toEqual([host]);
  expect((await entryOf("Camille"))!.value).toEqual({ given: "Camille", family: "Aubrac" });
  await w!.close();
  w = undefined;
  await start({ relaunch: true });
  const id = await tab(url);
  const text = (await allowing("read_tab", { id })).text;
  expect(text).toMatch(/⟨nom-[a-z0-9]{8}⟩/);
  expect(text).not.toContain("Aubrac");
});

it("a value already in the passport with this site, picked in a conversation started after it: ending hidden, nothing new written", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${known.url}/fiche.html`);
  await pick("#known");
  expect(await bubbleText("hide-question")).toBe("Cacher « Jeanne Durand » pour l'agent ?");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await endingShown()).toBe("hidden");
  expect(await bubbleText("hide-toast")).toBe("Déjà dans votre passeport.");
  expect(await has("hide-undo")).toBe(false);
  expect(await readPassport(profile!)).toHaveLength(1);
});

it("a tab the agent reached: no site line, the entry has no site, ending agentReached", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/fiche.html`, true);
  await pick("#name");
  await bubbleText("hide-question");
  expect(await has("hide-site")).toBe(false);
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await endingShown()).toBe("agentReached");
  await expect.poll(async () => (await entryOf("Camille"))?.origins, { timeout: 15_000 }).toEqual([]);
});

it("the page swaps the text after the click, before Cacher: the frozen text is saved (Review Focus 1)", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/fiche.html`);
  await pick("#swap");
  expect(await bubbleText("hide-question")).toBe("Cacher « Lucie Martin » pour l'agent ?");
  await inBrowser(m, B, `document.getElementById("swap").textContent = "Autre Personne";`);
  expect(await inBrowser<string>(m, B, `return document.getElementById("swap").textContent;`)).toBe("Autre Personne");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  await endingShown();
  await expect.poll(async () => (await entryOf("Lucie"))?.value, { timeout: 15_000 }).toEqual({ given: "Lucie", family: "Martin" });
  expect(await entryOf("Autre")).toBeUndefined();
});

it("Annuler within 8 s removes the entry; a page the conversation read says the agent had already read it", { timeout: 120_000 }, async () => {
  await start();
  const id = await tab(`${server.url}/fiche.html`);
  expect((await allowing("read_tab", { id })).error).toBe(false);
  await pick("#name");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await bubbleText("hide-read-before")).toBe("L'agent avait déjà lu cette page.");
  await expect.poll(async () => !!(await entryOf("Camille")), { timeout: 15_000 }).toBe(true);
  await click(m, '[data-testid="hide-undo"]', { frame: "hideBubble" });
  await expect.poll(async () => !!(await entryOf("Camille")), { timeout: 15_000 }).toBe(false);
});

it("the context menu on a two-word selection: « Cacher pour l'agent » opens the bubble on those words", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/fiche.html`);
  await inBrowser(m, B, `const t = document.getElementById("words").firstChild, r = document.createRange(); r.setStart(t, 12); r.setEnd(t, 23); getSelection().removeAllRanges(); getSelection().addRange(r);`);
  expect(await inBrowser<string>(m, B, "return getSelection().toString();")).toBe("lundi matin");
  const at = await inBrowser<{ x: number; y: number }>(m, B, "const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };");
  await trustedMouse(m, B, at, { button: 2 });
  await waitFor(m, "const p = document.getElementById('contentAreaContextMenu'); return p.state === 'open' && !document.getElementById('ressac-context-hide').hidden", (v) => v === true, 15_000);
  expect(await m.execute<string>("return document.getElementById('ressac-context-hide').getAttribute('label');")).toBe("Cacher pour l'agent");
  await m.execute("const p = document.getElementById('contentAreaContextMenu'); p.activateItem(document.getElementById('ressac-context-hide'));");
  expect(await bubbleText("hide-question")).toBe("Cacher « lundi matin » pour l'agent ?");
});

it("reduced motion: the toast appears and nothing in the layer or the bubble animates longer than 150 ms (Review Focus 3)", { timeout: 120_000 }, async () => {
  await start({ prefs: { "ui.prefersReducedMotion": 1 } });
  await tab(`${server.url}/fiche.html`);
  await click(m, '[data-testid="hide-button"]');
  // Both frames mounted, then a probe in each: CSS transitions and animations as they run, and Web Animations as made.
  for (const frame of ["hide", "hideBubble"] as const)
    await inUi(
      m,
      `ui.__longest = 0;
       const note = (ms) => (ui.__longest = Math.max(ui.__longest, Number(ms) || 0));
       const scan = (e) => { for (const a of e.target.getAnimations({ subtree: true })) note(a.effect.getComputedTiming().activeDuration); };
       doc.addEventListener("transitionrun", scan, true);
       doc.addEventListener("animationstart", scan, true);
       const animate = ui.Element.prototype.animate;
       ui.Element.prototype.animate = function (k, o) { note(typeof o === "number" ? o : o?.duration); return animate.call(this, k, o); };`,
      [],
      frame,
    );
  await click(m, '[data-testid="hide-button"]');
  await waitFor(m, "return document.getElementById('ressac-hide-layer')?.style.display", (v) => v === "none", 5000);
  await pick("#name");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  await endingShown();
  expect(await bubbleText("hide-toast")).toContain("Masqué pour l'agent");
  // The ending runs out (its chip leaves), then every animation it made is in the probe.
  await expect.poll(() => inUi<boolean>(m, "return !doc.querySelector('[data-testid=\"hide-chip\"]')", [], "hide"), { timeout: 10_000 }).toBe(true);
  for (const frame of ["hide", "hideBubble"] as const) expect(await inUi<number>(m, "return ui.__longest;", [], frame)).toBeLessThanOrEqual(150);
  expect(await inUi<number>(m, "return ui.__longest;", [], "hide")).toBeGreaterThan(0);
});

it("Touch ID refused: nothing is written and the bubble closes", { timeout: 120_000 }, async () => {
  await start({ reauth: "fail" });
  await tab(`${server.url}/fiche.html`);
  await pick("#name");
  await bubbleText("hide-question");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  await expect.poll(() => has("hide-bubble"), { timeout: 15_000 }).toBe(false);
  // The bubble closes once `hide` has answered « cancelled », after any write it could have made.
  expect(await readPassport(profile!)).toHaveLength(1);
  expect(await has("hide-toast")).toBe(false);
});
