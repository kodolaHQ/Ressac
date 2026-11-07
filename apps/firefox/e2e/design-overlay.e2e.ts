import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { placeBulle } from "../chrome/store/design-copies";
import { INVALID_REQUEST } from "../shared/design-guards";
import { openTab, testActor } from "./agent-extensions";
import { startDesignServers, trustedMouse } from "./design";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inBrowser, resolveLocalHosts } from "./sites";
import { click, inUi, pressKeys, typeText } from "./ui";

// Plan 35b Task 3: the design overlay (sidebar.html?calque), its bubble and the main window's cart column, driven by
// api.design.basculer() in the UI (⌘⇧D comes with Task 4). The demo is 127.0.0.1:15308, in this file's block 15305-15309.

const PORT = 15308;
const PROJECT = `demo-${PORT}`;
const B = "gBrowser.selectedBrowser";
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let servers: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;
const dirs: string[] = [];

/** WebAiOs on the demo's port block, on `dataDir` and `profile`, its host answering. */
async function boot(): Promise<void> {
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { ...a.env, WEBAIOS_PORTS_APPS: "15305-15309" }, prefs: a.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(m, ["localhost"]);
  await waitFor(m, `return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; return d.etat({ type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }).then(() => true, () => false); })();`, (v) => v === true, 30_000);
}

