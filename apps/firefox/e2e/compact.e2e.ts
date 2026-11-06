import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toggle = async () => dispatch(m, { type: "basculerCompact", fenetreId: (await state(m)).fenetres[0]!.id });

/** The page's box, the UI iframe's width, and whether the sidebar shows. */
const layout = () =>
  inUi<{ page: number; pageWidth: number; window: number; frame: number; sidebar: boolean }>(
    m,
    `const page = gBrowser.selectedBrowser.getBoundingClientRect();
     return { page: page.left, pageWidth: page.width, window: window.innerWidth, frame: frame.getBoundingClientRect().width, sidebar: !doc.querySelector('[data-testid="barre-laterale"]').parentElement.inert };`,
  );
const waitSidebar = (shown: boolean) =>
  waitUi(
    m,
    `return doc.querySelector('[data-testid="barre-laterale"]').parentElement.inert === !arguments[0]
       && (frame.hasAttribute("full") || frame.getBoundingClientRect().width === (arguments[0] ? 240 : 0));`,
    [shown],
  );

/** A mouse move through the widget, as an OS one: over a web page the UI document does not see it. */
const moveMouse = (x: number) =>
  m.execute(
    `const ratio = window.devicePixelRatio;
     window.windowUtils.sendNativeMouseEvent((window.mozInnerScreenX + arguments[0]) * ratio, (window.mozInnerScreenY + 300) * ratio, window.windowUtils.NATIVE_MOUSE_MESSAGE_MOVE, 0, 0, document.documentElement);`,
    [x],
  );

async function openPage(): Promise<void> {
  await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}/icone` });
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
    expect(hidden).toMatchObject({ page: 0, frame: 0, pageWidth: hidden.window });

    await moveMouse(5);
    await waitSidebar(true);
    expect(await layout()).toMatchObject({ page: 0, frame: 240, pageWidth: hidden.window });

    // Over the sidebar, then over its margin on the page: it stays.
    await moveMouse(100);
    await moveMouse(260);
    await sleep(500);
    expect((await layout()).sidebar).toBe(true);

    await moveMouse(600);
    await waitSidebar(false);
    expect(await layout()).toMatchObject({ page: 0, frame: 0 });
  });

  it("the macOS window buttons go with the sidebar", async () => {
    const buttons = () => m.execute<boolean>(`return document.getElementById("webaios-window-buttons").checkVisibility();`);
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
    await moveMouse(600);
    await moveMouse(100);
    await sleep(500);
    expect((await layout()).sidebar).toBe(true);
  });

  it("⇧⌘S toggles it from the page", async () => {
    await openPage();
    await pressKeys(m, "Meta+Shift+s");
    await waitSidebar(false);
    expect((await state(m)).fenetres[0]!.compact).toBe(true);
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
    await toggle();
    await waitSidebar(false);
    const shown = await inUi<{ frame: number; left: number; free: number }>(
      m,
      `return { frame: frame.getBoundingClientRect().width, left: doc.querySelector('[data-testid="zone-contenu"]').getBoundingClientRect().left,
        free: document.getElementById("webaios-agent").getBoundingClientRect().left };`,
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
});
