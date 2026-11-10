import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const NOTICE = "webaios-telemetry";

// A fake Sentry: every envelope posted to project 1 is kept, parsed.
let envelopes: { raw: string; event: any }[] = [];
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/api/1/envelope/": (req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          envelopes.push({ raw, event: JSON.parse(raw.split("\n")[2]!) });
          res.writeHead(200).end("{}");
        });
      },
    },
  });
});
afterAll(() => server?.close());

let w: LaunchedWebAiOs | undefined;
let m: Marionette;
afterEach(async () => {
  await w?.close();
  w = undefined;
  envelopes = [];
});

const dsn = () => `http://k@127.0.0.1:${server.port}/1`;
async function launch(o: { profile?: string; noDsn?: boolean } = {}): Promise<void> {
  w = await launchWebAiOs({ profile: o.profile, env: o.noDsn ? {} : { WEBAIOS_SENTRY_DSN: dsn() } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow", (v) => v === true);
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
  const version = await m.execute<string>("return Services.appinfo.version");
  process.kill(await hostPid(), "SIGKILL");
  await until(() => envelopes.some((e) => e.event.tags.source === "host"));
  const e = envelopes.find((x) => x.event.tags.source === "host")!;
  expect(e.event.release).toBe(version);
  expect(e.event.exception.values[0]).toMatchObject({ type: "HostExit" });
  expect(e.event.exception.values[0].value).toMatch(/^exit code /);
  expect(e.raw).not.toContain(os.homedir());
  expect(e.raw).not.toContain(w!.dataDir);
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
  await logError("chrome://browser/content/webaios/sidebar.js", "TypeError: boom https://exemple.fr/x");
  // Other real chrome errors may come too: ours is found by its message.
  const boom = () => envelopes.find((e) => e.event.exception.values[0].value.startsWith("boom"));
  await until(() => !!boom());
  expect(boom()!.event.tags.source).toBe("chrome");
  expect(boom()!.event.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom <url>" });
  expect(boom()!.raw).not.toContain("exemple.fr");
  await logError("https://exemple.fr/app.js", "TypeError: web page");
  await settle();
  expect(envelopes.filter((e) => e.raw.includes("web page"))).toEqual([]);
});

it("notice: shown once, « Couper l'envoi » turns sending off for good", async () => {
  // Our own profile folder: a launch's temporary one is deleted on close.
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
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
  expect(await m.execute("return Services.prefs.getBoolPref('webaios.telemetry.noticeShown')")).toBe(true);
  const label = await m.execute<string>(`return [...window.gNotificationBox.allNotifications].find((n) => n.getAttribute("value") === "${NOTICE}").messageText?.textContent ?? ""`);
  expect(label).toContain("WebAiOs envoie à son développeur les plantages et les erreurs, sans adresse de page ni contenu, pour corriger les bugs de la bêta.");
  await m.execute(
    `const n = [...window.gNotificationBox.allNotifications].find((n) => n.getAttribute("value") === "${NOTICE}");
     [...n.buttonContainer.children].find((b) => b.getAttribute("label") === "Couper l'envoi").doCommand();`,
  );
  expect(await m.execute("return Services.prefs.getBoolPref('webaios.telemetry.enabled')")).toBe(false);
  await settle(); // what was posted before the opt-out
  envelopes = [];
  await logError("chrome://browser/content/webaios/sidebar.js", "TypeError: after opt-out");
  await settle();
  expect(envelopes).toEqual([]);
  // Same profile again: no notice.
  await w!.close();
  await launch({ profile });
  await settle();
  expect(await notices()).toBe(0);
}

it("no dsn: no notice, nothing sent", async () => {
  await launch({ noDsn: true });
  await logError("chrome://browser/content/webaios/sidebar.js", "TypeError: no dsn");
  await settle();
  expect(await notices()).toBe(0);
  expect(envelopes).toEqual([]);
});
