import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, waitUi } from "./ui";

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
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
});
afterEach(() => w?.close());

const width = () => m.execute<number>("return window.innerWidth");
const rect = (sel: string) =>
  inUi<{ left: number; right: number }>(m, "const r = doc.querySelector(arguments[0]).getBoundingClientRect(); return { left: r.left, right: r.right };", [sel]);
const agentWidth = () => m.execute<number>("return document.getElementById('webaios-agent').getBoundingClientRect().width");
const setSide = (side: "left" | "right") => dispatch(m, { type: "setSidebarSide", side });

/** A native press on the agent's handle, a move of `dx`, the release: Gecko's own pointer capture does the rest. */
async function dragHandle(dx: number): Promise<void> {
  const x = await m.execute<number>("const r = document.getElementById('webaios-agent').getBoundingClientRect(); return r.right - 3;");
  const native = (px: number, type: string) =>
    m.execute(
      `const ratio = window.devicePixelRatio;
       window.windowUtils.sendNativeMouseEvent((window.mozInnerScreenX + arguments[0]) * ratio, (window.mozInnerScreenY + 300) * ratio, window.windowUtils[arguments[1]], 0, 0, document.documentElement);`,
      [px, type],
    );
  await native(x, "NATIVE_MOUSE_MESSAGE_MOVE");
  await native(x, "NATIVE_MOUSE_MESSAGE_BUTTON_DOWN");
  for (let i = 1; i <= 6; i++) await native(x + (dx * i) / 6, "NATIVE_MOUSE_MESSAGE_MOVE");
  await native(x + dx, "NATIVE_MOUSE_MESSAGE_BUTTON_UP");
}

describe("the sidebar on the right", () => {
  it("settings fill the window: its page sits left of the sidebar column, which is the rightmost 240 px", async () => {
    await setSide("right");
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"content-zone\"]')");
    await waitUi(m, `return frame.hasAttribute("full")`);
    const win = await width();
    const column = await rect(".column");
    const content = await rect('[data-testid="content-zone"]');
    expect(column).toEqual({ left: win - 240, right: win });
    expect(content.right).toBe(win - 240);
    expect(content.left).toBe(8);
  });

  it("a context menu on a tab stays inside the window, over a full-window page", async () => {
    await setSide("right");
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/icone` });
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, `return frame.hasAttribute("full")`);
    await click(m, '[data-testid^="tab-"]', { button: 2 });
    const menu = await waitUi<{ left: number; right: number }>(m, "const e = doc.querySelector('[role=menu]'); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right };");
    const win = await width();
    expect(menu.left).toBeGreaterThanOrEqual(0);
    expect(menu.right).toBeLessThanOrEqual(win);
    expect(menu.left).toBeGreaterThan(win - 240 - 170);
  });

  it("the compact column folds out to the right", async () => {
    await setSide("right");
    await dispatch(m, { type: "toggleCompact", windowId: (await state(m)).windows[0]!.id });
    await waitUi(m, "return doc.querySelector('.column').classList.contains('folded-up')");
    const t = await inUi<string>(m, "const c = doc.querySelector('.column'); return ui.getComputedStyle(c).transform;");
    // matrix(1, 0, 0, 1, 240, 0): translateX(100%) of a 240 px column.
    expect(t).toBe("matrix(1, 0, 0, 1, 240, 0)");
  });

  it("the URL field clears the window buttons, at the same spot as on the left", async () => {
    const field = () => inUi<number>(m, "return doc.querySelector('input').getBoundingClientRect().left - doc.querySelector('[data-testid=\"sidebar\"]').getBoundingClientRect().left");
    const buttons = () => m.execute<{ left: number; right: number }>("const r = document.getElementById('webaios-window-buttons').getBoundingClientRect(); return { left: r.left, right: r.right };");
    const sidebarLeft = () => m.execute<number>("return document.getElementById('webaios-sidebar').getBoundingClientRect().left");
    // The back, forward and reload buttons sit right of the buttons, on the navigation row above the field.
    await setSide("right");
    await waitFor(m, "return document.getElementById('webaios-sidebar').getBoundingClientRect().left", (v: number) => v > 0);
    const b = await buttons();
    // In window coordinates: the iframe's own offset plus the row's.
    const nav = await inUi<number>(m, "return frame.getBoundingClientRect().left + doc.querySelector('.navigation button').getBoundingClientRect().left");
    expect(nav).toBeGreaterThanOrEqual(b.right);
    expect(b.left).toBeGreaterThanOrEqual(await sidebarLeft());
    expect(await field()).toBeGreaterThanOrEqual(0);
  });

  it("the agent handle, on the panel's right edge, grows it as it moves right", async () => {
    await setSide("right");
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/icone` });
    await click(m, '[data-testid="agent-button"]');
    await waitFor(m, "return !document.getElementById('webaios-agent').hidden", (v) => v === true);
    const before = await agentWidth();
    await dragHandle(300);
    // The native drag loses the same 8 px on both sides (measured on the left handle too): a tolerance, not an offset in the code.
    await waitFor(m, "return document.getElementById('webaios-agent').getBoundingClientRect().width", (v: number) => v >= before + 290 && v <= before + 300);
    // Beyond the maximum (room for the page stays): clamped like the left side.
    await dragHandle(450);
    const win = await width();
    await waitFor(m, "return document.getElementById('webaios-agent').getBoundingClientRect().width", (v: number) => v === Math.min(1000, win - 240 - 300));
    expect(await agentWidth()).toBeLessThanOrEqual(1000);
  });
});
