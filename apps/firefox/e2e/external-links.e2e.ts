import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { URL_SETTINGS } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => {
  server = await startServer();
});
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchRessac({ env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
});
afterEach(async () => w?.close());

const STATE = `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state)();`;

/** What macOS does when another app opens a link with Ressac as the default browser (BrowserContentHandler). */
const openFromMac = (url: string) =>
  m.execute(
    `window.browserDOMWindow.openURI(Services.io.newURI(arguments[0]), null, Ci.nsIBrowserDOMWindow.OPEN_DEFAULTWINDOW, Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL, Services.scriptSecurityManager.getSystemPrincipal());`,
    [url],
  );

describe("links opened from macOS", () => {
  it("open in a new tab, the current one keeps its page", async () => {
    const first = `${server.url}/a`;
    const s0 = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: first });
    const current = Object.values(s0.tabs).find((t) => t.url === first)!;
    const external = `${server.url}/b`;
    await openFromMac(external);
    const s = await waitFor(m, STATE, (st: any) => Object.values(st.tabs).some((t: any) => t.url === external));
    expect((s as any).tabs[current.id].url).toBe(first);
    const f = (s as any).windows[0];
    expect((s as any).tabs[f.active[f.activeSpace]].url).toBe(external);
  });

  it("open in a new tab while the home page shows", async () => {
    const s0 = await state(m);
    const f0 = s0.windows[0]!;
    expect(f0.active[f0.activeSpace]).toBeNull();
    const external = `${server.url}/c`;
    await openFromMac(external);
    const s = await waitFor(m, STATE, (st: any) => Object.values(st.tabs).some((t: any) => t.url === external));
    const f = (s as any).windows[0];
    expect((s as any).tabs[f.active[f.activeSpace]].url).toBe(external);
  });

  it("open in a new tab while an internal page shows", async () => {
    await dispatch(m, { type: "openSettings", windowId: (await state(m)).windows[0]!.id });
    const external = `${server.url}/d`;
    await openFromMac(external);
    const s = await waitFor(m, STATE, (st: any) => Object.values(st.tabs).some((t: any) => t.url === external));
    const f = (s as any).windows[0];
    expect((s as any).tabs[f.active[f.activeSpace]].url).toBe(external);
    expect(Object.values((s as any).tabs).some((t: any) => t.url === URL_SETTINGS)).toBe(true);
  });
});
