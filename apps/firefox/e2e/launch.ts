import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Marionette } from "./marionette";

// Fake docker (a wrapper of faux-docker.cjs that knows the Firefox container name): no test ever touches a real container.
export const FAKE_TOOLS = path.resolve(import.meta.dirname, "../test/outils");
const DIST = path.resolve(import.meta.dirname, "../engine/obj-aarch64-apple-darwin/dist");
// The product's starter widgets, the ones the space setup copies into a new space.
const STARTER_WIDGETS = path.resolve(import.meta.dirname, "../../../packages/noyau/modeles/widgets");

/**
 * A new space gets the starter widgets, harvested at launch on the real web (the fake docker runs harvests on the Mac).
 * Seeds them without their `recolte`, so they are never due; the space setup never overwrites an existing widgets folder.
 */
async function seedStarterWidgets(dataDir: string): Promise<void> {
  const widgets = path.join(dataDir, "espace/accueil/widgets");
  if (existsSync(widgets)) return;
  for (const id of await readdir(STARTER_WIDGETS)) {
    await cp(path.join(STARTER_WIDGETS, id), path.join(widgets, id), { recursive: true });
    const file = path.join(widgets, id, "widget.json");
    const { recolte: _, ...widget } = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(widget, null, 2));
  }
}

export interface LaunchedWebAiOs {
  marionette: Marionette;
  profile: string;
  dataDir: string;
  pid: number;
  close(): Promise<void>;
}

function binary(): string {
  // The same app a person launches: an unbranded build (Nightly.app) is a misconfigured checkout, not a fallback.
  const file = path.join(DIST, "WebAiOs.app/Contents/MacOS/webaios");
  if (!existsSync(file)) throw new Error("build missing: pnpm --filter firefox-webaios build");
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
 * Launches WebAiOs-Firefox headless (`headed` shows its window). Folders passed in are reused and kept (to restart on the same data); the others
 * are temporary and deleted on close. `prefs` are appended to the profile's user.js. WEBAIOS_DATA_DIR is always set, so tests never touch the real data folder.
 * A data folder without a space's widgets folder gets the starter widgets without their harvest (`starterHarvests` keeps
 * them, and their real-web reads: prefer a local server).
 */
export async function launchWebAiOs(o: { headed?: boolean; width?: number; height?: number; dataDir?: string; profile?: string; env?: Record<string, string>; prefs?: Record<string, string | number | boolean>; starterHarvests?: boolean } = {}): Promise<LaunchedWebAiOs> {
  const profile = o.profile ?? (await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-")));
  const dataDir = o.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "webaios-data-")));
  const cleanup = () =>
    Promise.all([o.profile ? undefined : rm(profile, { recursive: true, force: true }), o.dataDir ? undefined : rm(dataDir, { recursive: true, force: true })]);
  if (!o.starterHarvests) await seedStarterWidgets(dataDir);
  // A reused profile may hold the previous run's port file.
  await rm(path.join(profile, "MarionetteActivePort"), { force: true });
  // Port 0: Firefox picks a free port and writes it to MarionetteActivePort, so parallel launches never collide.
  await writeFile(
    path.join(profile, "user.js"),
    'user_pref("marionette.port", 0);\nuser_pref("browser.sessionstore.resume_from_crash", false);\n' +
      // Media plugin updates (OpenH264, Widevine) would download from the real web at startup.
      'user_pref("media.gmp-manager.updateEnabled", false);\n' +
      Object.entries(o.prefs ?? {}).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(""),
  );
  const proc = spawn(
    binary(),
    ["--marionette", ...(o.headed ? [] : ["--headless"]), "--no-remote", "--profile", profile, "--width", String(o.width ?? 1280), "--height", String(o.height ?? 800)],
    // The chrome context (the browser's own UI) is only reachable over Marionette with system access enabled.
    { stdio: "ignore", env: {
        ...process.env,
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
        WEBAIOS_DATA_DIR: dataDir,
        // The fake agent writes its traces there.
        WEBAIOS_RACINE: path.join(dataDir, "espace"),
        // A free port: never the real 5279.
        WEBAIOS_PORT_MCP_EXTERNE: "0",
        // The host's notifications go to a file, never to the owner's screen (a test passes its own file to read them).
        WEBAIOS_TEST_NOTIFICATIONS: path.join(dataDir, "notifications.jsonl"),
        ...o.env,
        PATH: `${FAKE_TOOLS}${path.delimiter}${process.env.PATH ?? ""}`,
      }, },
  );
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
