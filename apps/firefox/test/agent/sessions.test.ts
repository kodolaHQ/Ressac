import { describe, expect, test, vi } from "vitest";
import { WorkshopError } from "@ressac/kernel";
import { GROUPING_MS, SUBMIT_DELAY_MS, SessionsAgent, BUFFER_MAX, SessionBuffer, type SessionLike } from "../../core/agent/sessions";

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
  const states = (f = "F") => sends.filter((e) => e.f === f && e.channel === "state").map((e) => e.v);
  return { management: manager, sessions, sends: sends, states: states, messages };
}
const size = { cols: 80, rows: 24 };

test("starting twice opens only one session; the second call returns the buffer", async () => {
  const { management: manager, sessions, sends, states } = prepare();
  await manager.start("F", size);
  sessions[0]!.emit("bonjour");
  sends.length = 0;
  await manager.start("F", size);
  expect(sessions).toHaveLength(1);
  expect(states()).toEqual([{ state: "active" }]);
  expect(sends.filter((e) => e.channel === "data").map((e) => e.v)).toEqual(["bonjour"]);
  // Output waiting to be sent is already in the returned buffer: no duplicate afterwards.
  await new Promise((r) => setTimeout(r, GROUPING_MS * 3));
  expect(sends.filter((e) => e.channel === "data")).toHaveLength(1);
});

