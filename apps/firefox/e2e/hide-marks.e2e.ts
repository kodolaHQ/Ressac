import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callMcpTool } from "../test/mcp";
import { writePassport } from "./passport-file";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { agentPanelReady, click, inUi } from "./ui";

// « Voir ce qu'il ne voit pas » (Task 5): while the agent's aura is on a tab, Ressac's marks frame hatches each text the
// agent receives masked there; the marks follow a scroll, fade with the aura, start over on a new page, and the page
// never learns.

type Rect = { x: number; y: number; width: number; height: number };
// Built from parts: no secret-shaped literal in the tree.
const IBAN = "FR76 3000 6000 " + "0112 3456 7890 189";
const RECORDER = `<script>
  window.__seen = [];
  new MutationObserver((rs) => { for (const r of rs) __seen.push("mutation " + r.type); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener("selectionchange", () => __seen.push("selectionchange"));
  document.addEventListener("transitionrun", (e) => __seen.push("transitionrun " + e.target.id), true);
  for (const t of ["mousemove", "mouseover", "pointermove", "mousedown", "click"]) addEventListener(t, () => __seen.push(t), true);
</script>`;
// `/compte/` makes a page the user reached a source (packages/kernel/src/access/sensitive.ts): the passport masks there.
const FICHE = `<!doctype html><meta charset="utf-8"><title>Fiche</title>
<body style="margin:0;font:16px/20px sans-serif;height:3000px">
<p style="position:absolute;left:40px;top:300px;margin:0">IBAN : <span id="iban">${IBAN}</span></p>
<p style="position:absolute;left:40px;top:360px;margin:0">Titulaire : <span id="nom">Camille Aubrac</span></p>
<p style="position:absolute;left:40px;top:420px;margin:0">Rien à cacher ici.</p>${RECORDER}`;
const AUTRE = `<!doctype html><meta charset="utf-8"><title>Autre</title>
<body style="margin:0;font:16px/20px sans-serif">
<p style="position:absolute;left:400px;top:600px;margin:0">Virement : <span id="iban">${IBAN}</span></p>${RECORDER}`;
const CARDS = '[data-testid="permission-request"] button, [data-testid="devtools-request"] button';

const html = (body: string) => (_req: unknown, res: ServerResponse) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
const dirs: string[] = [];
beforeAll(async () => {
  server = await startServer({ routes: { "/compte/fiche.html": html(FICHE), "/compte/autre.html": html(AUTRE), "/autre-onglet.html": html("<title>Ailleurs</title><p>Ailleurs</p>") } });
});
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out on ${what}: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A tool call through the window conversation's token (passport-masking.e2e.ts): its table resolves labels. */
function callTool(name: string, args: Record<string, unknown>) {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const config = readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => join(folder, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!config) throw new Error("no session config");
  return callMcpTool(join(w!.dataDir, "workspace"), name, args, config);
}

