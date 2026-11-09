import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_CLIENT } from "../../../packages/kernel/src/design/projects";
import { reviewUrl } from "../shared/model";
import { UNAVAILABLE_DESIGN } from "../shared/design-guards";
import { openTab, testActor } from "./agent-extensions";
import { startDesignServers, trustedMouse } from "./design";
import { dispatch, inWindow, newWindow, state, waitFor, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { declareProject, openApplications } from "./review";
import { inBrowser, resolveLocalHosts } from "./sites";
import { click, inUi, pressKeys, typeText } from "./ui";

// Plan 35b Task 4: the ✎ button, ⇧⌘D and the chevron's menu (Panier, Relire ce projet), without a
// native menu, and Review Focus 1. The demo is 127.0.0.1:15313, in this file's block 15310-15314.

const PORT = 15313;
const BLOCK = "15310-15314";
const B = "gBrowser.selectedBrowser";
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tid = (id: string) => `[data-testid="${id}"]`;

let demo: Awaited<ReturnType<typeof startDesignServers>>;
/** An external project's pages: 127.0.0.1 on a free port, outside the block (declared by the MCP client later). */
let ext: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];

async function boot(env: Record<string, string> = {}): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { ...a.env, WEBAIOS_APP_PORTS: BLOCK, ...env }, prefs: a.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(m, ["localhost"]);
  await waitFor(m, `return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; return d.state({ type: "fenetre", windowId: window.webaiosWindow.windowId }).then(() => true, () => false); })();`, (v) => v === true, 30_000);
}

