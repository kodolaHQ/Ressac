import type { ShortcutId } from "./shortcuts";

export type TipId = "ctrl-tab" | "cmd-t" | "cmd-l" | "cmd-j" | "spaces" | "design-mode";
export type FirstTimeId = "agent" | "design" | "actions";
export type HintId = TipId | FirstTimeId;

/** `text` and the first-time `title` / `text` are message ids (locales, sidebar.ftl): the screen calls t(). */
export const TIPS: { id: TipId; text: string; /** A fixed key, shown as is. */ keys?: string; /** A remappable action: its current binding is the message's `$key`. */ shortcut?: ShortcutId; tryIt?: "command" | "agent" }[] = [
  { id: "ctrl-tab", keys: "⌃Tab", text: "sidebar-tip-ctrl-tab" },
  { id: "cmd-t", shortcut: "command", tryIt: "command", text: "sidebar-tip-cmd-t" },
  { id: "cmd-l", shortcut: "address", text: "sidebar-tip-cmd-l" },
  { id: "cmd-j", shortcut: "agent", tryIt: "agent", text: "sidebar-tip-cmd-j" },
  { id: "spaces", text: "sidebar-tip-spaces" },
  { id: "design-mode", text: "sidebar-tip-design-mode" },
];

export const FIRST_TIME: Record<FirstTimeId, { title: string; text: string }> = {
  agent: { title: "sidebar-first-agent-title", text: "sidebar-first-agent-text" },
  design: { title: "sidebar-first-design-title", text: "sidebar-first-design-text" },
  actions: { title: "sidebar-first-actions-title", text: "sidebar-first-actions-text" },
};

export const HINT_IDS = [...TIPS.map((t) => t.id), ...(Object.keys(FIRST_TIME) as FirstTimeId[])] as unknown as readonly [HintId, ...HintId[]];

/** The first tip not seen yet. */
export function nextTip(seen: readonly string[]): (typeof TIPS)[number] | null {
  return TIPS.find((t) => !seen.includes(t.id)) ?? null;
}
