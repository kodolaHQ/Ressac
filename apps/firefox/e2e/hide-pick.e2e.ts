import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { center, trustedMouse } from "./design";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { openTab } from "./agent-extensions";

// « Cacher pour l'agent » Task 3: the page-proof RessacHide actor picks through invisible layers, lists the visible
// text and measures it, and the page never learns: no mutation, no selection change, no mouse event while picking.

const B = "gBrowser.selectedBrowser";
const ACTOR = "chrome://browser/content/ressac/hide-actor.sys.mjs";

const PAGE = `<!doctype html><meta charset="utf-8"><title>cacher</title>
<style>body{margin:0;font:16px sans-serif} .full{position:fixed;inset:0}</style>
<p>Bonjour <span id="cible" style="display:inline-block;margin:120px 0 0 120px">Camille Aubrac</span> et merci.</p>
<div id="leurre" style="display:none;position:fixed;left:120px;top:120px">Leurre caché</div>
<div id="fantome" style="visibility:hidden;position:fixed;left:100px;top:100px;width:300px;height:100px">Fantôme</div>
<div id="calque" class="full" style="pointer-events:none">Calque sans pointeur</div>
<div id="couvercle" class="full" style="opacity:0">Couvercle transparent</div>
<script>
  window.__seen = [];
  new MutationObserver((rs) => { for (const r of rs) __seen.push("mutation " + r.type); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener("selectionchange", () => __seen.push("selectionchange"));
  for (const t of ["mousemove", "mouseover", "pointermove", "mousedown", "mouseup", "click"]) addEventListener(t, (e) => __seen.push(t), true);
</script>`;

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  server = await startServer({ routes: { "/cacher": (_req, res) => (res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }), res.end(PAGE)) } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  w = await launchRessac({ dataDir, profile });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
const ask = <T = unknown>(name: string, data?: unknown) => m.execute<T>(`return ${B}.browsingContext.currentWindowGlobal.getActor("RessacHide").sendQuery(arguments[0], arguments[1]);`, [name, data ?? {}]);
const seen = () => inPage<string[]>("return window.__seen;");
const got = () => m.execute<[string, any][]>("return window.__hideGot;");
type Rect = { x: number; y: number; width: number; height: number };
const spanRect = () => inPage<Rect>(`const r = document.getElementById("cible").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
const inside = (r: Rect, box: Rect) => r.x >= box.x - 0.5 && r.y >= box.y - 0.5 && r.x + r.width <= box.x + box.width + 0.5 && r.y + r.height <= box.y + box.height + 0.5;

async function open(): Promise<void> {
  await openTab(m, `${server.url}/cacher`);
  await m.execute(`${B}.focus();`);
  await m.execute(
    `window.__hideGot = []; window.__hideOff?.(); window.__hideOff = ChromeUtils.importESModule("${ACTOR}").onHideMessage(${B}, (n, d) => window.__hideGot.push([n, d])); return 1;`,
  );
}

/** Armed, then the page's records emptied: a move left over the new tab by an earlier test (its mouseover) is not ours. */
async function arm(): Promise<void> {
  expect(await ask("arm")).toBe(true);
  await inPage("window.__seen.length = 0; return 1;");
}
/** What the page can see whether or not we are armed: a mutation or a selection change. */
const changes = async () => (await seen()).filter((s) => s.startsWith("mutation") || s === "selectionchange");

describe("RessacHide actor", () => {
  it("picks the span through an opacity:0 cover and a pointer-events:none layer, freezes its text, and the page sees nothing", async () => {
    await open();
    await arm();
    const box = await spanRect();
    await trustedMouse(m, B, "#cible", { move: true });
    await expect.poll(async () => (await got()).filter(([n, d]) => n === "hover" && d.rect).at(-1)?.[1].rect, { timeout: 10_000 }).toEqual(box);
    await trustedMouse(m, B, "#cible");
    await expect.poll(async () => (await got()).find(([n]) => n === "picked")?.[1], { timeout: 10_000 }).toEqual({ text: "Camille Aubrac", rect: box, origin: new URL(server.url).origin });
    // stop also ends the 500 ms swallow that follows a pick (the rest of a double click).
    expect(await ask("stop")).toBe(true);
    // Every event above (arm, move, click, stop) has been delivered by now: the page's records are final.
    expect(await seen()).toEqual([]);
    // Positive control: disarmed, the page's recorder does see a trusted move.
    await trustedMouse(m, B, "#cible", { move: true });
    await expect.poll(seen, { timeout: 10_000 }).toContain("mousemove");
  });

  it("never picks a hidden decoy: clicking where only invisible text lies picks nothing", async () => {
    await open();
    await arm();
    // Over the visibility:hidden and display:none decoys, outside the span and the paragraph's text.
    const c = await center(m, B, "#cible");
    const spot = { x: c.x + 200, y: c.y + 40 };
    expect(await inPage(`return document.elementsFromPoint(${spot.x}, ${spot.y}).map((e) => e.id || e.localName);`)).toEqual(expect.not.arrayContaining(["cible", "p"]));
    await trustedMouse(m, B, spot);
    // The child picks synchronously and messages keep their order: once the span's hover has come, a pick at the
    // decoys would have come before it.
    await trustedMouse(m, B, "#cible", { move: true });
    await expect.poll(async () => (await got()).some(([n, d]) => n === "hover" && d.rect), { timeout: 10_000 }).toBe(true);
    expect((await got()).filter(([n]) => n === "picked")).toEqual([]);
    // Still armed (nothing was picked): the span is picked now.
    await trustedMouse(m, B, "#cible");
    await expect.poll(async () => (await got()).find(([n]) => n === "picked")?.[1]?.text, { timeout: 10_000 }).toBe("Camille Aubrac");
    await ask("stop");
    expect(await seen()).toEqual([]);
  });

  it("pieces + rects: the visible text only, and the span's slice measured inside its box", async () => {
    await open();
    const { pieces } = await ask<{ pieces: { text: string; block: boolean }[] }>("pieces");
    const all = pieces.map((p) => p.text).join("");
    expect(all).toContain("Camille Aubrac");
    expect(all).toContain("Calque sans pointeur");
    expect(all).not.toMatch(/Leurre|Fantôme|Couvercle|MutationObserver/);
    const i = pieces.findIndex((p) => p.text === "Camille Aubrac");
    expect(i).toBeGreaterThanOrEqual(0);
    const { rects } = await ask<{ rects: Rect[][] }>("rects", { slices: [[{ piece: i, from: 0, to: 7 }]] });
    const box = await spanRect();
    expect(rects[0]!.length).toBeGreaterThan(0);
    for (const r of rects[0]!) expect(inside(r, box)).toBe(true);
    expect(await changes()).toEqual([]);
  });

  it("selection: the current selection's text, rect and origin; null when nothing is selected", async () => {
    await open();
    expect(await ask("selection")).toBe(null);
    await inPage(`const r = document.createRange(); r.selectNodeContents(document.getElementById("cible")); getSelection().addRange(r); return 1;`);
    const s = await ask<{ text: string; rect: Rect; origin: string }>("selection");
    expect(s.text).toBe("Camille Aubrac");
    expect(s.origin).toBe(new URL(server.url).origin);
    expect(inside(s.rect, await spanRect())).toBe(true);
  });
});
