import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIREFOX_HIDDEN_ITEMS } from "../chrome/window/firefox-items";
import { FIREFOX_COMMANDS, FIREFOX_KEYS } from "../chrome/window/keys";
import { waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";

// Plan 64: the Firefox features that compete with Ressac's own are out of reach.

let w: LaunchedRessac;
let m: Marionette;
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
});
afterEach(async () => w?.close());

describe("Firefox features in conflict", () => {
  it("are off by pref", async () => {
    const prefs = await m.execute<Record<string, unknown>>(`return {
      profiles: Services.prefs.getBoolPref("browser.profiles.enabled"),
      revamp: Services.prefs.getBoolPref("sidebar.revamp"),
      windowsUndo: Services.prefs.getIntPref("browser.sessionstore.max_windows_undo"),
      split: Services.prefs.getBoolPref("browser.tabs.splitView.enabled"),
      chat: Services.prefs.getBoolPref("browser.ml.chat.enabled"),
      containers: Services.prefs.getBoolPref("privacy.userContext.enabled"),
    };`);
    expect(prefs).toEqual({ profiles: false, revamp: false, windowsUndo: 0, split: false, chat: false, containers: true });
  });

  it("stay hidden each time their menu opens, « À propos » and the Dock's private window included", async () => {
    // Firefox re-shows context items on each opening: the second popupshowing must not bring them back.
    const shown = await m.execute<string[]>(
      `const ids = arguments[0];
       for (let i = 0; i < 2; i++) {
         for (const id of ids) {
           const el = document.getElementById(id);
           if (!el) continue;
           el.hidden = false;
           const popup = el.closest("menupopup") ?? el;
           popup.dispatchEvent(new Event("popupshowing", { bubbles: true }));
         }
       }
       return ids.filter((id) => document.getElementById(id) && !document.getElementById(id).hidden);`,
      [FIREFOX_HIDDEN_ITEMS],
    );
    expect(shown).toEqual([]);
    // Some exist only in the hidden window's menu bar (the one macOS shows with no window open).
    const missing = await m.execute<string[]>(
      `const hidden = Services.appShell.hiddenDOMWindow.document;
       return arguments[0].filter((id) => !document.getElementById(id) && !hidden.getElementById(id));`,
      [FIREFOX_HIDDEN_ITEMS],
    );
    expect(missing).toEqual([]);
    expect(await m.execute(`return document.getElementById("aboutName").hidden;`)).toBe(false);
    expect(await m.execute(`return Services.appShell.hiddenDOMWindow.document.getElementById("macDockMenuNewPrivateWindow")?.hidden;`)).toBe(true);
  });

  it("have their keys and commands disabled", async () => {
    const ids = ["addBookmarkAsKb", "viewBookmarksToolbarKb", "viewBookmarksSidebarKb", "viewOpenTabsSidebarKb", "viewGenaiChatSidebarKb", "toggleSidebarKb", "goHome", "Browser:AddBookmarkAs", "Browser:SearchBookmarks", "Browser:RestoreLastSession", "cmd_file_importFromAnotherBrowser", "cmd_CustomizeToolbars"];
    expect(ids.filter((id) => ![...FIREFOX_KEYS, ...FIREFOX_COMMANDS].includes(id))).toEqual([]);
    const enabled = await m.execute<string[]>(`return arguments[0].filter((id) => document.getElementById(id)?.getAttribute("disabled") !== "true");`, [ids]);
    expect(enabled).toEqual([]);
  });

  it("leave the About window without Firefox's update block", async () => {
    await m.execute("openAboutDialog();");
    const hidden = await waitFor(m, `const w = Services.wm.getMostRecentWindow("Browser:About"); return w?.document.readyState === "complete" ? w.document.getElementById("updateBox").hidden : null;`, (v) => v !== null);
    expect(hidden).toBe(true);
  });
});
