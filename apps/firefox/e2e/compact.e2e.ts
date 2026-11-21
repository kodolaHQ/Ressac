import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toggle = async () => dispatch(m, { type: "toggleCompact", windowId: (await state(m)).windows[0]!.id });

/** The page's box, the UI iframe's width, and whether the sidebar shows. */
const layout = () =>
  inUi<{ page: number; pageWidth: number; window: number; frame: number; sidebar: boolean }>(
    m,
    `const page = gBrowser.selectedBrowser.getBoundingClientRect();
     return { page: page.left, pageWidth: page.width, window: window.innerWidth, frame: frame.getBoundingClientRect().width, sidebar: !doc.querySelector('[data-testid="sidebar"]').parentElement.inert };`,
  );
const waitSidebar = (shown: boolean) =>
  waitUi(
    m,
    `return doc.querySelector('[data-testid="sidebar"]').parentElement.inert === !arguments[0]
       && (frame.hasAttribute("full") || frame.getBoundingClientRect().width === (arguments[0] ? 240 : 0));`,
    [shown],
  );

/** Mouse moves through the widget, as OS ones: over a web page the UI document does not see them. Several in one go, with no round trip between. */
const moveMouse = (...xs: number[]) =>
  m.execute(
    `const ratio = window.devicePixelRatio;
     for (const x of arguments[0]) window.windowUtils.sendNativeMouseEvent((window.mozInnerScreenX + x) * ratio, (window.mozInnerScreenY + 300) * ratio, window.windowUtils.NATIVE_MOUSE_MESSAGE_MOVE, 0, 0, document.documentElement);`,
    [xs],
  );

