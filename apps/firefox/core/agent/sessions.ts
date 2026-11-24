import { randomUUID } from "node:crypto";
import { WorkshopError, type BuildProgress, type InstructionChange } from "@ressac/kernel";
import type { AgentPanelState, TerminalSize } from "../../shared/api";
import type { WindowId } from "../../shared/model";

/** Output kept per window, returned when the UI reloads: enough to find the conversation again. */
export const BUFFER_MAX = 200_000;
/** The agent's output goes to the UI in batches: one IPC message per burst, not per pty chunk. */
export const GROUPING_MS = 8;
/** A submitted prefill: the Enter that sends it comes this long after its text. */
export const SUBMIT_DELAY_MS = 150;

/** The last characters of an output, kept in chunks: appending never copies the whole buffer. */
export class SessionBuffer {
  private chunks: string[] = [];
  private length = 0;
  private cut = false;

  constructor(private readonly max: number) {}

  add(d: string): void {
    this.chunks.push(d);
    this.length += d.length;
    while (this.length > this.max) {
      this.cut = true;
      const first = this.chunks[0]!;
      const tooMany = this.length - this.max;
      if (first.length <= tooMany) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.slice(tooMany);
        this.length -= tooMany;
      }
    }
  }

  /** Replaying a cut buffer starts at a whole line: not in the middle of an escape sequence. */
  text(): string {
    const s = this.chunks.join("");
    const line = this.cut ? s.indexOf("\n") : -1;
    return line >= 0 && line < s.length / 10 ? s.slice(line + 1) : s;
  }

  clear(): void {
    this.chunks = [];
    this.length = 0;
    this.cut = false;
  }
}

