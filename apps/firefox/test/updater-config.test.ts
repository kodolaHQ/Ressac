import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const app = join(__dirname, "..");
const read = (p: string) => readFileSync(join(app, p), "utf8");
const certs = join(app, "src/toolkit/mozapps/update/updater");

describe("updater configuration", () => {
  it("the engine is built with the updater", () => {
    expect(read("configs/common/mozconfig")).not.toMatch(/--disable-updater/);
  });

  it("the update host is ours", () => {
    expect(read("src/build/moz-build.patch")).toContain('+    appini_defines["MOZ_APPUPDATE_HOST"] = "updates.getressac.app"');
  });

  it("both MAR certificates are ours", () => {
    const d1 = join(certs, "dep1.der");
    const d2 = join(certs, "dep2.der");
    expect(existsSync(d1) && existsSync(d2)).toBe(true);
    expect(readFileSync(d1).equals(readFileSync(d2))).toBe(true);
    const subject = execFileSync("openssl", ["x509", "-inform", "DER", "-noout", "-subject", "-in", d1], { encoding: "utf8" });
    expect(subject).toMatch(/CN ?= ?Ressac MAR/);
  });

  it("update prefs", () => {
    const prefs = read("src/browser/app/profile/ressac.js");
    expect(prefs).toContain('pref("app.update.url.manual", "https://updates.getressac.app/download/Ressac.dmg");');
    expect(prefs).toContain('pref("app.update.url.details", "");');
    expect(prefs).toContain('pref("app.update.noWindowAutoRestart.enabled", false);');
    expect(prefs).toContain('pref("app.update.interval", 43200);');
  });

  it("the generated branding prefs (Zen's links, loaded after ressac.js) are replaced", () => {
    const branding = read("src/browser/branding/ressac/pref/firefox-branding.js");
    expect(branding).not.toMatch(/app\.update|zen-browser|startup\.homepage/);
  });

  it("dev builds never update", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    for (const s of ["build", "build:ui"]) expect(scripts[s]).toMatch(/zsh scripts\/dev-policy\.sh$/);
    const script = read("scripts/dev-policy.sh");
    expect(script).toContain("dist/Ressac.app");
    expect(script).toContain("/Contents/Resources/distribution/policies.json");
    expect(script).toContain('{"policies":{"DisableAppUpdate":true}}');
    // A missing dev app must fail the build, not leave an app that updates itself.
    expect(script).not.toMatch(/\|\| exit 0/);
  });
});
