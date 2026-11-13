import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import type { Marionette } from "./marionette";
import { pressKeys, waitUi } from "./ui";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";

/** The current state (chrome context). */
export async function state(m: Marionette): Promise<BrowserState> {
  return m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`);
}

/** Dispatches an action through the store and returns the new state. */
export async function dispatch(m: Marionette, action: Action): Promise<BrowserState> {
  return m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).dispatch(arguments[0]))();`, [action]);
}

/** Runs `script` (chrome context, may return a promise) until `predicate` accepts its result; rejects after `ms`. */
export async function waitFor<T>(m: Marionette, script: string, predicate: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await m.execute<T>(script);
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting on ${script}: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The handles of the open browser windows (chrome context). */
export async function windowHandles(m: Marionette): Promise<string[]> {
  return m.command<string[]>("WebDriver:GetWindowHandles");
}

/** Waits until exactly `n` browser windows are open; returns their handles. */
export async function waitWindowCount(m: Marionette, n: number, ms = 10_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const handles = await windowHandles(m);
    if (handles.length === n) return handles;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} windows: ${handles.length} open`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Runs `fn` with the window `handle` current (without focusing it), then switches back to the window it left. */
export async function inWindow<T>(m: Marionette, handle: string, fn: () => Promise<T>): Promise<T> {
  const previous = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  try {
    return await fn();
  } finally {
    // The window left may have closed meanwhile.
    if ((await windowHandles(m)).includes(previous)) await m.command("WebDriver:SwitchToWindow", { handle: previous, focus: false });
  }
}

/** The current window is Ressac: its controller, its parking tab and its sidebar are up. */
export async function waitReady(m: Marionette): Promise<void> {
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
}

/** A key that closes the current window: its key-ups have no window left to go to. */
export const pressClosing = (m: Marionette, combo: string) =>
  pressKeys(m, combo).catch((e) => {
    if (!/no such window/.test(String(e))) throw e;
  });

/** ⌘N from the current window (one open): waits for the second Ressac window to be up; returns its handle. */
export async function newWindow(m: Marionette): Promise<string> {
  const old = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  await pressKeys(m, "Meta+n");
  const other = (await waitWindowCount(m, 2)).find((h) => h !== old)!;
  await inWindow(m, other, () => waitReady(m));
  return other;
}
