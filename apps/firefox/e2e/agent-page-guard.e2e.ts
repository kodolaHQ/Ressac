import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { NET_PREFS, netEnv, resolvedNames, SFX } from "./ui-network";

// A page the agent serves on its container's ports reaches only local addresses (and a few CDNs): the "public"
// server is 127.0.0.1, declared public for the test; the agent page is opened on localhost.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const html = (body: string) => (_: unknown, res: any) => res.writeHead(200, { "Content-Type": "text/html" }).end(body);

let web: Awaited<ReturnType<typeof startServer>>;
let agent: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
let logDir: string;
beforeAll(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-dnslog-"));
  web = await startServer({
    routes: {
      "/arrive": html("<title>arrive</title>"),
      // A web page that navigates through the agent's server, which redirects it to the web.
      "/via-agent": (req, res) =>
        html(`<title>via</title><script>location = "http://localhost:${agent.port}/r?to=" + encodeURIComponent("${web.url}/via-agent-leak?d=secret")</script>`)(req, res),
    },
  });
  const to = web.url;
  agent = await startServer({
    routes: {
      "/leak": html(
        `<title>leak</title><img src="${to}/pixel.png?d=1">` +
          `<script>fetch("${to}/fetch?d=1").catch(() => {}); setTimeout(() => { location = "${to}/away?d=1"; }, 500)</script>`,
      ),
      "/beacon": html(`<title>beacon</title><script>addEventListener("pagehide", () => navigator.sendBeacon("${to}/beacon?d=1", "x"))</script>`),
      "/link": html(`<title>link</title><a id="out" href="${to}/arrive">out</a>`),
      "/r": (req: any, res: any) => res.writeHead(302, { Location: new URL(req.url, "http://x").searchParams.get("to") }).end(),
      // A secret as a host name: the cancel must come before its DNS lookup.
      "/dns": html(`<title>dns</title><img src="http://img-leak.${SFX}:${web.port}/p.png"><script>fetch("http://fetch-leak.${SFX}:${web.port}/f").catch(() => {}); try { new WebSocket("ws://ws-leak.${SFX}:${web.port}/w"); } catch (e) {}</script>`),
    },
  });
  w = await launchRessac({ prefs: NET_PREFS, env: { ...netEnv(logDir), RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_CONTAINER_PORTS: `${agent.port}-${agent.port}` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
});
afterAll(async () => {
  await w?.close();
  await agent?.close();
  await web?.close();
  if (logDir) await rm(logDir, { recursive: true, force: true });
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

it("an agent page's service worker never reaches the web", async () => {
  await open(`http://localhost:${agent.port}/travailleur?vers=${encodeURIComponent(web.url)}`);
  await waitFor(m, "return 0", () => agent.paths.includes("/sw.js"));
  // The worker fetches 4 s after it installs.
  await sleep(6000);
  expect(web.paths).not.toContain("/sw");
});

it("a beacon an agent page sends as it unloads never reaches the web", async () => {
  await open(`http://localhost:${agent.port}/beacon`);
  await m.execute(
    "gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })",
    [`${web.url}/arrive`],
  );
  await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v: string) => v === `${web.url}/arrive`);
  await sleep(1000);
  expect(web.paths).not.toContain("/beacon");
});

it("an agent page's request or WebSocket to a public name is cancelled before its DNS lookup", async () => {
  await open(`http://localhost:${agent.port}/dns`);
  // The witness: a tab's own navigation resolves its name, so the log does record lookups.
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `http://witness.${SFX}:${web.port}/arrive`, activate: true });
  await expect.poll(() => resolvedNames(logDir), { timeout: 15_000 }).toContain("witness");
  const names = await resolvedNames(logDir);
  expect(names.filter((n) => n.endsWith("-leak"))).toEqual([]);
});

// An address the user types is Ressac's load (the system principal), but the redirect is the agent server's choice.
const typed = (url: string) =>
  m.execute("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })", [url]);

it("a typed address of an agent page that redirects to the web does not leave; one that redirects to its own pages does", async () => {
  await open(`http://localhost:${agent.port}/link`);
  const before = web.paths.length;
  const asked = agent.paths.length;
  await typed(`http://localhost:${agent.port}/r?to=${encodeURIComponent(`${web.url}/typed-redirect?d=secret`)}`);
  // The redirect was answered and the load is over (blocked: the tab stays; let through: the web page).
  await expect.poll(() => agent.paths.slice(asked)).toContain("/r");
  await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument", (v) => v === true);
  expect(web.paths.slice(before)).toEqual([]);
  await typed(`http://localhost:${agent.port}/r?to=${encodeURIComponent(`http://localhost:${agent.port}/link?after`)}`);
  await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v) => v === `http://localhost:${agent.port}/link?after`);
});

it("a web page's navigation that the agent's server redirects to the web does not leave", async () => {
  const before = web.paths.length;
  const asked = agent.paths.length;
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${web.url}/via-agent`, activate: true });
  // The agent's server answered the redirect and the load is over (blocked: an error page; let through: the web).
  await expect.poll(() => agent.paths.slice(asked)).toContain("/r");
  await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument", (v) => v === true);
  expect(web.paths.slice(before).filter((p) => p.startsWith("/via-agent-leak"))).toEqual([]);
});
