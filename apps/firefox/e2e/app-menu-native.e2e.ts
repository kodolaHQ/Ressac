import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { launchRessac } from "./launch";

// The real macOS menu bar, which headless Firefox has not: a visible window, and System Events needs the terminal's
// Accessibility access. Run before a release (RESSAC_NATIVE_MENU=1): 0.1.9 crashed as soon as the app menu opened.
describe.skipIf(!process.env.RESSAC_NATIVE_MENU)("the native app menu", () => {
  it("opens, lists « À propos de Ressac », and Ressac keeps running", async () => {
    const r = await launchRessac({ headed: true });
    try {
      await r.marionette.setContext("chrome");
      const pid = await r.marionette.execute<number>(
        'Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport).activateApplication(true); return Services.appinfo.processID',
      );
      await new Promise((ok) => setTimeout(ok, 4000));
      // Reading its items makes AppKit open the app menu, as a click does.
      const items = execFileSync("osascript", ["-e", `tell application "System Events"
        tell (first process whose unix id is ${pid})
          set frontmost to true
          delay 0.5
          return name of every menu item of menu 1 of menu bar item 2 of menu bar 1
        end tell
      end tell`], { encoding: "utf8" });
      for (let i = 0; i < 10; i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        await Promise.race([r.marionette.execute("return 1"), new Promise((_, no) => setTimeout(() => no(new Error(`Ressac stopped answering ${i} s after the app menu opened`)), 5000))]);
      }
      expect(items).toMatch(/Ressac/);
    } finally {
      await r.close().catch(() => {});
    }
  }, 120_000);
});