beforeAll(async () => {
  demo = await startDesignServers({ port: PORT });
  ext = await startDesignServers();
  await boot();
}, 120_000);
afterAll(async () => {
  await w?.close();
  await demo?.close();
  await ext?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Runs `body` with `d` the design service, `t` the current window's target, `store` the store. */
const svc = <R = unknown>(body: string, args: unknown[] = []) =>
  m.execute<R>(
    `return (async (args) => { const store = await ChromeUtils.importESModule("${STORE}").ready, d = store.design; const t = { type: "fenetre", windowId: window.webaiosWindow.windowId }; ${body} })([...arguments]);`,
    args,
  );
const designState = () => svc<{ active: boolean; basket: number; project: { project: string } | null }>("return await d.state(t);");
const hosts = () => inBrowser<number>(m, B, `return document.querySelectorAll("webaios-viewfinder").length;`);
const button = () =>
  inUi<{ disabled: boolean; title: string; pressed: string; count: string | null } | null>(
    m,
    `const b = doc.querySelector('${tid("bouton-design")}');
     return b && { disabled: b.disabled, title: b.title, pressed: b.getAttribute("aria-pressed"), count: b.querySelector('${tid("compteur-panier")}')?.textContent ?? null };`,
  );
const pressed = async () => (await button())?.pressed;

/** A tab on `url` in the current window, the keyboard in its page. */
async function open(url: string): Promise<string> {
  const id = await openTab(m, url);
  await m.execute(`${B}.focus();`);
  return id;
}
const activate = async (id: string) => {
  await dispatch(m, { type: "activateTab", id });
  await waitFor(m, `return gBrowser.selectedTab.getAttribute("webaios-tab-id") === ${JSON.stringify(id)};`, (v) => v === true);
  await m.execute(`${B}.focus();`);
};

/** A chrome frame's state: shown (laid out), its rectangle, and `body` run in its document (`doc`). */
const frameOf = <T = unknown>(id: "webaios-design-calque" | "webaios-design-volet", body = "return null;") =>
  m.execute<{ shown: boolean; rect: { x: number; y: number; width: number; height: number }; v: T } | null>(
    `const f = document.getElementById(arguments[0]);
     if (!f) return null;
     const r = f.getBoundingClientRect(), doc = f.contentDocument;
     return { shown: f.style.display !== "none" && r.width > 0, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, v: (() => { ${body} })() };`,
    [id],
  );
/** The message's text while its frame shows it, else null. */
const message = async () => {
  const f = await frameOf<string | null>("webaios-design-calque", `return doc?.querySelector('${tid("message-design")}')?.textContent ?? null;`);
  return f?.shown ? f.v : null;
};
const columnShown = async () => (await frameOf("webaios-design-volet"))?.shown ?? false;
const sendButton = () =>
  frameOf<{ text: string; disabled: boolean; cart: string } | null>(
    "webaios-design-volet",
    `const b = doc?.querySelector('${tid("envoyer-remarques")}'); return b && { text: b.textContent, disabled: b.disabled, cart: doc.querySelector('${tid("panier-design")}').textContent };`,
  ).then((f) => f?.v ?? null);

/** The chevron's menu entries; the menu stays open. */
async function chevron(): Promise<string[]> {
  await click(m, ".design .chevron");
  await expect.poll(() => inUi<number>(m, `return doc.querySelectorAll('[role="menuitem"]').length;`), { timeout: 10_000 }).toBeGreaterThan(0);
  return inUi<string[]>(m, `return [...doc.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent.trim());`);
}

async function modeOn() {
  await pressKeys(m, "Meta+Shift+d");
  await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(true);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
}
async function modeOff() {
  if ((await designState()).active) await svc("await d.stop(t); return 1;");
  await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
}

/** `text` typed in the bubble of `#email`, then « Ajouter au panier »: the cart grows by one. */
async function remark(text: string) {
  const n = (await designState()).basket;
  await trustedMouse(m, B, "#email");
  await expect.poll(() => frameOf<string | null>("webaios-design-calque", "return doc.activeElement?.localName ?? null;").then((f) => f?.v), { timeout: 10_000 }).toBe("textarea");
  await typeText(m, text);
  await click(m, "button.ajouter", { frame: "overlay" });
  await expect.poll(async () => (await designState()).basket, { timeout: 10_000 }).toBe(n + 1);
}

describe("outside the followed projects", () => {
  it("design.spec.ts:291 a tab outside the followed projects: the button is disabled, ⇧⌘D sets no viewfinder", async () => {
    await open(`${demo.frame}/`);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: true, title: UNAVAILABLE_DESIGN, pressed: "false" });
    await pressKeys(m, "Meta+Shift+d");
    await sleep(400);
    expect(await hosts()).toBe(0);
    expect((await designState()).active).toBe(false);
    expect(await pressed()).toBe("false");
    await expect.poll(message, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN);
    await pressKeys(m, "Escape");
    await expect.poll(message, { timeout: 10_000 }).toBeNull();
  });

  it("design.spec.ts:311 outside a project, ⇧⌘D shows message-design = INDISPONIBLE, gone after 4 s; the next key or a click closes it too", async () => {
    await open(`${demo.frame}/x`);
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(message, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN);
    const shownAt = Date.now();
    expect(await hosts()).toBe(0);
    // 12 px from the top and the right of the <browser>, 360×56.
    const b = await m.execute<{ x: number; y: number; width: number }>(`const r = ${B}.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width };`);
    expect((await frameOf("webaios-design-calque"))!.rect).toEqual({ x: b.x + b.width - 12 - 360, y: b.y + 12, width: 360, height: 56 });
    // The message never takes the keyboard.
    expect(await m.execute("return document.activeElement === gBrowser.selectedBrowser;")).toBe(true);
    await sleep(2500);
    expect(await message()).toBe(UNAVAILABLE_DESIGN);
    await expect.poll(message, { timeout: 10_000 }).toBeNull();
    expect(Date.now() - shownAt).toBeGreaterThanOrEqual(3500);
    expect(await frameOf("webaios-design-calque").then((f) => f?.shown)).toBe(false);

    // The next key in the page.
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(message, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN);
    let t = Date.now();
    await pressKeys(m, "a");
    await expect.poll(message, { timeout: 10_000 }).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);

    // The next key in the window's UI.
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(message, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN);
    await m.execute(`document.getElementById("webaios-sidebar").focus();`);
    expect(await m.execute("return document.activeElement?.id;")).toBe("webaios-sidebar");
    t = Date.now();
    await pressKeys(m, "a");
    await expect.poll(message, { timeout: 10_000 }).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    await m.execute(`${B}.focus();`);

    // A click on the message.
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(message, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN);
    t = Date.now();
    await click(m, tid("message-design"), { frame: "overlay" });
    await expect.poll(message, { timeout: 10_000 }).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    expect(await hosts()).toBe(0);
  });

  it("⇧⌘D opens no Firefox bookmarks dialog", async () => {
    await open(`${demo.frame}/`);
    const before = (await m.command<string[]>("WebDriver:GetWindowHandles")).length;
    await pressKeys(m, "Meta+Shift+d");
    await sleep(1000);
    expect(
      await m.execute(
        `return {
          disabled: ["bookmarkAllTabsKb", "Browser:BookmarkAllTabs"].map((id) => document.getElementById(id)?.getAttribute("disabled")),
          organizer: !!Services.wm.getMostRecentWindow("Places:Organizer"),
          dialog: !!gDialogBox.isOpen || [...Services.wm.getEnumerator(null)].some((w) => /bookmark/i.test(w.location.href)),
        };`,
      ),
    ).toEqual({ disabled: ["true", "true"], organizer: false, dialog: false });
    expect((await m.command<string[]>("WebDriver:GetWindowHandles")).length).toBe(before);
    await pressKeys(m, "Escape");
  });
});

