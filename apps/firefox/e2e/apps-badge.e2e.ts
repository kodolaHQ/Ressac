import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { reviewUrl } from "../shared/model";
import { APPS_ENV, appRow, appWindowExpr, closeAppsPage, inAppView, launchAttempt, rowButton, rowMenuItems, writeProject, type AppsPage } from "./apps";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { LINES, reviewedRef, writeAppJs } from "./review";
import { inUi, waitUi } from "./ui";

// Plan 35a Task 5: the app window's badge (AppBadge.svelte in sidebar.html?badge=) and the
// agent apps' review, plus the security
// checks of spike S8 on the real code.

const BLOCK: [number, number] = [15295, 15299];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `body` in the chrome with `win` (app `dossier`'s window), `f` (its badge frame) and `doc` (the badge's document). */
const inBadge = <T = unknown>(m: Marionette, folder: string, body: string, args: unknown[] = []) =>
  m.execute<T>(
    `return (async () => { const win = ${appWindowExpr(folder)}; const f = win?.document.getElementById("webaios-app-badge"); const doc = f?.contentDocument;
     if (!doc?.querySelector('[data-testid="webaios-pill"]')) return null; ${body} })();`,
    args,
  );
/** The badge frame's place in its window: [right margin, top, width, height]. */
const place = (m: Marionette, folder: string) =>
  inBadge<number[]>(m, folder, "const r = f.getBoundingClientRect(); return [Math.round(win.innerWidth - r.right), Math.round(r.top), Math.round(r.width), Math.round(r.height)];");
const sized = (m: Marionette, folder: string, w: number, h: number) =>
  expect.poll(() => place(m, folder), { timeout: 10_000 }).toEqual([12, 12, w, h]);
/** Clicks `selector` in the badge's document. */
const clickBadge = (m: Marionette, folder: string, selector: string, text?: string) =>
  expect
    .poll(() => inBadge(m, folder, "const el = [...doc.querySelectorAll(arguments[0])].find((e) => !arguments[1] || e.textContent.includes(arguments[1])); if (!el) return false; el.click(); return true;", [selector, text ?? null]), { timeout: 10_000 })
    .toBe(true);
/** The agent's access to app `dossier`, cut from its badge. */
async function cutAccess(m: Marionette, folder: string): Promise<void> {
  await clickBadge(m, folder, '[data-testid="access-pill"]');
  await clickBadge(m, folder, '[data-testid="access-bubble"] button.cut');
  await expect.poll(() => inBadge(m, folder, `return doc.querySelectorAll('[data-testid="access-pill"]').length;`), { timeout: 10_000 }).toBe(0);
}
/** The access the badge's own api gives, its tab ids. */
const badgeAccess = (m: Marionette, folder: string) => inBadge<string[]>(m, folder, "return Object.keys((await f.contentWindow.webaios.access.state()).tabs);");
const reviewTabs = async (m: Marionette, project: string) => Object.values((await state(m)).tabs).filter((o) => o.url === reviewUrl(project));