/** A whole terminal reply (focus, mouse report, device attributes, cursor position, OSC/DCS answer): never the user's key. */
const TERMINAL_REPLY = /^\x1b(?:\[[IO]|\[<[\d;]+[Mm]|\[M[\s\S]{3}|\[[?>][\d;]*c|\[\d+;\d+R|\][\s\S]*|P[\s\S]*)$/;

/** Keys buffered while an agent wakes, as messages: each Enter outside a paste submits the text before it; the rest stays a draft. */
export function messages(keys: string): { text: string; submit?: true }[] {
  const out: { text: string; submit?: true }[] = [];
  let text = "";
  for (const [k] of keys.matchAll(/\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|[\s\S]/g)) {
    if (k !== "\r") text += k;
    else if (text) out.push({ text, submit: true }), (text = "");
  }
  if (text) out.push({ text });
  return out;
}

/** What the manager uses of a kernel SessionAgent. */
export interface SessionLike {
  readonly active: boolean;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  onData(r: (d: string) => void): () => void;
  onEnd(r: (code: number) => void): () => void;
  stop(): void | Promise<void>;
}

interface Entry {
  session?: SessionLike;
  buffer: SessionBuffer;
  /** Output not yet sent to the UI (see GROUPING_MS). */
  toSend: string;
  timer?: NodeJS.Timeout;
  startup?: Promise<void>;
  /** Last terminal size, to reopen the session identically (relancerTout). */
  size: TerminalSize;
  /** Text to put in the input as soon as the session is active (see prefill). */
  prefill?: { text: string; written?: () => void; submit?: boolean };
  /** This window's agent profile, fixed when the entry is made. */
  profile: string;
  /**
   * Profiles whose session was active in this window, with its conversation: switching back to one resumes it. Claude's is
   * resumed by its id (`sent`: it got a message, so Claude keeps it); the others resume their workdir's latest.
   */
  ran: Map<string, { id: string; sent: boolean }>;
  /** The engine (Réglages › Agent) the running session started with: a change applies only to the next session. */
  engine?: string;
  /** The engine changed since this session started: the panel offers to relaunch it. */
  engineChanged?: boolean;
  /** The user typed or pasted, or a text was submitted for them: the conversation (or draft) is someone's, never cut on its own. Ressac's own pre-fill is not. */
  touched?: boolean;
  /** The kernel waits on the user's answer about changed instruction files before this session starts. */
  review?: { id: number; files: InstructionChange[]; resolve: (c: "keep" | "revert") => void; reject: (e: Error) => void };
  /** Last output or input of the running session (Date.now()): what memory pressure measures idleness by. */
  last?: number;
  /** Stopped under memory pressure (sleepIdle): the next input resumes its conversation. */
  asleep?: boolean;
  /** Keys typed since the wake, written once the resumed agent first speaks (its TUI is then up), then while they are delivered. */
  waking?: string;
  /** The buffered keys and pre-fill are being written to the woken agent (deliver). */
  delivering?: boolean;
}

/** One agent session per window (spec §8): it survives tab changes and the panel closing. */
export class SessionsAgent {
  private inputs = new Map<WindowId, Entry>();
  /** Each review gets its own id: a late answer from an older card never settles a newer one. */
  private reviews = 0;

  constructor(
    private readonly o: {
      open: (
        f: WindowId,
        t: TerminalSize,
        s: {
          profile: string;
          resume: boolean;
          /** This window's conversation id for this profile (a new one unless resuming); only Claude uses it. */
          conversation: string;
          onBuildProgress: (p: BuildProgress) => void;
          /** Settles on answerReview, or rejects when the entry is dropped: the kernel never waits forever. */
          review: (changes: InstructionChange[]) => Promise<"keep" | "revert">;
        },
      ) => Promise<SessionLike>;
      /** The profile of a window that has not chosen one. */
      defaultProfile?: () => string;
      send: (f: WindowId, channel: "data" | "state", v: string | AgentPanelState) => void;
      /** The user submits a message (Enter) in this window's terminal. */
      onSend?: (f: WindowId) => void;
      /** The engine a new session of `profile` would use, as a comparable key. */
      engineOf?: (profile: string) => string;
      /** Ressac's own texts (prefills) as written to the window's running session: masked with its table. */
      mask?: (f: WindowId, text: string) => string;
    },
  ) {}

  private entry(f: WindowId, size: TerminalSize, profile = this.profileOf(f), ran: Entry["ran"] = new Map()): Entry {
    let e = this.inputs.get(f);
    if (!e) this.inputs.set(f, (e = { buffer: new SessionBuffer(BUFFER_MAX), toSend: "", size, profile, ran }));
    return e;
  }

  profileOf(f: WindowId): string {
    return this.inputs.get(f)?.profile ?? this.o.defaultProfile?.() ?? "claude";
  }

  /**
   * Idempotent: an active session returns its state and its buffer; otherwise a new session starts.
   * `resume` only applies to this start: Relancer/Réessayer start fresh.
   */
  start(f: WindowId, size: TerminalSize, resume = false): Promise<void> {
    const entry = this.entry(f, size);
    entry.size = size;
    if (entry.asleep) {
      // The panel reloaded: the conversation's last screen and the asleep line, the agent left asleep.
      this.o.send(f, "state", { state: "asleep" });
      const buffer = entry.buffer.text();
      if (buffer) this.o.send(f, "data", buffer);
      return Promise.resolve();
    }
    if (entry.session?.active) {
      entry.session.resize(size.cols, size.rows);
      this.o.send(f, "state", this.activeState(entry));
      // The buffer already contains the pending output: it is not sent a second time.
      this.cancelSend(entry);
      const buffer = entry.buffer.text();
      if (buffer) this.o.send(f, "data", buffer);
      return Promise.resolve();
    }
    if (entry.startup) {
      // The panel reloaded while the review card was up: it shows it again.
      if (entry.review) this.o.send(f, "state", { state: "review", id: entry.review.id, files: entry.review.files });
      return entry.startup;
    }
    entry.buffer.clear();
    this.cancelSend(entry);
    this.o.send(f, "state", { state: "preparing" });
    const was = entry.ran.get(entry.profile);
    // Claude resumes this window's own conversation by id, and only one that got a message: before it, Claude keeps none.
    if (entry.profile === "claude" && !was?.sent) resume = false;
    const conversation = resume && was ? was.id : randomUUID();
    entry.startup = this.o
      .open(f, size, {
        profile: entry.profile,
        resume,
        conversation,
        onBuildProgress: (p) => {
          if (this.inputs.get(f) === entry && !entry.session && !entry.review) this.o.send(f, "state", { state: "preparing", ...p });
        },
        review: (files) =>
          new Promise((resolve, reject) => {
            if (this.inputs.get(f) !== entry) return reject(new Error("closed"));
            entry.review?.reject(new Error("closed"));
            const id = ++this.reviews;
            entry.review = { id, files, resolve, reject };
            this.o.send(f, "state", { state: "review", id, files });
          }),
      })
      .then(
        (s) => {
          // Window closed or agent switched during startup: nobody will display this agent.
          if (this.inputs.get(f) !== entry) return void s.stop();
          entry.session = s;
          entry.ran.set(entry.profile, { id: conversation, sent: resume });
          entry.engine = this.o.engineOf?.(entry.profile);
          entry.engineChanged = false;
          entry.last = Date.now();
          s.onData((d) => {
            entry.last = Date.now();
            entry.buffer.add(d);
            entry.toSend += d;
            entry.timer ??= setTimeout(() => this.sendOutput(f, entry), GROUPING_MS);
            if (entry.waking !== undefined && !entry.delivering && entry.session === s) void this.deliver(f, entry, s);
          });
          s.onEnd((code) => {
            // Session replaced (relancerTout): its end is not that of the displayed conversation.
            if (entry.session !== s) return;
            entry.waking = undefined;
            this.sendOutput(f, entry);
            entry.session = undefined;
            this.o.send(f, "state", { state: "done", code });
          });
          this.o.send(f, "state", { state: "active" });
          // The pre-fill (and the keys typed meanwhile) wait for the agent to speak (deliver): written before its TUI
          // takes the terminal raw, the line discipline turns the submit's \r into \n and the message is never sent.
          if (entry.prefill && entry.waking === undefined) entry.waking = "";
        },
        (err: Error) => {
          // Startup abandoned (window closed, relancerTout): its failure no longer concerns the panel.
          if (this.inputs.get(f) !== entry) return;
          entry.waking = undefined;
          this.o.send(
            f,
            "state",
            err instanceof WorkshopError && err.state === "docker-absent" ? { state: "docker-absent" } : { state: "error", message: err.message },
          );
        },
      )
      .finally(() => (entry.startup = undefined));
    return entry.startup;
  }

  private activeState(e: Entry): AgentPanelState {
    return e.engineChanged ? { state: "active", engineChanged: true } : { state: "active" };
  }

  /** The user's answer on review `id`'s card; nothing unless that review is the one pending in this window. */
  answerReview(f: WindowId, id: number, choice: "keep" | "revert"): void {
    const e = this.inputs.get(f);
    const r = e?.review;
    if (!r || r.id !== id) return;
    e.review = undefined;
    this.o.send(f, "state", { state: "preparing" });
    r.resolve(choice);
  }

  /** The engine of `profile` changed: its running sessions keep the old one until relaunched, the panel says so. */
  engineChanged(profile: string): void {
    for (const [f, e] of this.inputs) {
      if (e.profile !== profile || !e.session?.active || e.engineChanged || e.engine === this.o.engineOf?.(profile)) continue;
      e.engineChanged = true;
      this.o.send(f, "state", this.activeState(e));
    }
  }

  /** Relancer after an engine change: a new session of the same profile, resuming the conversation. */
  async relaunch(f: WindowId): Promise<void> {
    const old = this.inputs.get(f);
    if (!old) return;
    this.inputs.delete(f);
    this.drop(old);
    const e = this.entry(f, old.size, old.profile, old.ran);
    e.touched = old.touched; // the conversation resumes
    await this.start(f, e.size, e.ran.has(e.profile));
  }

  private sendOutput(f: WindowId, e: Entry): void {
    const d = e.toSend;
    this.cancelSend(e);
    if (d && this.inputs.get(f) === e) this.o.send(f, "data", d);
  }

  private cancelSend(e: Entry): void {
    clearTimeout(e.timer);
    e.timer = undefined;
    e.toSend = "";
  }

  /** True while a window's session, running or starting, has the user's input or a text queued to send (see Entry.touched). */
  touched(): boolean {
    return [...this.inputs.values()].some((e) => (e.touched || e.prefill?.submit) && (e.session?.active || e.startup));
  }

  /** The window has an agent entry (started, starting, asleep, or a text waiting for its session). */
  has(f: WindowId): boolean {
    return this.inputs.has(f);
  }

  active(f: WindowId): boolean {
    return this.inputs.get(f)?.session?.active ?? false;
  }

  write(f: WindowId, d: string): void {
    const e = this.inputs.get(f);
    // Keys and pastes are the user's; the terminal's own replies (focus, queries, a click's mouse report) start with ESC.
    const user = !d.startsWith("\x1b") || d.startsWith("\x1b[200~");
    // The terminal's answers to the agent's own startup queries (cursor, colors) reach it even while its input waits.
    if (e?.session?.active && !e.asleep && TERMINAL_REPLY.test(d)) return void e.session.write(d);
    if (e?.asleep || e?.waking !== undefined) {
      // Any input wakes a sleeping agent (an empty write is the panel's click); the terminal's own replies are not kept.
      e.waking = (e.waking ?? "") + (TERMINAL_REPLY.test(d) ? "" : d);
      if (user && d) e.touched = true;
      this.wake(f, e);
      return;
    }
    if (!e?.session) return;
    e.last = Date.now();
    e.session.write(d);
    if (user) e.touched = true;
    if (d.includes("\r")) this.sent(f, e);
  }

  /**
   * Puts a text in the agent's input, sent only when `submit`: right away if the session is active, otherwise as soon as it
   * becomes so (a single pending text per window, the last wins). `ecrit` is called just before writing,
   * session open: an access granted there survives the policy's reset by the session opening.
   */
  prefill(f: WindowId, text: string, written?: () => void, submit = false): void {
    const p = { text: text, ...(written ? { written: written } : {}), ...(submit ? { submit: true } : {}) };
    let e = this.inputs.get(f);
    if (e?.session?.active && e.waking === undefined) return this.writePrefill(f, e.session, p);
    e ??= this.entry(f, { cols: 80, rows: 24 });
    // A sleeping agent wakes for it; the text goes as its own message, before the keys typed meanwhile.
    if (e.asleep) this.wake(f, e);
    const pending = e.prefill;
    // A message waiting to be sent (remarks, a ⌘T question) wins over a mere pre-fill (the panel's context), whose share still runs.
    if (pending?.submit && !submit) {
      const before = pending.written;
      pending.written = () => (before?.(), written?.());
      return;
    }
    e.prefill = p;
  }

  /** `typed`: keys the user typed while the agent woke, written as they are (what is typed is never masked). */
  private writePrefill(f: WindowId, s: SessionLike, p: NonNullable<Entry["prefill"]>, typed = false): void {
    p.written?.();
    // Masked here, not when queued: the window's session (and its label table) exists only once it runs.
    s.write(typed ? p.text : (this.o.mask?.(f, p.text) ?? p.text));
    if (!p.submit) return;
    // Enter apart from the text: in the same write, the agent's TUI takes it as a pasted newline, not a send.
    setTimeout(() => {
      const e = this.inputs.get(f);
      if (e?.session !== s || !s.active) return;
      s.write("\r");
      e.touched = true;
      this.sent(f, e);
    }, SUBMIT_DELAY_MS);
  }

  /** A message went to the agent: its conversation now exists to resume. */
  private sent(f: WindowId, e: Entry): void {
    const c = e.ran.get(e.profile);
    if (c) c.sent = true;
    this.o.onSend?.(f);
  }

  private wake(f: WindowId, e: Entry): void {
    if (!e.asleep) return;
    e.asleep = false;
    e.waking ??= "";
    void this.start(f, e.size, true);
  }

  /** The woken agent spoke: the pre-fill, then the keys typed meanwhile, each submitted line as its own message. */
  private async deliver(f: WindowId, e: Entry, s: SessionLike): Promise<void> {
    e.delivering = true;
    try {
      for (;;) {
        const p = e.prefill;
        e.prefill = undefined;
        const queue = [...(p ? [p] : []), ...messages(e.waking ?? "")];
        e.waking = "";
        if (!queue.length) return;
        for (const m of queue) {
          if (e.session !== s || !s.active) return;
          this.writePrefill(f, s, m, m !== p);
          // Its Enter goes first (writePrefill), then the next message.
          if (m.submit) await new Promise((r) => setTimeout(r, 2 * SUBMIT_DELAY_MS));
        }
      }
    } finally {
      e.delivering = false;
      if (e.session === s) e.waking = undefined;
    }
  }

  /**
   * macOS runs short of memory: every session with no output nor input for `idleMs` stops, as Relancer stops one (its
   * mark leaves the workshop, which can then stop), and its panel says it sleeps. A session working is never touched.
   */
  async sleepIdle(idleMs: number): Promise<void> {
    const now = Date.now();
    // Only Claude resumes by id: another profile resumes its workdir's latest conversation, which may be another window's.
    const alone = (e: Entry) => e.profile === "claude" || [...this.inputs.values()].every((o) => o === e || o.profile !== e.profile);
    const idle = [...this.inputs].filter(([, e]) => e.session?.active && !e.startup && e.waking === undefined && alone(e) && now - (e.last ?? 0) >= idleMs);
    await Promise.all(
      idle.map(([f, e]) => {
        const s = e.session!;
        this.sendOutput(f, e);
        // Taken away first: its end is not shown as the agent stopping.
        e.session = undefined;
        e.asleep = true;
        this.o.send(f, "state", { state: "asleep" });
        return s.stop();
      }),
    );
  }

  resize(f: WindowId, t: TerminalSize): void {
    const e = this.inputs.get(f);
    if (e) e.size = t;
    e?.session?.resize(t.cols, t.rows);
  }

  /** Stops an entry already taken out of the map: a startup still in flight is abandoned when it arrives. */
  private drop(e: Entry): void {
    this.cancelSend(e);
    this.rejectReview(e);
    const s = e.session;
    e.session = undefined;
    void s?.stop();
  }

  private rejectReview(e: Entry): void {
    e.review?.reject(new Error("closed"));
    e.review = undefined;
  }

  /**
   * Every window whose agent runs or is starting gets a new session of the same profile, resuming its conversation (a mode
   * change, a network not applied). A start still in flight is dropped: its session stops when it arrives.
   */
  async relaunchActive(): Promise<void> {
    await Promise.all([...this.inputs].filter(([, e]) => e.session?.active || e.startup).map(([f]) => this.relaunch(f)));
  }

  /** Workshop restart: every window that had an agent gets a new one of its own profile, at the same size, without resuming. */
  async relaunchAll(): Promise<void> {
    // A sleeping agent stays asleep: its next input starts it in the new workshop.
    const olds = [...this.inputs].filter(([, e]) => !e.asleep);
    for (const [f] of olds) this.inputs.delete(f);
    for (const [, e] of olds) this.drop(e);
    // A text queued to send (⌘T, a design remark) waits for the new session.
    await Promise.all(olds.map(([f, e]) => ((this.entry(f, e.size, e.profile, e.ran).prefill = e.prefill), this.start(f, e.size))));
  }

  /** This window only changes agent; switching back to a profile that ran here resumes its last conversation. */
  async switchProfile(f: WindowId, profile: string): Promise<void> {
    if (this.profileOf(f) === profile) return;
    const old = this.inputs.get(f);
    this.inputs.delete(f);
    if (old) this.drop(old);
    const e = this.entry(f, old?.size ?? { cols: 80, rows: 24 }, profile, old?.ran);
    e.touched = old?.touched;
    await this.start(f, e.size, e.ran.has(profile));
  }

  /** Hands control back once the agent is stopped in the container. */
  async closeWindow(f: WindowId): Promise<void> {
    const e = this.inputs.get(f);
    if (e) {
      this.cancelSend(e);
      this.rejectReview(e);
    }
    this.inputs.delete(f);
    await e?.session?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.inputs.keys()].map((f) => this.closeWindow(f)));
  }
}
