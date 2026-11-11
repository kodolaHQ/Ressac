import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { reviewUrl } from "../shared/model";
import { testActor } from "./agent-extensions";
import { agentInput, APPS_ENV, appWindowExpr, inAppView, killFakeApps, launchAttempt, rowButton, rowMenu, rowState, writeProject } from "./apps";
import { startDesignServers, trustedMouse } from "./design";
import { dispatch, inWindow, state, waitFor, waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { LINES, writeAppJs } from "./review";
import { inBrowser } from "./sites";
import { click, pressKeys, typeText, waitUi } from "./ui";

// Plan 35b Task 6: the design mode in an agent app's window (spec §13.5), plus the app's own stops, ⇧⌘D in its window, its source and the agent never seeing the bubble.
// Block 15320-15324; the demo of the main window's tab on 15324 (the apps take the first free ports).

const BLOCK: [number, number] = [15320, 15324];
const DEMO = 15324;
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const APP = appWindowExpr("essai");
const VIEW = "gBrowser.selectedBrowser";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tid = (id: string) => `[data-testid="${id}"]`;
// The « formulaire » server with design.html's data-source paragraph.
const SERVER = `import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<title>Inscription</title><form id="inscription"><input id="email" class="champ" type="email"> <button id="envoyer" type="button">Envoyer</button></form><p data-source="src/Inscription.svelte:12">Texte avec source</p>');
}).listen(Number(process.env.PORT));
`;

let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;
let demo: Awaited<ReturnType<typeof startDesignServers>>;

beforeAll(async () => {
  demo = await startDesignServers({ port: DEMO });
  dataDir = await mkdtemp(join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(join(os.tmpdir(), "webaios-firefox-"));
  writeProject(dataDir, "essai", { manifest: { name: "Essai" }, server: "form" });
  writeFileSync(join(dataDir, "workspace", "projects", "essai", "serveur.mjs"), SERVER);
  writeAppJs(join(dataDir, "workspace", "projects", "essai"), LINES);
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { ...APPS_ENV(BLOCK), ...a.env }, prefs: a.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  // Not expect.poll: run from beforeAll.
  for (const end = Date.now() + 15_000; !existsSync(join(dataDir, "workspace", ".webaios", "mcp.json")); await sleep(100))
    if (Date.now() > end) throw new Error("the MCP server did not start");
}, 120_000);
afterAll(async () => {
  await w?.close();
  killFakeApps(dataDir);
  await demo?.close();
  for (const d of [dataDir, profile]) if (d) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await callTool(dataDir, "stop_app", { folder: "essai" }).catch(() => {});
  await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.hasAttribute("webaios-app")).length;`, (n) => n === 0);
  await waitFor(m, "for (const t of gBrowser.tabs.slice(1)) gBrowser.removeTab(t); return gBrowser.tabs.length;", (n) => n === 1);
  // Each test starts with an empty cart.
  await svc(`for (const e of await store.agent.request("design.basket", { project: "app-essai" })) await store.agent.request("design.remove", { project: "app-essai", id: e.id }); return 1;`);
});

/** Runs `body` with `d` the design service, `t` the essai app's target, `main` Marionette's current (main) window's, `store` the store. */
const svc = <R = unknown>(body: string, args: unknown[] = []) =>
  m.execute<R>(
    `return (async (args) => { const store = await ChromeUtils.importESModule("${STORE}").ready, d = store.design; const t = { type: "app", folder: "essai" };
     const main = { type: "window", windowId: window.webaiosWindow?.windowId }; ${body} })([...arguments]);`,
    args,
  );
const designState = () => svc<{ active: boolean; basket: number; project: { project: string } | null }>("return await d.state(t);");
/** The host's cart of app-essai (whether its window is open or not). */
const cart = () => svc<number>(`return (await store.agent.request("design.tracking", { project: "app-essai" })).basket;`);
const hosts = () => inAppView<number>(m, "essai", `return document.querySelectorAll("webaios-viewfinder").length;`).catch(() => -1);

/** The essai window's chrome handle (Marionette's chrome context), waited for. */
async function appHandle(): Promise<string> {
  for (const end = Date.now() + 15_000; Date.now() < end; await sleep(100))
    for (const h of await windowHandles(m)) {
      const folder = await inWindow(m, h, () => m.execute<string | null>(`return document.documentElement.getAttribute("webaios-app");`)).catch(() => null);
      if (folder === "essai") return h;
    }
  throw new Error("no essai window");
}
/** `fn` with the essai window current: ui.ts's frames, keys and trustedMouse act in it. */
const inApp = async <T>(fn: () => Promise<T>): Promise<T> => inWindow(m, await appHandle(), fn);

/** Essai launched by the agent's tool, its page loaded and its badge mounted; returns its port. */
async function launched(): Promise<number> {
  const port = await launchAttempt(dataDir);
  await loadedAt(`http://localhost:${port}/`);
  return port;
}
const loadedAt = async (url: string) => {
  await waitFor(m, `const b = ${APP}?.gBrowser.selectedBrowser; return !!b && b.currentURI.spec === ${JSON.stringify(url)} && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
  await expect.poll(() => badge<boolean>("return true;"), { timeout: 10_000 }).toBe(true);
};

/** Runs `body` with `win` (essai's window), `f` (its badge frame) and `doc` (the badge's document); null while it is not mounted. */
const badge = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T | null>(
    `return (async () => { const win = ${APP}; const f = win?.document.getElementById("webaios-app-badge"); const doc = f?.contentDocument;
     if (!doc?.querySelector('[data-testid="webaios-pill"]')) return null; ${body} })();`,
    args,
  );
const badgeSize = () => badge<number[]>("const r = f.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)];");
const clickBadge = (selector: string, text?: string) =>
  expect
    .poll(() => badge("const el = [...doc.querySelectorAll(arguments[0])].find((e) => !arguments[1] || e.textContent.includes(arguments[1])); if (!el) return false; el.click(); return true;", [selector, text ?? null]), { timeout: 10_000 })
    .toBe(true);
/** The badge's menu item `name`. */
async function menu(name: string): Promise<void> {
  await clickBadge(tid("webaios-pill"));
  await clickBadge('[role="menuitem"]', name);
}

/** `body` with `doc` the document of essai's design overlay frame; null while it is absent or hidden. */
const overlay = <T = unknown>(body: string) =>
  m.execute<T | null>(
    `const f = ${APP}?.document.getElementById("webaios-design-calque");
     if (!f || f.style.display === "none" || !f.getBoundingClientRect().width) return null;
     const doc = f.contentDocument;
     return (() => { ${body} })();`,
  );
const bubbleText = () => overlay<string | null>(`return doc.querySelector('${tid("design-bubble")}')?.textContent ?? null;`);
const sendText = () => overlay<string | null>(`return doc.querySelector('${tid("send-remarks")}')?.textContent ?? null;`);

async function modeOn(): Promise<void> {
  await menu("Mode design");
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
/** A trusted click on `sel` in essai's page: its bubble, labelled `label`, opens in the window's overlay. */
async function aim(sel: string, label: string): Promise<void> {
  await inApp(() => trustedMouse(m, VIEW, sel));
  await expect.poll(bubbleText, { timeout: 10_000 }).toContain(label);
  await expect.poll(() => overlay<string | null>("return doc.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
}
/** `text` typed in the open bubble, then « Ajouter au panier »: the cart grows by one, the viewfinder is armed again. */
async function add(text: string): Promise<void> {
  const n = await cart();
  await inApp(async () => {
    await typeText(m, text);
    await click(m, "button.add-button", { frame: "overlay" });
  });
  await expect.poll(cart, { timeout: 10_000 }).toBe(n + 1);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
const reviewTabs = async () => Object.values((await state(m)).tabs).filter((o) => o.url === reviewUrl("app-essai"));

it("design.spec.ts:426 an app window launched from the Applications page: the WebAiOs badge, Mode design, the bubble in its overlay, Panier", async () => {
  const windowId = (await state(m)).windows[0]!.id;
  await dispatch(m, { type: "openApps", windowId: windowId });
  await rowButton(m, "essai", "Lancer");
  await rowState(m, "essai", "running", 15_000);
  await expect.poll(() => inAppView<string>(m, "essai", "return document.title;").catch(() => null), { timeout: 15_000 }).toBe("Inscription");
  // The app launched is « built »: the agent has access (88×28). Cut, the WebAiOs button stays alone (48×28).
  await expect.poll(() => badge<number>(`return doc.querySelectorAll('${tid("access-pill")}').length;`), { timeout: 10_000 }).toBe(1);
  await expect.poll(badgeSize, { timeout: 10_000 }).toEqual([88, 28]);
  await clickBadge(tid("access-pill"));
  await clickBadge(`${tid("access-bubble")} button.cut`);
  await expect.poll(() => badge<number>(`return doc.querySelectorAll('${tid("access-pill")}').length;`), { timeout: 10_000 }).toBe(0);
  await expect.poll(badgeSize, { timeout: 10_000 }).toEqual([48, 28]);
  await modeOn();
  await aim("#email", "input#email.champ");
  // The overlay is a frame of the app window, never of the main window.
  expect(await m.execute("return !!document.getElementById('webaios-design-calque');")).toBe(false);
  await add("Champ plus large");
  // « Panier »: the overlay shows the app's cart, on the right, 340 px wide, 12 px from the edges; the page keeps its width.
  const width = await inAppView<number>(m, "essai", "return innerWidth;");
  await menu("Panier (1)");
  await expect.poll(() => overlay<boolean>(`return !!doc.querySelector('${tid("design-basket")}');`), { timeout: 10_000 }).toBe(true);
  expect(await overlay<number>(`return doc.querySelectorAll('${tid("basket-remark")}').length;`)).toBe(1);
  await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
  expect(
    await m.execute(`const win = ${APP}, r = win.document.getElementById("webaios-design-calque").getBoundingClientRect(); return [Math.round(win.innerWidth - r.right), Math.round(r.top), Math.round(r.width), Math.round(win.innerHeight - r.bottom)];`),
  ).toEqual([12, 12, 340, 12]);
  expect(await inAppView<number>(m, "essai", "return innerWidth;")).toBe(width);
  expect(readdirSync(join(dataDir, "workspace", ".webaios", "remarks"))).toEqual(["app-essai"]);
});

it("design.spec.ts:529 app window essai: sending from the overlay sends to the main window's terminal", async () => {
  await launched();
  await modeOn();
  await aim("#email", "input#email.champ");
  await add("Champ plus large");
  await menu("Panier (1)");
  await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
  const before = agentInput(dataDir);
  await inApp(() => click(m, tid("send-remarks"), { frame: "overlay" }));
  await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
  await expect.poll(() => agentInput(dataDir).slice(before.length), { timeout: 20_000 }).toContain("appli Essai (/workspace/projects/essai)");
  expect(agentInput(dataDir)).toContain("/workspace/.webaios/remarks/app-essai/");
  await expect.poll(() => agentInput(dataDir), { timeout: 5_000 }).toMatch(/\] [^\r]*\r$/);
  await expect.poll(() => overlay<number>(`return doc.querySelectorAll('${tid("batch-sent")}').length;`), { timeout: 10_000 }).toBe(1);
});

// relecture.spec.ts:168: no native menu item relire-projet (spec §5.7); its two
// equivalents are the badge's item again and the card's « Relire ».
it("relecture.spec.ts:168 Voir les modifications de l'agent from essai's badge, twice, then Relire of its card bring back the same page, without a second tab", async () => {
  await launched();
  for (let i = 0; i < 2; i++) {
    await menu("Voir les modifications de l'agent");
    await waitUi(m, `return !!doc.querySelector('${tid("review-page")}')`, [], 15_000);
    await expect.poll(async () => (await reviewTabs()).map((o) => o.title), { timeout: 10_000 }).toEqual(["Relecture — Essai"]);
  }
  expect((await reviewTabs())[0]!.windowId).toBe((await state(m)).windows[0]!.id);
  await dispatch(m, { type: "openApps", windowId: (await state(m)).windows[0]!.id });
  await rowMenu(m, "essai", "Modifications");
  await waitUi(m, `return !!doc.querySelector('${tid("review-page")}')`, [], 15_000);
  await sleep(500);
  expect((await reviewTabs()).map((o) => o.title)).toEqual(["Relecture — Essai"]);
});

it("⇧⌘D in the app window toggles its own mode, never the main window's tab", async () => {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${demo.page}/` });
  await waitFor(m, `return ${VIEW}.currentURI.spec.startsWith(${JSON.stringify(demo.page)}) && !${VIEW}.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
  await launched();
  const handles = (await windowHandles(m)).length;
  await inApp(async () => {
    await m.execute(`${VIEW}.focus();`);
    await pressKeys(m, "Meta+Shift+d");
  });
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
  expect((await svc<{ active: boolean }>("return await d.state(main);")).active).toBe(false);
  expect(await svc("return d.overlayContext(main);")).toBeNull();
  expect(await inBrowser<number>(m, VIEW, `return document.querySelectorAll("webaios-viewfinder").length;`)).toBe(0);
  // Firefox's « bookmark all tabs » stays off in the app window.
  expect(await m.execute(`return ["bookmarkAllTabsKb", "Browser:BookmarkAllTabs"].map((id) => ${APP}.document.getElementById(id)?.getAttribute("disabled"));`)).toEqual(["true", "true"]);
  expect((await windowHandles(m)).length).toBe(handles);
  await inApp(() => pressKeys(m, "Meta+Shift+d"));
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(0);
  expect((await svc<{ active: boolean }>("return await d.state(main);")).active).toBe(false);
});

it("the source is read in an app window", async () => {
  await launched();
  await modeOn();
  await aim("p[data-source]", "p");
  expect(await svc("return d.overlayContext(t, ['bubble'])?.source;")).toBe("src/Inscription.svelte:12");
  expect(await bubbleText()).toContain("src/Inscription.svelte:12");
  await inApp(() => pressKeys(m, "Escape"));
  await expect.poll(bubbleText, { timeout: 10_000 }).toBeNull();
});

it("the agent reading the app window never sees the bubble's text", async () => {
  await launched();
  await modeOn();
  await aim("#email", "input#email.champ");
  await inApp(() => typeText(m, "texte secret"));
  await expect.poll(() => overlay<string>("return doc.querySelector('textarea').value;"), { timeout: 10_000 }).toBe("texte secret");
  const read = (await callTool(dataDir, "read_tab", { id: "app:essai" })).text;
  expect(read).toContain("Inscription");
  expect(read).not.toContain("texte secret");
  expect(read).not.toContain("Ajouter au panier");
  expect(read).not.toContain("input#email.champ");
  expect(await inAppView<string>(m, "essai", "return document.documentElement.outerHTML;")).not.toContain("texte secret");
});

it("a relaunch on another port, closing the window, stopping the app: each stops the mode, the cart stays", async () => {
  // The block's first port taken: essai gets the next one; freed, the relaunch takes it.
  const taken = createServer((_q, r) => r.end("taken"));
  await new Promise<void>((ok) => taken.listen(BLOCK[0], "127.0.0.1", ok));
  let port: number;
  try {
    port = await launched();
  } finally {
    await new Promise((ok) => (taken.closeAllConnections(), taken.close(ok)));
  }
  expect(port).not.toBe(BLOCK[0]);
  await modeOn();
  await aim("#email", "input#email.champ");
  await add("Une remarque");
  await svc("await store.agent.request('apps.act', { folder: 'essai', action: 'relaunch', window: main.windowId }); return 1;");
  await loadedAt(`http://localhost:${BLOCK[0]}/`);
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
  expect(await hosts()).toBe(0);
  expect(await cart()).toBe(1);

  // Closing the window: the app stops, the target is forgotten (no session, no overlay left).
  await modeOn();
  await menu("Panier (1)");
  await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
  await m.execute(`${APP}.close();`);
  await expect.poll(() => m.execute<boolean>(`return !${APP};`), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
  expect(await svc("return d.overlayContext(t);")).toBeNull();
  expect(await cart()).toBe(1);

  // Stopping the app: its window closes, the same.
  await launched();
  await modeOn();
  await menu("Panier (1)");
  await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
  await callTool(dataDir, "stop_app", { folder: "essai" });
  await expect.poll(() => m.execute<boolean>(`return !${APP};`), { timeout: 10_000 }).toBe(true);
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
  expect(await svc("return d.overlayContext(t);")).toBeNull();
  expect(await cart()).toBe(1);
  // Launched again: the mode is off, the cart is there.
  await launched();
  expect((await designState()).active).toBe(false);
  expect((await designState()).basket).toBe(1);
  expect(await hosts()).toBe(0);
});

describe("no main window", () => {
  it("sending from an app's cart with no main window open opens one and sends to it", async () => {
    await launched();
    await modeOn();
    await aim("#email", "input#email.champ");
    await add("Sans fenetre");
    await menu("Mode design");
    await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
    await menu("Panier (1)");
    await expect.poll(sendText, { timeout: 10_000 }).toBe("Envoyer 1 remarque à l'agent");
    const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const app = await appHandle();
    await m.execute("window.close();");
    await m.command("WebDriver:SwitchToWindow", { handle: app, focus: false });
    await expect.poll(async () => (await windowHandles(m)).includes(main), { timeout: 10_000 }).toBe(false);
    expect(await m.execute(`return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => !w.document.documentElement.hasAttribute("webaios-app")).length;`)).toBe(0);
    const before = agentInput(dataDir);
    await click(m, tid("send-remarks"), { frame: "overlay" });
    await expect.poll(() => agentInput(dataDir).slice(before.length), { timeout: 30_000 }).toContain("appli Essai (/workspace/projects/essai)");
    await expect.poll(() => agentInput(dataDir), { timeout: 5_000 }).toMatch(/\] [^\r]*\r$/);
    // The new main window, its agent panel open: the next tests act in it.
    let opened: string | undefined;
    for (const end = Date.now() + 10_000; !opened && Date.now() < end; await sleep(100))
      for (const h of await windowHandles(m))
        if (h !== app && (await inWindow(m, h, () => m.execute<boolean>("return !!window.webaiosWindow;")).catch(() => false))) opened = h;
    expect(opened).toBeTruthy();
    await m.command("WebDriver:SwitchToWindow", { handle: opened!, focus: false });
    await waitReady(m);
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
  });
});
