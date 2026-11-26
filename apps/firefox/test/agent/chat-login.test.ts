import { expect, test, vi } from "vitest";
import { createLoginTerminals } from "../../host/chat-login";

function fakePty() {
  const data = new Set<(d: string) => void>();
  const ends = new Set<(c: number) => void>();
  const s = {
    active: true,
    written: [] as string[],
    write: (d: string) => void s.written.push(d),
    resize: vi.fn(),
    onData: (cb: (d: string) => void) => (data.add(cb), () => data.delete(cb)),
    onEnd: (cb: (c: number) => void) => (ends.add(cb), () => ends.delete(cb)),
    stop: vi.fn(async () => s.end(143)),
    say: (d: string) => data.forEach((cb) => cb(d)),
    end: (c: number) => {
      if (!s.active) return;
      s.active = false;
      ends.forEach((cb) => cb(c));
    },
  };
  return s;
}

const size = { cols: 80, rows: 24 };

test("a first session's sweep waits for the login in progress, which then ends on its own", async () => {
  const pty = fakePty();
  const ended = vi.fn();
  const out: string[] = [];
  const logins = createLoginTerminals({ open: async () => pty, data: (_w, d) => void out.push(d), ended });
  await logins.start("w1", "claude", size);
  pty.say("Ouvrez https://claude.ai/…");
  expect(out).toEqual(["Ouvrez https://claude.ai/…"]);
  expect(logins.write("w1", "code\r")).toBe(true);
  expect(logins.write("w2", "x")).toBe(false);
  expect(pty.written).toEqual(["code\r"]);
  let swept = false;
  const sweep = logins.settled(10_000).then(() => (swept = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(swept).toBe(false);
  pty.end(0);
  await sweep;
  expect(ended).toHaveBeenCalledWith("w1", 0);
  expect(logins.has("w1")).toBe(false);
});

test("a login left open is stopped after the hold, then the sweep goes on", async () => {
  const pty = fakePty();
  const logins = createLoginTerminals({ open: async () => pty, data: () => {}, ended: () => {} });
  await logins.start("w1", "codex", size);
  await logins.settled(20);
  expect(pty.stop).toHaveBeenCalled();
  expect(logins.has("w1")).toBe(false);
});
