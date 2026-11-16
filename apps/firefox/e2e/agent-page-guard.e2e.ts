import { afterAll, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";

// A page the agent serves on its container's ports reaches only local addresses (and a few CDNs): the "public"
// server is 127.0.0.1, declared public for the test; the agent page is opened on localhost.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const html = (body: string) => (_: unknown, res: any) => res.writeHead(200, { "Content-Type": "text/html" }).end(body);

let web: Awaited<ReturnType<typeof startServer>>;
let agent: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => {
  web = await startServer({ routes: { "/arrive": html("<title>arrive</title>") } });
  const to = web.url;
  agent = await startServer({
    routes: {
      "/leak": html(
        `<title>leak</title><img src="${to}/pixel.png?d=1">` +
          `<script>fetch("${to}/fetch?d=1").catch(() => {}); setTimeout(() => { location = "${to}/away?d=1"; }, 500)</script>`,
      ),
      "/link": html(`<title>link</title><a id="out" href="${to}/arrive">out</a>`),
    },
  });
  w = await launchRessac({ env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_CONTAINER_PORTS: `${agent.port}-${agent.port}` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
});
afterAll(async () => {
  await w?.close();
  await agent?.close();
  await web?.close();
});

const open = async (url: string) => {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, activate: true });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
};
const current = () => m.execute<string>("return gBrowser.selectedBrowser.currentURI.spec");

it("an agent page's image, fetch and navigation never reach the web", async () => {
  const page = `http://localhost:${agent.port}/leak`;
  await open(page);
  await sleep(1500);
  expect(agent.paths).toContain("/leak");
  expect(web.paths).toEqual([]);
  expect(await current()).toBe(page);
});

it("a link the user clicks on an agent page leaves it", async () => {
  await open(`http://localhost:${agent.port}/link`);
  await inBrowser(m, "gBrowser.selectedBrowser", 'document.getElementById("out").click(); return 0', { gesture: true });
  await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v === `${web.url}/arrive`);
  expect(web.paths).toContain("/arrive");
});
