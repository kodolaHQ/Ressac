import type { Shortcut } from "../chrome/window/keys";

/** A key combination: `key` is the lowercase `e.key`, or `Digit1`…`Digit9` for a digit (read on the physical key, AZERTY). */
export interface Binding {
  key: string;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

const b = (key: string, mods: "" | "s" = ""): Binding => ({ key, shift: mods === "s", alt: false, ctrl: false, meta: true });

/** Every remappable action (`label` is its message id). ⌘1–9, ⌃1–9 and ⌃Tab are fixed and not listed. */
export const SHORTCUTS = {
  command: { label: "sidebar-shortcut-command", default: b("t"), run: { type: "shortcut", r: "command" } },
  address: { label: "sidebar-shortcut-address", default: b("l"), run: { type: "shortcut", r: "address" } },
  closeTab: { label: "sidebar-shortcut-closeTab", default: b("w"), run: { type: "shortcut", r: "closeTab" } },
  back: { label: "sidebar-shortcut-back", default: b("["), run: { type: "navigate", c: "back" } },
  forward: { label: "sidebar-shortcut-forward", default: b("]"), run: { type: "navigate", c: "forward" } },
  reload: { label: "sidebar-shortcut-reload", default: b("r"), run: { type: "navigate", c: "reload" } },
  newWindow: { label: "sidebar-shortcut-newWindow", default: b("n"), run: { type: "window" } },
  agent: { label: "sidebar-shortcut-agent", default: b("j"), run: { type: "agent" } },
  history: { label: "sidebar-shortcut-history", default: b("y"), run: { type: "panel", p: "history" } },
  settings: { label: "sidebar-shortcut-settings", default: b(","), run: { type: "settings" } },
  reopen: { label: "sidebar-shortcut-reopen", default: b("t", "s"), run: { type: "reopen" } },
  reloadHard: { label: "sidebar-shortcut-reloadHard", default: b("r", "s"), run: { type: "navigate", c: "reloadHard" } },
  closeWindow: { label: "sidebar-shortcut-closeWindow", default: b("w", "s"), run: { type: "closeWindow" } },
  downloads: { label: "sidebar-shortcut-downloads", default: b("j", "s"), run: { type: "panel", p: "downloads" } },
  compact: { label: "sidebar-shortcut-compact", default: b("s", "s"), run: { type: "compact" } },
  apps: { label: "sidebar-shortcut-apps", default: b("a", "s"), run: { type: "apps" } },
  design: { label: "sidebar-shortcut-design", default: b("d", "s"), run: { type: "design" } },
} satisfies Record<string, { label: string; default: Binding; run: Shortcut }>;

export type ShortcutId = keyof typeof SHORTCUTS;
export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];

export type Bindings = Record<ShortcutId, Binding>;

export function effectiveBindings(overrides: Partial<Record<ShortcutId, Binding>>): Bindings {
  return Object.fromEntries(SHORTCUT_IDS.map((id) => [id, overrides[id] ?? SHORTCUTS[id].default])) as Bindings;
}

export const sameBinding = (x: Binding, y: Binding): boolean => x.key === y.key && x.shift === y.shift && x.alt === y.alt && x.ctrl === y.ctrl && x.meta === y.meta;

export function isBinding(v: unknown): v is Binding {
  const o = v as Binding;
  return !!o && typeof o.key === "string" && o.key !== "" && typeof o.shift === "boolean" && typeof o.alt === "boolean" && typeof o.ctrl === "boolean" && typeof o.meta === "boolean";
}

export const pickBinding = ({ key, shift, alt, ctrl, meta }: Binding): Binding => ({ key, shift, alt, ctrl, meta });

