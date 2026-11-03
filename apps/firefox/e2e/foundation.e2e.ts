import { realpathSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";

describe("WebAiOs-Firefox foundation", () => {
  let w: LaunchedWebAiOs;
  beforeAll(async () => {
    w = await launchWebAiOs();
    await w.marionette.setContext("chrome");
  });
  afterAll(() => w?.close());

  it("starts headless and answers", async () => {
    expect(await w.marionette.execute("return Services.appinfo.name")).toBe("WebAiOs");
  });

  it("uses the temporary profile", async () => {
    const dir = await w.marionette.execute<string>("return Services.dirsvc.get('ProfD', Ci.nsIFile).path");
    expect(realpathSync(dir).startsWith(realpathSync(os.tmpdir()))).toBe(true);
    expect(realpathSync(dir)).toBe(realpathSync(w.profile));
  });

  it("opens a single tab at startup", async () => {
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await w.marionette.execute("return [...Services.wm.getEnumerator('navigator:browser')].length")).toBe(1);
    expect(await w.marionette.execute("return gBrowser.tabs.length")).toBe(1);
  });

  it("applies the WebAiOs default prefs", async () => {
    expect(
      await w.marionette.execute(
        "return [Services.prefs.getBoolPref('devtools.chrome.enabled'), Services.prefs.getBoolPref('devtools.debugger.remote-enabled'), Services.prefs.getIntPref('browser.tabs.inTitlebar')]",
      ),
    ).toEqual([true, true, 0]);
  });
});

describe("several WebAiOs-Firefox instances", () => {
  it("two launches in parallel", async () => {
    const [a, b] = await Promise.all([launchWebAiOs(), launchWebAiOs()]);
    try {
      for (const w of [a, b]) {
        await w.marionette.setContext("chrome");
        expect(await w.marionette.execute("return Services.appinfo.name")).toBe("WebAiOs");
      }
      expect(a.profile).not.toBe(b.profile);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
