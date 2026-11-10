import { expect, test } from "vitest";
import { SessionAgent } from "../../src/pty/session.js";

test("SessionAgent: echo via /bin/cat and end", async () => {
  const s = SessionAgent.start(["/bin/cat"], { cols: 80, rows: 24 });
  expect(s.active).toBe(true);
  let received = "";
  const seen = new Promise<void>((ok) => s.onData((d) => { received += d; if (received.includes("bonjour")) ok(); }));
  s.write("bonjour\r");
  await seen;
  const end = new Promise<number>((ok) => s.onEnd(ok));
  s.stop();
  await end;
  expect(s.active).toBe(false);
});

test("unsubscribing cuts the callbacks", async () => {
  const s = SessionAgent.start(["/bin/cat"], { cols: 80, rows: 24 });
  let calls = 0;
  const unsubscribe = s.onData(() => calls++);
  unsubscribe();
  s.write("x\r");
  await new Promise((r) => setTimeout(r, 200));
  s.stop();
  expect(calls).toBe(0);
});

test("arreter also notifies the container (stopRemote), only once", async () => {
  let remotes = 0;
  const s = SessionAgent.start(["/bin/cat"], { cols: 80, rows: 24, stopRemote: () => void remotes++ });
  const end = new Promise<number>((ok) => s.onEnd(ok));
  s.stop();
  await end;
  s.stop();
  expect(remotes).toBe(1);
});

test("arreter hands back control once the agent is stopped in the container (⌘Q leaves none running)", async () => {
  let finish!: () => void;
  const s = SessionAgent.start(["/bin/cat"], { cols: 80, rows: 24, stopRemote: () => new Promise<void>((ok) => (finish = ok)) });
  let rendered = false;
  const stop = Promise.resolve(s.stop()).then(() => (rendered = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendered).toBe(false);
  finish();
  await stop;
  expect(rendered).toBe(true);
});
