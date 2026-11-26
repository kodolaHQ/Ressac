import { expect, test, vi } from "vitest";
import { Masker } from "../../../../packages/kernel/src/mask/masker.ts";
import { LABELS } from "../../../../packages/kernel/src/mask/table.ts";
import { cleanDraft, createChatSend, prepareSend } from "../../host/chat-send";
import type { ChatDraft, ChatView } from "../../shared/chat";

const EMAIL = "camille.aubrac@example.com";
const draft = (text: string, o: Partial<ChatDraft> = {}): ChatDraft => ({ text, pasted: [], clear: [], ...o });
const masker = () => {
  const m = new Masker();
  m.open("s1", "w1");
  return m;
};
const outflow = () => ({ typed: vi.fn((_w: string, _d: string, _o?: { pasted?: boolean }) => {}) });
const typedText = (o: ReturnType<typeof outflow>) => o.typed.mock.calls.map((c) => c[1]).join("");

test("a passport email typed is sent as a label and shown as a chip", () => {
  const m = masker();
  const out = outflow();
  const r = prepareSend({ masker: m, sessionId: "s1", draft: draft(`écris à ${EMAIL}`), outflow: out, win: "w1" });
  expect(r.sent).toContain("⟨email-");
  expect(r.sent).not.toContain("camille.aubrac");
  expect(r.shown).toBe(r.sent);
  expect(typedText(out)).not.toContain("camille.aubrac");
  expect(typedText(out)).not.toMatch(LABELS);
  // Every typed segment, then the submit.
  expect(out.typed.mock.calls.at(-1)).toEqual(["w1", "\r"]);
  expect(out.typed.mock.calls.every((c) => c[0] === "w1")).toBe(true);
});

test("a pasted range is typed as pasted", () => {
  const out = outflow();
  prepareSend({ masker: masker(), sessionId: "s1", draft: draft("hello world", { pasted: [[0, 5]] }), outflow: out, win: "w1" });
  expect(out.typed.mock.calls).toEqual([
    ["w1", "hello", { pasted: true }],
    ["w1", " world", { pasted: false }],
    ["w1", "\r"],
  ]);
});

test("a label chosen in clear is sent in clear for this send only", () => {
  const m = masker();
  const label = [...m.maskTypedFor("s1", EMAIL).text.matchAll(LABELS)][0]![0];
  const out = outflow();
  const r = prepareSend({ masker: m, sessionId: "s1", draft: draft(`écris à ${EMAIL}`, { clear: [label] }), outflow: out, win: "w1" });
  expect(r.sent).toBe(`écris à ${EMAIL}`);
  // The transcript keeps the label: never a clear value on disk.
  expect(r.shown).toContain(label);
  // The user chose it: it is theirs to send (the typed exemption).
  expect(typedText(out)).toContain(EMAIL);
  const next = prepareSend({ masker: m, sessionId: "s1", draft: draft(`encore ${EMAIL}`), outflow: outflow(), win: "w1" });
  expect(next.sent).toBe(`encore ${label}@example.com`);
});

test("the context before and the pages after are masked but never typed", () => {
  const out = outflow();
  const r = prepareSend({ masker: masker(), sessionId: "s1", draft: draft("ma question"), outflow: out, win: "w1", before: `[contexte : ${EMAIL}] `, after: " — pages" });
  expect(r.sent).toMatch(/^\[contexte : ⟨email-\w+⟩@example\.com\] ma question — pages$/);
  expect(typedText(out)).toBe("ma question\r");
});

test("cleanDraft refuses what the UI must not send", () => {
  expect(cleanDraft({ text: "a", pasted: [[0, 1]], clear: [] })).toEqual({ text: "a", pasted: [[0, 1]], clear: [] });
  expect(cleanDraft({ text: 3 })).toBeNull();
  expect(cleanDraft({ text: "", pasted: [], clear: [] })).toBeNull();
  // Ranges out of the text are clamped, labels must look like labels.
  expect(cleanDraft({ text: "abc", pasted: [[2, 9], [5, 1], "x"], clear: ["nope", "⟨email-abcdefgh⟩"] })).toEqual({ text: "abc", pasted: [[2, 3]], clear: ["⟨email-abcdefgh⟩"] });
});

/** A fake Chats: one discussion whose session opens when the test says. */
function fakeChats() {
  let session: string | null = null;
  const prompts: [string, string, string][] = [];
  const view = (): ChatView => ({ summary: { id: "c1", title: "", engine: "claude", profile: "claude", mode: "browser", state: session ? "ready" : "starting", updatedAt: 0, messages: 0 }, items: [] });
  return {
    prompts,
    openSession: (s: string) => (session = s),
    chats: {
      sessionIdOf: vi.fn((_id: string) => session),
      prompt: vi.fn((id: string, sent: string, shown: string) => void prompts.push([id, sent, shown])),
      select: vi.fn(async (_w: string, _id: string) => view()),
      active: vi.fn((_w: string) => view()),
    },
  };
}