async function openPage(): Promise<void> {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/icone` });
  await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (u: string) => u.startsWith(server.url));
  await waitUi(m, `return !frame.hasAttribute("full");`);
}

describe("compact mode", () => {
  it("the button hides the column and the page takes the full width; the edge reveals it over the page, leaving hides", async () => {
    await openPage();
    expect(await layout()).toMatchObject({ page: 240, frame: 240, sidebar: true });

    await click(m, "button.compact");
    await waitSidebar(false);
    const hidden = await layout();
    // The page is framed by 8 px of aura on both sides.
    expect(hidden).toMatchObject({ page: 8, frame: 0, pageWidth: hidden.window - 16 });

    await moveMouse(5);
    await waitSidebar(true);
    expect(await layout()).toMatchObject({ page: 8, frame: 240, pageWidth: hidden.pageWidth });

    // Over the sidebar, then over its margin on the page: it stays.
    await moveMouse(100);
    await moveMouse(260);
    await sleep(500);
    expect((await layout()).sidebar).toBe(true);

    await moveMouse(600);
    await waitSidebar(false);
    expect(await layout()).toMatchObject({ page: 8, frame: 0 });
  });

  it("the macOS window buttons go with the sidebar", async () => {
    const buttons = () => m.execute<boolean>(`return document.getElementById("ressac-window-buttons").checkVisibility();`);
    await openPage();
    expect(await m.execute(`return document.documentElement.hasAttribute("customtitlebar");`)).toBe(true);
    expect(await buttons()).toBe(true);
    await toggle();
    await waitSidebar(false);
    expect(await buttons()).toBe(false);
    await moveMouse(5);
    await waitSidebar(true);
    expect(await buttons()).toBe(true);
  });

  it("coming back before the delay keeps the sidebar", async () => {
    await openPage();
    await toggle();
    await waitSidebar(false);
    await moveMouse(5);
    await waitSidebar(true);
    // Back within the 300 ms the sidebar waits before it hides (App.svelte HIDING_MS): both moves in one go.
    await moveMouse(600, 100);
    await sleep(500);
    expect((await layout()).sidebar).toBe(true);
  });

  it("⇧⌘S toggles it from the page", async () => {
    await openPage();
    await pressKeys(m, "Meta+Shift+s");
    await waitSidebar(false);
    expect((await state(m)).windows[0]!.compact).toBe(true);
    await pressKeys(m, "Meta+Shift+s");
    await waitSidebar(true);
    expect(await layout()).toMatchObject({ page: 240, frame: 240 });
  });

  it("a fast exit by the left of the window reveals it", async () => {
    await openPage();
    await toggle();
    await waitSidebar(false);
    await moveMouse(40);
    await sleep(100);
    expect((await layout()).sidebar).toBe(false);
    // Headless has no native "leave window" message: the event Firefox sends then.
    await m.execute(`window.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null }));`);
    await waitSidebar(true);
  });

  it("the empty page fills the space left of the agent panel", async () => {
    if (await m.execute<boolean>("return document.getElementById('ressac-agent').hidden")) await click(m, '[data-testid="agent-button"]');
    await toggle();
    await waitSidebar(false);
    const shown = await inUi<{ frame: number; left: number; free: number }>(
      m,
      `return { frame: frame.getBoundingClientRect().width, left: doc.querySelector('[data-testid="content-zone"]').getBoundingClientRect().left,
        free: document.getElementById("ressac-agent").getBoundingClientRect().left };`,
    );
    expect(shown).toMatchObject({ frame: shown.free, left: 0 });
  });

  it("HTML fullscreen leaves only the page", async () => {
    await openPage();
    await m.execute(`Services.prefs.setBoolPref("full-screen-api.allow-trusted-requests-only", false);
      gBrowser.selectedBrowser.messageManager.loadFrameScript("data:,content.document.documentElement.requestFullscreen()", false);`);
    await waitFor(m, "return document.documentElement.hasAttribute('inDOMFullscreen')", (v) => v === true);
    await waitUi(m, `return frame.getBoundingClientRect().width === 0;`);
    const full = await layout();
    expect(full).toMatchObject({ page: 0, pageWidth: full.window });
    await m.execute(`return document.exitFullscreen().then(() => { window.fullScreen = false; });`);
    await waitFor(m, "return document.documentElement.hasAttribute('inDOMFullscreen')", (v) => v === false);
    await waitUi(m, `return frame.getBoundingClientRect().width === 240;`);
    expect(await layout()).toMatchObject({ page: 240, frame: 240 });
  });

  describe("with the sidebar on the right", () => {
    const toRight = () => dispatch(m, { type: "setSidebarSide", side: "right" });
    const frameRight = () => m.execute<number>(`return document.getElementById("ressac-sidebar").getBoundingClientRect().right;`);

    it("the right edge reveals it over the page, leaving hides it", async () => {
      await openPage();
      await toRight();
      await toggle();
      await waitSidebar(false);
      const hidden = await layout();
      expect(hidden).toMatchObject({ page: 8, frame: 0, pageWidth: hidden.window - 16 });

      await moveMouse(hidden.window - 5);
      await waitSidebar(true);
      expect(await frameRight()).toBe(hidden.window);
      expect(await layout()).toMatchObject({ page: 8, frame: 240, pageWidth: hidden.pageWidth });

      await moveMouse(hidden.window - 100);
      await moveMouse(hidden.window - 260);
      await sleep(500);
      expect((await layout()).sidebar).toBe(true);

      await moveMouse(hidden.window - 300);
      await waitSidebar(false);
    });

    it("switching sides with the agent open moves both frames, the page stays loaded", async () => {
      await openPage();
      const windowId = (await state(m)).windows[0]!.id;
      await dispatch(m, { type: "toggleAgentPanel", windowId });
      await toggle();
      await waitSidebar(false);
      const page = () => m.execute<{ uri: string; inner: number }>(`return { uri: gBrowser.selectedBrowser.currentURI.spec, inner: gBrowser.selectedBrowser.innerWindowID };`);
      const before = await page();
      const agentLeft = "return document.getElementById('ressac-agent').getBoundingClientRect().left";
      const width = await m.execute<number>("return window.innerWidth");
      await waitFor(m, agentLeft, (v) => v === width - 420);

      await toRight();
      await waitFor(m, agentLeft, (v) => v === 0);
      await waitFor(m, "return gBrowser.selectedBrowser.getBoundingClientRect().left", (v) => v === 420 + 8);
      expect(await m.execute("return gBrowser.selectedBrowser.getBoundingClientRect().right")).toBe(width - 8);
      await moveMouse(width - 5);
      await waitSidebar(true);
      expect(await frameRight()).toBe(width);
      expect(await page()).toEqual(before);
    });
  });
});
