/**
 * The discussion of the session whose tool call runs now (the tabs it opens are grouped by it): a chat's live
 * conversation, or a window's terminal in « Mode avancé », which runs its active discussion. Anything else (workflows,
 * watches and recaps on the main token, a terminal of no discussion): none.
 */
export function callingChat(
  scope: { chat?: string | null; window?: string | null } | undefined,
  o: {
    chatOfSession: (session: string) => string | undefined;
    /** The window's panel is in « Mode avancé ». */
    advanced: (win: string) => boolean;
    /** The window's newest kernel session: its terminal's, once « Mode avancé » started it. */
    terminalSession: (win: string) => string | null;
    activeChat: (win: string) => string | undefined;
  },
): string | undefined {
  if (!scope?.chat) return undefined;
  const live = o.chatOfSession(scope.chat);
  if (live) return live;
  const win = scope.window;
  return win && o.advanced(win) && o.terminalSession(win) === scope.chat ? o.activeChat(win) : undefined;
}
