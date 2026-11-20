import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, siteWindowExpr, writeSite } from "./sites";
import { inFrame } from "./ui";
import { consoleWith, NET_PREFS, SFX, startNetWitness, widgetFiles } from "./ui-network";

// The UI's network failing to install (RESSAC_TEST_UI_NETWORK_FAIL, spec addendum 3): without the observer (the only
// layer of the system documents) no UI frame gets its src; the policy failing alone, the UI loads and the observer
// still cancels a widget's frame loads. One launch per case. Ports: 15375 (HTTP, logged by host), 15376 (TCP counter).

const HTTP = 15375;
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = (name: string) => `${name}.${SFX}:${HTTP}`;

let net: Awaited<ReturnType<typeof startNetWitness>>;
beforeAll(async () => {
  net = await startNetWitness({ http: HTTP, raw: 15376 });
});
afterAll(() => net?.close());

/** Ressac on a fresh data folder (`prepare` writes into it first), the net's step `fail` forced to throw. */
async function launch(fail: string, prepare: (dataDir: string) => Promise<void> | void): Promise<{ w: LaunchedRessac; m: Marionette; dataDir: string }> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  await prepare(dataDir);
  const w = await launchRessac({ dataDir, prefs: NET_PREFS, env: { RESSAC_TEST_UI_NETWORK_FAIL: fail, RESSAC_TEST_LOCAL_ADDRESSES: "1" } });
  await w.marionette.setContext("chrome");
  return { w, m: w.marionette, dataDir };
}

describe("the observer failing to install", () => {
  let l: Awaited<ReturnType<typeof launch>>;
  beforeAll(async () => {
    l = await launch("observer", async (dataDir) => {
      const failsite = { name: "Failsite", url: `http://failsite.localhost:${HTTP}/page`, domains: ["failsite.localhost"] };
      writeSite(dataDir, "failsite", { declaration: failsite });
      await grantSite(dataDir, "failsite", failsite);
    });
  }, 120_000);
  afterAll(async () => {
    await l?.w.close();
    if (l) await rm(l.dataDir, { recursive: true, force: true });
  });

  it("the observer failing to install: no UI frame gets its src", { timeout: 120_000 }, async () => {
    const { m } = l;
    await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true, 30_000);
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; await store.agent.request("sites.act", { id: "failsite", action: "open", window: store.state.windows[0].id }); })();`);
    // The app's view still loads (a content browser): its window is up.
    await expect.poll(() => net.hits.some((h) => h.label === "failsite.localhost" && h.path === "/page"), { timeout: 20_000 }).toBe(true);
    await sleep(3000);
    const uris = await m.execute(
      `const uri = (f) => f ? f.contentDocument?.documentURI ?? "none" : "missing";
       return [uri(document.getElementById("ressac-sidebar")), uri(document.getElementById("ressac-agent")), uri(${siteWindowExpr("failsite")}?.document.getElementById("ressac-site-bar"))];`,
    );
    expect(uris).toEqual(["about:blank", "about:blank", "about:blank"]);
    expect(await consoleWith(m, "[ui-network] the UI's network guard is missing")).not.toEqual([]);
    // A tab still loads.
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `http://127.0.0.1:${HTTP}/temoin`, activate: true });
    await expect.poll(() => net.hits.some((h) => h.path === "/temoin"), { timeout: 15_000 }).toBe(true);
  });
});

describe("the policy failing alone", () => {
  let l: Awaited<ReturnType<typeof launch>>;
  beforeAll(async () => {
    // The spikes' loadsWidget: a static web frame and a child navigated to the web.
    l = await launch("policy", (dataDir) =>
      widgetFiles(
        dataDir,
        "cadres",
        `<!doctype html><meta charset="utf-8"><p id="t">cadres</p>
<iframe src="http://${host("fail-sfr")}/fail/sfr"></iframe>
<script>
const f = document.createElement("iframe");
document.body.append(f);
try { f.contentWindow.location.href = "http://${host("fail-nav")}/fail/nav"; } catch (e) {}
</script>`,
      ),
    );
  }, 120_000);
  afterAll(async () => {
    await l?.w.close();
    if (l) await rm(l.dataDir, { recursive: true, force: true });
  });

  it("the policy failing alone: the UI loads, the observer still cancels a widget's frame load", { timeout: 120_000 }, async () => {
    const { m } = l;
    await waitReady(m);
    await expect
      .poll(() => inFrame(m, '[data-testid="widget-cadres"] browser', `!!document.getElementById("t")`).catch(() => false), {
        timeout: 20_000,
      })
      .toBe(true);
    await sleep(3000);
    expect(net.hits.filter((h) => h.label.startsWith("fail-")).map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect(await consoleWith(m, "[ui-network]")).not.toEqual([]);
  });
});
