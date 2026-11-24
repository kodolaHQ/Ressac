import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
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
import { inBrowser, resolveLocalHosts } from "./sites";
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
// The page records what reaches it: pointer and wheel events, a :hover transition, scrolls. A span below the fold.
const SPY = `${PAGE}<style>body{height:4000px} #name{transition:color 1ms} #name:hover{color:rgb(1,2,3)}</style>
<span id="low" style="position:absolute;left:100px;top:2400px">Paul Simon</span>
<script>
  // Each event's type, and when (epoch ms, comparable with the chrome's clock on the same machine).
  window.__seen = [];
  window.__at = [];
  const note = (t, e) => (__seen.push(t), __at.push(performance.timeOrigin + e.timeStamp));
  document.addEventListener("transitionrun", (e) => note("transitionrun " + e.target.id, e), true);
  for (const t of ["mousemove", "mouseover", "mouseout", "mouseenter", "pointermove", "pointerover", "pointerenter", "pointerdown", "pointerup", "mousedown", "mouseup", "click", "wheel"]) addEventListener(t, (e) => note(t, e), true);
  addEventListener("scroll", (e) => __seen.at(-1) !== "scroll" && note("scroll", e));
</script>`;
// The known value glued to a neighbour with no whitespace node, only CSS spacing: the page text is « Jeanne DurandRéf ».
const GLUED = `<!doctype html><meta charset="utf-8"><title>Colle</title><body style="margin:0;font:16px/20px sans-serif">
<div style="position:absolute;left:100px;top:100px"><span id="glued">Jeanne Durand</span><span style="display:inline-block;margin-left:8px">Réf</span></div>
<div style="position:absolute;left:100px;top:160px"><span id="glued-new">Camille Aubrac</span><span style="display:inline-block;margin-left:8px">Réf</span></div>`;
const FRAME = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif"><span id="far" style="position:absolute;left:40px;top:40px">Lucie Martin</span>`;
const WITH_FRAME = (frame: string) => `${PAGE}<iframe src="${frame}" style="position:absolute;left:400px;top:340px;width:300px;height:120px;border:0"></iframe>`;

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
type Site = { url: string; close(): Promise<void> };
// The passport's sites are https only: the pages are served over TLS (a self-signed certificate, checks off for the run).
let server: Site;
// Another site: the passport entry written before the launch names it, so it is a source of the conversation.
let known: Site;
// A frame of another site (localhost), inside `server`'s page.
let frameSite: Site;
// The same page over plain http, a loopback host the test seam would let match: still no site (R7).
let plain: Awaited<ReturnType<typeof startServer>>;
let certs: string;
let tls: { key: Buffer; cert: Buffer };

