import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_FORMAT } from "../core/state/format";
import { initialState } from "../core/state/initial-state";
import { FIRST_TIME, type FirstTimeId } from "../shared/hints";
import { Marionette } from "./marionette";

// Fake docker (a wrapper of fake-docker.cjs that knows the Firefox container name): no test ever touches a real container.
export const FAKE_TOOLS = path.resolve(import.meta.dirname, "../test/tools");
const DIST = path.resolve(import.meta.dirname, "../engine/obj-aarch64-apple-darwin/dist");
// The product's starter widgets, the ones the space setup copies into a new space.
const STARTER_WIDGETS = path.resolve(import.meta.dirname, "../../../packages/kernel/templates/fr/widgets");

/**
 * A new space gets the starter widgets, harvested at launch on the real web (the fake docker runs harvests on the Mac).
 * Seeds them without their `harvest`, so they are never due; the space setup never overwrites an existing widgets folder.
 */
async function seedStarterWidgets(dataDir: string): Promise<void> {
  const widgets = path.join(dataDir, "workspace/home/widgets");
  if (existsSync(widgets)) return;
  for (const id of await readdir(STARTER_WIDGETS)) {
    await cp(path.join(STARTER_WIDGETS, id), path.join(widgets, id), { recursive: true });
    const file = path.join(widgets, id, "widget.json");
    const { harvest: _, ...widget } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(widget, null, 2));
  }
}

/** A first session whose one-time notes (agent, design, actions) are already seen: tests that open those surfaces are not met by the note. */
async function seedFirstTimeNotesSeen(dataDir: string): Promise<void> {
  const file = path.join(dataDir, "session.json");
  if (existsSync(file)) return;
  const s = initialState();
  s.settings.hints.seen = Object.keys(FIRST_TIME) as FirstTimeId[];
  // Tests that restart on the same data come back to the tab they left; the launch on home has its own test.
  s.settings.startOnHome = false;
  // The tests read French text.
  s.settings.language = "fr";
  await writeFile(file, JSON.stringify(s));
}

export interface LaunchedRessac {
  marionette: Marionette;
  profile: string;
  dataDir: string;
  pid: number;
  close(): Promise<void>;
}

function binary(): string {
  // The same app a person launches: an unbranded build (Nightly.app) is a misconfigured checkout, not a fallback.
  const file = path.join(DIST, "Ressac.app/Contents/MacOS/ressac");
  if (!existsSync(file)) throw new Error("build missing: pnpm --filter firefox-ressac build");
  return file;
}

async function waitFor<T>(read: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Launches Ressac headless (`headed` shows its window). Folders passed in are reused and kept (to restart on the same data); the others
 * are temporary and deleted on close. `prefs` are appended to the profile's user.js (reduced motion is on unless `prefs` sets `ui.prefersReducedMotion` to 0). RESSAC_DATA_DIR is always set, so tests never touch the real data folder.
 * A data folder without a space's widgets folder gets the starter widgets without their harvest (`starterHarvests` keeps
 * them, and their real-web reads: prefer a local server). `firstTimeNotes` leaves the one-time notes unseen (a new session has them seen). `writer` signs the fake Claude Code or Codex in (widgets and actions write through it). `output`: a file that gets the browser's stdout and stderr.
 */
