import { WorkshopError } from "@webaios/kernel";
import type { AgentPanelState, TerminalSize } from "../../shared/api";
import type { WindowId } from "../../shared/model";

/** Output kept per window, returned when the UI reloads: enough to find the conversation again. */
export const BUFFER_MAX = 200_000;
/** The agent's output goes to the UI in batches: one IPC message per burst, not per pty chunk. */
export const GROUPING_MS = 8;

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
  prefill?: { text: string; written?: () => void };
  /** This window's agent profile, fixed when the entry is made. */
  profile: string;
  /** Profiles whose session was active in this window: switching back to one resumes its conversation. */
  ran: Set<string>;
}

/** One agent session per window (spec §8): it survives tab changes and the panel closing. */
export class SessionsAgent {
  private inputs = new Map<WindowId, Entry>();

  constructor(
    private readonly o: {
      open: (f: WindowId, t: TerminalSize, s: { profile: string; resume: boolean }) => Promise<SessionLike>;
      /** The profile of a window that has not chosen one. */
      defaultProfile?: () => string;
      send: (f: WindowId, channel: "data" | "state", v: string | AgentPanelState) => void;
      /** The user submits a message (Enter) in this window's terminal. */
      onSend?: (f: WindowId) => void;
    },
  ) {}

  private entry(f: WindowId, size: TerminalSize, profile = this.profileOf(f), ran = new Set<string>()): Entry {
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
    if (entry.session?.active) {
      entry.session.resize(size.cols, size.rows);
      this.o.send(f, "state", { state: "active" });
      // The buffer already contains the pending output: it is not sent a second time.
      this.cancelSend(entry);
      const buffer = entry.buffer.text();
      if (buffer) this.o.send(f, "data", buffer);
      return Promise.resolve();
    }
    if (entry.startup) return entry.startup;
    entry.buffer.clear();
    this.cancelSend(entry);
    this.o.send(f, "state", { state: "preparing" });
    entry.startup = this.o
      .open(f, size, { profile: entry.profile, resume })
      .then(
        (s) => {
          // Window closed or agent switched during startup: nobody will display this agent.
          if (this.inputs.get(f) !== entry) return void s.stop();
          entry.session = s;
          entry.ran.add(entry.profile);
          s.onData((d) => {
            entry.buffer.add(d);
            entry.toSend += d;
            entry.timer ??= setTimeout(() => this.sendOutput(f, entry), GROUPING_MS);
          });
          s.onEnd((code) => {
            // Session replaced (relancerTout): its end is not that of the displayed conversation.
            if (entry.session !== s) return;
            this.sendOutput(f, entry);
            entry.session = undefined;
            this.o.send(f, "state", { state: "done", code });
          });
          this.o.send(f, "state", { state: "active" });
          const p = entry.prefill;
          entry.prefill = undefined;
          if (p) this.writePrefill(s, p.text, p.written);
        },
        (err: Error) => {
          // Startup abandoned (window closed, relancerTout): its failure no longer concerns the panel.
          if (this.inputs.get(f) !== entry) return;
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

  active(f: WindowId): boolean {
    return this.inputs.get(f)?.session?.active ?? false;
  }

  write(f: WindowId, d: string): void {
    const session = this.inputs.get(f)?.session;
    if (!session) return;
    session.write(d);
    if (d.includes("\r")) this.o.onSend?.(f);
  }

  /**
   * Puts a text in the agent's input, without sending it: right away if the session is active, otherwise as soon as it
   * becomes so (a single pending text per window, the last wins). `ecrit` is called just before writing,
   * session open: an access granted there survives the policy's reset by the session opening.
   */
  prefill(f: WindowId, text: string, written?: () => void): void {
    let e = this.inputs.get(f);
    if (e?.session?.active) return this.writePrefill(e.session, text, written);
    e ??= this.entry(f, { cols: 80, rows: 24 });
    e.prefill = { text: text, ...(written ? { written: written } : {}) };
  }

  private writePrefill(s: SessionLike, text: string, written?: () => void): void {
    written?.();
    s.write(text);
  }

  resize(f: WindowId, t: TerminalSize): void {
    const e = this.inputs.get(f);
    if (e) e.size = t;
    e?.session?.resize(t.cols, t.rows);
  }

  /** Stops an entry already taken out of the map: a startup still in flight is abandoned when it arrives. */
  private drop(e: Entry): void {
    this.cancelSend(e);
    const s = e.session;
    e.session = undefined;
    void s?.stop();
  }

  /** Workshop restart: every window that had an agent gets a new one of its own profile, at the same size, without resuming. */
  async relaunchAll(): Promise<void> {
    const olds = [...this.inputs];
    this.inputs.clear();
    for (const [, e] of olds) this.drop(e);
    await Promise.all(olds.map(([f, e]) => (this.entry(f, e.size, e.profile, e.ran), this.start(f, e.size))));
  }

  /** This window only changes agent; switching back to a profile that ran here resumes its last conversation. */
  async switchProfile(f: WindowId, profile: string): Promise<void> {
    if (this.profileOf(f) === profile) return;
    const old = this.inputs.get(f);
    this.inputs.delete(f);
    if (old) this.drop(old);
    const e = this.entry(f, old?.size ?? { cols: 80, rows: 24 }, profile, old?.ran);
    await this.start(f, e.size, e.ran.has(profile));
  }

  /** Hands control back once the agent is stopped in the container. */
  async closeWindow(f: WindowId): Promise<void> {
    const e = this.inputs.get(f);
    if (e) this.cancelSend(e);
    this.inputs.delete(f);
    await e?.session?.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.inputs.keys()].map((f) => this.closeWindow(f)));
  }
}
