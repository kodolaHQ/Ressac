import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { launchRessac, type LaunchedRessac } from "./launch";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("closing Ressac", () => {
  let w: LaunchedRessac | undefined;
  afterEach(async () => {
    if (w && alive(w.pid)) process.kill(w.pid, "SIGKILL");
  });

  it("kills a wedged instance and removes its profile", async () => {
    w = await launchRessac();
    await w.marionette.command("WebDriver:SetTimeouts", { script: null });
    // A script that never settles: Marionette answers commands in order, so Quit would wait forever behind it.
    void w.marionette.execute("return new Promise(() => {})").catch(() => {});
    const start = Date.now();
    await w.close();
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(alive(w.pid)).toBe(false);
    expect(existsSync(w.profile)).toBe(false);
  });
});
