// « Mode avancé »: the window's discussion goes to its terminal, which resumes the same conversation (Claude by id, Codex
// its thread). The window turns terminal (`terminal` set, the view's `advanced`) only once the discussion's engine
// process is closed: that view makes the panel start the terminal, a second process on the conversation otherwise.

export async function chatToTerminal(
  win: string,
  o: {
    stopLogin: (win: string) => Promise<void>;
    active: (win: string) => { id: string; profile: string } | null;
    /** Resolves once the discussion's engine conversation has closed (Chats.pause). */
    pause: (chatId: string) => Promise<void>;
    resumeIdOf: (chatId: string) => string | undefined;
    resumeNext: (win: string, profile: string, id: string) => void;
    switchProfile: (win: string, profile: string) => Promise<void>;
    terminal: Set<string>;
    /** Pushes the discussion's view again, now advanced (a panel reload shows the terminal). */
    repush: (chatId: string) => void;
  },
): Promise<void> {
  // A sign-in still running would take the terminal's keys (agent.write goes to it first).
  await o.stopLogin(win);
  const chat = o.active(win);
  if (!chat) return void o.terminal.add(win);
  await o.pause(chat.id);
  const id = o.resumeIdOf(chat.id);
  // Before the window turns terminal: the start it causes must find the resume set.
  if (id) o.resumeNext(win, chat.profile, id);
  o.terminal.add(win);
  o.repush(chat.id);
  if (!id) void o.switchProfile(win, chat.profile);
}
