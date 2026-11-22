// Security bench B9, claim C9.5 (catalogue P11–P17): what telemetry really sends, captured by a fake Sentry.
// NOT part of the repo's suite. Written without the engine (it was busy): never run yet. To run, from apps/firefox:
//   cp <bench>/e2e/b9-telemetry-capture.e2e.ts e2e/bench-b9-telemetry-capture.e2e.ts
//   corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/bench-b9-telemetry-capture.e2e.ts
//   rm e2e/bench-b9-telemetry-capture.e2e.ts
// The DSN is a local server: nothing goes to the real Sentry. The captured payloads are written to
// $TMPDIR/ressac-b9-telemetry-payloads.json for the report (they may hold this machine's home path where a scrub fails:
// read them before sharing).
// Tests marked PREDICTED RED are scrub gaps the unit run already showed on the pure function (unit/results/pure.json).
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { NET_PREFS, netEnv } from "./ui-network";

const OURS = "chrome://browser/content/ressac/store.sys.mjs";
const OUT = path.join(os.tmpdir(), "ressac-b9-telemetry-payloads.json");

// A fake Sentry: every request is kept, whatever its path (an envelope, a minidump, anything else).
type Seen = { at: number; path: string; type: string; payload: any; raw: string };
let seen: Seen[] = [];
let server: Awaited<ReturnType<typeof startServer>>;
const keep = (p: string) => (req: any, res: any) => {
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c));
  req.on("end", () => {
    let type = "?", payload: any = null;
    try { const [, item, body] = raw.split("\n").map((l) => JSON.parse(l)); type = item.type; payload = body; } catch {}
    seen.push({ at: Date.now(), path: p, type, payload, raw });
    res.writeHead(200).end("{}");
  });
};
beforeAll(async () => {
  server = await startServer({ routes: { "/api/1/envelope/": keep("envelope"), "/api/1/minidump/": keep("minidump") } });
});
const all: Record<string, unknown> = {};
afterAll(async () => {
  writeFileSync(OUT, JSON.stringify(all, null, 1));
  await server?.close();
});

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  await w?.close();
  w = undefined;
  seen = [];
});
const dsn = () => `http://k@127.0.0.1:${server.port}/1`;
async function launch(profile: string, extra: { prefs?: Record<string, string | number | boolean>; env?: Record<string, string> } = {}): Promise<void> {
  w = await launchRessac({ profile, prefs: extra.prefs, env: { RESSAC_SENTRY_DSN: dsn(), ...extra.env } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
}
/** Logs a console error as if thrown by our chrome (as e2e/telemetry.e2e.ts does). */
const logError = (message: string, source = OURS) =>
  m.execute(
    `const e = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
     e.init(arguments[0], arguments[1], 1, 1, Ci.nsIScriptError.errorFlag, "chrome javascript");
     Services.console.logMessage(e);`,
    [message, source],
  );
const settle = (ms = 2000) => new Promise((r) => setTimeout(r, ms));
const events = () => seen.filter((s) => s.type === "event");
const sessions = () => seen.filter((s) => s.type === "session");

it("P11–P14: first launch sends nothing until the notice; then errors; the second launch one session; the switch stops all of it", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    // First launch. The notice is appended with the first window, and `noticeShown` is set at that same moment
    // (chrome/window/index.ts): "before the notice" is only the start-up itself.
    await launch(profile);
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
    const shownAt = Date.now();
    await settle();
    all.firstLaunchBeforeAnyError = seen.map((s) => ({ type: s.type, path: s.path, msBeforeNotice: shownAt - s.at }));
    expect(sessions(), "no launch count on the first launch").toEqual([]);
    expect(seen.filter((s) => s.at < shownAt), "nothing before the notice showed").toEqual([]);
    // P12: the notice is on screen, nobody answered it: an error now is sent (opt-out). Recorded, not judged.
    await logError("Error: bench first-launch error, notice unanswered");
    await settle();
    all.sentWhileNoticeUnanswered = events().length;
    console.log(`[P12] error raised while the notice is still unanswered: ${events().length ? "SENT" : "not sent"}`);
    await w!.close();
    w = undefined;
    seen = [];
    // Second launch: exactly one session.
    await launch(profile);
    await expect.poll(() => sessions().length, { timeout: 15_000 }).toBe(1);
    await settle();
    expect(sessions().length).toBe(1);
    all.session = sessions()[0]!.payload;
    all.sessionRaw = sessions()[0]!.raw;
    const installId = sessions()[0]!.payload.did;
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    // P14: the switch.
    await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.enabled", false);`);
    const n = seen.length;
    await logError("Error: bench error after the switch");
    await settle();
    expect(seen.length - n, "nothing after the switch").toBe(0);
    expect(await m.execute(`return [Services.prefs.getStringPref("ressac.telemetry.installId", ""), Services.prefs.getBoolPref("browser.tabs.crashReporting.sendReport", false)]`)).toEqual(["", false]);
    expect((await m.execute(`try { return Services.appinfo.QueryInterface(Ci.nsICrashReporter).submitReports; } catch (e) { return "no crash reporter"; }`)) === true, "crash reports are not submitted").toBe(false);
    await w!.close();
    w = undefined;
    seen = [];
    // Third launch, switch still off: nothing at all, not even the session.
    await launch(profile);
    await logError("Error: bench error, switch off since the last launch");
    await settle(4000);
    expect(seen).toEqual([]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 240_000);

it("P13, P15: every field of a real error event; crash reports are off by default", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    await launch(profile);
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
    await logError("TypeError: bench plain error");
    await expect.poll(() => events().length, { timeout: 10_000 }).toBe(1);
    const e = events()[0]!.payload;
    all.errorEvent = e;
    all.errorEventRaw = events()[0]!.raw;
    // Only these keys, as shared/telemetry.ts builds them: a new field must be a decision, not an accident.
    expect(Object.keys(e).sort()).toEqual(["environment", "event_id", "exception", "platform", "release", "sdk", "tags", "timestamp", "user"]);
    expect(e.user).toEqual({ ip_address: "0.0.0.0" });
    expect(Object.keys(e.tags)).toEqual(["source"]);
    expect(await m.execute(`return [Services.prefs.getBoolPref("ressac.telemetry.crashReports", false), Services.prefs.getBoolPref("browser.tabs.crashReporting.sendReport", false)]`)).toEqual([false, false]);
    expect((await m.execute(`try { return Services.appinfo.QueryInterface(Ci.nsICrashReporter).submitReports; } catch (e) { return "no crash reporter"; }`)) === true, "crash reports are not submitted").toBe(false);
    expect(seen.filter((s) => s.path === "minidump")).toEqual([]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 120_000);

// The real scrub, in the real app, with this machine's real home path and fake addresses. One error per case so that a
// failure names its case; each message is distinct (the reporter drops a repeated one).
const CASES: { id: string; message: (home: string) => string; secret: (home: string) => string; predictedRed?: true }[] = [
  { id: "https address", message: () => "Error: load of https://bank.example/compte/12345?iban=FR76 failed", secret: () => "bank.example" },
  { id: "file address", message: (h) => `Error: cannot read file://${h}/Documents/impots.pdf`, secret: () => "impots.pdf" },
  { id: "home path", message: (h) => `Error: ENOENT ${h}/Ressac/x.ts`, secret: (h) => h },
  { id: "quoted span", message: () => 'Error: unexpected "motdepasse-bench-123" here', secret: () => "motdepasse-bench-123" },
  { id: "home path, lowercase", message: (h) => `Error: ENOENT ${h.toLowerCase()}/Ressac/y.ts`, secret: (h) => path.basename(h).toLowerCase(), predictedRed: true },
  { id: "address without a scheme", message: () => "Error: Domaine non déclaré : intranet.client-bench.example", secret: () => "client-bench.example", predictedRed: true },
  { id: "address percent-encoded in about:reader", message: () => "Error: about:reader?url=https%3A%2F%2Fbank-bench.example%2Fcompte%2F12345 failed", secret: () => "bank-bench.example", predictedRed: true },
  { id: "e-mail address", message: () => "Error: session of marie.dupont@bench.example expired", secret: () => "marie.dupont@bench.example", predictedRed: true },
  { id: "LAN address", message: () => "Error: Adresse locale refusée : nas.local (192.168.77.12)", secret: () => "192.168.77.12", predictedRed: true },
  { id: "quoted span after a French apostrophe", message: () => "Error: Impossible d'ouvrir 'contrat-bench-acme.pdf'", secret: () => "contrat-bench-acme.pdf", predictedRed: true },
  { id: "folder names under the home", message: (h) => `Error: ENOENT ${h}/Ressac/Espace Banque/projet-bench-divorce/app.js`, secret: () => "projet-bench-divorce", predictedRed: true },
];
it("P2–P4 in the real app: what a scrubbed error still carries (each case reported; the first four are the claim)", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    await launch(profile);
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
    const home = await m.execute<string>(`return Services.dirsvc.get("Home", Ci.nsIFile).path`);
    const results: { id: string; leaked: boolean; value: string; predictedRed: boolean }[] = [];
    for (const c of CASES) {
      const n = events().length;
      // A case tag keeps each scrubbed message distinct: the reporter drops one it already sent.
      await logError(`[case ${CASES.indexOf(c)}] ${c.message(home)}`);
      await expect.poll(() => events().length, { timeout: 10_000 }).toBe(n + 1);
      const raw = events().at(-1)!.raw;
      results.push({ id: c.id, leaked: raw.includes(c.secret(home)), value: events().at(-1)!.payload.exception.values[0].value, predictedRed: !!c.predictedRed });
    }
    all.scrubCases = results;
    console.table(results);
    expect(results.filter((r) => !r.predictedRed && r.leaked).map((r) => r.id), "the claim: addresses and the home path are scrubbed").toEqual([]);
    expect(results.filter((r) => r.predictedRed && r.leaked).map((r) => r.id), "PREDICTED RED: what the scrub does not cover").toEqual([]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 180_000);

it("P16: an error from a web page, or from an actor running inside pages, is not reported", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    await launch(profile);
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
    await logError("Error: bench web error at https://bank.example/app.js", "https://bank.example/app.js");
    await logError("Error: bench actor error", "chrome://browser/content/ressac/site-actor.sys.mjs");
    await logError("Error: bench look-alike source", "chrome://browser/content/ressac-evil/x.js");
    await logError("Error: bench extension error", "moz-extension://1b2c3d/background.js");
    await settle(3000);
    expect(events().map((e) => e.payload.exception.values[0].value)).toEqual([]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 120_000);

// P17. Not a claim of SECURITY.md: the list of names a fresh profile asks for while idle, before and after the notice,
// with every name answered 127.0.0.1 (nothing reaches the internet, so each service only shows its first contact).
// A lower bound for the packaged app: Marionette and launchRessac turn several Firefox services off (updates, media
// plugins); the full capture needs the DMG in a VM behind a recording proxy.
it("P17 (measured, not judged): the names a first launch resolves in 40 s", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-b9-dns-"));
  try {
    await launch(profile, { prefs: NET_PREFS, env: netEnv(logDir) });
    await settle(40_000);
    const { readdir, readFile } = await import("node:fs/promises");
    let log = "";
    for (const f of await readdir(logDir)) log += await readFile(path.join(logDir, f), "utf8").catch(() => "");
    const names = [...new Set([...log.matchAll(/Resolving host \[([^\]]+)\]/g)].map((x) => x[1]!))].sort();
    all.firstLaunchResolvedNames = names;
    console.log("[P17] names resolved by an idle first launch:", names);
  } finally {
    await rm(profile, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
}, 120_000);
