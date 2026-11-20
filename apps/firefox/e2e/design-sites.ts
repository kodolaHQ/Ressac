import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { HOOKS_PAGE } from "./design";
import type { Marionette } from "./marionette";
import { HOME_COPY, homePoint as framePoint, inHomeFrame, inSiteBar, inSiteView, siteHomeBrowser, siteWindowExpr } from "./sites";

// The design mode in site apps' windows (plan 36): e2e helpers and pages. Chrome context.

export const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];

/** The site window of app `id` and its view's <browser> (chrome expressions). */
export const siteExpr = (id: string) => siteWindowExpr(id);
export const viewExpr = (id: string) => `${siteWindowExpr(id)}.gBrowser.selectedBrowser`;

// The test pages and apps.
export const TUNING_PAGE = `<title>Tuning</title><div id="banniere" class="cookies">Cookies ?</div><a id="lien" href="/autre">autre</a><ul id="films"><li class="affiche">Film 1</li><li class="affiche">Film 2</li></ul><script>window.reactions = []; document.addEventListener("click", () => reactions.push("clic"), true);</script>`;
export const OTHER_PAGE = "<title>Autre</title>";
export const LOGIN_PAGE = "<title>Connexion</title>";
export const WITH_HOME = '<!doctype html><title>Accueil</title><h1 id="titre">Bienvenue</h1><p class="intro">Reprendre la série</p>';
export const tuningDeclaration = (url: (host: string, path?: string) => string) => ({
  name: "Tuning",
  url: url("tuning-a.localhost", "/"),
  domains: ["tuning-a.localhost"],
  login: ["compte-tuning.localhost"],
  tweaks: [{ matches: ["/*"], css: ["tuning.css"] }],
});
export const withHomeDeclaration = (url: (host: string, path?: string) => string) => ({
  name: "Avec accueil",
  url: url("tuning-a.localhost", "/"),
  domains: ["tuning-a.localhost"],
  login: ["compte-tuning.localhost"],
});

/** Spike S5's page: the hostile page (HOOKS_PAGE), plus a password field and a green target. */
export const S5_PAGE = HOOKS_PAGE.replace('<button type="submit" id="envoyer">', '<input type="password" id="mdp" name="mdp"> <button type="submit" id="envoyer">').replace(
  "</body>",
  '<div id="cible" style="position:absolute;left:300px;top:200px;width:80px;height:30px;background:rgb(0,200,0)"></div><p class="cache">caché</p></body>',
);

/**
 * Spike S5's tweak, run in RessacSite's sandbox after the password guard: it listens first (window capture), hooks
 * the prototypes the viewfinder calls (in its own world), fakes the viewfinder's globals, and on « essai » writes what
 * it sees into the DOM.
 */
export const TWEAK = `
const R = document.documentElement;
const log = { early: [], keys: [], hooked: [], fake: 0 };
for (const t of ${JSON.stringify(MOUSE)}) window.addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);
document.addEventListener("keydown", (e) => log.keys.push((e.target && e.target.id) + ":" + e.key + ":" + e.isTrusted), true);
const hook = (o, k) => { try { const f = o[k]; o[k] = function (...a) { log.hooked.push(k); return f.apply(this, a); }; } catch {} };
hook(Element.prototype, "attachShadow"); hook(Document.prototype, "createElement"); hook(Element.prototype, "getBoundingClientRect");
hook(window, "getComputedStyle"); hook(Document.prototype, "querySelectorAll"); hook(CSS, "escape");
globalThis.__viewfinderStop = () => log.fake++; globalThis.__viewfinderSwallow = () => log.fake++; globalThis.__viewfinderPick = () => log.fake++;
globalThis.__retoucheSecret = "r";
R.dataset.retouche = "oui";
document.addEventListener("essai", () => {
  const hosts = document.getElementsByTagName("ressac-viewfinder");
  const pw = document.getElementById("mdp");
  R.dataset.sonde = JSON.stringify({ log, hosts: hosts.length, shadow: hosts[0] ? String(hosts[0].shadowRoot) : "none", closed: hosts[0] ? typeof hosts[0].openOrClosedShadowRoot : "none",
    pw: pw.value, pwAttr: String(pw.getAttribute("value")), fakeIsMine: globalThis.__viewfinderStop.toString().includes("log.fake") });
});`;

/** Runs `body` (an async function body) with `store` the chrome's store. */
export const inStore = <T = unknown>(m: Marionette, body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);

const viewOf = (m: Marionette, id: string) => inStore<string | null>(m, `return store.sites.viewOf(arguments[0]);`, [id]);

/** App `id`'s window opened by the agent's sites.agir (or already open). */
export async function openSite(m: Marionette, id: string): Promise<void> {
  if (!(await inStore<boolean>(m, `return store.sites.openIds().includes(arguments[0]);`, [id])))
    await inStore(m, `await store.agent.request("sites.act", { id: arguments[0], action: "open", window: store.state.windows[0].id });`, [id]);
  await expect.poll(() => viewOf(m, id), { timeout: 15_000 }).not.toBeNull();
}