describe("on the demo", () => {
  it("⇧⌘D toggles the mode on the demo as the button does; the counter shows the cart", async () => {
    await open(`${demo.page}/`);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false, title: "Mode design (⌘⇧D)", pressed: "false", count: null });
    await modeOn();
    await expect.poll(pressed, { timeout: 10_000 }).toBe("true");
    expect(await message()).toBeNull();
    // The mode on, the column open: the host is read a few times, never in a loop.
    await sleep(500);
    await svc(`window.__calls = []; const real = (store.agent.__real ??= store.agent.request); store.agent.request = (method, p) => (window.__calls.push(method), real.call(store.agent, method, p)); return 1;`);
    try {
      await sleep(3000);
      expect(await m.execute<number>(`return window.__calls.filter((c) => c.startsWith("design.")).length;`)).toBeLessThan(20);
    } finally {
      await svc("if (store.agent.__real) store.agent.request = store.agent.__real; return 1;");
    }
    await remark("Champ plus large");
    await expect.poll(async () => (await button())?.count, { timeout: 10_000 }).toBe("1");
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
    await expect.poll(pressed, { timeout: 10_000 }).toBe("false");
    expect(await hosts()).toBe(0);
    // The button does the same.
    await click(m, tid("bouton-design"));
    await expect.poll(pressed, { timeout: 10_000 }).toBe("true");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await click(m, tid("bouton-design"));
    await expect.poll(pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(0);
    expect((await button())?.count).toBe("1");
  });

  it("the chevron: Panier opens the column even outside the mode; no Relire ce projet on a demo; Fermer clears Panier", async () => {
    await open(`${demo.page}/`);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false });
    expect(await chevron()).toEqual(["Panier"]);
    await click(m, '[role="menuitem"]', { text: "Panier" });
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(true);
    expect((await designState()).active).toBe(false);
    // Asked by Panier, the column outlives the mode.
    await modeOn();
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
    await sleep(500);
    expect(await columnShown()).toBe(true);
    // « Fermer »: Panier is cleared, so the next mode's end closes the column.
    await click(m, 'button.fermer', { frame: "panel" });
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
    await sleep(500);
    expect(await columnShown()).toBe(false);
    await m.execute(`${B}.focus();`);
    await modeOn();
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(true);
    await pressKeys(m, "Meta+Shift+d");
    await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
    await expect.poll(columnShown, { timeout: 10_000 }).toBe(false);
  });

  it("Review Focus 1, two windows: each has its own mode", async () => {
    const a = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    await open(`${demo.page}/`);
    await modeOn();
    const fa = await m.execute<string>("return window.webaiosWindow.windowId;");
    const b = await newWindow(m);
    const fb = await inWindow(m, b, async () => {
      const f = await m.execute<string>("return window.webaiosWindow.windowId;");
      await dispatch(m, { type: "openTab", windowId: f, url: `${demo.page}/x` });
      await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument && gBrowser.selectedBrowser.currentURI.spec.endsWith('/x')", (v) => v === true);
      await m.execute(`${B}.focus();`);
      // B in front: A's mode stays.
      expect((await designState()).active).toBe(false);
      await pressKeys(m, "Meta+Shift+d");
      await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(true);
      await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
      return f;
    });
    expect(fb).not.toBe(fa);
    expect((await designState()).active).toBe(true);
    expect(await hosts()).toBe(1);
    // ⇧⌘D in B again: only B stops.
    await inWindow(m, b, async () => {
      await pressKeys(m, "Meta+Shift+d");
      await expect.poll(async () => (await designState()).active, { timeout: 10_000 }).toBe(false);
      await expect.poll(hosts, { timeout: 10_000 }).toBe(0);
      await pressKeys(m, "Meta+Shift+d");
      await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    });
    expect((await designState()).active).toBe(true);
    // A closes: B's mode stays.
    await m.execute("window.close();");
    await waitWindowCount(m, 1);
    await m.command("WebDriver:SwitchToWindow", { handle: b, focus: false });
    expect(a).not.toBe(b);
    expect(await svc<boolean>("return d.state({ type: 'fenetre', windowId: args[0] }).then((e) => e.actif);", [fa])).toBe(false);
    expect((await designState()).active).toBe(true);
    expect(await hosts()).toBe(1);
    await modeOff();
  });
});

