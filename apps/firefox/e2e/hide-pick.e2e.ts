import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTab } from "./agent-extensions";
import { center, trustedMouse } from "./design";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser, resolveLocalHosts } from "./sites";

// « Cacher pour l'agent » Task 3: the RessacHide actor answers the parent's coordinates (its layer captures the
// pointer, so no mouse event reaches the page): it picks visible text through layers a person sees through, follows a
// frame of another site, lists and measures the visible text, and the page never learns.

const B = "gBrowser.selectedBrowser";
const ACTOR = "chrome://browser/content/ressac/hide-actor.sys.mjs";
type Rect = { x: number; y: number; width: number; height: number };

const REPEAT = (s: string) => `${s} `.repeat(400);
const FRAME = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif"><span id="loin" style="position:absolute;left:50px;top:40px">Lucie Martin</span>`;
const PAGE = (frame: string) => `<!doctype html><meta charset="utf-8"><title>cacher</title>
<style>body{margin:0;font:16px/20px sans-serif} .full{position:fixed;inset:0;overflow:hidden}
#cible,#couvercle{transition:color 1ms} #cible:hover,#couvercle:hover{color:rgb(1,2,3)}</style>
<div id="emballage" style="position:absolute;left:100px;top:100px;padding:40px"><span id="cible">Camille Aubrac</span></div>
<div style="position:absolute;left:100px;top:260px"><span id="double">Camille <span style="opacity:0">X</span></span></div>
<div id="leurre" style="display:none;position:absolute;left:100px;top:320px">Leurre caché</div>
<iframe id="cadre" src="${frame}" style="position:absolute;left:400px;top:100px;width:300px;height:120px;border:0"></iframe>
<span id="p3" style="position:absolute;left:100px;top:360px;color:color(display-p3 1 0 0)">Jeanne Durand</span>
<span id="sous" style="position:absolute;left:100px;top:420px">Paul Simon</span>
<iframe id="voile" src="${frame}" style="opacity:0;position:absolute;left:80px;top:400px;width:200px;height:60px;border:0"></iframe>
<span id="cache" style="position:absolute;left:100px;top:500px">Marc Petit</span>
<div id="plaque" style="position:absolute;left:90px;top:490px;width:200px;height:40px;background:rgb(220,220,220)"></div>
<div id="calque" class="full" style="pointer-events:none">${REPEAT("Calque sans pointeur")}</div>
<div id="incolore" class="full" style="color:transparent">${REPEAT("Couleur transparente")}</div>
<div id="couvercle" class="full" style="opacity:0">${REPEAT("Couvercle transparent")}</div>
<script>
  window.__seen = [];
  new MutationObserver((rs) => { for (const r of rs) __seen.push("mutation " + r.type); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener("selectionchange", () => __seen.push("selectionchange"));
  document.addEventListener("transitionrun", (e) => __seen.push("transitionrun " + e.target.id), true);
  for (const t of ["mousemove", "mouseover", "pointermove", "mousedown", "click"]) addEventListener(t, () => __seen.push(t), true);
</script>`;

let page: Awaited<ReturnType<typeof startServer>>;
let frame: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
const dirs: string[] = [];
const html = (body: string) => (_req: unknown, res: any) => (res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }), res.end(body));

