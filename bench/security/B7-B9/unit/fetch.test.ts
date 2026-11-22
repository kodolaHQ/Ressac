// B7 C7.7, kernel fetch (packages/kernel/src/workflows/access.ts) against local servers and an in-process DNS stub.
// Records outcomes in results/fetch.json; no assertion decides the verdict, REPORT.md reads the rows.
import dns from "node:dns";
import http from "node:http";
import os from "node:os";
import { isIP } from "node:net";
import { writeFileSync } from "node:fs";
import { fetch as kfetch, checkUrl, checkPage, localUrl } from "../../../../packages/kernel/src/workflows/access.ts";

type Row = { id: string; input: string; outcome: string };
const rows: Row[] = [];
const hits: string[] = [];
const seenHeaders: Record<string, unknown>[] = [];
let lookups: string[] = [];

// The machine's own global IPv6 address: the only non-private address a local test server can bind.
const gua = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv6" && !a.internal && /^[23]/.test(a.address))?.address;
const mask = (s: string) => (gua ? s.split(gua).join("<mac-global-v6>") : s);

const table: Record<string, () => { address: string; family: number }[]> = {};
(dns as any).lookup = (host: string, options: any, cb: any) => {
  lookups.push(host);
  const fam = isIP(host);
  const e = fam ? () => [{ address: host, family: fam }] : table[host];
  if (!e) return cb(Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
  const list = e();
  return options?.all ? cb(null, list) : cb(null, list[0]!.address, list[0]!.family);
};
const v4 = (a: string) => () => [{ address: a, family: 4 }];
const v6 = (a: string) => () => [{ address: a, family: 6 }];

function handler(name: string): http.RequestListener {
  return (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.push(`${name} ${u.pathname}`);
    if (u.pathname === "/headers") { seenHeaders.push(req.headers); return void res.end("ok"); }
    if (u.pathname === "/r") return void res.writeHead(Number(u.searchParams.get("code") ?? 302), { location: u.searchParams.get("to")! }).end();
    if (u.pathname === "/noloc") return void res.writeHead(302).end();
    if (u.pathname === "/hops") { const n = Number(u.searchParams.get("n")); return void (n > 0 ? res.writeHead(302, { location: `/hops?n=${n - 1}` }).end() : res.end("end")); }
    if (u.pathname === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (u.pathname === "/big-cl") { res.writeHead(200, { "content-length": String(6 * 1024 * 1024) }); return void res.end(Buffer.alloc(6 * 1024 * 1024)); }
    if (u.pathname === "/big-chunked") { res.writeHead(200); for (let i = 0; i < 6; i++) res.write(Buffer.alloc(1024 * 1024)); return void res.end(); }
    if (u.pathname === "/drip") { res.writeHead(200); const t = setInterval(() => res.write("x"), 500); res.on("close", () => clearInterval(t)); return; }
    res.end(`${name}:${u.pathname}`);
  };
}
const listen = (name: string, host: string) => new Promise<http.Server>((ok, ko) => { const s = http.createServer(handler(name)); s.once("error", ko); s.listen(0, host, () => ok(s)); });
const port = (s: http.Server) => (s.address() as any).port as number;

async function attempt(id: string, url: string, domains: readonly string[] | null = null, local = false): Promise<string> {
  const before = hits.length;
  let outcome: string;
  try {
    const r = await kfetch(url, "text", domains, local);
    outcome = `ANSWER ${String(r).slice(0, 40)}`;
  } catch (e) {
    outcome = `refused: ${(e as Error).message}`;
  }
  const reached = hits.slice(before).filter((h) => h.startsWith("LOCAL"));
  if (reached.length) outcome += `  [LOCAL SERVER HIT: ${reached.join(", ")}]`;
  rows.push({ id, input: mask(url) + (domains ? ` domains=${JSON.stringify(domains)}` : "") + (local ? " local=true" : ""), outcome: mask(outcome) });
  return outcome;
}
function text(id: string, url: string, domains: readonly string[] | null = null) {
  let outcome: string;
  try { outcome = `accepted as ${checkUrl(url, domains, false).href}`; } catch (e) { outcome = `refused: ${(e as Error).message}`; }
  rows.push({ id, input: url + (domains ? ` domains=${JSON.stringify(domains)}` : ""), outcome });
}

test("kernel fetch", async () => {
  const L4 = await listen("LOCAL4", "127.0.0.1");
  const L6 = await listen("LOCAL6", "::1");
  const P = gua ? await listen("PUBLIC", gua) : null;
  const pL = port(L4), pL6 = port(L6), pP = P ? port(P) : 0;
  rows.push({ id: "setup", input: "servers", outcome: `LOCAL4 127.0.0.1, LOCAL6 ::1, PUBLIC ${gua ? "<mac-global-v6> (localUrl=" + localUrl(gua) + ")" : "none: no global address"}` });

  // G3 schemes, G4 credentials
  for (const u of ["file:///etc/hosts", "ftp://example.com/x", "data:text/plain,x", "gopher://example.com/", "javascript:alert(1)", "blob:http://example.com/x", "ws://example.com/"]) text("G3", u);
  text("G4", "http://u:p@example.com/");
  text("G4", "http://u@example.com/");

  // G5-G8 by text. Loopback spellings are also tried for real against LOCAL4/LOCAL6.
  for (const h of ["localhost", "localhost.", "LOCALHOST", "x.localhost", "x.local", "x.local.", "x.internal", "x.home.arpa", "127.0.0.1", "127.1", "0", "0.0.0.0", "10.0.0.1", "172.16.0.1", "172.31.255.255", "172.32.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "224.0.0.1", "255.255.255.255"]) text("G5", `http://${h}/`);
  for (const h of ["2130706433", "0x7f000001", "0177.0.0.1", "0x7f.1", "127.0.0.1.", "%31%32%37.0.0.1", "１２７.0.0.1", "127。0。0。1"]) await attempt("G6", `http://${h}:${pL}/secret`);
  for (const h of ["[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"]) await attempt("G7", `http://${h}:${pL6}/secret`);
  for (const h of ["[::]", "[::127.0.0.1]", "[fe80::1]", "[fc00::1]", "[fd12:3456::1]", "[fec0::1]", "[64:ff9b::7f00:1]", "[64:ff9b:1::7f00:1]", "[2002:7f00:1::]", "[2001:0:4136:e378:8000:63bf:3fff:fdd2]", "[ff02::1]", "[::ffff:0:7f00:1]", "[fe80::1%25lo0]"]) text("G7", `http://${h}/`);
  for (const h of ["198.18.0.1", "198.19.249.2", "192.0.0.8", "192.0.2.1", "198.51.100.1", "203.0.113.1", "192.88.99.1"]) text("G8", `http://${h}/`);

  // G9 names that resolve to local addresses
  table["a-loop.test"] = v4("127.0.0.1");
  table["a-ten.test"] = v4("10.0.0.1");
  table["a-zero.test"] = v4("0.0.0.0");
  table["aaaa-loop.test"] = v6("::1");
  table["aaaa-mapped.test"] = v6("::ffff:127.0.0.1");
  table["aaaa-ula.test"] = v6("fd00::1");
  table["aaaa-linklocal.test"] = v6("fe80::1%lo0");
  table["mixed.test"] = () => [{ address: gua ?? "93.184.216.34", family: gua ? 6 : 4 }, { address: "127.0.0.1", family: 4 }];
  table["orb.test"] = v4("198.19.249.2");
  for (const n of ["a-loop.test", "a-ten.test", "a-zero.test", "mixed.test"]) await attempt("G9", `http://${n}:${pL}/secret`);
  for (const n of ["aaaa-loop.test", "aaaa-mapped.test", "aaaa-ula.test", "aaaa-linklocal.test"]) await attempt("G9", `http://${n}:${pL6}/secret`);
  await attempt("G9", "http://nxdomain.test/");
  // 198.18/15 passes the address check: shown at the lookup only (no packet is sent there).
  rows.push({ id: "G9", input: "name -> 198.19.249.2 (lookup check only)", outcome: await new Promise((ok) => (kfetchLookup as any)("orb.test", { all: false }, (e: Error | null, a: string) => ok(e ? `refused: ${e.message}` : `accepted, would connect to ${a}`))) });

  if (P && gua) {
    table["pub.test"] = v6(gua);
    table["other.test"] = v6(gua);
    const pub = `http://pub.test:${pP}`;
    // The Mac's own global address is "public" for the check.
    await attempt("G8", `http://[${gua}]:${pP}/own-global-address`);
    // G10 rebinding: public at the first lookup, local at the second.
    let n = 0;
    table["rebind.test"] = () => (n++ === 0 ? [{ address: gua, family: 6 }] : [{ address: "127.0.0.1", family: 4 }]);
    lookups = [];
    await attempt("G10", `http://rebind.test:${pP}/r?to=${encodeURIComponent(`http://rebind.test:${pL}/secret`)}`);
    rows.push({ id: "G10", input: "lookups made", outcome: lookups.join(", ") });
    // G11 redirects
    const to = (t: string, code = 302) => `${pub}/r?code=${code}&to=${encodeURIComponent(t)}`;
    for (const code of [301, 302, 303, 307, 308]) await attempt("G11", to(`http://127.0.0.1:${pL}/secret`, code));
    await attempt("G11", to(`http://a-loop.test:${pL}/secret`));
    await attempt("G11", to(`http://2130706433:${pL}/secret`));
    await attempt("G11", to(`http://[::1]:${pL6}/secret`));
    await attempt("G11", to(`http://localhost.:${pL}/secret`));
    await attempt("G11", to("file:///etc/hosts"));
    await attempt("G11", to(`http://u:p@pub.test:${pP}/ok`));
    await attempt("G11", to("/relative-ok"));
    await attempt("G11", to(`//127.0.0.1:${pL}/secret`));
    await attempt("G11", `${pub}/hops?n=5`);
    await attempt("G11", `${pub}/hops?n=6`);
    await attempt("G11", `${pub}/loop`);
    await attempt("G11", `${pub}/noloc`);
    await attempt("G11", to(`http://other.test:${pP}/undeclared`), ["pub.test"]);
    await attempt("G11", to(`http://pub.test:${pP}/declared`), ["pub.test"]);
    // G13 keep-alive reuse: an allowed-local read first, then a no-local read to the same name and port.
    table["reuse.test"] = v4("127.0.0.1");
    await attempt("G13", `http://reuse.test:${pL}/first`, null, true);
    await attempt("G13", `http://reuse.test:${pL}/second-must-be-refused`, null, false);
    // G14 caps
    await attempt("G14", `${pub}/big-cl`);
    await attempt("G14", `${pub}/big-chunked`);
    const t0 = Date.now();
    await attempt("G14", `${pub}/drip`);
    rows.push({ id: "G14", input: "drip duration", outcome: `${Math.round((Date.now() - t0) / 1000)} s` });
    // G15 what goes out
    await attempt("G15", `${pub}/headers`);
    rows.push({ id: "G15", input: "request headers the server saw", outcome: mask(JSON.stringify(seenHeaders.at(-1))) });
    // G17 capacity: a long address
    await attempt("G17", `${pub}/x?d=${"A".repeat(12000)}`);
    await attempt("G17", `${pub}/x?d=${"A".repeat(60000)}`);
  }

  // G12 declared-domain matching (text)
  const D = ["app.example"];
  for (const u of ["https://app.example/", "https://APP.EXAMPLE./", "https://app.example:8443/", "http://app.example/", "https://sub.app.example/", "https://app.example.evil.test/", "https://evilapp.example/", "https://evil.test/app.example", "https://evil.test#@app.example", "https://evil.test\\@app.example/", "https://app.example\\@evil.test/", "https://app.example%2eevil.test/", "https://аpp.example/"]) text("G12", u, D);

  // G16 checkPage
  for (const u of ["http://127.0.0.1:1/", "https://evil.test/", "https://app.example/x", "about:blank", "file:///etc/hosts"]) {
    let outcome: string;
    try { checkPage({ url: u } as any, D, false); outcome = "accepted"; } catch (e) { outcome = `refused: ${(e as Error).message}`; }
    rows.push({ id: "G16", input: u, outcome });
  }

  for (const s of [L4, L6, P]) { s?.closeAllConnections(); s?.close(); }
  writeFileSync(new URL("./results/fetch.json", import.meta.url), JSON.stringify(rows, null, 1));
}, 120_000);

import { lookupWithoutLocal as kfetchLookup } from "../../../../packages/kernel/src/workflows/access.ts";
