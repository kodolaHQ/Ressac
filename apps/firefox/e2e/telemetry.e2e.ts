import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const NOTICE = "ressac-telemetry";

// A fake Sentry: every envelope posted to project 1 is kept, parsed.
let envelopes: { raw: string; event: any }[] = [];
let sessions: any[] = [];
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/api/1/envelope/": (req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const [, item, payload] = raw.split("\n").map((l) => JSON.parse(l));
          (item.type === "session" ? sessions : envelopes).push(item.type === "session" ? payload : { raw, event: payload });
          res.writeHead(200).end("{}");
        });
      },
    },
  });
});
afterAll(() => server?.close());

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  await w?.close();
  w = undefined;
  envelopes = [];
  sessions = [];
});

const dsn = () => `http://k@127.0.0.1:${server.port}/1`;
async function launch(o: { profile?: string; noDsn?: boolean } = {}): Promise<void> {
  w = await launchRessac({ profile: o.profile, env: o.noDsn ? {} : { RESSAC_SENTRY_DSN: dsn() } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
}
const hostPid = () =>
  waitFor<number | null>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => !!v, 20_000) as Promise<number>;
const notices = () => m.execute<number>(`return [...window.gNotificationBox.allNotifications].filter((n) => n.getAttribute("value") === "${NOTICE}").length`);
/** Logs a console error as if thrown by `source`. */
const logError = (source: string, message: string) =>
  m.execute(
    `const e = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
     e.init(arguments[0], arguments[1], 1, 1, Ci.nsIScriptError.errorFlag, "chrome javascript");
     Services.console.logMessage(e);`,
    [message, source],
  );
async function until(ok: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error(`timed out: ${envelopes.length} envelopes`);
}
const settle = () => new Promise((r) => setTimeout(r, 1_500));

it("host crash: one anonymous envelope from the host", async () => {
  await launch();
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  process.kill(await hostPid(), "SIGKILL");
  await until(() => envelopes.some((e) => e.event.tags.source === "host"));
  const e = envelopes.find((x) => x.event.tags.source === "host")!;
  expect(e.event.release).toBe(version);
  expect(e.event.exception.values[0]).toMatchObject({ type: "HostExit" });
  expect(e.event.exception.values[0].value).toMatch(/^exit code /);
  expect(e.raw).not.toContain(os.homedir());
  expect(e.raw).not.toContain(w!.dataDir);
});

it("launch: no session before the notice, then one anonymous session with an install id", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    await launch({ profile });
    await settle();
    expect(sessions).toEqual([]);
    await w!.close();
    await launch({ profile });
    await until(() => sessions.length > 0);
    expect(sessions[0]).toMatchObject({ init: true, status: "exited", attrs: { environment: "beta", ip_address: "0.0.0.0" } });
    expect(sessions[0].did).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    await w?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

it("host stop: a requested stop sends nothing", async () => {
  await launch();
  await hostPid();
  await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.stop())();`);
  await settle();
  expect(envelopes.filter((e) => e.event.exception.values[0].type === "HostExit")).toEqual([]);
});

it("chrome error: our chrome's errors are sent scrubbed, a web page's are not", async () => {
  await launch();
  await logError("chrome://browser/content/ressac/sidebar.js", "TypeError: boom https://exemple.fr/x");
  // Other real chrome errors may come too: ours is found by its message.
  const boom = () => envelopes.find((e) => e.event.exception.values[0].value.startsWith("boom"));
  await until(() => !!boom());
  expect(boom()!.event.tags.source).toBe("chrome");
  expect(boom()!.event.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom <url>" });
  expect(boom()!.raw).not.toContain("exemple.fr");
  await logError("https://exemple.fr/app.js", "TypeError: web page");
  await logError("chrome://browser/content/ressac/page-actor.sys.mjs", "TypeError: actor error");
  await settle();
  expect(envelopes.filter((e) => e.raw.includes("web page") || e.raw.includes("actor error"))).toEqual([]);
});

it("notice: shown once, « Couper l'envoi » turns sending off for good", async () => {
  // Our own profile folder: a launch's temporary one is deleted on close.
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  try {
    await noticeOnce(profile);
  } finally {
    await w?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

async function noticeOnce(profile: string): Promise<void> {
  await launch({ profile });
  await waitFor(m, `return [...window.gNotificationBox.allNotifications].some((n) => n.getAttribute("value") === "${NOTICE}")`, (v) => v === true);
  expect(await m.execute("return Services.prefs.getBoolPref('ressac.telemetry.noticeShown')")).toBe(true);
  const label = await m.execute<string>(`return [...window.gNotificationBox.allNotifications].find((n) => n.getAttribute("value") === "${NOTICE}").messageText?.textContent ?? ""`);
  expect(label).toContain("Ressac envoie à son développeur ses erreurs, sans adresse de page, pour corriger les bugs de la bêta, et à chaque lancement un identifiant d'installation anonyme pour compter les utilisateurs. Les rapports de plantage de Firefox, qui peuvent contenir des morceaux des pages ouvertes, ne partent que si vous les activez dans Réglages › Confidentialité.");
  await m.execute(
    `const n = [...window.gNotificationBox.allNotifications].find((n) => n.getAttribute("value") === "${NOTICE}");
     [...n.buttonContainer.children].find((b) => b.getAttribute("label") === "Couper l'envoi").doCommand();`,
  );
  expect(await m.execute("return Services.prefs.getBoolPref('ressac.telemetry.enabled')")).toBe(false);
  await settle(); // what was posted before the opt-out
  envelopes = [];
  await logError("chrome://browser/content/ressac/sidebar.js", "TypeError: after opt-out");
  await settle();
  expect(envelopes).toEqual([]);
  // Same profile again: no notice.
  await w!.close();
  await launch({ profile });
  await settle();
  expect(await notices()).toBe(0);
}

it("before the notice has shown, neither error reports nor crash reports go out; after it, crash reports only once turned on", async () => {
  await launch();
  await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
  await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.noticeShown", false);`);
  expect(await m.execute("return Services.prefs.getBoolPref('browser.tabs.crashReporting.sendReport')")).toBe(false);
  await logError("chrome://browser/content/ressac/sidebar.js", "TypeError: before the notice");
  await settle();
  expect(envelopes.filter((e) => e.raw.includes("before the notice"))).toEqual([]);
  await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.noticeShown", true);`);
  // Minidumps can hold page data: off until the user turns them on, and off again with the telemetry switch.
  expect(await m.execute("return Services.prefs.getBoolPref('browser.tabs.crashReporting.sendReport')")).toBe(false);
  await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.crashReports", true);`);
  expect(await m.execute("return Services.prefs.getBoolPref('browser.tabs.crashReporting.sendReport')")).toBe(true);
  // Pending reports go at the next launch on their own.
  expect(await m.execute("return Services.prefs.getBoolPref('browser.crashReports.unsubmittedCheck.autoSubmit2')")).toBe(true);
  await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.enabled", false);`);
  expect(await m.execute("return Services.prefs.getBoolPref('browser.tabs.crashReporting.sendReport')")).toBe(false);
  expect(await m.execute("return Services.prefs.getBoolPref('browser.crashReports.unsubmittedCheck.autoSubmit2')")).toBe(false);
});