async function startHttps(routes: Record<string, string>, host = "127.0.0.1"): Promise<Site> {
  const srv = createHttpsServer(tls, (req, res) => {
    const body = routes[(req.url ?? "").split("?")[0]!];
    if (body === undefined) return void res.writeHead(404).end();
    html(res, body);
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  return { url: `https://${host}:${port}`, close: () => new Promise((ok) => (srv.closeAllConnections(), srv.close(() => ok()))) };
}
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
let profile: string | undefined;

beforeAll(async () => {
  certs = mkdtempSync(join(os.tmpdir(), "ressac-cert-"));
  const [key, cert] = [join(certs, "key.pem"), join(certs, "cert.pem")];
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  tls = { key: readFileSync(key), cert: readFileSync(cert) };
  frameSite = await startHttps({ "/cadre.html": FRAME }, "localhost");
  server = await startHttps({ "/fiche.html": PAGE, "/espion.html": SPY, "/cadre-page.html": WITH_FRAME(`${frameSite.url}/cadre.html`), "/colle.html": GLUED });
  known = await startHttps({ "/fiche.html": PAGE, "/colle.html": GLUED });
  plain = await startServer({ routes: { "/fiche.html": (_req: unknown, res: ServerResponse) => html(res, PAGE) } });
});
afterAll(async () => {
  await Promise.all([server?.close(), known?.close(), frameSite?.close(), plain?.close()]);
  rmSync(certs, { recursive: true, force: true });
});
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
  // The self-signed certificate of the test sites: accepted for this run.
  await m.execute('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);');
  await resolveLocalHosts(m, ["localhost"]);
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

/** The toolbar button: the viewfinder armed, its layer taking the pointer. */
async function arm(): Promise<void> {
  await click(m, '[data-testid="hide-button"]');
  await waitFor(m, "return document.getElementById('ressac-hide-layer')?.style.pointerEvents", (v) => v === "auto");
}

/** The toolbar button, then the outline over `selector` (in the `frame`-th frame), moved to until the layer draws it, then the click. */
async function pick(selector: string, frame?: number, armed = false): Promise<void> {
  if (!armed) await arm();
  const at = await center(m, B, selector, frame);
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

it("a known value glued to a neighbour on the page: masked alone, not on this page, so the ending is notHere, never hidden", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${known.url}/colle.html`);
  await pick("#glued");
  expect(await bubbleText("hide-question")).toBe("Cacher « Jeanne Durand » pour l'agent ?");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await endingShown()).toBe("notHere");
  expect(await bubbleText("hide-toast")).toContain("Pas masqué sur cette page.");
});

it("a new value glued to a neighbour: the site is added, but the next conversation would not mask it here either, so notHere, never next", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/colle.html`);
  await pick("#glued-new");
  expect(await bubbleText("hide-question")).toBe("Cacher « Camille Aubrac » pour l'agent ?");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await endingShown()).toBe("notHere");
  expect(await bubbleText("hide-toast")).toContain("pas masqué sur cette page.");
  await expect.poll(async () => (await entryOf("Camille"))?.origins, { timeout: 15_000 }).toEqual([new URL(server.url).host]);
});

it("the agent reaches the tab while the bubble is up: the site is not added, ending agentReached", { timeout: 120_000 }, async () => {
  await start();
  const id = await tab(`${server.url}/fiche.html`);
  await pick("#name");
  expect(await bubbleText("hide-site")).toBe(`Sur ${new URL(server.url).host} et vos autres sources`);
  expect((await dispatch(m, { type: "agentNavigated", id })).tabs[id]?.agentReached).toBe(true);
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

it("an http page, even a loopback one the test seam would match: no site line, no site on the entry, ending notHere", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${plain.url}/fiche.html`);
  await pick("#name");
  expect(await bubbleText("hide-question")).toBe("Cacher « Camille Aubrac » pour l'agent ?");
  expect(await has("hide-site")).toBe(false);
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await endingShown()).toBe("notHere");
  await expect.poll(async () => (await entryOf("Camille"))?.origins, { timeout: 15_000 }).toEqual([]);
});

it("a value in a frame of another site: the bubble names the top page's site, and the entry gets it", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/cadre-page.html`);
  await waitFor(m, `return ${B}.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec ?? "";`, (v) => typeof v === "string" && v.startsWith("https://localhost:"), 15_000);
  await expect.poll(() => inBrowser<string>(m, B, "return document.readyState;", { frame: 0 }), { timeout: 15_000 }).toBe("complete");
  await pick("#far", 0);
  expect(await bubbleText("hide-question")).toBe("Cacher « Lucie Martin » pour l'agent ?");
  const host = new URL(server.url).host;
  expect(await bubbleText("hide-site")).toBe(`Sur ${host} et vos autres sources`);
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  await endingShown();
  await expect.poll(async () => (await entryOf("Lucie"))?.origins, { timeout: 15_000 }).toEqual([host]);
});

