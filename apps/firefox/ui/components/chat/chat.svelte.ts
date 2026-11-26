import type { ChatSummary, ChatView } from "../../../shared/chat";
import { api } from "../../state.svelte";
import { t } from "../../i18n.svelte";
import { dismissBubble } from "../terminalAgent.svelte";

/**
 * The window's chat, shared by the panel's header, thread, composer and list: the active discussion as the host last
 * pushed it, and the list of the space's discussions. `visible`: the panel is shown (a hidden one draws no frames, so
 * its fades would never end: they get no duration).
 */
export const chat = $state<{ view: ChatView | null; list: ChatSummary[]; listOpen: boolean; error: string | null; visible: boolean }>({
  view: null,
  list: [],
  listOpen: false,
  error: null,
  visible: false,
});

/** Only the latest open applies: an older answer never replaces the discussion the user picked after it. */
let opens = 0;
async function take(p: Promise<ChatView>): Promise<void> {
  const n = ++opens;
  try {
    const v = await p;
    if (n !== opens) return;
    // Another discussion's labels are not this one's: a value shown for the previous one goes.
    if (chat.view?.summary.id !== v.summary.id) dismissBubble();
    chat.view = v;
    chat.error = null;
  } catch (e) {
    if (n === opens) chat.error = e instanceof Error ? e.message : String(e);
  }
}

/** Makes `id` the window's active discussion (omitted: the active one, made if none). */
export const openChat = (id?: string): Promise<void> => take(api.chat.open(id));
export const newChat = (o?: { profile?: string; mode?: "browser" | "workshop" }): Promise<void> => take(api.chat.create(o));
export const readList = (): Promise<void> => api.chat.list().then((l) => void (chat.list = l), () => {});

/**
 * « Supprimer »: the row goes at once; the window's active discussion gives way to a new one (what the panel opens with
 * none). Returns a short notice for the list, null when there is nothing to say.
 */
export async function removeChat(id: string, engineHistory: boolean): Promise<string | null> {
  const wasActive = chat.view?.summary.id === id;
  chat.list = chat.list.filter((s) => s.id !== id);
  let notice: string | null = null;
  try {
    const history = await api.chat.remove(id, { engineHistory });
    notice = history === "pending" ? t("chat-delete-pending") : history === "failed" ? t("chat-delete-history-failed") : null;
  } catch (e) {
    notice = t("chat-delete-failed", { message: e instanceof Error ? e.message : String(e) });
  }
  await readList();
  // A new discussion, never another one: picking one could take it from another window or wake a paused engine.
  if (wasActive && !chat.list.some((s) => s.id === id)) await openChat();
  return notice;
}

const off = api.onChat((v) => {
  if (chat.view?.summary.id === v.summary.id) chat.view = v;
  const i = chat.list.findIndex((s) => s.id === v.summary.id);
  if (i >= 0) chat.list[i] = v.summary;
  else if (chat.listOpen) void readList();
});

// Deleted (from any window): this one moves on to a new discussion, as after its own « Supprimer » (twice is harmless).
const offRemoved = api.onChatRemoved((id) => {
  chat.list = chat.list.filter((s) => s.id !== id);
  if (chat.view?.summary.id === id) void openChat();
});

// A streaming message's text only: the other items stay as they are, so they are not drawn again.
const offStream = api.onChatStream((id, s) => {
  if (chat.view?.summary.id === id) chat.view.streaming = s;
});

// Hot reload (development): the old module gives its subscription back.
if (import.meta.hot) import.meta.hot.dispose(() => (off(), offStream(), offRemoved()));

// The titles live apart: the sidebar's « Agent » groups use them without this window's chat state.
export { chatTitle, maskedName } from "./title";
