import { describe, expect, test, vi } from "vitest";
import { WorkshopError } from "@ressac/kernel";
import { Masker } from "../../../../packages/kernel/src/index.ts";
import { GROUPING_MS, SUBMIT_DELAY_MS, SessionsAgent, BUFFER_MAX, SessionBuffer, messages, type SessionLike } from "../../core/agent/sessions";

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

test("prefill before the start writes once the started agent speaks, not before (its TUI would not take the terminal raw yet)", async () => {
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
  expect(session.written).toEqual([]);
  session.emit("agent> ");
  // The last text wins; access is given at write time, session open; nothing is sent.
  expect(session.written).toEqual(["[contexte] "]);
  expect(written).toEqual(["accès avant : 0"]);
  expect(messages).toEqual([]);
});

test("while a first start's pre-fill waits, the terminal's replies to the agent's queries still reach it", async () => {
  const { management: manager, sessions } = prepare();
  manager.prefill("F", "[remarques] ", undefined, true);
  await manager.start("F", size);
  manager.write("F", "\x1b[12;1R");
  expect(sessions[0]!.written).toEqual(["\x1b[12;1R"]);
});

test("a pending message to send (remarks, a ⌘T question) is not replaced by the panel's context; the context's tab share still runs", async () => {
  let open!: (s: SessionLike) => void;
  const session = new FakeSession();
  const { management: manager } = prepare(() => new Promise((r) => (open = r)));
  const shared: string[] = [];
  manager.prefill("F", "[remarques] ", () => shared.push("remarques"), true);
  manager.prefill("F", "[contexte] ", () => shared.push("onglet"));
  const startup = manager.start("F", size);
  open(session);
  await startup;
  session.emit("agent> ");
  expect(session.written[0]).toBe("[remarques] ");
  expect(shared).toEqual(["remarques", "onglet"]);
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

test("a prefill is written masked with the window's own session table, at write time; keys typed meanwhile are not", async () => {
  vi.useFakeTimers();
  try {
    const masker = new Masker();
    const sessions: FakeSession[] = [];
    let opened = 0;
    const manager = new SessionsAgent({
      open: async (f) => {
        // As the kernel does: the window's session table opens with its session.
        masker.open(`s${++opened}`, f);
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      send: () => {},
      mask: (f, text) => masker.maskTyped(f, text).text,
    });
    const iban = "FR76 3000 6000 " + "0112 3456 7890 189";
    manager.prefill("F", `mon IBAN ${iban}`, undefined, true);
    await manager.start("F", size);
    manager.write("F", `tape ${iban}`);
    sessions[0]!.emit("ready");
    await vi.advanceTimersByTimeAsync(2 * SUBMIT_DELAY_MS);
    const [first, enter, typed] = sessions[0]!.written;
    const label = first!.match(/⟨iban-[a-z0-9]{8}⟩/)?.[0];
    expect(first).toBe(`mon IBAN ${label}`);
    expect(masker.lookupForUser("F", label!)?.value).toBe(iban);
    expect([enter, typed]).toEqual(["\r", `tape ${iban}`]);
    // An active session: written masked right away.
    manager.prefill("F", `encore ${iban}`);
    expect(sessions[0]!.written.at(-1)).toBe(`encore ${label}`);
  } finally {
    vi.useRealTimers();
  }
});

test("without a masker a prefill is written as it is", async () => {
  const { management: manager, sessions } = prepare();
  await manager.start("F", size);
  manager.prefill("F", "FR76 3000 6000 " + "0112 3456 7890 189");
  expect(sessions[0]!.written).toEqual(["FR76 3000 6000 0112 3456 7890 189"]);
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

test("a discussion handed to the terminal is resumed by its conversation at the next start only", async () => {
  const opened: { profile: string; resume: boolean; conversation: string }[] = [];
  const manager = new SessionsAgent({
    open: async (_f, _t, s) => {
      opened.push({ profile: s.profile, resume: s.resume, conversation: s.conversation });
      return new FakeSession();
    },
    send: () => {},
  });
  await manager.start("F", size);
  manager.resumeNext("F", "claude", "33333333-3333-4333-8333-333333333333");
  await manager.start("F", size);
  expect(opened[1]).toEqual({ profile: "claude", resume: true, conversation: "33333333-3333-4333-8333-333333333333" });
  await manager.closeWindow("F");
  await manager.start("F", size);
  expect(opened[2]!.resume).toBe(false);
});

test("a Codex discussion handed to the terminal resumes its own thread and model, kept across a wake, gone with a profile switch", async () => {
  const opened: { profile: string; resume: boolean; thread?: string; model?: string }[] = [];
  const manager = new SessionsAgent({
    open: async (_f, _t, s) => {
      opened.push({ profile: s.profile, resume: s.resume, ...(s.thread ? { thread: s.thread } : {}), ...(s.model ? { model: s.model } : {}) });
      return new FakeSession();
    },
    send: () => {},
  });
  manager.resumeNext("F", "codex", "thread-1", "gpt-5.4");
  await manager.start("F", size);
  expect(opened[0]).toEqual({ profile: "codex", resume: true, thread: "thread-1", model: "gpt-5.4" });
  await manager.sleepIdle(0);
  manager.write("F", "x");
  await new Promise((r) => setTimeout(r, 0));
  expect(opened[1]).toEqual({ profile: "codex", resume: true, thread: "thread-1", model: "gpt-5.4" });
  await manager.switchProfile("F", "claude");
  await manager.switchProfile("F", "codex");
  expect(opened.at(-1)).toEqual({ profile: "codex", resume: true });
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
    w.manager.write("f1", "hi\r");
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

describe("engine change (Réglages › Agent)", () => {
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
    w.manager.write("F", "hi\r");
    w.setEngine("ollama");
    w.manager.engineChanged("claude");
    await w.manager.relaunch("F");
    expect(w.sessions[0]!.stopped).toBe(true);
    expect(w.opens).toEqual([{ profile: "claude", resume: false }, { profile: "claude", resume: true }]);
    expect(w.states().at(-1)).toEqual({ state: "active" });
    w.manager.engineChanged("claude");
    expect(w.states().at(-1)).toEqual({ state: "active" });
  });

  test("relaunchActive: every running session, whatever its profile, starts again and resumes; an ended one does not", async () => {
    const w = withEngine();
    await w.manager.start("F", size);
    w.manager.write("F", "hi\r");
    await w.manager.switchProfile("G", "mine");
    await w.manager.start("H", size);
    w.sessions[2]!.finish(0);
    await w.manager.relaunchActive();
    expect(w.sessions.slice(0, 2).map((s) => s.stopped)).toEqual([true, true]);
    expect(w.opens.slice(3)).toEqual([{ profile: "claude", resume: true }, { profile: "mine", resume: true }]);
  });

  test("relaunchActive: a session still starting is relaunched too, and the one it was starting stops on arrival", async () => {
    let release!: (s: FakeSession) => void;
    const opens: boolean[] = [];
    const late = new FakeSession();
    const manager = new SessionsAgent({
      open: (_f, _t, s) => (opens.push(s.resume), opens.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve(new FakeSession())),
      defaultProfile: () => "claude",
      send: () => {},
    });
    const first = manager.start("F", size);
    await new Promise((r) => setTimeout(r, 0));
    const relaunched = manager.relaunchActive();
    release(late);
    await Promise.all([first, relaunched]);
    expect(opens).toHaveLength(2);
    expect(late.stopped).toBe(true);
    expect(manager.active("F")).toBe(true);
  });
});

test("touched: a session the user typed or pasted in, or that has a text queued to send; not the terminal's replies nor Ressac's own pre-fill; kept by Relancer, not by a workshop restart", async () => {
  const { management: manager } = prepare();
  await manager.start("F", size);
  await manager.start("G", size);
  manager.write("F", "\x1b[I"); // the terminal's own replies (focus, queries) are not the user's
  manager.write("F", "\x1b[?1;2c");
  expect(manager.touched()).toBe(false);
  manager.write("F", "bonj"); // a draft: lost if the session restarted
  expect(manager.touched()).toBe(true);
  await manager.relaunch("F");
  expect(manager.touched()).toBe(true);
  await manager.relaunchAll();
  expect(manager.touched()).toBe(false);
  manager.write("F", "\x1b[200~collé\x1b[201~"); // a paste
  expect(manager.touched()).toBe(true);
  await manager.closeWindow("F");
  manager.prefill("G", "[contexte : Page A] ");
  expect(manager.touched()).toBe(false);
  vi.useFakeTimers();
  manager.prefill("G", "résume la page", undefined, true);
  vi.advanceTimersByTime(SUBMIT_DELAY_MS);
  vi.useRealTimers();
  expect(manager.touched()).toBe(true);
  await manager.closeWindow("G");
  expect(manager.touched()).toBe(false);
});

test("touched: a text queued to send on a session still starting counts, and survives a workshop restart", async () => {
  let release: (s: SessionLike) => void = () => {};
  const { management: manager } = prepare(() => new Promise<SessionLike>((r) => (release = r)));
  void manager.start("F", size);
  manager.prefill("F", "question ⌘T", undefined, true);
  expect(manager.touched()).toBe(true);
  void manager.relaunchAll();
  expect(manager.touched()).toBe(true);
  release(new FakeSession());
});


describe("instruction review before a session", () => {
  const files = [{ path: "/workspace/AGENTS.md", status: "changed" as const, lines: [{ kind: "+" as const, text: "x" }] }];
  /** `open` asks for a review before returning its session, like the kernel on changed instruction files. */
  function reviewing() {
    const answers: (string | Error)[] = [];
    const sessions: FakeSession[] = [];
    const sends: { f: string; channel: string; v: unknown }[] = [];
    const manager = new SessionsAgent({
      open: async (_f, _t, s) => {
        try {
          answers.push(await s.review(files));
        } catch (err) {
          answers.push(err as Error);
          throw err;
        }
        const x = new FakeSession();
        sessions.push(x);
        return x;
      },
      defaultProfile: () => "claude",
      send: (f, channel, v) => sends.push({ f, channel, v }),
    });
    const states = () => sends.filter((e) => e.channel === "state").map((e) => e.v);
    return { manager, answers, sessions, states };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** The id of the last review shown. */
  const lastId = (w: ReturnType<typeof reviewing>) => (w.states().findLast((s) => (s as { state: string }).state === "review") as { id: number }).id;

  test("a review sends the review state and resolves on answerReview, then preparing", async () => {
    const w = reviewing();
    const started = w.manager.start("F", size);
    await tick();
    expect(w.states()).toEqual([{ state: "preparing" }, { state: "review", id: expect.any(Number), files }]);
    w.manager.answerReview("F", lastId(w), "revert");
    await started;
    expect(w.answers).toEqual(["revert"]);
    expect(w.states().slice(2)).toEqual([{ state: "preparing" }, { state: "active" }]);
    expect(w.manager.active("F")).toBe(true);
  });

  for (const [name, leave] of [
    ["closeWindow", (m: SessionsAgent) => m.closeWindow("F")],
    ["switchProfile", (m: SessionsAgent) => m.switchProfile("F", "mine")],
    ["relaunch", (m: SessionsAgent) => m.relaunch("F")],
    ["relaunchAll", (m: SessionsAgent) => m.relaunchAll()],
    ["stopAll", (m: SessionsAgent) => m.stopAll()],
  ] as const) {
    test(`a review pending when the window is left (${name}) rejects and no session starts from it`, async () => {
      const w = reviewing();
      const started = w.manager.start("F", size);
      await tick();
      expect(w.states().at(-1)).toEqual({ state: "review", id: expect.any(Number), files });
      void leave(w.manager);
      await started;
      expect(w.answers[0]).toEqual(new Error("closed"));
      expect(w.sessions).toHaveLength(0);
    });
  }

  test("answerReview for a window without a pending review does nothing", async () => {
    const w = reviewing();
    w.manager.answerReview("F", 1, "keep");
    const started = w.manager.start("F", size);
    await tick();
    w.manager.answerReview("G", lastId(w), "keep");
    expect(w.answers).toEqual([]);
    w.manager.answerReview("F", lastId(w), "keep");
    w.manager.answerReview("F", lastId(w), "revert");
    await started;
    expect(w.answers).toEqual(["keep"]);
  });

  test("start while a review is pending re-sends the review state", async () => {
    const w = reviewing();
    const started = w.manager.start("F", size);
    await tick();
    void w.manager.start("F", size);
    expect(w.states().at(-1)).toEqual({ state: "review", id: expect.any(Number), files });
    w.manager.answerReview("F", lastId(w), "keep");
    await started;
  });

  test("an answer with the previous review's id leaves the new review pending", async () => {
    const w = reviewing();
    const first = w.manager.start("F", size);
    await tick();
    const old = lastId(w);
    void w.manager.relaunch("F"); // the old card is rejected, a new review shows
    await first;
    await tick();
    expect(lastId(w)).not.toBe(old);
    w.manager.answerReview("F", old, "keep");
    expect(w.answers).toEqual([new Error("closed")]);
    expect(w.states().at(-1)).toEqual({ state: "review", id: lastId(w), files });
    w.manager.answerReview("F", lastId(w), "revert");
    await tick();
    expect(w.answers).toEqual([new Error("closed"), "revert"]);
  });
});

describe("memory pressure: idle sessions sleep", () => {
  function sleepy(defaultProfile = "claude") {
    const opens: boolean[] = [];
    const conversations: string[] = [];
    const sessions: FakeSession[] = [];
    const p = prepare();
    // Records the `resume` of each start.
    const manager = new SessionsAgent({
      defaultProfile: () => defaultProfile,
      open: async (_f, _t, o) => {
        opens.push(o.resume);
        conversations.push(o.conversation);
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
      send: (f, channel, v) => p.sends.push({ f, channel, v }),
      onSend: (f) => p.messages.push(f),
    });
    return { ...p, management: manager, sessions, opens, conversations };
  }

  test("a session quiet for the given time is stopped and shown asleep; a working one is untouched", async () => {
    vi.useFakeTimers();
    try {
      const { management: manager, sessions, states } = sleepy();
      await manager.start("F", size);
      await manager.start("G", size);
      vi.advanceTimersByTime(60_000);
      sessions[1]!.emit("still working");
      vi.advanceTimersByTime(60_000);
      await manager.sleepIdle(120_000);
      expect(sessions[0]!.stopped).toBe(true);
      expect(sessions[1]!.stopped).toBe(false);
      expect(states("F").at(-1)).toEqual({ state: "asleep" });
      expect(states("G").at(-1)).toEqual({ state: "active" });
      expect(manager.active("F")).toBe(false);
      // Its end, which the stop causes, is not shown as the agent stopping.
      sessions[0]!.finish(0);
      expect(states("F").at(-1)).toEqual({ state: "asleep" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("user input counts as activity", async () => {
    vi.useFakeTimers();
    try {
      const { management: manager, sessions } = sleepy();
      await manager.start("F", size);
      vi.advanceTimersByTime(119_000);
      manager.write("F", "a");
      vi.advanceTimersByTime(119_000);
      await manager.sleepIdle(120_000);
      expect(sessions[0]!.stopped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the panel reloading shows the asleep screen again, without waking the agent", async () => {
    const { management: manager, sessions, sends, states } = sleepy();
    await manager.start("F", size);
    sessions[0]!.emit("conversation");
    await new Promise((r) => setTimeout(r, GROUPING_MS * 3));
    await manager.sleepIdle(0);
    sends.length = 0;
    await manager.start("F", size);
    expect(sessions).toHaveLength(1);
    expect(states()).toEqual([{ state: "asleep" }]);
    expect(sends.filter((e) => e.channel === "data").map((e) => e.v)).toEqual(["conversation"]);
  });

  test("the next key resumes the conversation; the keys typed meanwhile reach the agent once it speaks", async () => {
    vi.useFakeTimers();
    try {
      const { management: manager, sessions, opens, states, messages, conversations } = sleepy();
      await manager.start("F", size);
      manager.write("F", "first\r");
      messages.length = 0;
      await manager.sleepIdle(0);
      manager.write("F", "h");
      manager.write("F", "\x1b[<0;3;4M"); // a click's mouse report: wakes, never typed
      manager.write("F", "i\r");
      await vi.advanceTimersByTimeAsync(0);
      expect(opens).toEqual([false, true]);
      // Its own conversation, by id.
      expect(conversations[1]).toBe(conversations[0]);
      expect(states().slice(-2)).toEqual([{ state: "preparing" }, { state: "active" }]);
      const s = sessions[1]!;
      expect(s.written).toEqual([]);
      s.emit("resumed> ");
      expect(s.written).toEqual(["hi"]);
      // Enter apart, as a submitted pre-fill.
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      expect(s.written).toEqual(["hi", "\r"]);
      expect(messages).toEqual(["F"]);
      await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
      manager.write("F", "x");
      expect(s.written.at(-1)).toBe("x");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a click alone wakes the agent", async () => {
    const { management: manager, sessions, opens } = sleepy();
    await manager.start("F", size);
    manager.write("F", "hi\r");
    await manager.sleepIdle(0);
    manager.write("F", "");
    await new Promise((r) => setTimeout(r, 0));
    expect(opens).toEqual([false, true]);
    sessions[1]!.emit("ready");
    expect(sessions[1]!.written).toEqual([]);
  });

  test("a conversation that never got a message wakes as a new one (Claude kept none to resume)", async () => {
    const { management: manager, opens, conversations } = sleepy();
    await manager.start("F", size);
    await manager.sleepIdle(0);
    manager.write("F", "a");
    await new Promise((r) => setTimeout(r, 0));
    expect(opens).toEqual([false, false]);
    expect(conversations[1]).not.toBe(conversations[0]);
  });

  test("a pre-fill wakes the agent and goes as its own message, before the keys typed meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const { management: manager, sessions, opens } = sleepy();
      await manager.start("F", size);
      manager.write("F", "hi\r");
      await manager.sleepIdle(0);
      manager.prefill("F", "[question]", undefined, true);
      manager.write("F", "draft");
      await vi.advanceTimersByTimeAsync(0);
      expect(opens).toEqual([false, true]);
      const s = sessions[1]!;
      expect(s.written).toEqual([]);
      s.emit("ready");
      expect(s.written).toEqual(["[question]"]);
      await vi.advanceTimersByTimeAsync(2 * SUBMIT_DELAY_MS);
      expect(s.written).toEqual(["[question]", "\r", "draft"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("buffered keys: the user's escape keys stay, the terminal's replies go, each Enter submits its own line", async () => {
    vi.useFakeTimers();
    try {
      const { management: manager, sessions } = sleepy();
      await manager.start("F", size);
      manager.write("F", "hi\r");
      await manager.sleepIdle(0);
      for (const d of ["one", "\x1b[I", "\x1b[<0;3;4M", "\x1b[?1;2c", "\x1b[12;40R", "\r", "\x1b[D", "two", "\r"]) manager.write("F", d);
      await vi.advanceTimersByTimeAsync(0);
      const s = sessions[1]!;
      s.emit("ready");
      await vi.advanceTimersByTimeAsync(4 * SUBMIT_DELAY_MS);
      expect(s.written).toEqual(["one", "\r", "\x1b[Dtwo", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an Enter inside a paste does not submit", () => {
    expect(messages("\x1b[200~a\rb\x1b[201~\rc")).toEqual([{ text: "\x1b[200~a\rb\x1b[201~", submit: true }, { text: "c" }]);
  });

  test("a woken agent that ends before speaking drops the keys", async () => {
    const { management: manager, sessions } = sleepy();
    await manager.start("F", size);
    manager.write("F", "hi\r");
    await manager.sleepIdle(0);
    manager.write("F", "x");
    await new Promise((r) => setTimeout(r, 0));
    sessions[1]!.finish(1);
    await manager.start("F", size);
    sessions[2]!.emit("ready");
    expect(sessions[2]!.written).toEqual([]);
  });

  test("a workshop restart leaves a sleeping agent asleep", async () => {
    const { management: manager, sessions, states } = sleepy();
    await manager.start("F", size);
    await manager.sleepIdle(0);
    await manager.relaunchAll();
    expect(sessions).toHaveLength(1);
    expect(states().at(-1)).toEqual({ state: "asleep" });
  });

  test("Codex, which resumes its workdir's latest, sleeps only when no other window runs Codex", async () => {
    const { management: manager, sessions } = sleepy("codex");
    await manager.start("F", size);
    await manager.start("G", size);
    await manager.sleepIdle(0);
    expect(sessions.map((s) => s.stopped)).toEqual([false, false]);
    await manager.closeWindow("G");
    await manager.sleepIdle(0);
    expect(sessions[0]!.stopped).toBe(true);
  });
});
