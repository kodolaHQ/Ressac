import { realpathSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
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

  it("ships the first-run prefs as defaults, not only through Marionette", async () => {
    // Marionette's recommended prefs already set these at runtime, so read the default branch that real users get.
    expect(
      await w.marionette.execute(`
        const d = Services.prefs.getDefaultBranch("");
        return [
          d.getBoolPref("browser.shell.checkDefaultBrowser"),
          d.getBoolPref("browser.aboutwelcome.enabled"),
          d.getBoolPref("browser.preonboarding.enabled"),
          d.getBoolPref("termsofuse.bypassNotification"),
          d.getBoolPref("datareporting.policy.dataSubmissionEnabled"),
          d.getCharPref("browser.startup.homepage_override.mstone"),
        ];
      `),
    ).toEqual([false, false, false, true, false, "ignore"]);
  });

  it("hides Firefox's toolbars", async () => {
    expect(await w.marionette.execute("return getComputedStyle(document.getElementById('navigator-toolbox')).display")).toBe("none");
  });

  it("renders the sidebar as HTML", async () => {
    // Waits for the sidebar iframe to load, then reads its root element.
    const root = await w.marionette.execute<{ ns: string; text: string } | null>(`return (async () => {
      const frame = document.getElementById("webaios-sidebar");
      if (!frame) return null;
      for (let i = 0; i < 100; i++) {
        const el = frame.contentDocument?.querySelector('[data-testid="barre-laterale"]');
        if (el) return { ns: el.namespaceURI, text: el.textContent };
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();`);
    expect(root?.ns).toBe("http://www.w3.org/1999/xhtml");
    expect(root?.text).toContain("Nouvel onglet");
  });

  it("covers the window with the UI while no page is shown, then keeps the left 240 px", async () => {
    const rect = "const r = document.getElementById('webaios-sidebar')?.getBoundingClientRect(); return r ? { left: r.left, width: r.width } : null";
    expect(await w.marionette.execute(rect)).toEqual({ left: 0, width: 1280 });
    const f = (await state(w.marionette)).fenetres[0]!;
    await dispatch(w.marionette, { type: "ouvrirOnglet", fenetreId: f.id, url: "data:text/html,<title>t</title>t" });
    await waitFor(w.marionette, rect, (r: { width: number } | null) => r?.width === 240);
  });

  it("gives the page the rest of the window", async () => {
    const r = await w.marionette.execute<{ title: string; left: number; right: number; inner: number }>(`return (async () => {
      const b = gBrowser.selectedBrowser;
      b.loadURI(Services.io.newURI("data:text/html,<title>essai</title>ok"), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      for (let i = 0; i < 100 && b.contentTitle !== "essai"; i++) await new Promise((res) => setTimeout(res, 100));
      const rect = b.getBoundingClientRect();
      return { title: b.contentTitle, left: rect.left, right: rect.left + rect.width, inner: window.innerWidth };
    })();`);
    expect(r.title).toBe("essai");
    expect(r.left).toBeGreaterThanOrEqual(240);
    expect(Math.abs(r.right - r.inner)).toBeLessThanOrEqual(1);
  });
});

describe("several WebAiOs-Firefox instances", () => {
  it("two launches in parallel", async () => {
    // allSettled: if one launch fails, the other one is still closed.
    const launches = await Promise.allSettled([launchWebAiOs(), launchWebAiOs()]);
    const started = launches.flatMap((l) => (l.status === "fulfilled" ? [l.value] : []));
    try {
      expect(started).toHaveLength(2);
      for (const w of started) {
        await w.marionette.setContext("chrome");
        expect(await w.marionette.execute("return Services.appinfo.name")).toBe("WebAiOs");
      }
      expect(started[0]!.profile).not.toBe(started[1]!.profile);
    } finally {
      await Promise.all(started.map((w) => w.close()));
    }
  });
});