test("a draft sent before the session exists waits, then is masked once it does", async () => {
  const f = fakeChats();
  const m = masker();
  const spy = vi.spyOn(m, "maskTypedFor");
  const interacted = vi.fn();
  const send = createChatSend({ chats: f.chats, masker: () => m, outflow: () => outflow(), interacted, create: async () => f.chats.active("w1") });
  expect(await send.send("w1", "c1", draft(`écris à ${EMAIL}`))).toEqual({ ok: true });
  expect(spy).not.toHaveBeenCalled();
  expect(f.prompts).toEqual([]);
  expect(send.waiting("c1")).toBe(1);
  f.openSession("s1");
  send.flush("c1");
  expect(f.prompts.length).toBe(1);
  expect(f.prompts[0]![1]).toContain("⟨email-");
  expect(f.prompts[0]![1]).not.toContain("camille.aubrac");
  expect(interacted).toHaveBeenCalledWith("w1");
  expect(send.waiting("c1")).toBe(0);
});

test("waiting drafts are dropped on cancel and window close, never kept in clear", async () => {
  const f = fakeChats();
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => outflow(), interacted: () => {}, create: async () => f.chats.active("w1") });
  await send.send("w1", "c1", draft("a"));
  send.drop("c1");
  expect(send.waiting("c1")).toBe(0);
  await send.send("w1", "c1", draft("b"));
  send.dropWindow("w1");
  f.openSession("s1");
  send.flush("c1");
  expect(f.prompts).toEqual([]);
});

test("the panel's context goes before the first message of the window's new discussion only", async () => {
  const f = fakeChats();
  f.openSession("s1");
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => outflow(), interacted: () => {}, create: async () => f.chats.active("w1") });
  send.panelOpened("w1", "[contexte : Page — https://a.fr/] ");
  await send.send("w1", "c1", draft("bonjour"));
  expect(f.prompts[0]![1]).toBe("[contexte : Page — https://a.fr/] bonjour");
  await send.send("w1", "c1", draft("encore"));
  expect(f.prompts[1]![1]).toBe("encore");
});

test("a submitted prefill (design remarks) is a message to the active discussion, masked, never typed", async () => {
  const f = fakeChats();
  f.openSession("s1");
  const out = outflow();
  const written = vi.fn();
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => out, interacted: () => {}, create: async () => f.chats.active("w1") });
  await send.prefill("w1", `remarque pour ${EMAIL}`, { submit: true, written });
  expect(f.prompts[0]![1]).toMatch(/^remarque pour ⟨email-\w+⟩@example\.com$/);
  expect(typedText(out)).toBe("\r");
  expect(written).toHaveBeenCalled();
});

test("a draft prefill (a site app's prefix) waits as the window's prefix, shown to the UI, put before the next message", async () => {
  const f = fakeChats();
  f.openSession("s1");
  const out = outflow();
  const written = vi.fn();
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => out, interacted: () => {}, create: async () => f.chats.active("w1") });
  await send.prefill("w1", "[application : Lune] ", { written });
  expect(f.prompts).toEqual([]);
  expect(send.prefixOf("w1")).toBe("[application : Lune] ");
  expect(written).not.toHaveBeenCalled();
  await send.send("w1", "c1", draft("corrige"));
  expect(f.prompts[0]![1]).toBe("[application : Lune] corrige");
  expect(typedText(out)).toBe("corrige\r");
  expect(written).toHaveBeenCalled();
  expect(send.prefixOf("w1")).toBeNull();
});

test("the panel's context, arriving after an app's prefix (design.giveAgent opens the panel), never replaces it", async () => {
  const f = fakeChats();
  f.openSession("s1");
  const written = vi.fn();
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => outflow(), interacted: () => {}, create: async () => f.chats.active("w1") });
  await send.prefill("w1", "[application : Lune] ", { written });
  send.panelOpened("w1", "[contexte : Page — https://a.fr/] ");
  expect(send.prefixOf("w1")).toBe("[application : Lune] ");
  await send.send("w1", "c1", draft("corrige"));
  expect(f.prompts[0]![1]).toBe("[application : Lune] corrige");
  expect(written).toHaveBeenCalled();
});

test("a send that fails keeps the window's prefix for the next one", async () => {
  const f = fakeChats();
  f.chats.select.mockResolvedValueOnce(null as never);
  const send = createChatSend({ chats: f.chats, masker: () => masker(), outflow: () => outflow(), interacted: () => {}, create: async () => f.chats.active("w1") });
  await send.prefill("w1", "[application : Lune] ");
  expect(await send.send("w1", "c1", draft("corrige"))).toMatchObject({ ok: false });
  expect(send.prefixOf("w1")).toBe("[application : Lune] ");
});