beforeAll(async () => {
  frame = await startServer({ routes: { "/cadre": html(FRAME) } });
  // The frame is reached as localhost: another site than 127.0.0.1, so another process.
  page = await startServer({ routes: { "/cacher": html(PAGE(`http://localhost:${frame.port}/cadre`)) } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  w = await launchRessac({ dataDir, profile });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await resolveLocalHosts(m, ["localhost"]);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await page?.close();
  await frame?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
/** `expr` awaited in the chrome window, with `H` the RessacHideParent class and `b` the selected browser. */
const hide = <T = unknown>(expr: string, args: unknown[] = []) =>
  m.execute<T>(`const { RessacHideParent: H } = ChromeUtils.importESModule("${ACTOR}"); const b = ${B}, args = [...arguments]; return (async () => ${expr})();`, args);
const top = `b.browsingContext.currentWindowGlobal.getActor("RessacHide")`;
const pickAt = (p: { x: number; y: number }) => hide<{ text: string; rect: Rect; origin: string | null } | null>("H.pickAt(b, args[0], args[1])", [p.x, p.y]);
const hoverAt = (p: { x: number; y: number }) => hide<{ rect: Rect } | null>("H.hoverAt(b, args[0], args[1])", [p.x, p.y]);
const seen = () => inPage<string[]>("return window.__seen;");
/**
 * The page's records once a short window has passed after the last query: a style flush or layout our queries cause
 * (getComputedStyle, elementsFromPoint, Range rects) could only show up as a late transition, mutation or selection
 * change, dispatched within a frame or two.
 */
const seenAfter = async () => {
  await new Promise((r) => setTimeout(r, 100));
  return seen();
};
const rectOf = (sel: string) => inPage<Rect>(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
const inside = (r: Rect, box: Rect) => r.x >= box.x - 0.5 && r.y >= box.y - 0.5 && r.x + r.width <= box.x + box.width + 0.5 && r.y + r.height <= box.y + box.height + 0.5;

async function open(): Promise<void> {
  await openTab(m, `${page.url}/cacher`);
  // The frame's own document loaded (its actor answers for its site).
  await waitFor(m, `return ${B}.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec ?? "";`, (v) => typeof v === "string" && v.startsWith("http://localhost:"), 15_000);
  await expect.poll(() => inBrowser<string>(m, B, "return document.readyState;", { frame: 0 }), { timeout: 15_000 }).toBe("complete");
}

describe("RessacHide actor", () => {
  it("picks the span through opacity:0, transparent-colour and pointer-events:none layers; hover gives its box; the page sees nothing", async () => {
    await open();
    const at = await center(m, B, "#cible");
    const box = await rectOf("#cible");
    expect(await hoverAt(at)).toEqual({ rect: box });
    expect(await pickAt(at)).toEqual({ text: "Camille Aubrac", rect: box, origin: new URL(page.url).origin });
    // Queries move no mouse: no :hover transition, no event, no mutation, no selection change.
    expect(await seenAfter()).toEqual([]);
  });

  it("picks nothing on a wrapper's padding or over a display:none decoy; an invisible child stays out of the frozen text", async () => {
    await open();
    const wrap = await rectOf("#emballage");
    expect(await pickAt({ x: wrap.x + 10, y: wrap.y + 10 })).toBe(null);
    expect(await hoverAt({ x: wrap.x + 10, y: wrap.y + 10 })).toBe(null);
    // Where the display:none decoy would be: only the covers' invisible text is under the point.
    expect(await pickAt({ x: 110, y: 330 })).toBe(null);
    const d = await rectOf("#double");
    expect((await pickAt({ x: d.x + 10, y: d.y + d.height / 2 }))?.text).toBe("Camille");
    expect(await seenAfter()).toEqual([]);
  });

  it("a frame of another site answers for itself: its text, a rect in top-window px inside the frame, its origin; offsetOf adds up", async () => {
    await open();
    const at = await center(m, B, "#loin", 0);
    const frameBox = await rectOf("#cadre");
    const inner = await inBrowser<Rect>(m, B, `const r = document.getElementById("loin").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`, { frame: 0 });
    const picked = await pickAt(at);
    expect(picked?.text).toBe("Lucie Martin");
    expect(picked?.origin).toBe(`http://localhost:${frame.port}`);
    expect(inside(picked!.rect, frameBox)).toBe(true);
    expect(picked!.rect).toEqual({ ...inner, x: inner.x + frameBox.x, y: inner.y + frameBox.y });
    expect(await hide("H.offsetOf(b.browsingContext.children[0])")).toEqual({ x: frameBox.x, y: frameBox.y });
    expect(await seenAfter()).toEqual([]);
  });

  it("display-p3 text is pickable; an opacity:0 frame of another site over a span lets the pick through; an opaque box over a span stops it", async () => {
    await open();
    expect((await pickAt(await center(m, B, "#p3")))?.text).toBe("Jeanne Durand");
    const sous = await center(m, B, "#sous");
    // The transparent frame lies over the span at that point.
    const ids = await inPage<string[]>(`return document.elementsFromPoint(${sous.x}, ${sous.y}).map((e) => e.id);`);
    expect(ids.indexOf("voile")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("voile")).toBeLessThan(ids.indexOf("sous"));
    expect((await pickAt(sous))?.text).toBe("Paul Simon");
    const cache = await center(m, B, "#cache");
    const under = await inPage<string[]>(`return document.elementsFromPoint(${cache.x}, ${cache.y}).map((e) => e.id);`);
    expect(under.indexOf("plaque")).toBeGreaterThanOrEqual(0);
    expect(under.indexOf("plaque")).toBeLessThan(under.indexOf("cache"));
    expect(await pickAt(cache)).toBe(null);
    expect(await seenAfter()).toEqual([]);
  });

  it("pieces + rects: the visible text only, and the span's slice measured inside its box", async () => {
    await open();
    const pieces = await hide<{ text: string; block: boolean }[]>(`${top}.pieces()`);
    const all = pieces.map((p) => p.text).join("");
    expect(all).toContain("Camille Aubrac");
    expect(all).toContain("Calque sans pointeur");
    expect(all).not.toMatch(/Leurre|Couvercle|Couleur transparente|MutationObserver|Lucie/);
    expect(pieces.map((p) => p.text)).not.toContain("X");
    const i = pieces.findIndex((p) => p.text === "Camille Aubrac");
    expect(i).toBeGreaterThanOrEqual(0);
    const rects = await hide<Rect[][]>(`${top}.rects(args[0])`, [[[{ piece: i, from: 0, to: 7 }]]]);
    const box = await rectOf("#cible");
    expect(rects[0]!.length).toBeGreaterThan(0);
    for (const r of rects[0]!) expect(inside(r, box)).toBe(true);
    expect(await seenAfter()).toEqual([]);
  });

  it("selection: the current selection's text and rect, the origin from the parent; null when nothing is selected", async () => {
    await open();
    expect(await hide(`${top}.selection()`)).toBe(null);
    await inPage(`const r = document.createRange(); r.selectNodeContents(document.getElementById("cible")); getSelection().addRange(r); return 1;`);
    const s = await hide<{ text: string; rect: Rect; origin: string }>(`${top}.selection()`);
    expect(s.text).toBe("Camille Aubrac");
    expect(s.origin).toBe(new URL(page.url).origin);
    expect(inside(s.rect, await rectOf("#cible"))).toBe(true);
  });

  // Last: it moves the real mouse, which a later test's new tab would get as a mouseover.
  it("positive control: a real move over the page does reach the page's recorders", async () => {
    await open();
    await trustedMouse(m, B, await center(m, B, "#cible"), { move: true });
    await expect.poll(seen, { timeout: 10_000 }).toEqual(expect.arrayContaining(["mousemove", "transitionrun couvercle"]));
  });
});
