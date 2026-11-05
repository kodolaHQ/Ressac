import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
// The noyau's gap between two reads of a site: a request must come at least this long (minus clock slack) after the previous.
const GAP_MS = 900;

interface Site {
  port: number;
  /** Where /bounce sends the browser (the other site's /bounce). */
  peer: string;
  hits: { path: string; at: number }[];
  close(): Promise<void>;
}
/** A test site: /page is text, /302?to= redirects, /script?to= redirects from a script, /bounce goes to the peer's /bounce, every request is timed. */
async function site(name: string): Promise<Site> {
  const hits: Site["hits"] = [];
  const self = { peer: "" } as Site;
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.push({ path: u.pathname, at: Date.now() });
    const to = u.searchParams.get("to") ?? "";
    if (u.pathname === "/bounce") return res.writeHead(302, { Location: self.peer }).end();
    if (u.pathname === "/302") return res.writeHead(302, { Location: to }).end();
    const body = u.pathname === "/script" ? `<title>s</title><p>saut</p><script>location.href = ${JSON.stringify(to)}</script>` : `<title>${name}</title><p>Texte de ${name}</p>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // ?slow holds the lane of a read for a while (one test only).
    if (u.searchParams.has("slow")) setTimeout(() => res.end(body), 1500);
    else res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(self, {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  });
}

let a: Site;
let b: Site;
let w: LaunchedWebAiOs;
let m: Marionette;
const urlA = (p: string) => `http://site-a.test:${a.port}${p}`;
const urlB = (p: string) => `http://site-b.test:${b.port}${p}`;
// site-c is a third name for the first server: another site for the noyau, the same test server.
const urlC = (p: string) => `http://site-c.test:${a.port}${p}`;

beforeAll(async () => {
  [a, b] = await Promise.all([site("site-a"), site("site-b")]);
  a.peer = `http://site-b.test:${b.port}/bounce`;
  b.peer = `http://site-a.test:${a.port}/bounce`;
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_ADRESSES_PUBLIQUES: "127.0.0.1", WEBAIOS_TEST_LECTURE_MENAGEE: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow", (v) => v === true);
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  await m.execute(
    `const o = Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride);
     o.addIPOverride("site-a.test", "127.0.0.1"); o.addIPOverride("site-b.test", "127.0.0.1"); o.addIPOverride("site-c.test", "127.0.0.1");
     Services.prefs.setIntPref("browser.download.folderList", 2); Services.prefs.setStringPref("browser.download.dir", arguments[0]);`,
    [w.dataDir],
  );
});
afterAll(async () => {
  await w?.close();
  await Promise.all([a?.close(), b?.close()]);
});
beforeEach(() => {
  a.hits.length = 0;
  b.hits.length = 0;
});

type Outcome = { ok: { url: string; texte: string }; at: number } | { err: string; at: number };
/** A paced read through the host's test hook (the noyau's Menagement), resolving when it ends. */
const paced = (url: string) =>
  m.execute<Outcome>(
    `return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      try { const ok = await s.agent.request("test.lectureMenagee", { url: arguments[0] }); return { ok, at: Date.now() }; }
      catch (e) { return { err: String(e?.message ?? e), at: Date.now() }; }
    })();`,
    [url],
  );
/** An unpaced read straight from the chrome (the way before: a cross-site redirect is followed at once). */
const plain = (url: string) =>
  m.execute<Outcome>(
    `return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      try { const ok = await s.readPage(arguments[0], { profil: null }); return { ok, at: Date.now() }; }
      catch (e) { return { err: String(e?.message ?? e), at: Date.now() }; }
    })();`,
    [url],
  );
const texte = (r: Outcome) => ("ok" in r ? r.ok.texte : r.err);

/** A read of site-b and, at the same moment, a read reaching site-b only by a redirect: the redirect must wait for the first read's turn. */
async function redirectBesideRead(redirect: string) {
  const [first, second] = await Promise.all([paced(urlB("/page")), paced(redirect)]);
  expect(texte(first)).toContain("Texte de site-b");
  expect(texte(second)).toContain("Texte de site-b");
  expect(b.hits).toHaveLength(2);
  // The turn comes one gap after the earlier read of site-b, which ended after its request.
  expect(b.hits[1]!.at - b.hits[0]!.at).toBeGreaterThanOrEqual(GAP_MS);
}

describe("paced reads", () => {
  it("a 302 to another site waits for that site's turn: no request reaches it before", async () => {
    await redirectBesideRead(urlA(`/302?to=${encodeURIComponent(urlB("/page"))}`));
  }, 60_000);

  it("a script redirect (location.href) to another site waits too", async () => {
    await redirectBesideRead(urlA(`/script?to=${encodeURIComponent(urlB("/page"))}`));
  }, 60_000);

  it("same-site redirect follows without waiting", async () => {
    const r = await paced(urlA(`/302?to=${encodeURIComponent(urlA("/page"))}`));
    expect(texte(r)).toContain("Texte de site-a");
    expect(a.hits.map((h) => h.path)).toEqual(["/302", "/page"]);
  }, 60_000);

  it("A ⇄ B loop fails with Trop de redirections", async () => {
    const r = await paced(urlA("/bounce"));
    expect(r).toMatchObject({ err: expect.stringContaining("Trop de redirections") });
  }, 90_000);

  it("a read without changerHote still follows a cross-site 302 at once", async () => {
    const r = await plain(urlA(`/302?to=${encodeURIComponent(urlB("/page"))}`));
    expect(texte(r)).toContain("Texte de site-b");
  }, 60_000);

  it("another read gets a place while two others wait for site-b's turn", async () => {
    const to = encodeURIComponent(urlB("/page"));
    // A slow read of site-b holds its lane (1.5 s, then one gap): the waits below end long after the plain read.
    const holder = paced(urlB("/page?slow"));
    await waitFor(m, "return 0", () => b.hits.length === 1, 20_000);
    // Two sites, so the noyau queues neither before the chrome: both reads sit in the chrome's wait together
    // (site-b's lane serves them one gap apart, the first not before one gap after the read above).
    const waiting = [paced(urlA(`/302?to=${to}`)), paced(urlC(`/302?to=${to}`))];
    await waitFor(m, "return 0", () => a.hits.filter((h) => h.path === "/302").length === 2, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    // Both stopped at their redirect, each holding a read place if it kept it: the third read must still get one
    // (read places: 2), and it ends before the first wait does.
    const free = await plain(urlA("/page"));
    expect(texte(free)).toContain("Texte de site-a");
    const ends = (await Promise.all(waiting)).map((r) => r.at);
    expect(free.at).toBeLessThan(Math.min(...ends));
    expect(texte(await holder)).toContain("Texte de site-b");
  }, 90_000);
});
