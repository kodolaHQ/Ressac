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

/** Every remappable action. ⌘1–9, ⌃1–9 and ⌃Tab are fixed and not listed. */
export const SHORTCUTS = {
  command: { label: "Barre de commande", default: b("t"), run: { type: "shortcut", r: "command" } },
  address: { label: "Barre d'adresse", default: b("l"), run: { type: "shortcut", r: "address" } },
  closeTab: { label: "Fermer l'onglet", default: b("w"), run: { type: "shortcut", r: "closeTab" } },
  back: { label: "Page précédente", default: b("["), run: { type: "navigate", c: "back" } },
  forward: { label: "Page suivante", default: b("]"), run: { type: "navigate", c: "forward" } },
  reload: { label: "Recharger", default: b("r"), run: { type: "navigate", c: "reload" } },
  newWindow: { label: "Nouvelle fenêtre", default: b("n"), run: { type: "window" } },
  agent: { label: "Panneau de l'agent", default: b("j"), run: { type: "agent" } },
  history: { label: "Historique", default: b("y"), run: { type: "panel", p: "history" } },
  settings: { label: "Réglages", default: b(","), run: { type: "settings" } },
  reopen: { label: "Rouvrir l'onglet fermé", default: b("t", "s"), run: { type: "reopen" } },
  reloadHard: { label: "Recharger sans cache", default: b("r", "s"), run: { type: "navigate", c: "reloadHard" } },
  closeWindow: { label: "Fermer la fenêtre", default: b("w", "s"), run: { type: "closeWindow" } },
  downloads: { label: "Téléchargements", default: b("j", "s"), run: { type: "panel", p: "downloads" } },
  compact: { label: "Mode compact", default: b("s", "s"), run: { type: "compact" } },
  apps: { label: "Applications", default: b("a", "s"), run: { type: "apps" } },
  design: { label: "Mode design", default: b("d", "s"), run: { type: "design" } },
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

const RESERVED_MESSAGE = "Réservé par macOS ou l'édition de texte";
// ⌘+ and ⌘= are the same zoom key, with or without ⇧.
const RESERVED_ANY_SHIFT = ["+", "=", "-", "−", "0", "tab", "`"];
const RESERVED_PLAIN = ["q", "h", "m", "c", "v", "x", "a", "z", "f", "g", "p", "s", "o"];

/** Why a binding cannot be given to `id`: reserved by macOS or text editing, no ⌘ or ⌃, or another action's. Null when it can. */
export function bindingProblem(id: ShortcutId, binding: Binding, effective: Bindings): string | null {
  const { key, shift, alt, ctrl, meta } = binding;
  if (!meta && !ctrl) return "Utilisez ⌘ ou ⌃";
  const cmdOnly = meta && !ctrl && !alt;
  const fixed = /^Digit[1-9]$/.test(key) && !shift && !alt && meta !== ctrl;
  const ctrlTab = ctrl && !meta && key === "tab";
  if (fixed || ctrlTab || (cmdOnly && (RESERVED_ANY_SHIFT.includes(key) || (!shift && RESERVED_PLAIN.includes(key)) || (shift && key === "z"))))
    return RESERVED_MESSAGE;
  const other = SHORTCUT_IDS.find((o) => o !== id && sameBinding(effective[o], binding));
  return other ? `Déjà utilisé par ${SHORTCUTS[other].label}` : null;
}

const KEY_NAMES: Record<string, string> = { " ": "Espace", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", enter: "↩", backspace: "⌫", escape: "⎋", tab: "⇥" };

/** `⇧⌘D`: macOS order ⌃⌥⇧⌘. */
export function bindingLabel(x: Binding): string {
  const key = /^Digit\d$/.test(x.key) ? x.key.slice(5) : (KEY_NAMES[x.key] ?? x.key.toUpperCase());
  return `${x.ctrl ? "⌃" : ""}${x.alt ? "⌥" : ""}${x.shift ? "⇧" : ""}${x.meta ? "⌘" : ""}${key}`;
}
