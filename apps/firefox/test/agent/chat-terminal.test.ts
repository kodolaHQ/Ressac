import { expect, test, vi } from "vitest";
import { chatToTerminal } from "../../host/chat-terminal";

function deps(resumeId: string | undefined) {
  let closed!: () => void;
  const closing = new Promise<void>((r) => (closed = r));
  const o = {
    stopLogin: vi.fn(async () => {}),
    active: () => ({ id: "c1", profile: "claude" }),
    pause: vi.fn(() => closing),
    resumeIdOf: () => resumeId,
    resumeNext: vi.fn(),
    switchProfile: vi.fn(async () => {}),
    terminal: new Set<string>(),
    repush: vi.fn(),
  };
  return { o, closed };
}

test("the window turns terminal only once the discussion's engine has closed, with the resume already set", async () => {
  const { o, closed } = deps("11111111-1111-4111-8111-111111111111");
  const done = chatToTerminal("w1", o);
  await vi.waitFor(() => expect(o.pause).toHaveBeenCalledWith("c1"));
  // Still closing: no advanced view, no terminal resume armed.
  expect(o.terminal.has("w1")).toBe(false);
  expect(o.resumeNext).not.toHaveBeenCalled();
  expect(o.repush).not.toHaveBeenCalled();
  o.resumeNext.mockImplementation(() => expect(o.terminal.has("w1")).toBe(false));
  closed();
  await done;
  expect(o.resumeNext).toHaveBeenCalledWith("w1", "claude", "11111111-1111-4111-8111-111111111111");
  expect(o.terminal.has("w1")).toBe(true);
  expect(o.repush).toHaveBeenCalledWith("c1");
  expect(o.switchProfile).not.toHaveBeenCalled();
});

test("no resume id: the terminal starts fresh, after the close too", async () => {
  const { o, closed } = deps(undefined);
  const done = chatToTerminal("w1", o);
  await vi.waitFor(() => expect(o.pause).toHaveBeenCalled());
  expect(o.switchProfile).not.toHaveBeenCalled();
  closed();
  await done;
  expect(o.switchProfile).toHaveBeenCalledWith("w1", "claude");
});