/** The site view of app `id`, on `path` of its start address (loaded by Ressac), its document complete. */
export async function toSite(m: Marionette, id: string, path = "/"): Promise<string> {
  await openSite(m, id);
  if ((await viewOf(m, id)) !== "site") await inStore(m, `store.sites.controller(arguments[0]).enter();`, [id]);
  const target = await inStore<string>(m, `return new URL(arguments[1], store.sites.siteOf(arguments[0]).start).href;`, [id, path]);
  await expect.poll(() => m.execute(`return ${viewExpr(id)}?.currentURI.spec ?? null;`), { timeout: 15_000 }).not.toBeNull();
  if ((await m.execute(`return ${viewExpr(id)}.currentURI.spec;`)) !== target) await inStore(m, `return store.sites.navigateForAgent(arguments[0], arguments[1]);`, [id, target]);
  await expect.poll(() => m.execute(`const b = ${viewExpr(id)}; return b.currentURI.spec === arguments[0] && !b.webProgress.isLoadingDocument;`, [target]), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => inSiteView(m, id, "return document.readyState;").catch(() => null), { timeout: 10_000 }).toBe("complete");
  return target;
}

/** The home in the bar of app `id`, shown and loaded from its served copy. */
export async function toHome(m: Marionette, id: string): Promise<void> {
  await openSite(m, id);
  if ((await viewOf(m, id)) !== "home") await inStore(m, `store.sites.controller(arguments[0]).home();`, [id]);
  await expect
    .poll(() => inHomeFrame<string | null>(m, siteHomeBrowser(id), `return document.readyState === "complete" ? document.documentURI : null;`).catch(() => null), { timeout: 15_000 })
    .toMatch(HOME_COPY);
}

/** A trusted gesture sent by the site window (as a person's mouse): a move, then a click of `button` unless `move`. */
export const siteMouse = (m: Marionette, id: string, p: { x: number; y: number }, o: { button?: number; move?: boolean } = {}) =>
  m.execute(
    `return (async ([x, y, button, move]) => {
       const win = ${siteExpr(id)};
       win.synthesizeMouseEvent("mousemove", x, y, { button: 0, clickCount: 0 });
       await new Promise((r) => setTimeout(r, 50));
       if (move) return;
       win.synthesizeMouseEvent("mousedown", x, y, { button, clickCount: 1 });
       win.synthesizeMouseEvent("mouseup", x, y, { button, clickCount: 1 });
       if (button === 2) win.synthesizeMouseEvent("contextmenu", x, y, { button: 2, clickCount: 1 });
     })(arguments);`,
    [p.x, p.y, o.button ?? 0, o.move ?? false],
  );

/** Trusted keys in the window `winExpr` (nsITextInputProcessor), to its focused element, with `mods` (Meta, Shift…) held. */
export const keyIn = (m: Marionette, winExpr: string, key: string, mods: string[] = []) =>
  m.execute(
    `const win = ${winExpr};
     const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
     tip.beginInputTransactionForTests(win);
     const mods = arguments[1].map((k) => new win.KeyboardEvent("", { key: k, code: k + "Left" }));
     for (const e of mods) tip.keydown(e);
     const ev = new win.KeyboardEvent("", { key: arguments[0], code: arguments[0].length === 1 ? "Key" + arguments[0].toUpperCase() : arguments[0] });
     tip.keydown(ev); tip.keyup(ev);
     for (const e of mods.reverse()) tip.keyup(e);`,
    [key, mods],
  );

/** Trusted keys in the site window (nsITextInputProcessor), to its focused element. */
export const siteKey = (m: Marionette, id: string, key: string, mods: string[] = []) => keyIn(m, siteExpr(id), key, mods);

/** The centre of `sel` in the app view, in the site window's coordinates (read in the page's world: before arming). */
export async function viewPoint(m: Marionette, id: string, sel: string): Promise<{ x: number; y: number }> {
  const c = await inSiteView<{ x: number; y: number }>(m, id, `const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  const b = await m.execute<{ x: number; y: number; z: number }>(`const r = ${viewExpr(id)}.getBoundingClientRect(); return { x: r.left, y: r.top, z: ${viewExpr(id)}.fullZoom };`);
  return { x: b.x + c.x * b.z, y: b.y + c.y * b.z };
}

/** The centre of `sel` in the home's frame, in the site window's coordinates. */
export async function homePoint(m: Marionette, id: string, sel: string): Promise<{ x: number; y: number }> {
  const [x, y] = await framePoint(m, siteHomeBrowser(id), sel);
  return { x, y };
}

/** `body` with `f` the site window's overlay frame (#ressac-design-calque) and `doc` its document; null while it is absent or hidden. */
export const overlayOf = <T = unknown>(m: Marionette, id: string, body: string, args: unknown[] = []) =>
  m.execute<T | null>(
    `const win = ${siteExpr(id)}, f = win?.document.getElementById("ressac-design-calque");
     if (!f || f.style.display === "none" || !f.getBoundingClientRect().width) return null;
     const doc = f.contentDocument;
     return (() => { ${body} })();`,
    args,
  );

/** The PNG's size (IHDR), the colours at `at` and every colour in it, decoded by the chrome. */
export async function readPng(m: Marionette, file: string, at: [number, number][]) {
  const buf = readFileSync(file);
  const decoded = await m.execute<{ at: number[][]; colours: string[] }>(
    `return (async ([b64, at]) => {
       const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
       img.src = "data:image/png;base64," + b64;
       await img.decode();
       const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       c.width = img.naturalWidth; c.height = img.naturalHeight;
       const x = c.getContext("2d");
       x.drawImage(img, 0, 0);
       const d = x.getImageData(0, 0, c.width, c.height).data, colours = new Set();
       for (let i = 0; i < d.length; i += 4) colours.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
       return { at: at.map(([px, py]) => [...x.getImageData(px, py, 1, 1).data].slice(0, 3)), colours: [...colours] };
     })(arguments);`,
    [buf.toString("base64"), at],
  );
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ...decoded };
}