const B = "gBrowser.selectedBrowser";
const inPage = <T>(script: string) => inBrowser<T>(m, B, script);
const rectOf = (id: string) => inPage<Rect>(`const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
/** The hatches drawn in the marks frame, in its CSS px (the content area's, zoom 1: the page's viewport). */
const marks = () =>
  m.execute<Rect[]>(`const d = document.getElementById("ressac-hide-marks")?.contentDocument;
    return d ? [...d.querySelectorAll('[data-testid="hide-mark"]')].map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }) : [];`);
const meets = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const covers = (rs: Rect[], target: Rect) => rs.some((r) => meets(r, target));
const working = `return document.documentElement.hasAttribute("ressac-agent-working");`;

async function userTab(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}

it("the marks hatch what the agent receives masked, follow a scroll, fade with the aura, start over on a new page, and the page sees nothing", async () => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  await writePassport(profile, [{ id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, origins: [] }]);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_LOCAL_ADDRESSES: "1", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await until(async () => existsSync(join(w!.dataDir, "workspace", ".ressac", "mcp.json")), Boolean, "the MCP config", 20_000);
  await agentPanelReady(m);

  const other = await userTab(`${server.url}/autre-onglet.html`);
  const id = await userTab(`${server.url}/compte/fiche.html`);

  // A long tool on the tab that leaves it a source (unlike run_js): the profile holds the aura on for the whole test.
  let done = false;
  const profiling = callTool("profile_performance", { id, duration_s: 60 }).finally(() => (done = true));
  profiling.catch(() => {}); // the test ends long before it; Ressac closes under it
  await until(
    async () => {
      const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => x.textContent.trim().startsWith("Autoriser")); return b ? b.textContent.trim() : null;`, [CARDS]);
      // The card may go between the look and the press: looked at again on the next turn.
      if (label) await click(m, CARDS, { text: label }).catch(() => {});
      return (await m.execute<boolean>(working)) || done;
    },
    Boolean,
    "the aura",
    30_000,
  );
  expect(done, "the profile ended before the aura came on").toBe(false);
  // The card's press left the pointer over the page, which got a mouseover as the card left (measured): the pointer
  // goes to Ressac's UI and the recorder starts here, so a tab shown again under it sends nothing either. The marks'
  // first show is checked again below, when the aura comes back.
  await inUi(m, `ui.synthesizeMouseEvent("mousemove", 5, 5, {}); return true;`);
  await inPage("window.__seen.length = 0; return true;");

  // The IBAN (a detector's form) and the passport's name are hatched; the plain line is not.
  const [iban, name, plain] = [await rectOf("iban"), await rectOf("nom"), await inPage<Rect>(`const p = document.querySelectorAll("p")[2].getBoundingClientRect(); return { x: p.x, y: p.y, width: p.width, height: p.height };`)];
  const first = await until(marks, (rs) => covers(rs, iban) && covers(rs, name), "the hatches over the IBAN and the name");
  expect(covers(first, plain)).toBe(false);

  // A scroll of the page: the hatches follow (their rects move with the text; the re-measure's rhythm is the unit test's).
  await inPage("window.scrollBy(0, 200); return true;");
  const [iban2, name2] = [await rectOf("iban"), await rectOf("nom")];
  expect(iban2.y).toBeCloseTo(iban.y - 200, 0);
  await until(marks, (rs) => covers(rs, iban2) && covers(rs, name2) && !covers(rs, iban), "the hatches after the scroll");

  // The aura goes off (another tab shown, at once): the hatches fade (an opacity transition ends) and are gone.
  await m.execute(`const d = document.getElementById("ressac-hide-marks").contentDocument;
    window.ressacTestFaded = false;
    d.querySelector('[data-testid="hide-marks"]').addEventListener("transitionend", (e) => {
      if (e.propertyName === "opacity" && d.defaultView.getComputedStyle(e.target).opacity === "0") window.ressacTestFaded = true;
    });`);
  await dispatch(m, { type: "activateTab", id: other });
  await waitFor(m, working, (v) => v === false, 10_000);
  await waitFor(m, "return window.ressacTestFaded;", (v) => v === true, 10_000);
  await until(marks, (rs) => rs.length === 0, "no hatch once faded");

  // The tab shown again (the profile still runs there): the aura and its hatches come back.
  await dispatch(m, { type: "activateTab", id });
  await waitFor(m, working, (v) => v === true, 20_000);
  const back = [await rectOf("iban"), await rectOf("nom")];
  await until(marks, (rs) => back.every((r) => covers(rs, r)), "the hatches back with the aura");
  // The page saw none of it: no mutation, selection, transition or pointer event. Read only now, after several
  // measures (the first show, the scroll, the fade, the show again), so every kind of refresh had its chance to leak.
  expect(await inPage<string[]>("return window.__seen;")).toEqual([]);

  // A new page with the aura on: only its own hatches, none left from the old page.
  await inPage(`location.href = "/compte/autre.html"; return true;`);
  await waitFor(m, `return ${B}.currentURI.spec.endsWith("/compte/autre.html") && !${B}.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
  const next = await rectOf("iban");
  await until(marks, (rs) => rs.length > 0 && rs.every((r) => meets(r, next)), "only the new page's hatches");
  // The aura is still on over the new page (the profile runs on): the old page's hatches went for the new document,
  // not because the aura went out.
  await waitFor(m, working, (v) => v === true, 20_000);
  expect(await inPage<string[]>("return window.__seen;")).toEqual([]);
}, 180_000);

/** The composited window's pixel at the first hatch's centre, with the hatches filled green for the read. */
const hatchPixel = () =>
  m.execute<number[]>(`return (async () => {
    const f = document.getElementById("ressac-hide-marks"), d = f.contentDocument;
    const style = d.createElement("style");
    style.textContent = ".mark { background: rgb(0, 255, 0) !important; border-radius: 0 !important }";
    d.head.append(style);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const a = f.getBoundingClientRect(), r = d.querySelector('[data-testid="hide-mark"]').getBoundingClientRect();
      const bitmap = await window.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(a.x + r.x + r.width / 2, a.y + r.y + r.height / 2, 1, 1), 1, "white");
      const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      c.width = c.height = 1;
      const g = c.getContext("2d");
      g.drawImage(bitmap, 0, 0);
      return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    } finally {
      style.remove();
    }
  })();`);

it("the viewfinder of « Cacher pour l'agent » shows the hatches without the aura, and leaving it takes them away", async () => {
  const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  await writePassport(profile, [{ id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, origins: [] }]);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_LOCAL_ADDRESSES: "1", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await until(async () => existsSync(join(w!.dataDir, "workspace", ".ressac", "mcp.json")), Boolean, "the MCP config", 20_000);
  const other = await userTab(`${server.url}/autre-onglet.html`);
  const id = await userTab(`${server.url}/compte/fiche.html`);
  await inPage("window.__seen.length = 0; return true;");
  expect(await marks()).toEqual([]);

  // Armed: the passport's name and the IBAN are hatched, no aura needed; the plain line is not.
  await click(m, '[data-testid="hide-button"]');
  await waitFor(m, "return document.getElementById('ressac-hide-layer')?.style.pointerEvents", (v) => v === "auto");
  expect(await m.execute<boolean>(working)).toBe(false);
  const [iban, name, plain] = [await rectOf("iban"), await rectOf("nom"), await inPage<Rect>(`const p = document.querySelectorAll("p")[2].getBoundingClientRect(); return { x: p.x, y: p.y, width: p.width, height: p.height };`)];
  const shown = await until(marks, (rs) => covers(rs, iban) && covers(rs, name), "the hatches while picking");
  expect(covers(shown, plain)).toBe(false);
  // Painted over the page, not only laid out: a pixel at the name's hatch, read from the window's composited snapshot
  // with the hatch filled green (at z-index 2 the page covered the marks frame and only rects were right).
  expect(await hatchPixel()).toEqual([0, 255, 0]);

  // A second press leaves the viewfinder: the hatches go.
  await click(m, '[data-testid="hide-button"]');
  await until(marks, (rs) => rs.length === 0, "no hatch once the viewfinder is left");
  expect(await inPage<string[]>("return window.__seen.filter((e) => !/^(mouse|pointer|click)/.test(e));")).toEqual([]);

  // Armed again, then another tab shown: the gesture closes and the hatches go with it, none drawn over the other tab.
  await click(m, '[data-testid="hide-button"]');
  await until(marks, (rs) => covers(rs, name), "the hatches while picking again");
  await dispatch(m, { type: "activateTab", id: other });
  await until(marks, (rs) => rs.length === 0, "no hatch after the tab switch");
  await waitFor(m, "return document.getElementById('ressac-hide-marks')?.style.display", (v) => v === "none", 10_000);
  // Back on the page, the viewfinder is closed: no hatch comes back without it.
  await dispatch(m, { type: "activateTab", id });
  await new Promise((r) => setTimeout(r, 1500)); // > RUNS_FRESH_MS + MARKS_EVERY_MS: a stray start would have drawn by now
  expect(await marks()).toEqual([]);
}, 120_000);
