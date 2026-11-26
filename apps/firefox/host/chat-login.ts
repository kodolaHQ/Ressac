// The chat's login terminals: the CLI's own sign-in (`claude auth login`, `codex login --device-auth`) in a small PTY of
// the window's panel, over the agent.data / agent.write / agent.resize channel. Not a counted kernel session.
import type { SessionLike } from "../core/agent/sessions.ts";
import type { TerminalSize } from "../shared/api.ts";

/** A sign-in left open this long no longer holds a first session's sweep: it is stopped (as Réglages' sign-in by code). */
export const LOGIN_HOLD_MS = 2 * 60_000;

export function createLoginTerminals(o: {
  open: (program: "claude" | "codex", size: TerminalSize) => Promise<SessionLike>;
  data: (win: string, d: string) => void;
  /** The login ended (signed in, given up or stopped): the window's signed-out discussions try again. */
  ended: (win: string, code: number) => void;
}) {
  const running = new Map<string, { s: SessionLike; done: Promise<void> }>();

  return {
    /** One per window: a new one replaces the old. */
    async start(win: string, program: "claude" | "codex", size: TerminalSize): Promise<void> {
      await running.get(win)?.s.stop();
      const s = await o.open(program, size);
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      running.set(win, { s, done });
      s.onData((d) => o.data(win, d));
      s.onEnd((code) => {
        if (running.get(win)?.s === s) running.delete(win);
        finish();
        o.ended(win, code);
      });
    },
    /** Keys for the window's login, when one runs: never the outflow's (no agent reads them). */
    write(win: string, d: string): boolean {
      const l = running.get(win);
      l?.s.write(d);
      return !!l;
    },
    resize(win: string, t: TerminalSize): boolean {
      const l = running.get(win);
      l?.s.resize(t.cols, t.rows);
      return !!l;
    },
    has: (win: string) => running.has(win),
    /**
     * The sweep before a first agent session kills every process of the agent's user, a sign-in in progress included: it
     * waits for the running ones, at most `maxMs`, then stops what is left.
     */
    async settled(maxMs = LOGIN_HOLD_MS): Promise<void> {
      const now = [...running.values()];
      if (!now.length) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(now.map((l) => l.done)), new Promise((r) => (timer = setTimeout(r, maxMs)))]);
      clearTimeout(timer);
      await Promise.all(now.map((l) => l.s.stop()));
    },
    async stop(win: string): Promise<void> {
      await running.get(win)?.s.stop();
    },
    async stopAll(): Promise<void> {
      await Promise.all([...running.values()].map((l) => l.s.stop()));
    },
  };
}
