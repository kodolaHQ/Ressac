import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { button, installAddon, writeXpi, type Fixture } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

// Probes of plan 23's unknowns (docs/superpowers/notes/2026-11-04-modules-firefox-essai.md). They print what they see
// rather than assert it: rerun them with RESSAC_SPIKE=1 after a Firefox version change and compare with the note.

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);

/** A content script on every page that appends <p id="addon-mark">MARQUE-MODULE</p>. */
const marker: Fixture = {
  id: "mark@ressac.test",
  manifest: {
    manifest_version: 2,
    name: "Marque",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "mark@ressac.test" } },
    content_scripts: [{ matches: ["<all_urls>"], js: ["mark.js"] }],
  },
  files: { "mark.js": 'const p = document.createElement("p"); p.id = "addon-mark"; p.textContent = "MARQUE-MODULE"; document.body.append(p);' },
};

/** Cancels every request to /fichier.txt (webRequest). */
const blocker: Fixture = {
  id: "block@ressac.test",
  manifest: {
    manifest_version: 2,
    name: "Bloqueur",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "block@ressac.test" } },
    permissions: ["webRequest", "webRequestBlocking", "<all_urls>"],
    background: { scripts: ["background.js"] },
  },
  files: { "background.js": 'browser.webRequest.onBeforeRequest.addListener(() => ({ cancel: true }), { urls: ["*://*/fichier.txt"] }, ["blocking"]);' },
};

/** Asks for permissions, so that installing it shows the permissions prompt. */
const asking: Fixture = {
  id: "asking@ressac.test",
  manifest: {
    manifest_version: 2,
    name: "Demande",
    version: "1.0",
    browser_specific_settings: { gecko: { id: "asking@ressac.test" } },
    permissions: ["tabs", "<all_urls>"],
  },
};

/** Creates (once) a 24×24 fixed XUL box at (20, 60) in the window, id `ressac-anchor`. */
const ANCHOR = `
  let box = document.getElementById("ressac-anchor");
  if (!box) {
    box = document.createXULElement("box");
    box.id = "ressac-anchor";
    box.style.cssText = "position: fixed; left: 20px; top: 60px; width: 24px; height: 24px;";
    document.documentElement.append(box);
  }`;

/** What a panel looks like now, and where the window's inner screen origin is. */
const PANEL_STATE = `
  const describe = (panel) => {
    const r = panel?.getOuterScreenRect?.();
    return {
      state: panel?.state,
      anchor: panel?.anchorNode?.id || panel?.anchorNode?.localName || null,
      rect: r && { left: r.left, top: r.top, width: r.width, height: r.height },
      innerScreen: { x: window.mozInnerScreenX, y: window.mozInnerScreenY },
    };
  };`;

async function ready(m: Marionette): Promise<void> {
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
}

/** Opens `url` in a Ressac tab and waits until the selected browser shows it; returns the Ressac tab id. */
async function open(m: Marionette, url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
  return Object.keys(s.tabs).find((id) => !before.has(id))!;
}