test("the agent's output goes out in batches: several close chunks, a single send", async () => {
  vi.useFakeTimers();
  try {
    const { management: manager, sessions, sends } = prepare();
    await manager.start("F", size);
    for (const d of ["a", "b", "c"]) sessions[0]!.emit(d);
    expect(sends.filter((e) => e.channel === "data")).toEqual([]);
    vi.advanceTimersByTime(GROUPING_MS);
    expect(sends.filter((e) => e.channel === "data").map((e) => e.v)).toEqual(["abc"]);
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
  expect(absent.states()).toEqual([{ state: "preparing" }, { state: "docker-absent" }]);
  const broken = prepare(() => Promise.reject(new Error("x")));
  await broken.management.start("F", size);
  expect(broken.states().at(-1)).toEqual({ state: "error", message: "x" });
});

test("agent end → termine; demarrer starts a new session", async () => {
  const { management: manager, sessions, states } = prepare();
  await manager.start("F", size);
  sessions[0]!.finish(3);
  expect(states().at(-1)).toEqual({ state: "done", code: 3 });
  expect(manager.active("F")).toBe(false);
  await manager.start("F", size);
  expect(sessions).toHaveLength(2);
  expect(manager.active("F")).toBe(true);
});

test("closeWindow stops the session; a session that finishes opening after the close is stopped", async () => {
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

test("Enter in the terminal = the user sends a message (onSend); an ordinary keystroke does not", async () => {
  const { management: manager, messages } = prepare();
  await manager.start("F", size);
  manager.write("F", "abc");
  expect(messages).toEqual([]);
  manager.write("F", "abc\r");
  expect(messages).toEqual(["F"]);
});

test("relaunchAll stops every session and reopens one at the same size, without announcing « terminé »", async () => {
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
  expect(sends.filter((e) => e.channel === "state").map((e) => e.v)).toEqual([{ state: "preparing" }, { state: "active" }]);
  expect(manager.active("F")).toBe(true);
});

test("relaunchAll during a start: the failure of the old start does not overwrite the new session", async () => {
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
  expect(sends.filter((e) => e.channel === "state").at(-1)?.v).toEqual({ state: "active" });
  expect(manager.active("F")).toBe(true);
});

test("stopAll waits for each session to stop", async () => {
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

test("prefill before the start writes as soon as the session is active", async () => {
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

test("prefill on an active session writes right away", async () => {
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

describe("each window keeps its agent", () => {
  /** `open` notes each call; `fails` lists profiles whose opening rejects; `slow` holds openings until released. */
  function windows(o: { fails?: string[]; slow?: boolean } = {}) {
    const calls: { f: string; profile: string; resume: boolean }[] = [];
    const opened: { f: string; profile: string; s: FakeSession }[] = [];
    const pending: (() => void)[] = [];
    const manager = new SessionsAgent({
      defaultProfile: () => "claude",
      open: (f, _t, { profile, resume }) => {
        calls.push({ f, profile, resume });
        if (o.fails?.includes(profile)) return Promise.reject(new Error("no"));
        const s = new FakeSession();
        s.stop = () => s.finish(143);
        opened.push({ f, profile, s });
        return o.slow ? new Promise((ok) => pending.push(() => ok(s))) : Promise.resolve(s);
      },
      send: () => {},
    });
    const live = (f: string) => opened.filter((x) => x.f === f && x.s.active);
    return { manager, calls, opened, pending, live };
  }

  test("default profile", async () => {
    const w = windows();
    await w.manager.start("f1", size);
    expect(w.calls).toEqual([{ f: "f1", profile: "claude", resume: false }]);
  });

  test("switch only this window", async () => {
    const w = windows();
    await w.manager.start("f1", size);
    await w.manager.start("f2", size);
    const [one, two] = w.opened;
    await w.manager.switchProfile("f1", "codex");
    expect(one!.s.active).toBe(false);
    expect(w.calls.at(-1)).toEqual({ f: "f1", profile: "codex", resume: false });
    expect(two!.s.active).toBe(true);
    expect(w.calls.filter((c) => c.f === "f2")).toHaveLength(1);
    expect(w.manager.profileOf("f1")).toBe("codex");
    expect(w.manager.profileOf("f2")).toBe("claude");
    await w.manager.switchProfile("f1", "codex");
    expect(w.calls).toHaveLength(3);
  });

  test("switch back resumes", async () => {
    const w = windows();
    await w.manager.start("f1", size);
    await w.manager.switchProfile("f1", "codex");
    await w.manager.switchProfile("f1", "claude");
    expect(w.calls.at(-1)).toEqual({ f: "f1", profile: "claude", resume: true });
    await w.manager.switchProfile("f1", "codex");
    expect(w.calls.at(-1)).toEqual({ f: "f1", profile: "codex", resume: true });
  });

  test("no resume without an active session", async () => {
    const w = windows({ fails: ["codex"] });
    await w.manager.start("f1", size);
    await w.manager.switchProfile("f1", "codex");
    await w.manager.switchProfile("f1", "claude");
    w.calls.length = 0;
    await w.manager.switchProfile("f1", "codex");
    expect(w.calls).toEqual([{ f: "f1", profile: "codex", resume: false }]);
  });

  test("fast switches leave one session, of the last profile", async () => {
    const w = windows({ slow: true });
    const first = w.manager.start("f1", size);
    w.pending.shift()!();
    await first;
    const toCodex = w.manager.switchProfile("f1", "codex");
    const toClaude = w.manager.switchProfile("f1", "claude");
    for (const release of w.pending.splice(0)) release();
    await Promise.all([toCodex, toClaude]);
    const codex = w.opened.find((x) => x.profile === "codex")!;
    expect(codex.s.active).toBe(false); // stopped on arrival
    expect(w.live("f1").map((x) => x.profile)).toEqual(["claude"]);
    expect(w.manager.active("f1")).toBe(true);
  });

  test("relaunchAll keeps each window's agent", async () => {
    const w = windows();
    await w.manager.start("f1", size);
    await w.manager.start("f2", size);
    await w.manager.switchProfile("f1", "codex");
    w.calls.length = 0;
    await w.manager.relaunchAll();
    expect(w.calls.sort((a, b) => a.f.localeCompare(b.f))).toEqual([
      { f: "f1", profile: "codex", resume: false },
      { f: "f2", profile: "claude", resume: false },
    ]);
  });

  test("Relancer does not resume", async () => {
    const w = windows();
    await w.manager.start("f1", size);
    await w.manager.switchProfile("f1", "codex");
    await w.manager.switchProfile("f1", "claude");
    w.opened.at(-1)!.s.finish(0);
    await w.manager.start("f1", size);
    expect(w.calls.at(-1)).toEqual({ f: "f1", profile: "claude", resume: false });
  });
});

test("a submitted prefill sends Enter apart from its text", async () => {
  vi.useFakeTimers();
  try {
    const { management: manager, sessions } = prepare();
    await manager.start("F", size);
    manager.prefill("F", "[remarques] ", undefined, true);
    expect(sessions[0]!.written).toEqual(["[remarques] "]);
    vi.advanceTimersByTime(SUBMIT_DELAY_MS);
    expect(sessions[0]!.written).toEqual(["[remarques] ", "\r"]);
  } finally {
    vi.useRealTimers();
  }
});

describe("engine change (Réglages › Agents)", () => {
  function withEngine() {
    let engine = "subscription";
    const opens: { profile: string; resume: boolean }[] = [];
    const sessions: FakeSession[] = [];
    const sends: { f: string; channel: string; v: unknown }[] = [];
    const manager = new SessionsAgent({
      open: async (_f, _t, s) => {
        opens.push({ profile: s.profile, resume: s.resume });
        const x = new FakeSession();
        sessions.push(x);
        return x;
      },
      defaultProfile: () => "claude",
      engineOf: () => engine,
      send: (f, channel, v) => sends.push({ f, channel, v }),
    });
    const states = () => sends.filter((e) => e.channel === "state").map((e) => e.v);
    return { manager, opens, sessions, states, setEngine: (e: string) => (engine = e) };
  }

  test("a running session is told once; the same engine tells nothing", async () => {
    const w = withEngine();
    await w.manager.start("F", size);
    w.manager.engineChanged("claude");
    expect(w.states().at(-1)).toEqual({ state: "active" });
    w.setEngine("ollama");
    w.manager.engineChanged("claude");
    w.manager.engineChanged("claude");
    expect(w.states().filter((s) => (s as { engineChanged?: boolean }).engineChanged)).toHaveLength(1);
    // Another profile's change does not concern it.
    w.manager.engineChanged("codex");
    expect(w.states()).toHaveLength(3);
    // The panel reopened: the notice is still there.
    await w.manager.start("F", size);
    expect(w.states().at(-1)).toEqual({ state: "active", engineChanged: true });
  });

  test("relaunch: the old session stops, the new one resumes the conversation without the notice", async () => {
    const w = withEngine();
    await w.manager.start("F", size);
    w.setEngine("ollama");
    w.manager.engineChanged("claude");
    await w.manager.relaunch("F");
    expect(w.sessions[0]!.stopped).toBe(true);
    expect(w.opens).toEqual([{ profile: "claude", resume: false }, { profile: "claude", resume: true }]);
    expect(w.states().at(-1)).toEqual({ state: "active" });
    w.manager.engineChanged("claude");
    expect(w.states().at(-1)).toEqual({ state: "active" });
  });
});
