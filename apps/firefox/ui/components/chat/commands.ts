import type { ChatCommand } from "../../../shared/chat";

/**
 * The composer's « / » commands and « @ » references. Names are typed in French or English, accents optional (/modèle,
 * /modele, /model); the menu shows the name in the user's language (Fluent `chat-command-<id>`).
 */
export type CommandId = "model" | "new" | "mode" | "agent" | "terminal" | ChatCommand;
export type RefId = "tab" | "page" | "history" | "bookmark";

export const COMMANDS: readonly { id: CommandId; aliases: readonly string[] }[] = [
  { id: "model", aliases: ["modèle", "model"] },
  { id: "new", aliases: ["nouvelle", "new"] },
  { id: "mode", aliases: ["mode"] },
  { id: "agent", aliases: ["agent"] },
  { id: "terminal", aliases: ["terminal"] },
  { id: "search", aliases: ["cherche", "search"] },
  { id: "read", aliases: ["lis", "read"] },
  { id: "tabs", aliases: ["onglets", "tabs"] },
  { id: "history", aliases: ["historique", "history"] },
  { id: "bookmarks", aliases: ["favoris", "bookmarks"] },
];
export const REFS: readonly { id: RefId; aliases: readonly string[] }[] = [
  { id: "tab", aliases: ["onglet", "tab"] },
  { id: "page", aliases: ["page"] },
  { id: "history", aliases: ["historique", "history"] },
  { id: "bookmark", aliases: ["favori", "bookmark"] },
];

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
/** The entries one of whose names starts with what was typed. */
export const matching = <T extends { aliases: readonly string[] }>(list: readonly T[], query: string): T[] => list.filter((e) => e.aliases.some((a) => norm(a).startsWith(norm(query))));
const named = <T extends { aliases: readonly string[] }>(list: readonly T[], word: string): T | undefined => list.find((e) => e.aliases.some((a) => norm(a) === norm(word)));

export type MenuState =
  | { kind: "command"; query: string; start: number }
  | { kind: "option"; command: "mode" | "agent"; query: string; start: number }
  | { kind: "ref"; query: string; start: number }
  | { kind: "pick"; ref: Exclude<RefId, "page">; query: string; start: number };

/** The menu the text before the caret opens, null for none. `start`: where the typed « / » or « @ » token begins. */
export function menuAt(before: string): MenuState | null {
  let m = /^\/(\S*)$/.exec(before);
  if (m) return { kind: "command", query: m[1]!, start: 0 };
  m = /^\/(\S+) (\S*)$/.exec(before);
  const c = m && named(COMMANDS, m[1]!);
  if (m && (c?.id === "mode" || c?.id === "agent")) return { kind: "option", command: c.id, query: m[2]!, start: 0 };
  m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (m) return { kind: "ref", query: m[2]!, start: m.index + m[1]!.length };
  m = /(^|\s)@(\S+) ([^@\n]*)$/.exec(before);
  const r = m && named(REFS, m[2]!);
  if (m && r && r.id !== "page") return { kind: "pick", ref: r.id, query: m[3]!, start: m.index + m[1]!.length };
  return null;
}

/** A message that starts with a known command: which one, and the text after it. */
export function parseCommand(text: string): { id: CommandId; rest: string; restStart: number } | null {
  const m = /^\/(\S+)(\s+|$)/.exec(text);
  const c = m && named(COMMANDS, m[1]!);
  return c ? { id: c.id, rest: text.slice(m![0].length), restStart: m![0].length } : null;
}

/** The text without its typed token (`start` to `end`), one space kept between the words around it. */
export function withoutToken(text: string, start: number, end: number): { text: string; caret: number } {
  const tail = (start === 0 || text[start - 1] === " ") && text[end] === " " ? text.slice(end + 1) : text.slice(end);
  return { text: text.slice(0, start) + tail, caret: start };
}

/** The menu's next row for a key: ↑ ↓ wrap, Home and End jump, any other key stays. */
export function nextIndex(i: number, n: number, key: string): number {
  if (n === 0) return 0;
  if (key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return i;
}
