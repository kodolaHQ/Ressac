import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Marionette } from "./marionette";

const DIST = path.resolve(import.meta.dirname, "../engine/obj-aarch64-apple-darwin/dist");

export interface LaunchedWebAiOs {
  marionette: Marionette;
  profile: string;
  pid: number;
  close(): Promise<void>;
}

function binary(): string {
  const app = existsSync(DIST) ? readdirSync(DIST).find((n) => n.endsWith(".app")) : undefined;
  const file = app && path.join(DIST, app, "Contents/MacOS/webaios");
  if (!file || !existsSync(file)) throw new Error("build missing: pnpm --filter firefox-webaios build");
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

/** Launches WebAiOs-Firefox headless, with a temporary profile deleted on close. */
export async function launchWebAiOs(o: { width?: number; height?: number } = {}): Promise<LaunchedWebAiOs> {
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  // Port 0: Firefox picks a free port and writes it to MarionetteActivePort, so parallel launches never collide.
  await writeFile(path.join(profile, "user.js"), 'user_pref("marionette.port", 0);\nuser_pref("browser.sessionstore.resume_from_crash", false);\n');
  const proc = spawn(
    binary(),
    ["--marionette", "--headless", "--no-remote", "--profile", profile, "--width", String(o.width ?? 1280), "--height", String(o.height ?? 800)],
    // The chrome context (the browser's own UI) is only reachable over Marionette with system access enabled.
    { stdio: "ignore", env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } },
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
    const close = async () => {
      await marionette.command("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
      marionette.close();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
      await rm(profile, { recursive: true, force: true });
    };
    return { marionette, profile, pid: proc.pid!, close };
  } catch (e) {
    proc.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true });
    throw e;
  }
}
