import type { Action } from "./api";
import { format, languageName, LOCALES } from "./i18n";
import { APPEARANCES, type BrowserState } from "./model";
import { SEARCH_ENGINES } from "./search";
import { SHORTCUT_IDS, SHORTCUTS, shortcutLabel, type ShortcutId } from "./shortcuts";

/** Réglages' sections, in its order (ui/components/Settings.svelte). */
export const SETTINGS_SECTIONS = ["agents", "ai", "workshop", "permissions", "data", "privacy", "shortcuts", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type CommandRun = { kind: "shortcut"; id: ShortcutId } | { kind: "dispatch"; action: Action } | { kind: "settings"; section: SettingsSection };

/**
 * A browser command, found by name in ⌘T's « Commandes » and listed in the menu bar's « Commandes » (the macOS Help
 * search reads it). `id` never depends on the state (menu item ids). `keys`: its binding (« ⇧⌘D »), empty for none.
 * `current`: the option already chosen (« Apparence : Sombre » in dark mode); ⌘T leaves it out.
 */
export type BrowserCommand = { id: string; group: "shortcut" | "setting" | "section"; label: string; keys: string; words: string; current: boolean; run: CommandRun; toggle?: true };

type Settings = BrowserState["settings"];

/** Every command, shortcuts first, then the settings' choices and toggles, then Réglages' sections. */
export function browserCommands(state: { locale: string; settings: Settings }): BrowserCommand[] {
  const { locale, settings: s } = state;
  const say = (id: string, args?: Record<string, string>) => format(locale, id, args);
  const choice = (setting: string, value: string) => say("sidebar-command-choice", { setting: say(setting), value });
  const list: BrowserCommand[] = SHORTCUT_IDS.filter((id) => id !== "command" && id !== "address").map((id) => ({
    id,
    group: "shortcut",
    label: say(SHORTCUTS[id].label),
    keys: shortcutLabel(id, s),
    words: "",
    current: false,
    run: { kind: "shortcut", id },
  }));
  const setting = (id: string, label: string, words: string, current: boolean, action: Action) =>
    list.push({ id, group: "setting", label, keys: "", words, current, run: { kind: "dispatch", action } });
  // A toggle is one row that says what it does next.
  const toggle = (id: string, on: boolean, words: string, enable: Action, disable: Action) =>
    list.push({ id, group: "setting", label: say(`sidebar-command-${id}-${on ? "off" : "on"}`), keys: "", words, current: false, run: { kind: "dispatch", action: on ? disable : enable }, toggle: true });

  toggle("vim", s.vimMode, "vim", { type: "setVimMode", enabled: true }, { type: "setVimMode", enabled: false });
  const appearanceWords = { system: "système systeme system auto", light: "clair light jour", dark: "dark nuit" } as const;
  for (const a of APPEARANCES)
    setting(`appearance-${a}`, choice("settings-appearance-label", say(`settings-appearance-${a}`)), `theme thème mode ${appearanceWords[a]}`, s.appearance === a, { type: "chooseAppearance", appearance: a });
  for (const l of ["system", ...LOCALES])
    setting(`language-${l}`, choice("settings-language-label", l === "system" ? say("settings-language-system") : languageName(l)), "langue language", s.language === l, { type: "chooseLanguage", language: l });
  for (const side of ["left", "right"] as const)
    setting(`sidebar-${side}`, choice("settings-sidebar-label", say(`settings-sidebar-${side}`)), "sidebar barre côté cote", s.sidebarSide === side, { type: "setSidebarSide", side });
  for (const [e, { label }] of Object.entries(SEARCH_ENGINES) as [keyof typeof SEARCH_ENGINES, { label: string }][])
    setting(`engine-${e}`, choice("settings-engine-label", label), "moteur recherche search engine", s.engine === e, { type: "chooseEngine", engine: e });
  toggle("aura", s.auraMotion, "aura animation", { type: "setAuraMotion", enabled: true }, { type: "setAuraMotion", enabled: false });
  toggle("home", s.startOnHome, "accueil home démarrage lancement", { type: "setStartOnHome", enabled: true }, { type: "setStartOnHome", enabled: false });
  toggle("hints", s.hints.enabled, "astuces conseils tips", { type: "setHintsEnabled", enabled: true }, { type: "setHintsEnabled", enabled: false });

  for (const section of SETTINGS_SECTIONS)
    list.push({
      id: `settings-${section}`,
      group: "section",
      label: say("sidebar-command-settings-section", { section: say(`settings-section-${section}`) }),
      keys: "",
      words: "réglages reglages settings préférences preferences",
      current: false,
      run: { kind: "settings", section },
    });
  return list;
}
