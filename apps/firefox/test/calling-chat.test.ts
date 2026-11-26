import { expect, test } from "vitest";
import { callingChat } from "../host/calling-chat";

const o = {
  chatOfSession: (s: string) => (s === "pipe-a" ? "chat-a" : undefined),
  advanced: (w: string) => w === "W1",
  terminalSession: (w: string) => (w === "W1" ? "pty-1" : w === "W2" ? "pty-2" : null),
  activeChat: (w: string) => (w === "W1" ? "chat-t" : w === "W2" ? "chat-u" : undefined),
};

test("a live chat's session is its discussion, wherever it runs", () => {
  expect(callingChat({ chat: "pipe-a", window: "W2" }, o)).toBe("chat-a");
});

test("the terminal of a window in « Mode avancé » runs its active discussion; no other session of that window does", () => {
  expect(callingChat({ chat: "pty-1", window: "W1" }, o)).toBe("chat-t");
  expect(callingChat({ chat: "other", window: "W1" }, o)).toBeUndefined();
  // A terminal shown by the setting (not « Mode avancé ») is no discussion's.
  expect(callingChat({ chat: "pty-2", window: "W2" }, o)).toBeUndefined();
});

test("the main token (workflows, watches, recaps) or a session with no window: no discussion", () => {
  expect(callingChat({ chat: null, window: "W1" }, o)).toBeUndefined();
  expect(callingChat({ chat: "pty-1", window: null }, o)).toBeUndefined();
  expect(callingChat(undefined, o)).toBeUndefined();
});
