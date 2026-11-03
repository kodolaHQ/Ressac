import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Marionette } from "./marionette";

// Fake docker (a wrapper of Electron's, which knows the Firefox container name): no test ever touches a real container.
export const FAKE_TOOLS = path.resolve(import.meta.dirname, "../test/outils");
const DIST = path.resolve(import.meta.dirname, "../engine/obj-aarch64-apple-darwin/dist");

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
 * Launches WebAiOs-Firefox headless. Folders passed in are reused and kept (to restart on the same data); the others
 * are temporary and deleted on close. WEBAIOS_DATA_DIR is always set, so tests never touch the real data folder.
 */
export async function launchWebAiOs(o: { width?: number; height?: number; dataDir?: string; profile?: string; env?: Record<string, string> } = {}): Promise<LaunchedWebAiOs> {
  const profile = o.profile ?? (await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-")));
  const dataDir = o.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "webaios-data-")));
  const cleanup = () =>
    Promise.all([o.profile ? undefined : rm(profile, { recursive: true, force: true }), o.dataDir ? undefined : rm(dataDir, { recursive: true, force: true })]);
  // A reused profile may hold the previous run's port file.
  await rm(path.join(profile, "MarionetteActivePort"), { force: true });
  // Port 0: Firefox picks a free port and writes it to MarionetteActivePort, so parallel launches never collide.
  await writeFile(path.join(profile, "user.js"), 'user_pref("marionette.port", 0);\nuser_pref("browser.sessionstore.resume_from_crash", false);\n');
  const proc = spawn(
    binary(),
    ["--marionette", "--headless", "--no-remote", "--profile", profile, "--width", String(o.width ?? 1280), "--height", String(o.height ?? 800)],
    // The chrome context (the browser's own UI) is only reachable over Marionette with system access enabled.
    { stdio: "ignore", env: {
        ...process.env,
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1",
        WEBAIOS_DATA_DIR: dataDir,
        // The fake agent writes its traces there.
        WEBAIOS_RACINE: path.join(dataDir, "espace"),
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