beforeAll(async () => {
  servers = await startDesignServers({ port: PORT });
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  await boot();
}, 120_000);
afterAll(async () => {
  await w?.close();
  await servers?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Runs `body` with `d` the design service, `t` this window's target, `store` the store. */
const svc = <R = unknown>(body: string, args: unknown[] = []) =>
  m.execute<R>(
    `return (async (args) => { const store = await ChromeUtils.importESModule("${STORE}").ready, d = store.design; const t = { type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }; ${body} })([...arguments]);`,
    args,
  );
const etat = () => svc<{ actif: boolean; panier: number; projet: { projet: string } | null }>("return await d.etat(t);");
/** The UI's own api.design.basculer(), as ✎ will call it. */
const basculer = () => inUi(m, "ui.webaios.design.basculer(); return 1;");
const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
const hosts = () => inPage<number>(`return document.querySelectorAll("webaios-viseur").length;`);

async function open(p = "/"): Promise<void> {
  await openTab(m, `${servers.page}${p}`);
  await m.execute(`${B}.focus();`);
}

/** A chrome frame's state: shown (laid out), its rectangle, and `body` run in its document (`doc`). */
const frameOf = <T = unknown>(id: "webaios-design-calque" | "webaios-design-volet", body = "return null;") =>
  m.execute<{ shown: boolean; rect: { x: number; y: number; width: number; height: number }; v: T } | null>(
    `const f = document.getElementById(arguments[0]);
     if (!f) return null;
     const r = f.getBoundingClientRect(), doc = f.contentDocument;
     return { shown: f.style.display !== "none" && r.width > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, v: (() => { ${body} })() };`,
    [id],
  );
const bubbleText = async () => (await frameOf<string | null>("webaios-design-calque", `return doc?.querySelector('[data-testid="bulle-design"]')?.textContent ?? null;`))?.v ?? null;
const bubbleShown = async () => (await frameOf("webaios-design-calque"))?.shown ?? false;
const columnShown = async () => (await frameOf("webaios-design-volet"))?.shown ?? false;
const cartLines = async () => (await frameOf<string[]>("webaios-design-volet", `return [...(doc?.querySelectorAll('[data-testid="remarque-panier"]') ?? [])].map((e) => e.textContent);`))?.v ?? [];
const pageWidth = () => inPage<number>("return innerWidth;");

/** The mode on through the UI, the viewfinder armed. */
async function modeOn() {
  await basculer();
  await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(true);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
async function modeOff() {
  if ((await etat()).actif) await svc("await d.stop(t); return 1;");
  await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
}

/** A trusted click on `sel`: its bubble, with the keyboard in its textarea. */
async function aim(sel: string, label: string) {
  await trustedMouse(m, B, sel);
  await expect.poll(bubbleText, { timeout: 10_000 }).toContain(label);
  await expect.poll(() => frameOf<string | null>("webaios-design-calque", "return doc.activeElement?.localName ?? null;").then((f) => f?.v), { timeout: 10_000 }).toBe("textarea");
}

/** `text` typed in the bubble, then « Ajouter au panier »: the cart grows by one. */
async function remark(sel: string, label: string, text: string) {
  const n = (await etat()).panier;
  await aim(sel, label);
  await typeText(m, text);
  await click(m, "button.ajouter", { frame: "calque" });
  await expect.poll(async () => (await etat()).panier, { timeout: 10_000 }).toBe(n + 1);
}

describe("design overlay", () => {
  it("design.spec.ts:340 on the demo: cart column, bubble on #email, remark in the cart, viewfinder armed again; Annuler then Escape", async () => {
    await open();
    const before = await pageWidth();
    await modeOn();
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(true);
    await expect.poll(pageWidth, { timeout: 10_000 }).toBe(before - 300);
    await remark("#email", "input#email.champ", "Champ plus large");
    await expect.poll(bubbleShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(cartLines, { timeout: 10_000 }).toHaveLength(1);
    expect((await cartLines())[0]).toContain("input#email.champ");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    // Annuler (Escape in the bubble): nothing added, the viewfinder comes back at once.
    await aim("#envoyer", "button#envoyer");
    await pressKeys(m, "Escape");
    await expect.poll(bubbleShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    expect(await cartLines()).toHaveLength(1);
    // Escape in the page: the mode stops, the column closes, the cart stays.
    await m.execute(`${B}.focus();`);
    await pressKeys(m, "Escape");
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(pageWidth, { timeout: 10_000 }).toBe(before);
    expect(await hosts()).toBe(0);
    expect((await etat()).panier).toBe(1);
    expect(await inPage("return window.reactions;")).toEqual([]);
  });

  it("the cart column shrinks the page by 300 px and is never covered", async () => {
    await open();
    const before = await pageWidth();
    await modeOn();
    await expect.poll(pageWidth, { timeout: 10_000 }).toBe(before - 300);
    const g = await m.execute<{ browserRight: number; voletLeft: number; voletWidth: number; voletRight: number; right: number; atVolet: string | undefined; top: number; tabboxTop: number; bottom: number; height: number }>(
      `const b = ${B}.getBoundingClientRect(), f = document.getElementById("webaios-design-volet"), v = f.getBoundingClientRect();
       const agent = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--webaios-agent")) || 0;
       return { browserRight: b.right, voletLeft: v.left, voletWidth: v.width, voletRight: v.right, right: window.innerWidth - agent, atVolet: document.elementFromPoint(v.left + 10, v.top + v.height / 2)?.id,
         top: v.top, tabboxTop: document.getElementById("tabbrowser-tabbox").getBoundingClientRect().top, bottom: v.bottom, height: window.innerHeight };`,
    );
    expect(g.voletWidth).toBe(300);
    expect(g.browserRight).toBe(g.voletLeft);
    expect(g.voletRight).toBe(g.right);
    expect(g.atVolet).toBe("webaios-design-volet");
    expect([g.top, g.bottom]).toEqual([g.tabboxTop, g.height]);
    await modeOff();
    await expect.poll(pageWidth, { timeout: 10_000 }).toBe(before);
  });

  it("the bubble takes the keyboard, ⌘Enter adds, Escape cancels, then the page has it back", async () => {
    await open();
    await modeOn();
    const n = (await etat()).panier;
    await aim("#email", "input#email.champ");
    expect(await m.execute("return document.activeElement?.id;")).toBe("webaios-design-calque");
    await inPage("window.typed = []; addEventListener('keydown', (e) => typed.push(e.key), true); return 1;");
    await typeText(m, "ab");
    expect(await frameOf<string>("webaios-design-calque", "return doc.querySelector('textarea').value;").then((f) => f?.v)).toBe("ab");
    await pressKeys(m, "Meta+Enter");
    await expect.poll(async () => (await etat()).panier, { timeout: 10_000 }).toBe(n + 1);
    await expect.poll(bubbleShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => m.execute("return document.activeElement?.localName;"), { timeout: 10_000 }).toBe("browser");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await aim("#envoyer", "button#envoyer");
    await typeText(m, "x");
    await pressKeys(m, "Escape");
    await expect.poll(bubbleShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => m.execute("return document.activeElement?.localName;"), { timeout: 10_000 }).toBe("browser");
    // Nothing leaves without ⌘Enter or « Ajouter »: the text typed then cancelled is not in the cart.
    expect((await etat()).panier).toBe(n + 1);
    expect(await inPage("return window.typed;")).toEqual([]);
    await pressKeys(m, "b");
    await expect.poll(() => inPage<string[]>("return window.typed;"), { timeout: 10_000 }).toEqual(["b"]);
    expect(await inPage("return document.hasFocus();")).toBe(true);
    await modeOff();
  });

  it("outside the bubble, the page gets clicks and the wheel", async () => {
    await open();
    await modeOn();
    await aim("#email", "input#email.champ");
    // After the capture's 500 ms swallow (the rest of a double click).
    await sleep(700);
    await inPage("window.got = []; for (const t of ['mousedown', 'click', 'wheel']) addEventListener(t, (e) => got.push(t), true); return 1;");
    const hits = await m.execute<{ onBubble: string; outside: string }>(
      `const b = ${B}.getBoundingClientRect(), f = document.getElementById("webaios-design-calque").getBoundingClientRect();
       const hit = (x, y) => { const e = document.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; };
       const x = b.left + b.width - 50, y = b.top + b.height - 50;
       const out = { onBubble: hit(f.left + 20, f.top + 20), outside: hit(x, y) };
       window.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 }); window.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });
       window.windowUtils.sendWheelEvent(x, y, 0, 100, 0, 0, 0, 0, 0, 0);
       return out;`,
    );
    expect(hits).toEqual({ onBubble: "iframe#webaios-design-calque", outside: "browser" });
    await expect.poll(() => inPage<string[]>("return window.got;"), { timeout: 10_000 }).toEqual(["mousedown", "click", "wheel"]);
    expect(await bubbleShown()).toBe(true);
    await pressKeys(m, "Escape");
    await modeOff();
  });

  it("Fermer of the cart stops an active mode and clears Panier", async () => {
    await open();
    await modeOn();
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(true);
    await click(m, 'button[aria-label="Fermer le panier"]', { frame: "volet" });
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
    await expect.poll(hosts, { timeout: 10_000 }).toBe(0);
    // Panier cleared: nothing opens the column again.
    await sleep(500);
    expect(await columnShown()).toBe(false);
  });

  it("an overlay asking another project's cart gets nothing (projetPermis); its target is the chrome's; overlay and page cannot see each other", async () => {
    await open();
    await modeOn();
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(true);
    await expect.poll(cartLines, { timeout: 10_000 }).not.toHaveLength(0);
    await svc(`window.__calls = []; const real = (store.agent.__real ??= store.agent.request); store.agent.request = (method, p) => (window.__calls.push(method + " " + p?.projet), real.call(store.agent, method, p)); return 1;`);
    try {
      const answers = await m.execute<unknown[]>(
        `const api = document.getElementById("webaios-design-volet").contentWindow.webaios;
         return Promise.all([api.panier("demo-15307"), api.lots("app-autre"), api.envoyer("demo-15307"), api.retirer("demo-15307", "e"), api.traite("demo-15307", "l")]);`,
      );
      expect(answers).toEqual([[], [], { ok: false, erreur: INVALID_REQUEST }, null, null]);
      // The column's own reads of its project go on; nothing ever asked for another project.
      expect(await m.execute<string[]>(`return window.__calls.filter((c) => c.startsWith("design.") && !c.startsWith("design.suivi") && !c.endsWith(" ${PROJECT}"));`)).toEqual([]);
      const own = await m.execute<unknown[]>(`return document.getElementById("webaios-design-volet").contentWindow.webaios.panier(arguments[0]);`, [PROJECT]);
      expect(own.length).toBeGreaterThan(0);
      expect(await m.execute<string[]>("return window.__calls;")).toContain(`design.panier ${PROJECT}`);
    } finally {
      await svc("if (store.agent.__real) store.agent.request = store.agent.__real; return 1;");
    }
    // The target is the chrome's: the frame's address names none, and the overlay cannot reach the page's document.
    const overlay = await m.execute<{ search: string[]; page: unknown }>(
      `const f = document.getElementById("webaios-design-volet").contentWindow, c = document.getElementById("webaios-design-calque")?.contentWindow;
       return { search: [f.location.search, c ? c.location.search : "?calque"], page: f.parent.gBrowser.selectedBrowser.contentDocument };`,
    );
    expect(overlay).toEqual({ search: ["?calque", "?calque"], page: null });
    // The page sees no overlay: it is its own top, with no frame element, no api, no frame of ours.
    expect(await inPage("return { top: window.top === window, parent: window.parent === window, frame: window.frameElement, api: typeof window.webaios, frames: window.frames.length };")).toEqual({
      top: true, parent: true, frame: null, api: "undefined", frames: 0,
    });
    await modeOff();
  });

  it("zoomed (1.5) and scrolled: the bubble sits under the element", async () => {
    await open("/cible");
    await m.execute(`${B}.fullZoom = 1.5;`);
    await inPage("scrollTo(0, 700); return 1;");
    await expect.poll(() => inPage<number>("return scrollY;"), { timeout: 10_000 }).toBe(700);
    await modeOn();
    await aim("#cible", "div#cible");
    const r = await inPage<{ x: number; y: number; largeur: number; hauteur: number }>(`const r = document.querySelector("#cible").getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height };`);
    const g = await m.execute<{ z: number; x: number; y: number; width: number; height: number; w: number; h: number }>(
      `const r = ${B}.getBoundingClientRect(); return { z: ${B}.fullZoom, x: r.x, y: r.y, width: r.width, height: r.height, w: window.innerWidth, h: window.innerHeight };`,
    );
    const f = (await frameOf("webaios-design-calque"))!;
    const p = placeBulle(r, g.z, g, [g.w, g.h]);
    expect(f.rect).toEqual({ x: p.x, y: p.y, width: p.width, height: p.height });
    // Under the element as the chrome shows it (CSS px × zoom, from the view's edge).
    expect(f.rect.y).toBeGreaterThanOrEqual(g.y + (r.y + r.hauteur) * 1.5);
    await click(m, "button.annuler", { frame: "calque" });
    await expect.poll(bubbleShown, { timeout: 10_000 }).toBe(false);
    await modeOff();
    await m.execute(`${B}.fullZoom = 1;`);
  });

  it("pushState under an open bubble keeps the remark, then the viewfinder is armed again", async () => {
    await open();
    await modeOn();
    const n = (await etat()).panier;
    await aim("#email", "input#email.champ");
    await inPage(`history.pushState({}, "", "/x"); return 1;`);
    await sleep(300);
    expect(await bubbleShown()).toBe(true);
    await typeText(m, "reste");
    await click(m, "button.ajouter", { frame: "calque" });
    await expect.poll(async () => (await etat()).panier, { timeout: 10_000 }).toBe(n + 1);
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    expect((await etat()).actif).toBe(true);
    await modeOff();
  });

  it("design.spec.ts:379 two remarks, reload then restart: the mode is off, the cart stays (<dataDir>/espace/.webaios/remarques/demo-15308)", { timeout: 120_000 }, async () => {
    await open();
    const n = (await etat()).panier;
    await modeOn();
    await remark("#email", "input#email.champ", "Champ plus large");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await remark("#envoyer", "button#envoyer", "Bouton en vert");
    await m.execute(`${B}.reload();`);
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
    expect((await etat()).panier).toBe(n + 2);
    await w.close();
    await boot();
    await open();
    await expect.poll(async () => (await etat()).panier, { timeout: 15_000 }).toBe(n + 2);
    expect((await etat()).actif).toBe(false);
    expect(await columnShown()).toBe(false);
    const file = path.join(dataDir, "espace", ".webaios", "remarques", PROJECT, "panier.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(n + 2);
  });

  // Last: it stops the host.
  it("host down while the bubble is open: Ajouter shows the call's error in the bubble, the mode stays; started again, the state reads", async () => {
    await open();
    await modeOn();
    await aim("#email", "input#email.champ");
    await svc("await store.agent.stop(); return 1;");
    await typeText(m, "perdue");
    await click(m, "button.ajouter", { frame: "calque" });
    await expect.poll(() => frameOf<string | null>("webaios-design-calque", `return doc.querySelector('[role="alert"]')?.textContent ?? null;`).then((f) => f?.v ?? null), { timeout: 10_000 }).toBeTruthy();
    expect(await bubbleShown()).toBe(true);
    expect(await svc("return d.overlayContext(t)?.mode ?? null;")).toBe("bulle");
    // Réessayer: the host starts again; the UI's design state reads as on.
    await svc("await store.agent.ensure(); return 1;");
    await expect
      .poll(() => inUi<boolean | null>(m, "return ui.webaios.design.etat().then((e) => e.actif, () => null);"), { timeout: 30_000 })
      .toBe(true);
    await pressKeys(m, "Escape");
    await modeOff();
  });
});