it("Annuler within 8 s removes the entry; a page the conversation read says the agent had already read it", { timeout: 120_000 }, async () => {
  await start();
  const id = await tab(`${server.url}/fiche.html`);
  expect((await allowing("read_tab", { id })).error).toBe(false);
  await pick("#name");
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await bubbleText("hide-read-before")).toBe("L'agent a peut-être déjà lu cette page.");
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

it("the page sees no pointer from the arm through the bubble; at the toast it gets the pointer and its clicks back", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/espion.html`);
  // The panel's press left the pointer somewhere: moved to Ressac's UI first, then the record starts.
  await inUi(m, `ui.synthesizeMouseEvent("mousemove", 5, 5, {}); return true;`);
  await inBrowser(m, B, "window.__seen.length = 0; window.__at.length = 0;");
  await pick("#name");
  expect(await bubbleText("hide-question")).toBe("Cacher « Camille Aubrac » pour l'agent ?");
  // The bubble is up: the pointer rests over the value picked, then moves a little there, as a hand does.
  const at = await center(m, B, "#name");
  await trustedMouse(m, B, { x: at.x + 3, y: at.y + 1 }, { move: true });
  await trustedMouse(m, B, at, { move: true });
  expect(await m.execute<string>("return document.getElementById('ressac-hide-layer').style.pointerEvents")).toBe("auto");
  // The release's instant, on the chrome's clock: the layer lets the pointer go when the toast comes.
  await m.execute(`const l = document.getElementById("ressac-hide-layer");
    window.ressacTestReleasedAt = 0;
    new MutationObserver(() => { if (!window.ressacTestReleasedAt && l.style.pointerEvents === "none") window.ressacTestReleasedAt = performance.timeOrigin + performance.now(); }).observe(l, { attributes: true, attributeFilter: ["style"] });`);
  await click(m, '[data-testid="hide-confirm"]', { frame: "hideBubble" });
  expect(await bubbleText("hide-toast")).toContain("Masqué pour l'agent");
  const releasedAt = await waitFor(m, "return window.ressacTestReleasedAt", (v) => typeof v === "number" && v > 0, 5000);
  // A late :hover transition or a synthetic move for the moves above would come within a frame or two: the window
  // starts at the release, the last moment the layer held the pointer.
  await new Promise((r) => setTimeout(r, 200));
  const [seen, times] = await inBrowser<[string[], number[]]>(m, B, "return [window.__seen, window.__at];");
  expect(seen.filter((_, i) => times[i]! < (releasedAt as number))).toEqual([]);
  // After the release the page may get the pointer back where it rests (measured 2026-11-24 at a close: pointerover,
  // pointerenter, mouseover, mouseenter about 150 ms later), the limit SECURITY.md states; not asserted.
  // The toast is still up, and a click on the page reaches it at once.
  expect(await has("hide-undo")).toBe(true);
  await trustedMouse(m, B, await center(m, B, "#words"));
  await expect.poll(() => inBrowser<string[]>(m, B, "return window.__seen;"), { timeout: 5000 }).toContain("click");
  expect(await has("hide-toast")).toBe(true);
});

it("a wheel while armed scrolls the page (no wheel event in it) and a span that was below the fold is picked", { timeout: 120_000 }, async () => {
  await start();
  await tab(`${server.url}/espion.html`);
  await inUi(m, `ui.synthesizeMouseEvent("mousemove", 5, 5, {}); return true;`);
  await inBrowser(m, B, "window.__seen.length = 0; window.__at.length = 0;");
  const below = await inBrowser<boolean>(m, B, `return document.getElementById("low").getBoundingClientRect().top > innerHeight;`);
  expect(below).toBe(true);
  await arm();
  // A wheel over the layer, at its middle, until the span is in view (the layer listens once its document has loaded).
  await expect
    .poll(async () => {
      await m.execute(`const b = ${B}, r = b.getBoundingClientRect(); window.windowUtils.sendWheelEvent(r.left + r.width / 2, r.top + r.height / 2, 0, 300, 0, WheelEvent.DOM_DELTA_PIXEL, 0, 0, 0, 0);`);
      return inBrowser<boolean>(m, B, `const r = document.getElementById("low").getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight - 20;`);
    }, { timeout: 15_000, interval: 200 })
    .toBe(true);
  await pick("#low", undefined, true);
  expect(await bubbleText("hide-question")).toBe("Cacher « Paul Simon » pour l'agent ?");
  const seen = await inBrowser<string[]>(m, B, "return window.__seen;");
  expect(seen).toContain("scroll");
  expect(seen).not.toContain("wheel");
  expect(seen.filter((e) => e !== "scroll")).toEqual([]);
});