export async function launchRessac(o: { headed?: boolean; width?: number; height?: number; dataDir?: string; profile?: string; env?: Record<string, string | undefined>; prefs?: Record<string, string | number | boolean>; starterHarvests?: boolean; firstTimeNotes?: boolean; output?: string; realTools?: boolean; ai?: boolean; writer?: "claude" | "codex" } = {}): Promise<LaunchedRessac> {
  const profile = o.profile ?? (await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-")));
  const dataDir = o.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "ressac-data-")));
  const cleanup = () =>
    Promise.all([o.profile ? undefined : rm(profile, { recursive: true, force: true }), o.dataDir ? undefined : rm(dataDir, { recursive: true, force: true })]);
  // The current data format: without the marker the store would set the folder aside.
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, ".format-version"), JSON.stringify({ format: DATA_FORMAT }));
  if (!o.starterHarvests) await seedStarterWidgets(dataDir);
  if (!o.firstTimeNotes) await seedFirstTimeNotesSeen(dataDir);
  // The account the writing goes through (the fake docker's `claude auth status` / `codex login status`).
  if (o.writer) {
    await mkdir(path.join(dataDir, "workspace"), { recursive: true });
    await writeFile(path.join(dataDir, "workspace", o.writer === "claude" ? "fake-claude-auth.json" : "fake-codex-auth"), o.writer === "claude" ? '{"loggedIn":true,"email":"test@example.com"}' : "");
  }
  // A reused profile may hold the previous run's port file.
  await rm(path.join(profile, "MarionetteActivePort"), { force: true });
  // Port 0: Firefox picks a free port and writes it to MarionetteActivePort, so parallel launches never collide.
  await writeFile(
    path.join(profile, "user.js"),
    'user_pref("marionette.port", 0);\nuser_pref("browser.sessionstore.resume_from_crash", false);\n' +
      // Media plugin updates (OpenH264, Widevine) would download from the real web at startup.
      'user_pref("media.gmp-manager.updateEnabled", false);\n' +
      // Reduced motion by default (no drifting aura, no blur animation on parallel browsers); a test of motion passes 0.
      Object.entries({ "ui.prefersReducedMotion": 1, ...o.prefs }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(""),
  );
  const out = o.output ? openSync(o.output, "a") : "ignore";
  const proc = spawn(
    binary(),
    ["--marionette", ...(o.headed ? [] : ["--headless"]), "--no-remote", "--profile", profile, "--width", String(o.width ?? 1280), "--height", String(o.height ?? 800)],
    // The chrome context (the browser's own UI) is only reachable over Marionette with system access enabled.
    { stdio: ["ignore", out, out], env: {
        ...process.env,
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
        RESSAC_DATA_DIR: dataDir,
        // The fake agent writes its traces there.
        RESSAC_ROOT: path.join(dataDir, "workspace"),
        // A free port: never the real 5279.
        RESSAC_PORT_MCP_EXTERNAL: "0",
        // The host's notifications go to a file, never to the owner's screen (a test passes its own file to read them).
        RESSAC_TEST_NOTIFICATIONS: path.join(dataDir, "notifications.jsonl"),
        // No real Sentry from a test: only one that passes a DSN itself gets one.
        RESSAC_SENTRY_DSN: "",
        // The import screen never reads the owner's browsers: an empty home (a test passes its own fake one).
        RESSAC_TEST_IMPORT_HOME: path.join(dataDir, "import-home"),
        // No welcome screen in front of the tests.
        RESSAC_SKIP_WELCOME: "1",
        // AI on unless the test asks for it off (`ai: false`).
        RESSAC_TEST_AI: o.ai === false ? "0" : "1",
        // Réglages never changes the owner's macOS: his default browser and his screen recording grant stay his.
        RESSAC_TEST_NO_SYSTEM: "1",
        // Never the decision model running on this machine (nothing listens there). A test with a fake passes its own;
        // `undefined` (dropped by spawn) restores the kernel's default.
        RESSAC_KEV_URL: "http://127.0.0.1:9",
        // Never the real search model (334 MB): a test with a fake host passes its own.
        RESSAC_EMBED_URL: "http://127.0.0.1:9",
        // A new session follows the Mac's language: the tests read French whatever this machine's language is.
        RESSAC_TEST_MAC_LANGUAGES: "fr-FR",
        // The frames' test hook (e2e/ui.ts inFrame): evaluates in an agent-written frame's page.
        RESSAC_TEST_FRAMES: "1",
        ...o.env,
        // realTools: the machine's own docker, claude… (README captures with the real agent), never in a test.
        PATH: o.realTools ? (process.env.PATH ?? "") : `${FAKE_TOOLS}${path.delimiter}${process.env.PATH ?? ""}`,
      }, },
  );
  if (typeof out === "number") closeSync(out);
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  try {
    const port = await waitFor(
      () => readFile(path.join(profile, "MarionetteActivePort"), "utf8").then((t) => Number(t.trim()) || undefined, () => undefined),
      30_000,
      "the Marionette port",
    );
    const marionette = await Marionette.connect(port);
    await marionette.command("WebDriver:NewSession", {});
    let closing: Promise<void> | undefined;
    // Idempotent: a test may close early (to check what quitting does), afterEach closes again.
    const close = () =>
      (closing ??= (async () => {
        await marionette.command("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
        marionette.close();
        const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(timer);
        await cleanup();
      })());
    return { marionette, profile, dataDir, pid: proc.pid!, close };
  } catch (e) {
    proc.kill("SIGKILL");
    await exited;
    await cleanup();
    throw e;
  }
}
