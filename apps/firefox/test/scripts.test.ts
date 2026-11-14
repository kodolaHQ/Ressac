import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

describe("package scripts", () => {
  it("builds the three bundles before surfer import, build and build:ui", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/^zsh scripts\/ui\.sh && /);
    expect(readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8")).toMatch(/for mode in sidebar window store agent actor/);
  });

  it("prunes dangling links before surfer import", () => {
    expect(scripts["engine:import"]).toMatch(/ui\.sh && zsh scripts\/engine\.sh prune && zsh scripts\/env\.sh surfer set brand ressac && zsh scripts\/env\.sh surfer import$/);
  });

  it("sets the brand in every checkout before importing or building (surfer keeps it in the untracked .surfer/)", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/surfer set brand ressac && zsh scripts\/env\.sh surfer (import|build)/);
  });
});

describe("agent scaffolding", () => {
  it("builds the agent panel and the page actor", () => {
    const ui = readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8");
    const jar = readFileSync(new URL("../src/browser/base/content/ressac/jar.inc.mn", import.meta.url), "utf8");
    for (const m of ["agent", "actor"]) expect(ui).toMatch(new RegExp(`\\b${m}\\b`));
    for (const f of ["agent.html", "agent.js", "agent.css", "page-actor.sys.mjs"]) expect(jar).toContain(`content/ressac/${f})`);
  });

  it("copies the page actor into the build: the content sandbox cannot follow a link into a checkout", () => {
    const jar = readFileSync(new URL("../src/browser/base/content/ressac/jar.inc.mn", import.meta.url), "utf8");
    expect(jar).toMatch(/^\*\s+content\/browser\/ressac\/page-actor\.sys\.mjs/m);
    // `*` runs Mozilla's preprocessor: it needs one directive, and any other line starting with # would be read as one.
    const built = new URL("../src/browser/base/content/ressac/page-actor.sys.mjs", import.meta.url);
    if (existsSync(built)) expect(readFileSync(built, "utf8").match(/^\s*#.*$/gm)).toEqual(["#define RESSAC_PAGE_ACTOR"]);
  });
});

describe("engine.sh prune", () => {
  it("removes only dangling links into a Ressac checkout, and only under src/'s directories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ressac-prune-"));
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "src/browser"), { recursive: true });
    copyFileSync(new URL("../scripts/engine.sh", import.meta.url), path.join(root, "scripts/engine.sh"));
    const dir = path.join(root, "engine/browser/base");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, "real.txt"), "");
    const gone = "/nowhere/Ressac/.claude/worktrees/old/apps/firefox/src/browser/base/x.js";
    symlinkSync(gone, path.join(dir, "dangling-ours"));
    symlinkSync("/nowhere/other/file", path.join(dir, "dangling-other"));
    symlinkSync(path.join(root, "real.txt"), path.join(dir, "alive"));
    execFileSync("zsh", [path.join(root, "scripts/engine.sh"), "prune"]);
    const exists = (p: string) => existsSync(p) || (() => { try { return !!lstatSync(p); } catch { return false; } })();
    expect(exists(path.join(dir, "dangling-ours"))).toBe(false);
    expect(exists(path.join(dir, "dangling-other"))).toBe(true);
    expect(exists(path.join(dir, "alive"))).toBe(true);
  });

  it("also removes live links into another checkout, so surfer import relinks every file to this one", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ressac-prune-"));
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "src/browser"), { recursive: true });
    copyFileSync(new URL("../scripts/engine.sh", import.meta.url), path.join(root, "scripts/engine.sh"));
    const dir = path.join(root, "engine/browser/base");
    mkdirSync(dir, { recursive: true });
    const other = mkdtempSync(path.join(os.tmpdir(), "ressac-main-"));
    mkdirSync(path.join(other, "apps/firefox/src"), { recursive: true });
    writeFileSync(path.join(other, "apps/firefox/src/x.js"), "");
    writeFileSync(path.join(root, "src/browser/y.js"), "");
    symlinkSync(path.join(other, "apps/firefox/src/x.js"), path.join(dir, "other-checkout"));
    symlinkSync(path.join(realpathSync(root), "src/browser/y.js"), path.join(dir, "this-checkout"));
    execFileSync("zsh", [path.join(root, "scripts/engine.sh"), "prune"]);
    const exists = (p: string) => { try { return !!lstatSync(p); } catch { return false; } };
    expect(exists(path.join(dir, "other-checkout"))).toBe(false);
    expect(exists(path.join(dir, "this-checkout"))).toBe(true);
  });
});

describe("package.sh update archive", () => {
  const sh = readFileSync(new URL("../scripts/package.sh", import.meta.url), "utf8");
  const at = (s: string) => {
    const i = sh.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it("drops the dev update policy and regenerates precomplete before signing", () => {
    const signing = at('step "Signing"');
    expect(at("rm -f $res/distribution/policies.json")).toBeLessThan(signing);
    expect(at("grep -rq DisableAppUpdate $res/distribution")).toBeLessThan(signing);
    expect(at("createprecomplete.py")).toBeLessThan(signing);
  });

  it("builds, signs and verifies the full MAR after codesign --verify, then writes update.xml", () => {
    const verify = at("codesign --verify --deep --strict $app");
    const full = at("make_full_update.sh");
    const sign = at("-n ressac-mar -s");
    const check = at("signmar -D $app_dir/src/toolkit/mozapps/update/updater/dep1.der -v $mar");
    const xml = at("scripts/update-xml.mjs");
    expect(verify).toBeLessThan(full);
    expect(full).toBeLessThan(sign);
    expect(sign).toBeLessThan(check);
    expect(check).toBeLessThan(xml);
    expect(xml).toBeLessThan(at('step "DMG"'));
    expect(sh).toContain("warning: no MAR key or no RESSAC_UPDATE_KEY, packaging without an update archive");
  });

  it("points the app's update feed at the secret folder through the AppUpdateURL policy, after the dev policy is gone and before signing", () => {
    const feed = at('feed="https://updates.getressac.app/updates/$update_key/browser/Darwin_aarch64-gcc3/ressac/update.xml"');
    expect(at("rm -f $res/distribution/policies.json")).toBeLessThan(feed);
    expect(feed).toBeLessThan(at('step "Signing"'));
    expect(sh).toContain('{\\"policies\\": {\\"AppUpdateURL\\": \\"$feed\\"}}');
    expect(sh).not.toContain("[AppUpdate\\]");
    expect(sh).toContain("update-xml.mjs $mar $res/application.ini $version $update_key ${build_ids[1]}");
    expect(sh).toContain("strings -a $app/Contents/MacOS/ressac | grep -xE '20[0-9]{12}'");
    expect(sh).toContain("[[ -z $update_key || $update_key =~ '^[a-z0-9]{24,64}$' ]]");
  });

  it("hands the MAR key password to pk12util in a mode-600 file, never on its command line", () => {
    expect(sh).not.toMatch(/pk12util[^\n]*-W/);
    expect(at("umask 077")).toBeLessThan(at("pk12util -i $mar_p12 -d $db -w $node_x/mar-pw"));
  });
});