describe.skipIf(!process.env.RESSAC_SPIKE)("add-on spike", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());

  describe("one session", () => {
    let w: LaunchedRessac;
    let m: Marionette;
    let id: string;
    beforeAll(async () => {
      w = await launchRessac();
      m = w.marionette;
      await ready(m);
    });
    afterAll(() => w?.close());

    it("S0: a temporary unsigned xpi installs", async () => {
      id = await installAddon(m, button());
      expect(id).toBe("button@ressac.test");
      const active = await m.execute<boolean>("return WebExtensionPolicy.getByID(arguments[0])?.active === true", [id]);
      note("S0 id, active", { id, active });
      expect(active).toBe(true);
    });

    /** Option A: PanelUI.showSubView on our box; then moveToAnchor bottomleft topleft. */
    const popupOnBox = () =>
      m.execute<unknown>(
        `return (async () => {
          ${ANCHOR}
          ${PANEL_STATE}
          const ba = gUnifiedExtensions.browserActionFor(WebExtensionPolicy.getByID(arguments[0]));
          ba.lastClickInfo = { button: 0, modifiers: [] };
          ba.openPopupWithoutUserInteraction = false;
          const shown = new Promise((r) => window.addEventListener("popupshown", (e) => r(e.target), { capture: true, once: true }));
          let error = null;
          try { await PanelUI.showSubView(ba.viewId, box); } catch (e) { error = String(e); }
          const panel = await Promise.race([shown, new Promise((r) => setTimeout(() => r(null), 5000))]);
          const out = { error, panelId: panel?.id ?? null, shown: describe(panel), boxRect: box.getBoundingClientRect().toJSON() };
          for (let i = 0; i < 50; i++) {
            const b = document.querySelector("browser.webextension-popup-browser");
            out.popup = b && { url: b.currentURI?.spec, title: b.contentTitle };
            if (out.popup?.title === "Popup de test prête") break;
            await new Promise((r) => setTimeout(r, 100));
          }
          if (panel) {
            panel.moveToAnchor(box, "bottomleft topleft");
            await new Promise((r) => setTimeout(r, 300));
            out.moved = describe(panel);
            const hidden = new Promise((r) => panel.addEventListener("popuphidden", r, { once: true }));
            panel.hidePopup();
            await hidden;
          }
          return out;
        })();`,
        [id],
      );

    it("S1: popup on our anchor (option A), parking tab then a page", async () => {
      note("S1 parking shown", await m.execute("return gBrowser.selectedTab.hasAttribute('ressac-parking')"));
      note("S1 A on parking", await popupOnBox());
      await open(m, `${server.url}/texte.html`);
      note("S1 A on page", await popupOnBox());
      // Away from the window's left edge, which direction does the panel take by itself?
      await m.execute('document.getElementById("ressac-anchor").style.left = "300px"');
      note("S1 A on page, box at x=300", await popupOnBox());
      await m.execute('document.getElementById("ressac-anchor").style.left = "20px"');
    });

    it("S1: option B, hidden toolbox, visible unified-extensions-button, triggerAction", async () => {
      note(
        "S1 B",
        await m.execute(
          `return (async () => {
            ${ANCHOR}
            ${PANEL_STATE}
            const toolbox = document.getElementById("navigator-toolbox");
            toolbox.style.cssText = "display: block !important; position: fixed; top: 0; left: 0; width: 0; height: 0; visibility: hidden; pointer-events: none;";
            const btn = document.getElementById("unified-extensions-button");
            btn.style.cssText = "visibility: visible; position: fixed; left: 20px; top: 60px; width: 24px; height: 24px; opacity: 0;";
            await new Promise((r) => setTimeout(r, 100));
            const ba = gUnifiedExtensions.browserActionFor(WebExtensionPolicy.getByID(arguments[0]));
            const shown = new Promise((r) => window.addEventListener("popupshown", (e) => r(e.target), { capture: true, once: true }));
            const out = { focused: Services.focus.activeWindow === window, btnVisible: btn.checkVisibility({ visibilityProperty: true }), btnRect: btn.getBoundingClientRect().toJSON() };
            try { ba.triggerAction(window); } catch (e) { out.error = String(e); }
            const panel = await Promise.race([shown, new Promise((r) => setTimeout(() => r(null), 5000))]);
            out.panelId = panel?.id ?? null;
            out.shown = describe(panel);
            for (let i = 0; i < 30; i++) {
              const b = document.querySelector("browser.webextension-popup-browser");
              out.popup = b && { url: b.currentURI?.spec, title: b.contentTitle };
              if (out.popup?.title === "Popup de test prête") break;
              await new Promise((r) => setTimeout(r, 100));
            }
            if (panel) panel.hidePopup();
            toolbox.style.cssText = "";
            btn.style.cssText = "";
            return out;
          })();`,
          [id],
        ),
      );
    });

    /** PopupNotifications.show of a test notification on the selected page; its panel once shown; then removed. */
    const showTest = () =>
      m.execute<unknown>(
        `return (async () => {
          ${PANEL_STATE}
          const panel = PopupNotifications.panel;
          const shown = new Promise((r) => panel.addEventListener("popupshown", () => r(true), { once: true }));
          const n = PopupNotifications.show(gBrowser.selectedBrowser, "test", "x", "geo-notification-icon", { label: "ok", accessKey: "o", callback() {} }, [], {});
          const ok = await Promise.race([shown, new Promise((r) => setTimeout(() => r(false), 5000))]);
          const out = { popupshown: ok, ...describe(panel) };
          const hidden = new Promise((r) => panel.addEventListener("popuphidden", r, { once: true }));
          PopupNotifications.remove(n);
          if (ok) await hidden;
          return out;
        })();`,
      );

    const HOOKS = `
      ${ANCHOR}
      gUnifiedExtensions.getPopupAnchorID = (b) => { b["ressac-anchorpopupnotificationanchor"] = box; return "ressac-anchor"; };
      PopupNotifications._getVisibleAnchorElement = (el) => (el?.checkVisibility({ visibilityProperty: true }) ? el : box);`;

    it("S2: site and add-on prompts, with and without our hooks", async () => {
      // The page is still the one S1 loaded.
      note("S2 test prompt without hooks", await showTest());
      await m.execute(`${HOOKS}`);
      note("S2 test prompt with hooks", await showTest());

      // Geolocation from the page (127.0.0.1 is a secure context), asked from Marionette's content context.
      const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);`);
      await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
      await m.setContext("content");
      note("S2 geolocation secure context", await m.execute("navigator.geolocation.getCurrentPosition(() => (document.title = 'geo-ok'), (e) => (document.title = 'geo-err:' + e.code)); return isSecureContext"));
      await m.setContext("chrome");
      note(
        "S2 geolocation",
        await m.execute(
          `return (async () => {
            ${PANEL_STATE}
            const b = gBrowser.selectedBrowser;
            let n;
            for (let i = 0; i < 50 && !(n = PopupNotifications.getNotification("geolocation", b)); i++) await new Promise((r) => setTimeout(r, 100));
            for (let i = 0; i < 20 && PopupNotifications.panel.state !== "open"; i++) await new Promise((r) => setTimeout(r, 100));
            const out = { notification: !!n, current: PopupNotifications._currentNotifications.map((x) => x.id), title: b.contentTitle, ...describe(PopupNotifications.panel) };
            if (n) PopupNotifications.remove(n);
            return out;
          })();`,
        ),
      );
    });

    it("S2: install from a page, the first notification", async () => {
      const xpi = await writeXpi(asking);
      note(
        "S2 install from page",
        await m.execute(
          `return (async () => {
            ${PANEL_STATE}
            const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
            const b = gBrowser.selectedBrowser;
            const install = await AddonManager.getInstallForFile(new FileUtils.File(arguments[0]));
            const seen = [];
            const panel = PopupNotifications.panel;
            const onShown = () => seen.push({ ids: PopupNotifications._currentNotifications.map((n) => n.id), anchor: describe(panel).anchor, rect: describe(panel).rect });
            panel.addEventListener("popupshown", onShown);
            AddonManager.installAddonFromWebpage("application/x-xpinstall", b, b.contentPrincipal, install);
            await new Promise((r) => setTimeout(r, 3000));
            panel.removeEventListener("popupshown", onShown);
            const out = { seen, now: PopupNotifications._currentNotifications.map((n) => n.id), installState: install.state, installError: install.error, ...describe(panel) };
            for (const n of [...PopupNotifications._currentNotifications]) PopupNotifications.remove(n);
            return out;
          })();`,
          [xpi],
        ),
      );
    });

    it("S2: the minimal call that shows addon-webext-permissions", async () => {
      note(
        "S2 permissions prompt",
        await m.execute(
          `return (async () => {
            ${PANEL_STATE}
            const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
            const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
            const strings = ExtensionData.formatPermissionStrings({ addon: { name: "Demande" }, permissions: { permissions: ["tabs"], origins: ["<all_urls>"] } }, { fullDomainsList: true });
            strings.addonName = "Demande";
            const panel = PopupNotifications.panel;
            const shown = new Promise((r) => panel.addEventListener("popupshown", () => r(true), { once: true }));
            const answer = ExtensionsUI.showPermissionsPrompt(gBrowser.selectedBrowser, strings, null);
            const ok = await Promise.race([shown, new Promise((r) => setTimeout(() => r(false), 5000))]);
            const n = PopupNotifications.getNotification("addon-webext-permissions", gBrowser.selectedBrowser);
            const out = { popupshown: ok, notification: !!n, msgs: strings.msgs, ...describe(panel) };
            if (n) PopupNotifications.remove(n);
            out.answer = await answer;
            return out;
          })();`,
        ),
      );
    });

    it("S3: a private windowless browser for the agent", async () => {
      await installAddon(m, marker);
      await installAddon(m, blocker);
      // webRequest: does /fichier.txt, cancelled by the blocker, reach the server?
      const reached = () => server.paths.includes("/fichier.txt");
      server.paths.length = 0;
      note("S3 mark in a normal tab", await probeMark(m, `${server.url}/texte.html`, false));
      await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/fichier.txt` });
      await new Promise((r) => setTimeout(r, 1500));
      note("S3 normal tab, blocked request reached the server", reached());
      server.paths.length = 0;
      note("S3 control, windowless not private", await probeMark(m, `${server.url}/texte.html`, false, true));
      note("S3 control, blocked request reached the server", reached());
      server.paths.length = 0;
      note("S3 windowless private", await probeMark(m, `${server.url}/texte.html`, true, true));
      note("S3 private, blocked request reached the server", reached());
    });

    it("S6: about:addons in a Ressac tab", async () => {
      await m.execute(`window.spikeEmLoaded = 0; Services.obs.addObserver(() => window.spikeEmLoaded++, "EM-loaded");`);
      const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "about:addons" });
      const tabId = Object.entries(s.tabs).find(([, o]) => o.url === "about:addons")?.[0];
      await new Promise((r) => setTimeout(r, 2000));
      const after = (await state(m)).tabs[tabId!];
      note("S6 state tab", after && { url: after.url, title: after.title });
      note(
        "S6 page",
        await m.execute(
          `return (async () => {
            const tab = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
            const win = tab?.linkedBrowser.contentWindow;
            const out = { xulTab: !!tab, selected: tab?.selected, remote: tab?.linkedBrowser.isRemoteBrowser, url: tab?.linkedBrowser.currentURI.spec, hasLoadView: typeof win?.loadView, emLoaded: window.spikeEmLoaded };
            if (typeof win?.loadView === "function") {
              await win.loadView("addons://list/extension");
              for (let i = 0; i < 30 && !win.document.querySelector("addon-card"); i++) await new Promise((r) => setTimeout(r, 100));
              out.cards = [...win.document.querySelectorAll("addon-card")].map((c) => c.getAttribute("addon-id"));
            }
            return out;
          })();`,
          [tabId],
        ),
      );
    });

    it("S7: the application's identity", async () => {
      note(
        "S7 appinfo",
        await m.execute("return { id: Services.appinfo.ID, version: Services.appinfo.version, platformVersion: Services.appinfo.platformVersion, name: Services.appinfo.name, userAgent: Cc[\"@mozilla.org/network/protocol;1?name=http\"].getService(Ci.nsIHttpProtocolHandler).userAgent }"),
      );
      // A manifest asking for a recent Firefox, as most AMO add-ons do.
      const strict: Fixture = {
        id: "strict@ressac.test",
        manifest: { manifest_version: 2, name: "Récent", version: "1.0", browser_specific_settings: { gecko: { id: "strict@ressac.test", strict_min_version: "115.0" } } },
      };
      let installed: unknown;
      try {
        installed = await installAddon(m, strict);
      } catch (e) {
        installed = String(e);
      }
      note("S7 strict_min_version 115.0 install", installed);
      note(
        "S7 strict_min_version 115.0 add-on",
        await m.execute(`return (async () => {
          const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          const a = await AddonManager.getAddonByID("strict@ressac.test");
          return a && { isActive: a.isActive, isCompatible: a.isCompatible, appDisabled: a.appDisabled };
        })();`),
      );
    });
  });

  it("S4: a public container turned internal keeps its id and cookies across a restart", async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    const CIS = 'ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService';
    const cookies = `return Services.cookies.getCookiesFromHost("127.0.0.1", { userContextId: arguments[0] }).map((c) => c.name + "=" + c.value);`;
    try {
      let w = await launchRessac({ profile, dataDir });
      let m = w.marionette;
      await ready(m);
      const userContextId = await m.execute<number>(`return ${CIS}.create("ressac-p1", "fence", "blue").userContextId;`);
      await m.execute(
        `return (async () => {
          const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== arguments[0]; i++) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, 500));
          gBrowser.removeTab(tab);
        })();`,
        [`${server.url}/cookie`, userContextId],
      );
      note("S4 cookie before", await m.execute(cookies, [userContextId]));
      note(
        "S4 turned internal",
        await m.execute(
          `const CIS = ${CIS};
           const i = CIS._identities.find((x) => x.userContextId === arguments[0]);
           i.public = false;
           i.name = i.policyId = "userContextIdInternal.webaios-p1";
           i.policy = true;
           delete i.icon; delete i.color; delete i.l10nId;
           CIS.saveSoon();
           return { identity: { ...i }, inPublic: CIS.getPublicIdentities().some((x) => x.userContextId === arguments[0]) };`,
          [userContextId],
        ),
      );
      await w.close();
      w = await launchRessac({ profile, dataDir });
      m = w.marionette;
      await ready(m);
      note(
        "S4 after restart",
        await m.execute(
          `const CIS = ${CIS};
           return { privateId: CIS.getPrivateIdentity("userContextIdInternal.webaios-p1")?.userContextId, inPublic: CIS.getPublicIdentities().some((x) => x.userContextId === arguments[0]) };`,
          [userContextId],
        ),
      );
      note("S4 cookie after restart", await m.execute(cookies, [userContextId]));
      note(
        "S4 tab in the internal container",
        await m.execute(
          `return (async () => {
            const errors = [];
            const listener = { observe(msg) { if (msg instanceof Ci.nsIScriptError && msg.flags === Ci.nsIScriptError.errorFlag) errors.push(msg.message); } };
            Services.console.registerListener(listener);
            const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
            for (let i = 0; i < 50 && tab.linkedBrowser.contentTitle !== "Texte"; i++) await new Promise((r) => setTimeout(r, 100));
            await new Promise((r) => setTimeout(r, 300));
            Services.console.unregisterListener(listener);
            const out = { title: tab.linkedBrowser.contentTitle, userContextId: tab.userContextId, errors };
            gBrowser.removeTab(tab);
            return out;
          })();`,
          [`${server.url}/texte.html`, userContextId],
        ),
      );
      await w.close();
    } finally {
      await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
    }
  });

  it("S5: a non-temporary unsigned install under the automation pref", { timeout: 120_000 }, async () => {
    const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    const o = {
      profile,
      dataDir,
      prefs: { "xpinstall.signatures.required": false, "security.turn_off_all_security_so_that_viruses_can_take_over_this_computer": true },
      env: { MOZ_DISABLE_NONLOCAL_CONNECTIONS: "1" },
    };
    const addon = `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const a = await AddonManager.getAddonByID("button@ressac.test");
      return a && { active: a.isActive, temporary: a.temporarilyInstalled, signedState: a.signedState };
    })();`;
    try {
      let w = await launchRessac(o);
      let m = w.marionette;
      await ready(m);
      note("S5 isInAutomation", await m.execute("return Cu.isInAutomation"));
      let installed: unknown;
      try {
        installed = await installAddon(m, button(), { temporary: false });
      } catch (e) {
        installed = String(e);
      }
      note("S5 install", installed);
      note("S5 add-on", await m.execute(addon));
      await w.close();
      w = await launchRessac(o);
      m = w.marionette;
      await ready(m);
      note("S5 add-on after restart", await m.execute(addon));
      await open(m, `${server.url}/texte.html`);
      const xpi = await writeXpi(asking);
      note(
        "S5 install from page",
        await m.execute(
          `return (async () => {
            const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
            const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
            const b = gBrowser.selectedBrowser;
            const install = await AddonManager.getInstallForFile(new FileUtils.File(arguments[0]));
            const seen = [];
            AddonManager.installAddonFromWebpage("application/x-xpinstall", b, b.contentPrincipal, install);
            for (let i = 0; i < 80; i++) {
              const ids = PopupNotifications._currentNotifications.map((n) => n.id + (n.anchorElement?.id ? "@" + n.anchorElement.id : ""));
              if (ids.join() !== seen.at(-1)?.join()) seen.push(ids);
              // The site is not allowed to install: allow it, as a person would.
              const blocked = PopupNotifications.getNotification("addon-install-blocked", b);
              if (blocked) blocked.mainAction.callback();
              if (PopupNotifications.getNotification("addon-webext-permissions", b)) break;
              await new Promise((r) => setTimeout(r, 100));
            }
            const out = { seen, installState: install.state, installError: install.error };
            for (const n of [...PopupNotifications._currentNotifications]) PopupNotifications.remove(n);
            return out;
          })();`,
          [xpi],
        ),
      );
      await w.close();
    } finally {
      await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
    }
  });
});