describe("an external project", () => {
  let p: Awaited<ReturnType<typeof declareProject>>;
  let tab: string;
  const project = () => `ext-${p.id}`;

  beforeAll(async () => {
    await openApplications(m);
    p = await declareProject(m, { dataDir: w.dataDir, ports: [Number(new URL(ext.page).port)] });
    tab = await open(`${ext.page}/`);
  }, 60_000);
  afterAll(async () => {
    await p?.client.close().catch(() => undefined);
  });

  const reviewTabs = async () => Object.values((await state(m)).tabs).filter((o) => o.url === reviewUrl(project()));

  it("relecture.spec.ts:168 Relire ce projet of an external project's tab, twice: one Review page, no second tab", async () => {
    await activate(tab);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false });
    expect(await chevron()).toEqual(["Panier", "Relire ce projet"]);
    await click(m, '[role="menuitem"]', { text: "Relire ce projet" });
    await expect.poll(async () => (await reviewTabs()).length, { timeout: 10_000 }).toBe(1);
    const review = (await reviewTabs())[0]!;
    await expect.poll(() => inUi<boolean>(m, `return !!doc.querySelector('${tid("page-relecture")}');`), { timeout: 10_000 }).toBe(true);
    await activate(tab);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false });
    await chevron();
    await click(m, '[role="menuitem"]', { text: "Relire ce projet" });
    await expect.poll(async () => (await state(m)).windows[0]!.active[(await state(m)).windows[0]!.activeSpace], { timeout: 10_000 }).toBe(review.id);
    expect((await reviewTabs()).map((o) => o.id)).toEqual([review.id]);
    await activate(tab);
  });

  it("externes.spec.ts:209 after Révoquer, the cart's send is disabled with NO_CLIENT", async () => {
    await activate(tab);
    await modeOn();
    await remark("Une remarque");
    await expect.poll(sendButton, { timeout: 10_000 }).toMatchObject({ disabled: false });
    expect((await sendButton())!.text).toContain("Claude Code");
    await modeOff();
    await openApplications(m);
    await click(m, `${tid("client-externe")} button`, { text: "Révoquer" });
    await expect.poll(() => inUi<number>(m, `return doc.querySelectorAll('${tid("client-externe")}').length;`), { timeout: 10_000 }).toBe(0);
    await activate(tab);
    await modeOn();
    await expect.poll(sendButton, { timeout: 10_000 }).toMatchObject({ disabled: true });
    expect((await sendButton())!.cart).toContain(NO_CLIENT);
    await modeOff();
  });

  it("externes.spec.ts:230 after Oublier, the ✎ button of the project's tab is unavailable", async () => {
    await activate(tab);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false });
    await openApplications(m);
    await click(m, `${tid("projet-externe")} button`, { text: "Oublier" });
    await expect.poll(() => inUi<number>(m, `return doc.querySelectorAll('${tid("projet-externe")}').length;`), { timeout: 10_000 }).toBe(0);
    await activate(tab);
    await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: true, title: UNAVAILABLE_DESIGN });
  });
});

describe("without git", () => {
  it("relecture.spec.ts:200 without git (WEBAIOS_GIT absent), the design mode still works on an external project", async () => {
    await w.close();
    await boot({ WEBAIOS_GIT: "/chemin/absent" });
    await openApplications(m);
    const p = await declareProject(m, { dataDir: w.dataDir, ports: [Number(new URL(ext.page).port)], snapshot: false });
    try {
      await open(`${ext.page}/`);
      await expect.poll(button, { timeout: 10_000 }).toMatchObject({ disabled: false });
      await click(m, tid("bouton-design"));
      await expect.poll(pressed, { timeout: 10_000 }).toBe("true");
      await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
      await modeOff();
    } finally {
      await p.client.close().catch(() => undefined);
    }
  }, 120_000);
});
