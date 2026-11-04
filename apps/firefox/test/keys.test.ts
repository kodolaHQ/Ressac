import { describe, expect, it } from "vitest";
import { FIREFOX_COMMANDS, FIREFOX_KEYS, shortcutFor } from "../chrome/window/keys";

const key = (key: string, code: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  shortcutFor({ key, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

describe("shortcutFor", () => {
  it("maps the menu accelerators", () => {
    expect(key("t", "KeyT", { meta: true })).toEqual({ type: "raccourci", r: "commande" });
    expect(key("l", "KeyL", { meta: true })).toEqual({ type: "raccourci", r: "adresse" });
    expect(key("w", "KeyW", { meta: true })).toEqual({ type: "raccourci", r: "fermerOnglet" });
    expect(key("T", "KeyT", { meta: true, shift: true })).toEqual({ type: "rouvrir" });
    expect(key("[", "BracketLeft", { meta: true })).toEqual({ type: "naviguer", c: "reculer" });
    expect(key("]", "BracketRight", { meta: true })).toEqual({ type: "naviguer", c: "avancer" });
    expect(key("r", "KeyR", { meta: true })).toEqual({ type: "naviguer", c: "recharger" });
    expect(key("R", "KeyR", { meta: true, shift: true })).toEqual({ type: "naviguer", c: "rechargerSansCache" });
  });

  it("⌘N opens a window, ⇧⌘W closes it", () => {
    expect(key("n", "KeyN", { meta: true })).toEqual({ type: "fenetre" });
    expect(key("W", "KeyW", { meta: true, shift: true })).toEqual({ type: "fermerFenetre" });
    // The native menu items lead to the window registry; only their keys are ours.
    expect(FIREFOX_KEYS).toContain("key_closeWindow");
    expect(FIREFOX_COMMANDS).not.toContain("cmd_newNavigator");
    expect(FIREFOX_COMMANDS).not.toContain("cmd_closeWindow");
  });

  it("reads digits on the physical key", () => {
    expect(key("3", "Digit3", { meta: true })).toEqual({ type: "nieme", n: 3 });
    // AZERTY: ⌘1 types “&”.
    expect(key("&", "Digit1", { meta: true })).toEqual({ type: "nieme", n: 1 });
    expect(key("2", "Digit2", { ctrl: true })).toEqual({ type: "espace", n: 2 });
    expect(key("0", "Digit0", { meta: true })).toBeNull();
  });

  it("walks the tabs with ⌃Tab", () => {
    expect(key("Tab", "Tab", { ctrl: true })).toEqual({ type: "parcourir", delta: 1 });
    expect(key("Tab", "Tab", { ctrl: true, shift: true })).toEqual({ type: "parcourir", delta: -1 });
  });

  it("⌘J is the agent shortcut", () => {
    expect(key("j", "KeyJ", { meta: true })).toEqual({ type: "agent" });
    expect(FIREFOX_KEYS).toContain("key_openDownloads");
  });

  it("leaves other keys alone", () => {
    expect(key("t", "KeyT")).toBeNull();
    expect(key("t", "KeyT", { meta: true, alt: true })).toBeNull();
    expect(key("t", "KeyT", { ctrl: true })).toBeNull();
    expect(key("c", "KeyC", { meta: true })).toBeNull();
    expect(key("Tab", "Tab")).toBeNull();
  });
});