/**
 * Loads `url` in a normal Ressac tab or, with `windowless`, in a copy of the agent's windowless browser (private
 * with `priv`, in a fresh internal container); reads it with the page actor; reports whether #addon-mark is there.
 * The windowless browser first loads /fichier.txt, which the blocker cancels (webRequest), then its cookies.
 */
function probeMark(m: Marionette, url: string, priv: boolean, windowless = false): Promise<unknown> {
  if (!windowless)
    return (async () => {
      await open(m, url);
      await new Promise((r) => setTimeout(r, 1000));
      return m.execute(
        `return (async () => (await gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("RessacPage").sendQuery("html", { max: 100000 })).includes("addon-mark"))();`,
      );
    })();
  return m.execute(
    `return (async () => {
      const [url, priv] = arguments;
      const CIS = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService;
      const userContextId = CIS.createForPolicy("userContextIdInternal.webaios-spike-" + Date.now()).userContextId;
      // invisible.ts's createBrowser, private if asked.
      let flags = Ci.nsIWebBrowserChrome.CHROME_REMOTE_WINDOW | Ci.nsIWebBrowserChrome.CHROME_FISSION_WINDOW;
      if (priv) flags |= Ci.nsIWebBrowserChrome.CHROME_PRIVATE_WINDOW | Ci.nsIWebBrowserChrome.CHROME_PRIVATE_LIFETIME;
      const windowless = Services.appShell.createWindowlessBrowser(true, flags);
      const out = {};
      try {
        await new Promise((ok) => {
          const progress = windowless.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
          const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
            onStateChange(_p, request, state) {
              if (!request || !(state & Ci.nsIWebProgressListener.STATE_STOP) || !(state & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) return;
              progress.removeProgressListener(listener);
              ok();
            },
          };
          progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
          windowless.loadURI(Services.io.newURI("chrome://global/content/backgroundPageThumbs.xhtml"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        });
        const doc = windowless.document;
        const browser = doc.createXULElement("browser");
        for (const [k, v] of Object.entries({ type: "content", remote: "true", maychangeremoteness: "true", disableglobalhistory: "true", messagemanagergroup: "ressac-reading", manualactiveness: "true", usercontextid: String(userContextId) }))
          browser.setAttribute(k, v);
        browser.style.width = "1280px";
        browser.style.height = "900px";
        doc.documentElement.appendChild(browser);
        for (let i = 0; i < 500 && !browser.browsingContext.currentWindowGlobal; i++) await new Promise((r) => setTimeout(r, 10));
        out.usePrivateBrowsing = browser.browsingContext.usePrivateBrowsing;
        try { await browser.browsingContext.currentWindowGlobal.getActor("RessacReading").sendQuery("prepare"); out.prepare = "ok"; } catch (e) { out.prepare = String(e); }
        browser.docShellIsActive = true;
        const load = async (u) => {
          const uri = Services.io.newURI(u);
          browser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId, privateBrowsingId: priv ? 1 : 0 }) });
          for (let i = 0; i < 100 && (browser.currentURI.spec !== u || browser.webProgress.isLoadingDocument); i++) await new Promise((r) => setTimeout(r, 50));
          await new Promise((r) => setTimeout(r, 2000));
        };
        await load(new URL("/fichier.txt", url).href);
        await load(url);
        out.url = browser.currentURI.spec;
        out.originAttributes = browser.browsingContext.currentWindowGlobal?.documentPrincipal.originAttributes;
        try { out.mark = (await browser.browsingContext.currentWindowGlobal.getActor("RessacPage").sendQuery("html", { max: 100000 })).includes("addon-mark"); } catch (e) { out.mark = String(e); }
        // Private cookies of this container, and whether clearing the container pattern removes them.
        await load(new URL("/cookie", url).href);
        const oa = { userContextId, privateBrowsingId: priv ? 1 : 0 };
        out.cookieBefore = Services.cookies.getCookiesFromHost("127.0.0.1", oa).map((c) => c.name);
        await new Promise((ok) => Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId }, { onDataDeleted: () => ok() }));
        out.cookieAfterClear = Services.cookies.getCookiesFromHost("127.0.0.1", oa).map((c) => c.name);
        await new Promise((ok) => Services.clearData.deleteDataFromOriginAttributesPattern(oa, { onDataDeleted: () => ok() }));
        out.cookieAfterClearWithPrivateBrowsingId = Services.cookies.getCookiesFromHost("127.0.0.1", oa).map((c) => c.name);
      } finally {
        windowless.close();
      }
      return out;
    })();`,
    [url, priv],
  );
}
