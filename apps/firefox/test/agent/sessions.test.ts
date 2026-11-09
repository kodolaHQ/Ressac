import { expect, test, vi } from "vitest";
import { WorkshopError } from "@webaios/kernel";
import { GROUPING_MS, SessionsAgent, BUFFER_MAX, SessionBuffer, type SessionLike } from "../../core/agent/sessions";

class FakeSession implements SessionLike {
  active = true;
  written: string[] = [];
  stopped = false;
  private data: ((d: string) => void)[] = [];
  private ends: ((c: number) => void)[] = [];
  write(d: string) {
    this.written.push(d);
  }
  resize() {}
  onData(r: (d: string) => void) {
    this.data.push(r);
    return () => {};
  }
  onEnd(r: (c: number) => void) {
    this.ends.push(r);
    return () => {};
  }
  stop() {
    this.stopped = true;
  }
  emit(d: string) {
    for (const r of this.data) r(d);
  }
  finish(code: number) {
    this.active = false;
    for (const r of this.ends) r(code);
  }
}

function prepare(open?: () => Promise<SessionLike>) {
  const sessions: FakeSession[] = [];
  const sends: { f: string; channel: string; v: unknown }[] = [];
  const messages: string[] = [];
  const manager = new SessionsAgent({
    open:
      open ??
      (async () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      }),
    send: (f, channel, v) => sends.push({ f, channel: channel, v }),
    onSend: (f) => messages.push(f),
  });
  const states = (f = "F") => sends.filter((e) => e.f === f && e.channel === "etat").map((e) => e.v);
  return { management: manager, sessions, sends: sends, states: states, messages };
}
const size = { cols: 80, rows: 24 };

test("starting twice opens only one session; the second call returns the buffer", async () => {
  const { management: manager, sessions, sends: sends, states: states } = prepare();
  await manager.start("F", size);
  sessions[0]!.emit("bonjour");
  sends.length = 0;
  await manager.start("F", size);
  expect(sessions).toHaveLength(1);
  expect(states()).toEqual([{ state: "actif" }]);
  expect(sends.filter((e) => e.channel === "donnees").map((e) => e.v)).toEqual(["bonjour"]);
  // Output waiting to be sent is already in the returned buffer: no duplicate afterwards.
  await new Promise((r) => setTimeout(r, GROUPING_MS * 3));
  expect(sends.filter((e) => e.channel === "donnees")).toHaveLength(1);
});

test("the agent's output goes out in batches: several close chunks, a single send", async () => {
  vi.useFakeTimers();
  try {
    const { management: manager, sessions, sends: sends } = prepare();
    await manager.start("F", size);
    for (const d of ["a", "b", "c"]) sessions[0]!.emit(d);
    expect(sends.filter((e) => e.channel === "donnees")).toEqual([]);
    vi.advanceTimersByTime(GROUPING_MS);
    expect(sends.filter((e) => e.channel === "donnees").map((e) => e.v)).toEqual(["abc"]);
  } finally {
    vi.useRealTimers();
  }
});

