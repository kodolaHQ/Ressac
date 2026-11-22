// Drives the packaged Ressac in the VM over Marionette (tunnelled to 127.0.0.1:28280) and reads the host servers' hits.
import fs from "node:fs";
import { Marionette } from "../../../apps/firefox/e2e/marionette.ts";
const [log, out] = process.argv.slice(2);
// The host as the VM sees it: Tart's default NAT gateway, else VM_HOST_IP.
const HOST = process.env.VM_HOST_IP ?? "192.168.64.1";
const H = `http://${HOST}`;
// Agent pages on the VM's own loopback (an ssh reverse tunnel to the host server), as the agent's container serves them.
const A = "http://localhost:5300";
const hits = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const m = await Marionette.connect(28280);
await m.command("WebDriver:NewSession", {});
await m.setContext("chrome");
const until = async (script: string, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) { try { if (await m.execute<boolean>(script)) return; } catch {} if (Date.now() > end) throw new Error("timeout: " + script); await sleep(200); }
};
await until("return typeof gBrowser !== 'undefined' && !!gBrowser.selectedBrowser", 120_000);
// The CDN names point to the host in /etc/hosts; their real IPv6 answers would win otherwise.
await m.execute("Services.prefs.setBoolPref('network.dns.disableIPv6', true); Cc['@mozilla.org/network/dns-service;1'].getService(Ci.nsIDNSService).clearCache(true)");
await m.execute("gBrowser.selectedTab = gBrowser.addTab('about:blank', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })");
const results: any[] = [];
async function step(id: string, how: "typed" | "page", url: string, mustArrive: string[], mustNot: string[]) {
  const before = hits().length;
  await m.execute(
    "gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })",
    [url],
  );
  await sleep(500);
  await until("return !gBrowser.selectedBrowser.webProgress.isLoadingDocument");
  // Positive hits are waited for; the must-not window starts once the load is over.
  const end = Date.now() + 10_000;
  while (Date.now() < end && !mustArrive.every((p) => hits().slice(before).some((h) => h.url.startsWith(p)))) await sleep(200);
  await sleep(2000);
  const got = hits().slice(before).map((h) => `${h.port}${h.url}`);
  const arrived = mustArrive.filter((p) => !hits().slice(before).some((h) => h.url.startsWith(p)));
  const leaked = mustNot.filter((p) => hits().slice(before).some((h) => h.url.startsWith(p)));
  const uri = await m.execute<string>("return gBrowser.selectedBrowser.currentURI.spec");
  results.push({ id, how, ok: arrived.length === 0 && leaked.length === 0, missing: arrived, leaked, got, tab: uri });
}
const enc = encodeURIComponent;
await step("C1 control: a typed LAN address loads", "typed", `${H}:8099/v/c1-direct`, ["/v/c1-direct"], []);
await step("C2 control: a typed non-agent page that redirects to it loads", "typed", `${H}:8098/r?to=${enc(`${H}:8099/v/c2-redirect`)}`, ["/v/c2-redirect"], []);
await step("B4: a typed agent address redirected to the web does not leave", "typed", `${A}/r?to=${enc(`${H}:8099/v/b4-redirect?d=secret`)}`, ["/r"], ["/v/b4-redirect"]);
await step("B4 honest: a typed agent address redirected to its own page loads", "typed", `${A}/r?to=${enc(`${A}/page?after`)}`, ["/page?after"], []);
await step("Review: a web page sent through the agent's server to the web does not leave", "page", `${H}:8098/via`, ["/r"], ["/v/via-leak"]);
// The CDN names resolve to the host for the two CDN steps only.
await m.execute("Services.prefs.setStringPref('network.dns.forceResolve', arguments[0]); Services.prefs.setBoolPref('network.stricttransportsecurity.preloadlist', false); Cc['@mozilla.org/network/dns-service;1'].getService(Ci.nsIDNSService).clearCache(true)", [HOST]);
await step("A6 control: a normal page's clear-text image on a CDN name loads", "page", `${H}:8098/cdnctl`, ["/v/a6-control"], []);
await step("A6: an agent page's clear-text CDN image on another port does not leave", "page", `${A}/cdn`, ["/own.png"], ["/v/a6-clear"]);
await m.execute("Services.prefs.clearUserPref('network.dns.forceResolve'); Services.prefs.clearUserPref('network.stricttransportsecurity.preloadlist')");
const info = await m.execute<any>("return { version: Services.appinfo.version, buildID: Services.appinfo.appBuildID }");
fs.writeFileSync(out, JSON.stringify({ info, results }, null, 1));
console.log(JSON.stringify({ info, results }, null, 1));
process.exit(0);
