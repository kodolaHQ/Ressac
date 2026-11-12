import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, waitUi } from "./ui";

// Sound does not decode in a hidden test browser (measured 2026-11-12: a media element with a sound track stays at
// readyState 1): the tab's mute goes through Firefox's own switch, and a playing media session is set in the state.
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
});
afterEach(() => w?.close());

const open = async (path: string) => {
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: server.url + path, activate: true });
  return Object.values(s.tabs).find((t) => t.url === server.url + path)!.id;
};
const sound = async (id: string) => (await state(m)).tabs[id]!.sound ?? null;

it("a muted tab shows it in its row; the pictogram unmutes the tab without switching to it", async () => {
  const a = await open("/a.html");
  await open("/b.html");
  // Firefox's own mute (what the pictogram calls): the row follows the tab's attribute.
  await m.execute(`gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]).toggleMuteAudio()`, [a]);
  await expect.poll(() => sound(a)).toBe("muted");
  const pictogram = `[data-testid="tab-${a}"] [data-testid="tab-sound"]`;
  await waitUi(m, `return doc.querySelector(arguments[0])?.getAttribute("aria-pressed") === "true"`, [pictogram]);
  await click(m, pictogram);
  await expect.poll(() => sound(a)).toBeNull();
  expect(await m.execute(`return gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]).linkedBrowser.audioMuted`, [a])).toBe(false);
  await waitUi(m, `return !doc.querySelector(arguments[0])`, [pictogram]);
  expect(await m.execute(`return gBrowser.selectedTab.getAttribute("webaios-tab-id")`)).not.toBe(a);
});

it("a background tab with a media session gets a media bar; none for the shown tab or a call; back to the tab", async () => {
  const a = await open("/a.html");
  await open("/b.html");
  await dispatch(m, { type: "updateTab", id: a, fields: { playback: "playing", sound: "playing" } });
  await waitUi(m, `return !!doc.querySelector('[data-testid="media-bar"] [data-testid="media-play"][aria-label="Mettre en pause"]') && !!doc.querySelector('[data-testid="media-bar"] [data-testid="tab-sound"]')`);
  // Paused: the bar stays to resume.
  await dispatch(m, { type: "updateTab", id: a, fields: { playback: "paused", sound: null } });
  await waitUi(m, `return !!doc.querySelector('[data-testid="media-bar"] [data-testid="media-play"][aria-label="Reprendre la lecture"]') && !doc.querySelector('[data-testid="media-bar"] [data-testid="tab-sound"]')`);
  // A call has its own bar.
  await dispatch(m, { type: "setCall", id: a, call: { mic: true, camera: true } });
  await waitUi(m, `return !doc.querySelector('[data-testid="media-bar"]') && !!doc.querySelector('[data-testid="call-bar"]')`);
  await dispatch(m, { type: "setCall", id: a, call: null });
  await click(m, '[data-testid="media-back"]');
  await waitFor(m, `return gBrowser.selectedTab.getAttribute("webaios-tab-id")`, (v: string) => v === a);
  // The shown tab: no bar, and its pause in the background is forgotten.
  await waitUi(m, `return !doc.querySelector('[data-testid="media-bar"]')`);
  await expect.poll(async () => (await state(m)).tabs[a]!.playback ?? null).toBeNull();
  // No media session on this page: the button's play / pause does nothing, and does not throw.
  expect(await m.execute(`window.webaiosWindow.togglePlayback(arguments[0]); return true`, [a])).toBe(true);
});