describe("one WebAiOs, essai and autre launched in each test", () => {
  let p: AppsPage;
  let m: Marionette;

  beforeAll(async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "webaios-data-"));
    const profile = await mkdtemp(join(os.tmpdir(), "webaios-firefox-"));
    // relecture.spec.ts:20-27: essai with app.js (30 lines) and logo.bin; autre a second application; vieux without manifest.
    writeProject(dataDir, "essai", { manifest: { name: "Essai" } });
    writeAppJs(join(dataDir, "workspace", "projects", "essai"), LINES);
    writeFileSync(join(dataDir, "workspace", "projects", "essai", "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeProject(dataDir, "autre", { manifest: { name: "Autre" } });
    writeProject(dataDir, "vieux");
    const w = await launchWebAiOs({ dataDir, profile, env: APPS_ENV(BLOCK) });
    m = w.marionette;
    p = { w, m, dataDir, profile };
    await m.setContext("chrome");
    await waitReady(m);
    // Not expect.poll: run from beforeAll.
    for (const end = Date.now() + 15_000; !existsSync(join(dataDir, "workspace", ".webaios", "mcp.json")); await sleep(100))
      if (Date.now() > end) throw new Error("the MCP server did not start");
  }, 90_000);
  afterAll(() => closeAppsPage(p));
  afterEach(async () => {
    for (const folder of ["essai", "autre"]) await callTool(p.dataDir, "stop_app", { folder: folder }).catch(() => {});
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.hasAttribute("webaios-app")).length;`, (n) => n === 0);
    await waitFor(m, "for (const t of gBrowser.tabs.slice(1)) gBrowser.removeTab(t); return gBrowser.tabs.length;", (n) => n === 1);
  });
  /** App `dossier` launched with the agent's tool, its view loaded and its badge mounted. */
  async function launched(folder = "essai"): Promise<void> {
    if (folder === "essai") await launchAttempt(p.dataDir);
    else expect((await callTool(p.dataDir, "launch_app", { folder: folder })).text).toMatch(/en marche sur/);
    await waitFor(m, `const b = ${appWindowExpr(folder)}?.gBrowser.selectedBrowser; return !!b && b.currentURI.spec.startsWith("http://localhost:") && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
    await expect.poll(() => place(m, folder), { timeout: 10_000 }).not.toBeNull();
  }

  // relecture.spec.ts:52
  it("at start the first photo of essai exists (refs/webaios/relu under <dataDir>/design/review/app-essai.git) and no .git appears in projets/essai", async () => {
    await expect.poll(() => existsSync(reviewedRef(p.dataDir, "app-essai")), { timeout: 15_000 }).toBe(true);
    const projects = join(p.dataDir, "workspace", "projects");
    expect(readdirSync(join(projects, "essai")).sort()).toEqual(["app.js", "logo.bin", "serveur.mjs", "webaios.json"]);
    expect(existsSync(join(projects, ".git"))).toBe(false);
    // A project without manifest gets no snapshot.
    expect(existsSync(reviewedRef(p.dataDir, "app-vieux"))).toBe(false);
  });

  it("the badge paints top right, 48×28; clicks beside it reach the page", async () => {
    await launched();
    await cutAccess(m, "essai");
    await sized(m, "essai", 48, 28);
    const placed = await m.execute<{ view: number[]; frame: number[] }>(
      `const win = ${appWindowExpr("essai")}, v = win.gBrowser.selectedBrowser.getBoundingClientRect(), r = win.document.getElementById("webaios-app-badge").getBoundingClientRect();
       return { view: [v.left, v.top, v.width, v.height], frame: [r.left, r.top, r.width, r.height] };`,
    );
    const [fx, fy, fw, fh] = placed.frame as [number, number, number, number];
    const [bx, by, bw, bh] = placed.view as [number, number, number, number];
    // The paint (spike S8): the WebAiOs button in the badge, the page around it and through its transparent corner.
    const shot = await m.execute<{ button: number[]; corner: number[]; outside: number[] }>(
      `return (async () => { const win = ${appWindowExpr("essai")}, [fx, fy, fw, fh, bx, by] = arguments;
       const shot = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, win.devicePixelRatio, "white");
       const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       c.width = shot.width; c.height = shot.height;
       const ctx = c.getContext("2d"); ctx.drawImage(shot, 0, 0);
       const at = (x, y) => [...ctx.getImageData(Math.round(x * win.devicePixelRatio), Math.round(y * win.devicePixelRatio), 1, 1).data].slice(0, 3);
       return { button: at(fx + fw - 24, fy + fh / 2), corner: at(fx + 1, fy + 1), outside: at(bx + 100, by + 300) }; })();`,
      [fx, fy, fw, fh, bx, by],
    );
    expect(shot.outside).toEqual([255, 255, 255]);
    expect(shot.corner).toEqual([255, 255, 255]);
    expect(shot.button).not.toEqual([255, 255, 255]);
    // A click on the badge goes to the badge, one beside it to the page, at its coordinates.
    await inAppView(m, "essai", "window.got = []; for (const t of ['mousedown', 'click']) addEventListener(t, (e) => got.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true); return 1;");
    const routed = await m.execute<{ onBadge: string | null; beside: string | null }>(
      `return (async () => { const win = ${appWindowExpr("essai")}, [fx, fy, fw, fh, bx, by] = arguments;
       const hit = (x, y) => { const e = win.document.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; };
       const out = { onBadge: hit(fx + fw / 2, fy + fh / 2), beside: hit(bx + 100, by + 300) };
       win.synthesizeMouseEvent("mousedown", bx + 100, by + 300, { button: 0, clickCount: 1 });
       win.synthesizeMouseEvent("mouseup", bx + 100, by + 300, { button: 0, clickCount: 1 });
       await new Promise((r) => win.setTimeout(r, 300));
       return out; })();`,
      [fx, fy, fw, fh, bx, by],
    );
    expect(routed).toEqual({ onBadge: "iframe#webaios-app-badge", beside: "browser" });
    await expect.poll(() => inAppView<string[]>(m, "essai", "return window.got;"), { timeout: 10_000 }).toEqual(["mousedown@100,300", "click@100,300"]);
    // Security: the page has no frame nor node more, its size is the view's, and under the badge it finds its own body.
    const pageView = await inAppView(m, "essai", `const e = document.elementFromPoint(innerWidth - 12 - ${fw / 2}, 12 + ${fh / 2}); return { under: e && e.localName, frames: window.length, iframes: document.querySelectorAll("iframe").length, innerWidth, innerHeight };`);
    expect(pageView).toEqual({ under: "body", frames: 0, iframes: 0, innerWidth: bw, innerHeight: bh });
  });

  it("opening the menu grows it to 300×320; Escape shrinks it back", async () => {
    await launched();
    await cutAccess(m, "essai");
    await sized(m, "essai", 48, 28);
    await clickBadge(m, "essai", '[data-testid="webaios-pill"]');
    await sized(m, "essai", 300, 320);
    expect(await inBadge(m, "essai", `return [...doc.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim());`)).toEqual(["Mode design ⌘⇧D", "Panier (0)", "Relire ce projet"]);
    await inBadge(m, "essai", `f.contentWindow.dispatchEvent(new f.contentWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1;`);
    await sized(m, "essai", 48, 28);
    expect(await inBadge(m, "essai", `return doc.querySelectorAll('[role="menuitem"]').length;`)).toBe(0);
  });

  it("the badge cannot reach the page", async () => {
    await launched();
    // From the badge's own document: the view is remote, its document and window are out of reach, in another process.
    const seen = await inBadge(
      m,
      "essai",
      `const v = f.contentWindow.parent.gBrowser.selectedBrowser;
       return { remote: v.isRemoteBrowser, doc: v.contentDocument, win: v.contentWindow, otherProcess: v.browsingContext.currentWindowGlobal.osPid !== Services.appinfo.processID, frames: f.contentWindow.length };`,
    );
    expect(seen).toEqual({ remote: true, doc: null, win: null, otherProcess: true, frames: 0 });
  });

  // design.spec.ts:443-445
  it("agent access to the app shows in its badge, 88×28", async () => {
    await launched();
    await expect.poll(async () => (await callTool(p.dataDir, "read_tab", { id: "app:essai" })).text, { timeout: 10_000 }).toContain("Titre : Essai essai");
    await expect.poll(() => inBadge(m, "essai", `return doc.querySelectorAll('[data-testid="access-pill"]').length;`), { timeout: 10_000 }).toBe(1);
    await sized(m, "essai", 88, 28);
    expect(await badgeAccess(m, "essai")).toEqual(["app:essai"]);
  });

  // Review Focus 3
  it("two apps: each badge gets its own app's access only", async () => {
    await launched("essai");
    await launched("autre");
    await callTool(p.dataDir, "read_tab", { id: "app:essai" });
    // What a change sends: each badge hears only its own app.
    const listen = (d: string) => inBadge(m, d, "const w = f.contentWindow; w.heard = []; w.webaios.onAccess((e) => w.heard.push(Object.keys(e.tabs).join(','))); return 1;");
    await listen("essai");
    await listen("autre");
    await cutAccess(m, "autre");
    await sized(m, "essai", 88, 28);
    await sized(m, "autre", 48, 28);
    expect(await badgeAccess(m, "essai")).toEqual(["app:essai"]);
    expect(await badgeAccess(m, "autre")).toEqual([]);
    const heard = (d: string) => inBadge<string[]>(m, d, "return [...f.contentWindow.heard];");
    await expect.poll(async () => (await heard("essai"))!.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(new Set(await heard("essai"))).toEqual(new Set(["app:essai"]));
    expect(new Set(await heard("autre"))).toEqual(new Set([""]));
    // Security: a badge cuts only its own app's access.
    await inBadge(m, "autre", `f.contentWindow.webaios.access.cut("app:essai"); return 1;`);
    await sleep(700);
    await sized(m, "essai", 88, 28);
    expect(await badgeAccess(m, "essai")).toEqual(["app:essai"]);
  });

  it("every value from the chrome is the badge's own copy", async () => {
    await launched();
    const realms = await inBadge(
      m,
      "essai",
      `const w = f.contentWindow;
       const e = await w.webaios.access.state();
       const t = e.tabs["app:essai"];
       return { state: Object.getPrototypeOf(e) === w.Object.prototype, tabs: Object.getPrototypeOf(e.tabs) === w.Object.prototype, tab: !!t && Object.getPrototypeOf(t) === w.Object.prototype };`,
    );
    expect(realms).toEqual({ state: true, tabs: true, tab: true });
    // A change sent to the badge is a copy too.
    await inBadge(m, "essai", "const w = f.contentWindow; w.copies = []; w.webaios.onAccess((x) => w.copies.push(Object.getPrototypeOf(x) === w.Object.prototype && Object.getPrototypeOf(x.tabs) === w.Object.prototype)); return 1;");
    await cutAccess(m, "essai");
    await expect.poll(() => inBadge<boolean[]>(m, "essai", "return [...f.contentWindow.copies];"), { timeout: 10_000 }).toContain(true);
    expect((await inBadge<boolean[]>(m, "essai", "return [...f.contentWindow.copies];"))!.every(Boolean)).toBe(true);
  });

  // relecture.spec.ts:65 (its opening part)
  it("Relire of the essai card opens the Review page on app-essai; a project without manifest has no Relire", async () => {
    const windowId = (await state(m)).windows[0]!.id;
    await dispatch(m, { type: "openApps", windowId: windowId });
    await waitUi(m, `return !!doc.querySelector(${JSON.stringify(appRow("vieux"))})`);
    expect(await inUi<string[]>(m, `return [...doc.querySelectorAll(arguments[0])].map((b) => b.textContent.trim());`, [`${appRow("vieux")} button`])).not.toContain("Relire");
    expect(await rowMenuItems(m, "vieux")).not.toContain("Relire");
    await inUi(m, "doc.body.dispatchEvent(new ui.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1;");
    await rowButton(m, "essai", "Relire");
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"review-page\"]')", [], 15_000);
    await expect.poll(async () => (await reviewTabs(m, "app-essai")).map((o) => o.title), { timeout: 10_000 }).toEqual(["Relecture — Essai"]);
    // The UI refuses a folder name a shell would not take, and a project without manifest, before any page.
    await inUi(m, "ui.webaios.apps.act('../x', 'review'); ui.webaios.apps.act('vieux', 'review'); return 1;");
    await sleep(500);
    expect(Object.values((await state(m)).tabs).filter((o) => o.url.startsWith(reviewUrl("app-"))).length).toBe(1);
  });

  // relecture.spec.ts:168
  it("Relire ce projet from the badge opens the same page in the main window, without a second tab", async () => {
    await launched();
    for (let i = 0; i < 2; i++) {
      await clickBadge(m, "essai", '[data-testid="webaios-pill"]');
      await clickBadge(m, "essai", '[role="menuitem"]', "Relire ce projet");
      await expect.poll(async () => (await reviewTabs(m, "app-essai")).map((o) => o.title), { timeout: 10_000 }).toEqual(["Relecture — Essai"]);
    }
    const s = await state(m);
    const tab = (await reviewTabs(m, "app-essai"))[0]!;
    expect(s.windows[0]!.id).toBe(tab.windowId);
    // The badge's menu closed with the choice: back to its closed size.
    await expect.poll(async () => (await place(m, "essai"))?.slice(2)[1], { timeout: 10_000 }).toBe(28);
  });
});
