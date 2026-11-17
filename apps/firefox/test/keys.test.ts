import { describe, expect, it } from "vitest";
import { effectiveBindings } from "../shared/shortcuts";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor } from "../chrome/window/keys";

const key = (key: string, code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  shortcutFor({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt }, effectiveBindings({}));

describe("shortcutFor", () => {
  it("maps the menu accelerators", () => {
    expect(key("t", "KeyT", { meta: true })).toEqual({ type: "shortcut", r: "command" });
    expect(key("l", "KeyL", { meta: true })).toEqual({ type: "shortcut", r: "address" });
    expect(key("w", "KeyW", { meta: true })).toEqual({ type: "shortcut", r: "closeTab" });
    expect(key("T", "KeyT", { meta: true, shift: true })).toEqual({ type: "reopen" });
    expect(key("[", "BracketLeft", { meta: true })).toEqual({ type: "navigate", c: "back" });
    expect(key("]", "BracketRight", { meta: true })).toEqual({ type: "navigate", c: "forward" });
    expect(key("r", "KeyR", { meta: true })).toEqual({ type: "navigate", c: "reload" });
    expect(key("R", "KeyR", { meta: true, shift: true })).toEqual({ type: "navigate", c: "reloadHard" });
  });

  it("⌘N opens a window, ⇧⌘W closes it", () => {
    expect(key("n", "KeyN", { meta: true })).toEqual({ type: "window" });
    expect(key("W", "KeyW", { meta: true, shift: true })).toEqual({ type: "closeWindow" });
    // The native menu items lead to the window registry; only their keys are ours.
    expect(FIREFOX_KEYS).toContain("key_closeWindow");
    expect(FIREFOX_COMMANDS).not.toContain("cmd_newNavigator");
    expect(FIREFOX_COMMANDS).not.toContain("cmd_closeWindow");
  });

  it("reads digits on the physical key", () => {
    expect(key("3", "Digit3", { meta: true })).toEqual({ type: "nth", n: 3 });
    // AZERTY: ⌘1 types “&”.
    expect(key("&", "Digit1", { meta: true })).toEqual({ type: "nth", n: 1 });
    expect(key("2", "Digit2", { ctrl: true })).toEqual({ type: "space", n: 2 });
    expect(key("0", "Digit0", { meta: true })).toBeNull();
  });

  it("walks the tabs with ⌃Tab", () => {
    expect(key("Tab", "Tab", { ctrl: true })).toEqual({ type: "cycle", delta: 1 });
    expect(key("Tab", "Tab", { ctrl: true, shift: true })).toEqual({ type: "cycle", delta: -1 });
  });

  it("swallows Firefox's other tab keys, which walk every space's tabs", () => {
    const swallowed = { type: "ignore" };
    expect(key("PageDown", "PageDown", { ctrl: true })).toEqual(swallowed);
    expect(key("PageUp", "PageUp", { ctrl: true })).toEqual(swallowed);
    // ⌃⇧PageUp/PageDown move the tab among them.
    expect(key("PageUp", "PageUp", { ctrl: true, shift: true })).toEqual(swallowed);
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(key(k, k, { meta: true, alt: true })).toEqual(swallowed);
    expect(key("}", "BracketRight", { meta: true, shift: true })).toEqual(swallowed);
    expect(key("{", "BracketLeft", { meta: true, shift: true })).toEqual(swallowed);
    expect(key("PageDown", "PageDown")).toBeNull();
    expect(key("ArrowLeft", "ArrowLeft", { meta: true })).toBeNull();
  });

  it("⌘J is the agent shortcut", () => {
    expect(key("j", "KeyJ", { meta: true })).toEqual({ type: "agent" });
    expect(FIREFOX_KEYS).toContain("key_openDownloads");
  });

  it("⌘Y opens the history, ⇧⌘J the downloads", () => {
    expect(key("y", "KeyY", { meta: true })).toEqual({ type: "panel", p: "history" });
    expect(key("J", "KeyJ", { meta: true, shift: true })).toEqual({ type: "panel", p: "downloads" });
    expect(FIREFOX_KEYS).toEqual(expect.arrayContaining(["key_gotoHistory", "showAllHistoryKb", "manBookmarkKb"]));
    expect(FIREFOX_COMMANDS).toEqual(expect.arrayContaining(["Browser:ShowAllHistory", "Browser:ShowAllBookmarks", "Tools:Downloads"]));
  });

  it("⇧⌘S toggles compact mode, not Firefox's screenshot", () => {
    expect(key("S", "KeyS", { meta: true, shift: true })).toEqual({ type: "compact" });
    expect(key("s", "KeyS", { meta: true })).toBeNull();
    expect(FIREFOX_KEYS).toContain("key_screenshot");
    expect(FIREFOX_COMMANDS).toContain("Browser:Screenshot");
  });

  it("⇧⌘A opens the Applications page, not Firefox's add-ons", () => {
    expect(key("A", "KeyA", { meta: true, shift: true })).toEqual({ type: "apps" });
    expect(key("a", "KeyA", { meta: true })).toBeNull();
    expect(FIREFOX_KEYS).toContain("key_openAddons");
  });

  it("⌘, opens the Settings page, not Firefox's preferences", () => {
    expect(key(",", "Comma", { meta: true })).toEqual({ type: "settings" });
    expect(key(",", "Comma", { meta: true, shift: true })).toBeNull();
    expect(key(",", "Comma", { ctrl: true })).toBeNull();
  });

  it("⇧⌘D toggles the design mode, not Firefox's « bookmark all tabs »", () => {
    expect(key("D", "KeyD", { meta: true, shift: true })).toEqual({ type: "design" });
    expect(key("d", "KeyD", { meta: true })).toBeNull();
    expect(FIREFOX_KEYS).toContain("bookmarkAllTabsKb");
    expect(FIREFOX_COMMANDS).toContain("Browser:BookmarkAllTabs");
  });

  it("leaves other keys alone", () => {
    expect(key("t", "KeyT")).toBeNull();
    expect(key("t", "KeyT", { meta: true, alt: true })).toBeNull();
    expect(key("t", "KeyT", { ctrl: true })).toBeNull();
    expect(key("c", "KeyC", { meta: true })).toBeNull();
    expect(key("Tab", "Tab")).toBeNull();
  });
});

describe("remapped bindings", () => {
  const press = (k: string, code: string, mods: { meta?: boolean; shift?: boolean }) =>
    shortcutFor({ key: k, code, metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, altKey: false }, effectiveBindings({ agent: { key: "k", shift: false, alt: false, ctrl: false, meta: true } }));
  it("an override replaces the default", () => {
    expect(press("k", "KeyK", { meta: true })).toEqual({ type: "agent" });
    expect(press("j", "KeyJ", { meta: true })).toBeNull();
    expect(press("J", "KeyJ", { meta: true, shift: true })).toEqual({ type: "panel", p: "downloads" });
  });
  it("a digit binding is read on the physical key", () => {
    const b = effectiveBindings({ design: { key: "Digit1", shift: true, alt: false, ctrl: false, meta: true } });
    const e = { key: "1", code: "Digit1", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false };
    expect(shortcutFor(e, b)).toEqual({ type: "design" });
    expect(shortcutFor({ ...e, shiftKey: false }, b)).toEqual({ type: "nth", n: 1 });
  });
});