test("the buffer keeps the end of a huge output, starting at the beginning of a line", () => {
  const t = new SessionBuffer(1000);
  for (let i = 0; i < 100; i++) t.add(`${String(i).padStart(3, "0")}\x1b[31mrouge\x1b[0m\r\n`);
  const s = t.text();
  expect(s.length).toBeLessThanOrEqual(1000);
  expect(s.length).toBeGreaterThan(900);
  expect(s.endsWith("099\x1b[31mrouge\x1b[0m\r\n")).toBe(true);
  expect(s).toMatch(/^\d{3}\x1b\[31m/);
});

test("the buffer cuts a newline-free output exactly at the character", () => {
  const t = new SessionBuffer(BUFFER_MAX);
  for (let i = 0; i < 1000; i++) t.add(`${String(i).padStart(4, "0")}${"x".repeat(996)}`);
  expect(t.text().length).toBe(BUFFER_MAX);
  expect(t.text().endsWith(`0999${"x".repeat(996)}`)).toBe(true);
});

test("Docker absent → docker-absent; other error → error with message", async () => {
  const absent = prepare(() => Promise.reject(new WorkshopError("docker-absent")));
  await absent.management.start("F", size);
  expect(absent.states()).toEqual([{ state: "preparation" }, { state: "docker-absent" }]);
  const broken = prepare(() => Promise.reject(new Error("x")));
  await broken.management.start("F", size);
  expect(broken.states().at(-1)).toEqual({ state: "erreur", message: "x" });
});

test("agent end → termine; demarrer starts a new session", async () => {
  const { management: manager, sessions, states: states } = prepare();
  await manager.start("F", size);
  sessions[0]!.finish(3);
  expect(states().at(-1)).toEqual({ state: "termine", code: 3 });
  expect(manager.active("F")).toBe(false);
  await manager.start("F", size);
  expect(sessions).toHaveLength(2);
  expect(manager.active("F")).toBe(true);
});

test("fermerFenetre stops the session; a session that finishes opening after the close is stopped", async () => {
  const { management: manager, sessions } = prepare();
  await manager.start("F", size);
  manager.closeWindow("F");
  expect(sessions[0]!.stopped).toBe(true);
  let release!: (s: SessionLike) => void;
  const late = new FakeSession();
  const slow = prepare(() => new Promise((ok) => (release = ok)));
  const startup = slow.management.start("G", size);
  slow.management.closeWindow("G");
  release(late);
  await startup;
  expect(late.stopped).toBe(true);
});

test("ecrire goes to the window's session", async () => {
  const { management: manager, sessions } = prepare();
  await manager.start("F", size);
  manager.write("F", "ls\r");
  manager.write("G", "rien");
  expect(sessions[0]!.written).toEqual(["ls\r"]);
});

test("Enter in the terminal = the user sends a message (surEnvoi); an ordinary keystroke does not", async () => {
  const { management: manager, messages } = prepare();
  await manager.start("F", size);
  manager.write("F", "abc");
  expect(messages).toEqual([]);
  manager.write("F", "abc\r");
  expect(messages).toEqual(["F"]);
});

test("relancerTout stops every session and reopens one at the same size, without announcing « terminé »", async () => {
  const sizes: { cols: number; rows: number }[] = [];
  const sessions: FakeSession[] = [];
  const sends: { f: string; channel: string; v: unknown }[] = [];
  const manager = new SessionsAgent({
    open: async (_f, t) => {
      sizes.push(t);
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
    send: (f, channel, v) => sends.push({ f, channel: channel, v }),
  });
  await manager.start("F", size);
  manager.resize("F", { cols: 100, rows: 30 });
  const old = sessions[0]!;
  old.stop = () => old.finish(143); // a real pty announces its end when stopped
  sends.length = 0;
  await manager.relaunchAll();
  expect(old.active).toBe(false);
  expect(sessions).toHaveLength(2);
  expect(sizes[1]).toEqual({ cols: 100, rows: 30 });
  expect(sends.filter((e) => e.channel === "etat").map((e) => e.v)).toEqual([{ state: "preparation" }, { state: "actif" }]);
  expect(manager.active("F")).toBe(true);
});

test("relancerTout during a start: the failure of the old start does not overwrite the new session", async () => {
  const sessions: FakeSession[] = [];
  const sends: { f: string; channel: string; v: unknown }[] = [];
  let fail!: (e: Error) => void;
  let calls = 0;
  const manager = new SessionsAgent({
    open: () => {
      if (calls++ === 0) return new Promise((_ok, ko) => (fail = ko));
      const s = new FakeSession();
      sessions.push(s);
      return Promise.resolve(s);
    },
    send: (f, channel, v) => sends.push({ f, channel: channel, v }),
  });
  const old = manager.start("F", size);
  await manager.relaunchAll();
  fail(new Error("kernel stopped"));
  await old;
  expect(sends.filter((e) => e.channel === "etat").at(-1)?.v).toEqual({ state: "actif" });
  expect(manager.active("F")).toBe(true);
});

test("toutArreter waits for each session to stop", async () => {
  let finish!: () => void;
  const s = new FakeSession();
  s.stop = () => new Promise<void>((ok) => (finish = ok));
  const manager = new SessionsAgent({ open: async () => s, send: () => {} });
  await manager.start("F", size);
  let rendered = false;
  const stop = manager.stopAll().then(() => (rendered = true));
  await new Promise((r) => setTimeout(r, 20));
  expect(rendered).toBe(false);
  finish();
  await stop;
});

test("preRemplir before the start writes as soon as the session is active", async () => {
  let open!: (s: SessionLike) => void;
  const session = new FakeSession();
  const { management: manager, messages } = prepare(() => new Promise((r) => (open = r)));
  const written: string[] = [];
  manager.prefill("F", "[premier] ");
  manager.prefill("F", "[contexte] ", () => written.push(`accès avant : ${session.written.length}`));
  const startup = manager.start("F", size);
  expect(session.written).toEqual([]);
  open(session);
  await startup;
  // The last text wins; access is given at write time, session open; nothing is sent.
  expect(session.written).toEqual(["[contexte] "]);
  expect(written).toEqual(["accès avant : 0"]);
  expect(messages).toEqual([]);
});

test("preRemplir on an active session writes right away", async () => {
  const { management: manager, sessions, messages } = prepare();
  await manager.start("F", size);
  let called = 0;
  manager.prefill("F", "[application : Essai] ", () => called++);
  expect(sessions[0]!.written).toEqual(["[application : Essai] "]);
  expect(called).toBe(1);
  expect(messages).toEqual([]);
});

test("ouvrir receives the session's window", async () => {
  const received: { f: string; t: { cols: number; rows: number } }[] = [];
  const manager = new SessionsAgent({
    open: async (f, t) => {
      received.push({ f, t });
      return new FakeSession();
    },
    send: () => {},
  });
  await manager.start("F7", size);
  expect(received).toEqual([{ f: "F7", t: size }]);
});