// ⌘+ and ⌘= are the same zoom key, with or without ⇧.
const RESERVED_ANY_SHIFT = ["+", "=", "-", "−", "0", "tab", "`"];
const RESERVED_PLAIN = ["q", "h", "m", "c", "v", "x", "a", "z", "f", "g", "p", "s", "o"];
const RESERVED_CMD_EDIT = ["arrowleft", "arrowright", "arrowup", "arrowdown", "backspace", "delete"];
const RESERVED_CTRL_EDIT = [..."aebfnpdhk"];
// The zoom keys are read on the physical key: AZERTY types « à » for ⌘0.
const ZOOM_CODES: Record<string, string> = { Digit0: "0", Minus: "-", Equal: "=" };

/** The binding a keydown makes: a digit is read on the physical key (AZERTY types « & » for the 1 key), so are the zoom keys. */
export const bindingFromKey = (e: { key: string; code: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): Binding => ({
  key: /^Digit[1-9]$/.test(e.code) ? e.code : (ZOOM_CODES[e.code] ?? e.key.toLowerCase()),
  shift: e.shiftKey,
  alt: e.altKey,
  ctrl: e.ctrlKey,
  meta: e.metaKey,
});

/** Why a binding is refused; the screen words it (this file is also read by the host, which cannot load the messages). */
export type BindingProblem = { problem: "modifier" | "reserved" } | { problem: "taken"; by: ShortcutId };

/** Why a binding cannot be given to `id`: reserved by macOS or text editing, no ⌘ or ⌃, or another action's. Null when it can. */
export function bindingProblem(id: ShortcutId, binding: Binding, effective: Bindings): BindingProblem | null {
  const { key, shift, alt, ctrl, meta } = binding;
  if (!meta && !ctrl) return { problem: "modifier" };
  const cmdOnly = meta && !ctrl && !alt;
  const fixed = /^Digit[1-9]$/.test(key) && !shift && !alt && meta !== ctrl;
  const ctrlTab = ctrl && !meta && key === "tab";
  if (
    fixed ||
    ctrlTab ||
    (cmdOnly && (RESERVED_ANY_SHIFT.includes(key) || (!shift && RESERVED_PLAIN.includes(key)) || (shift && key === "z"))) ||
    // ⌘ + arrows, ⌫ and ⌦ move and delete in text fields, with or without ⇧ and ⌥.
    (meta && RESERVED_CMD_EDIT.includes(key)) ||
    // The Cocoa ⌃ editing keys (⌃A, ⌃E, ⌃K…), ⌃ + arrows (Mission Control).
    (ctrl && !meta && (RESERVED_CTRL_EDIT.includes(key) || key.startsWith("arrow"))) ||
    // Full screen, emoji picker.
    (ctrl && meta && (key === "f" || key === " ")) ||
    // Consumed by the window before the bindings are read (keys.ts): a binding there would never fire.
    (meta && !ctrl && !alt && (key === "{" || key === "}")) ||
    (ctrl && !meta && !alt && (key === "pageup" || key === "pagedown"))
  )
    return { problem: "reserved" };
  const other = SHORTCUT_IDS.find((o) => o !== id && sameBinding(effective[o], binding));
  return other ? { problem: "taken", by: other } : null;
}

const KEY_NAMES: Record<string, string> = { " ": "Espace", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", enter: "↩", backspace: "⌫", escape: "⎋", tab: "⇥" };

/** `⇧⌘D`: macOS order ⌃⌥⇧⌘. */
export function bindingLabel(x: Binding): string {
  const key = /^Digit\d$/.test(x.key) ? x.key.slice(5) : (KEY_NAMES[x.key] ?? x.key.toUpperCase());
  return `${x.ctrl ? "⌃" : ""}${x.alt ? "⌥" : ""}${x.shift ? "⇧" : ""}${x.meta ? "⌘" : ""}${key}`;
}

/** The label of an action's current binding, for tooltips and hints. */
export const shortcutLabel = (id: ShortcutId, settings: { shortcuts: Partial<Record<ShortcutId, Binding>> } | undefined): string =>
  bindingLabel(settings?.shortcuts[id] ?? SHORTCUTS[id].default);
