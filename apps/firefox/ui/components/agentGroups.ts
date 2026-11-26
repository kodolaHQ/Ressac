import type { ChatSummary } from "../../shared/chat";

/** One discussion's tabs (`chat` null: « Sans discussion »). */
export type AgentGroup = { chat: ChatSummary | null; tabs: string[] };

/**
 * The agent's tabs by the discussion that opened them, in the list's order inside each group: the discussion the panel
 * shows first, then the most recently active, and last the tabs of no discussion this space lists (none recorded, or
 * deleted).
 */
export function agentGroups(order: readonly string[], chatOf: (tab: string) => string | undefined, chats: readonly ChatSummary[], shown: string | undefined): AgentGroup[] {
  const known = new Map(chats.map((c) => [c.id, c]));
  const by = new Map<ChatSummary | null, string[]>();
  for (const id of order) {
    const c = known.get(chatOf(id) ?? "") ?? null;
    const tabs = by.get(c);
    if (tabs) tabs.push(id);
    else by.set(c, [id]);
  }
  const none = by.get(null);
  by.delete(null);
  const groups = [...by].map(([chat, tabs]) => ({ chat, tabs })).sort((a, b) => Number(b.chat!.id === shown) - Number(a.chat!.id === shown) || b.chat!.updatedAt - a.chat!.updatedAt);
  return none ? [...groups, { chat: null, tabs: none }] : groups;
}
