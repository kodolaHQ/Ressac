import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, inUi, waitUi } from "./ui";

// A call page on a fake camera and microphone. ⌘D and ⌘E are its own shortcuts (as Meet's): they switch its tracks and
// note in the title whether the key was a trusted one.
const CALL = `<title>Appel</title><video id="v" autoplay playsinline width="640" height="360"></video><script>
const video = v;
navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => {
  video.srcObject = new MediaStream(s.getVideoTracks());
  document.title = "Appel en cours";
  addEventListener("keydown", (e) => {
    const t = e.metaKey && e.key === "d" ? s.getAudioTracks()[0] : e.metaKey && e.key === "e" ? s.getVideoTracks()[0] : null;
    if (!t) return;
    t.enabled = !t.enabled;
    // As a real site: no camera, no video element.
    if (e.key === "e") t.enabled ? (document.body.prepend(video), video.play()) : video.remove();
    document.title = "touche " + e.key + " " + e.isTrusted;
  });
}, (e) => (document.title = "ERR " + e));
</script>`;

let server: Server;
let url: string;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => {
  server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/call" ? CALL : "<title>Autre</title>autre")).listen(0);
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await m.execute(`Services.prefs.setBoolPref("media.navigator.streams.fake", true); Services.prefs.setBoolPref("media.navigator.permission.disabled", true);
    // Fake devices count as a capture only with this one.
    Services.prefs.setBoolPref("media.navigator.permission.fake", true);`);
});
afterEach(() => w?.close());

const open = async (path: string) => {
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: url + path, activate: true });
  return Object.values(s.tabs).find((t) => t.url === url + path)!.id;
};
const bar = () =>
  inUi<{ mic: string; camera: string } | null>(
    m,
    `const b = doc.querySelector('[data-testid="call-bar"]');
     return b ? { mic: b.querySelector('[data-testid="call-mic"]').getAttribute("aria-pressed"), camera: b.querySelector('[data-testid="call-camera"]').getAttribute("aria-pressed") } : null;`,
  );
const waitBar = (mic: string, camera: string) =>
  waitUi(m, `const b = doc.querySelector('[data-testid="call-bar"]'); return b?.querySelector('[data-testid="call-mic"]').getAttribute("aria-pressed") === arguments[0] && b.querySelector('[data-testid="call-camera"]').getAttribute("aria-pressed") === arguments[1];`, [mic, camera]);
const callTitle = (id: string, title: string) =>
  waitFor(m, `return gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === ${JSON.stringify(id)})?.linkedBrowser.contentTitle`, (v: string) => v === title);

it("leaving a call's tab floats its video and shows the call bar; its buttons mute what the tab sends; back to the call puts everything away", async () => {
  // A page without a call: nothing floats, no bar.
  await open("/other");
  const call = await open("/call");
  await callTitle(call, "Appel en cours");
  expect(await bar()).toBeNull();
  await open("/other2");
  await waitBar("true", "true");
  await waitFor(m, `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`, (v: number) => v === 1);
  // An unknown site: Firefox mutes what the tab sends, and unmutes it.
  await click(m, '[data-testid="call-mic"]');
  await waitBar("false", "true");
  await click(m, '[data-testid="call-camera"]');
  await waitBar("false", "false");
  await click(m, '[data-testid="call-mic"]');
  await waitBar("true", "false");
  // Back to the call: its tab is shown, the bar and the floating video go.
  await click(m, '[data-testid="call-back"]');
  await waitFor(m, `return gBrowser.selectedTab.getAttribute("ressac-tab-id")`, (v: string) => v === call);
  await waitUi(m, `return !doc.querySelector('[data-testid="call-bar"]')`);
  await waitFor(m, `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`, (v: number) => v === 0);
  expect((await state(m)).tabs[call]!.call).toBeUndefined();
});

it("on a known site the buttons press the site's own shortcut, as a trusted key, and show what the site then sends", async () => {
  const key = (k: string, code: number) => ({ key: k, code: "Key" + k.toUpperCase(), keyCode: code, meta: true });
  await m.execute(`Services.prefs.setStringPref("ressac.call.sites", arguments[0])`, [JSON.stringify([{ host: "^127\\.0\\.0\\.1$", mic: key("d", 68), camera: key("e", 69) }])]);
  const call = await open("/call");
  await callTitle(call, "Appel en cours");
  await open("/other");
  await waitBar("true", "true");
  await click(m, '[data-testid="call-mic"]');
  await waitBar("false", "true");
  await callTitle(call, "touche d true");
  await click(m, '[data-testid="call-camera"]');
  await waitBar("false", "false");
  await callTitle(call, "touche e true");
  // The site drops its video with the camera: the floating video goes, and comes back when the camera does.
  await waitFor(m, `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`, (v: number) => v === 0);
  await click(m, '[data-testid="call-camera"]');
  await waitBar("false", "true");
  await waitFor(m, `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`, (v: number) => v === 1);
});

it("a call that ends in the background takes its bar away", async () => {
  const call = await open("/call");
  await callTitle(call, "Appel en cours");
  await open("/other");
  await waitBar("true", "true");
  await dispatch(m, { type: "closeTab", id: call });
  await waitUi(m, `return !doc.querySelector('[data-testid="call-bar"]')`);
  await waitFor(m, `return [...Services.wm.getEnumerator("Toolkit:PictureInPicture")].length`, (v: number) => v === 0);
});