it("no dsn: no notice, nothing sent", async () => {
  await launch({ noDsn: true });
  await logError("chrome://browser/content/ressac/sidebar.js", "TypeError: no dsn");
  await settle();
  expect(await notices()).toBe(0);
  expect(envelopes).toEqual([]);
});

const RUN_MARK = "ressac-run.json";
async function launchWithMark(profile: string, env: Record<string, string> = {}): Promise<void> {
  w = await launchRessac({ profile, env: { RESSAC_SENTRY_DSN: dsn(), ...env } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
  await waitFor(m, `return IOUtils.exists(PathUtils.join(PathUtils.profileDir, "${RUN_MARK}"))`, (v) => v === true);
}

it("abrupt exit: a killed run is reported at the next launch with macOS's jetsam reason; a clean quit is not", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  const reports = await mkdtemp(path.join(os.tmpdir(), "ressac-diag-"));
  const env = { RESSAC_TEST_DIAGNOSTIC_DIR: reports };
  const abrupt = () => envelopes.filter((e) => e.event.exception.values[0].type === "AbruptExit");
  try {
    // First launch shows the notice: reports go from the next one. A clean quit leaves no mark.
    await launchWithMark(profile, env);
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.noticeShown", false)`, (v) => v === true);
    await w!.close();
    await launchWithMark(profile, env);
    await until(() => sessions.length > 0); // the launch's own reports have started: an abrupt exit would be among them
    // A mark the run has rewritten since launch: the wake below is in it.
    await m.execute(`Services.obs.notifyObservers(null, "wake_notification");`);
    await waitFor(m, `return IOUtils.readJSON(PathUtils.join(PathUtils.profileDir, "${RUN_MARK}")).then((j) => !!j.wokeAt)`, (v) => v === true);
    expect(abrupt()).toEqual([]);
    await m.execute("Services.prefs.savePrefFile(null);");
    process.kill(w!.pid, "SIGKILL");
    await w!.close();
    // macOS's report of that kill, written after the run started.
    await writeFile(
      path.join(reports, "JetsamEvent-2026-11-25-125153.ips"),
      '{"bug_type":"298"}\n' + JSON.stringify({ date: "2026-11-25 12:51:53.87 +0100", largestProcess: "ressac", processes: [{ name: "ressac", reason: "vm-pageshortage" }] }),
    );
    await launchWithMark(profile, env);
    await until(() => abrupt().length > 0);
    const e = abrupt()[0]!;
    expect(e.event.exception.values[0].value).toBe("jetsam vm-pageshortage");
    expect(e.event.tags).toMatchObject({ source: "chrome", kind: "jetsam", jetsamReason: "vm-pageshortage", largestIsOurs: "true", endKnown: "true" });
    expect(e.event.tags.tabs).toMatch(/^\d+$/);
    expect(e.raw).not.toContain(os.homedir());
  } finally {
    await w?.close();
    await rm(profile, { recursive: true, force: true });
    await rm(reports, { recursive: true, force: true });
  }
});
