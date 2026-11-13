import { realpathSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { FAKE_TOOLS, launchRessac, type LaunchedRessac } from "./launch";

describe("Ressac foundation", () => {
  let w: LaunchedRessac;
  beforeAll(async () => {
    w = await launchRessac();
    await w.marionette.setContext("chrome");
  });
  afterAll(() => w?.close());

  it("starts headless and answers", async () => {
    expect(await w.marionette.execute("return Services.appinfo.name")).toBe("Ressac");
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

  it("applies the Ressac default prefs", async () => {
    expect(
      await w.marionette.execute(
        "return [Services.prefs.getBoolPref('devtools.chrome.enabled'), Services.prefs.getBoolPref('devtools.debugger.remote-enabled'), Services.prefs.getIntPref('browser.tabs.inTitlebar')]",
      ),
    ).toEqual([true, true, 1]);
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
      const frame = document.getElementById("ressac-sidebar");
      if (!frame) return null;
      for (let i = 0; i < 100; i++) {
        const el = frame.contentDocument?.querySelector('[data-testid="sidebar"]');
        if (el) return { ns: el.namespaceURI, text: el.textContent };
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();`);
    expect(root?.ns).toBe("http://www.w3.org/1999/xhtml");
    expect(root?.text).toContain("Nouvel onglet");
  });

  it("the UI uses the bundled Aura fonts and tokens", async () => {
    const r = await w.marionette.execute<{ family: string; faces: number; a1: string; accent: string } | null>(`return (async () => {
      const frame = document.getElementById("ressac-sidebar");
      for (let i = 0; i < 100 && !frame?.contentDocument?.querySelector('[data-testid="sidebar"]'); i++) await new Promise((r) => setTimeout(r, 100));
      const d = frame?.contentDocument;
      if (!d) return null;
      const faces = await d.fonts.load("16px Geist");
      const root = d.documentElement;
      return {
        family: d.defaultView.getComputedStyle(d.body).fontFamily,
        faces: faces.length,
        a1: d.defaultView.getComputedStyle(root).getPropertyValue("--a1").trim(),
        accent: d.defaultView.getComputedStyle(root).getPropertyValue("--accent").trim(),
      };
    })();`);
    expect(r?.family.startsWith('"Geist"') || r?.family.startsWith("Geist")).toBe(true);
    expect(r?.faces).toBeGreaterThan(0);
    // @property <color> makes the computed value serialize as rgb().
    expect(r?.a1.toLowerCase()).toBe("rgb(255, 159, 122)");
    expect(r?.accent).not.toBe("");
    expect(r?.accent.toLowerCase()).not.toBe("#8b7cf6");
    expect(r?.accent.toLowerCase()).not.toBe("rgb(139, 124, 246)");
  });

  it("covers the window left of the agent panel with the UI while no page is shown, then keeps the left 240 px", async () => {
    const rect = "const r = document.getElementById('ressac-sidebar')?.getBoundingClientRect(); return r ? { left: r.left, width: r.width } : null";
    // The home page opens the 420 px agent panel.
    await waitFor(w.marionette, rect, (r: { left: number; width: number } | null) => r?.left === 0 && r.width === 1280 - 420);
    const f = (await state(w.marionette)).windows[0]!;
    await dispatch(w.marionette, { type: "openTab", windowId: f.id, url: "data:text/html,<title>t</title>t" });
    await waitFor(w.marionette, rect, (r: { width: number } | null) => r?.width === 240);
  });

  it("gives the page the rest of the window", async () => {
    const r = await w.marionette.execute<{ title: string; left: number; right: number; edge: number }>(`return (async () => {
      const b = gBrowser.selectedBrowser;
      b.loadURI(Services.io.newURI("data:text/html,<title>essai</title>ok"), {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      for (let i = 0; i < 100 && b.contentTitle !== "essai"; i++) await new Promise((res) => setTimeout(res, 100));
      const rect = b.getBoundingClientRect();
      const agent = document.getElementById("ressac-agent");
      return { title: b.contentTitle, left: rect.left, right: rect.left + rect.width, edge: agent.hidden ? window.innerWidth : agent.getBoundingClientRect().left };
    })();`);
    expect(r.title).toBe("essai");
    expect(r.left).toBeGreaterThanOrEqual(240);
    // Up to the agent panel, open on the home page, less the 8 px of aura that frame the page.
    expect(Math.abs(r.right + 8 - r.edge)).toBeLessThanOrEqual(1);
  });
});

describe("several Ressac instances", () => {
  it("two launches in parallel", async () => {
    // allSettled: if one launch fails, the other one is still closed.
    const launches = await Promise.allSettled([launchRessac(), launchRessac()]);
    const started = launches.flatMap((l) => (l.status === "fulfilled" ? [l.value] : []));
    try {
      expect(started).toHaveLength(2);
      for (const w of started) {
        await w.marionette.setContext("chrome");
        expect(await w.marionette.execute("return Services.appinfo.name")).toBe("Ressac");
      }
      expect(started[0]!.profile).not.toBe(started[1]!.profile);
    } finally {
      await Promise.all(started.map((w) => w.close()));
    }
  });

  it("passes extra environment variables and puts the fake docker first on PATH", async () => {
    const p = await launchRessac({ env: { RESSAC_PROBE: "1" } });
    try {
      await p.marionette.setContext("chrome");
      const [probe, path] = await p.marionette.execute<[string, string]>("return [Services.env.get('RESSAC_PROBE'), Services.env.get('PATH')]");
      expect(probe).toBe("1");
      expect(path.startsWith(FAKE_TOOLS + ":")).toBe(true);
    } finally {
      await p.close();
    }
  });
});
