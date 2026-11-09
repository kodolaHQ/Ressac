import { spawn, type IPty } from "node-pty";

/** A CLI agent running in a pseudo-terminal (displayed by xterm.js on the UI side). */
export class SessionAgent {
  private alive = true;

  private constructor(
    private readonly pty: IPty,
    /** Stops the agent where it really runs (the container), in addition to the local terminal. */
    private readonly stopRemote?: () => void | Promise<void>,
  ) {
    pty.onExit(() => {
      this.alive = false;
    });
  }

  static start(
    command: string[],
    o: { cols: number; rows: number; env?: Record<string, string>; stopRemote?: () => void | Promise<void> },
  ): SessionAgent {
    const [file, ...args] = command;
    if (!file) throw new Error("Commande vide");
    return new SessionAgent(
      spawn(file, args, {
        name: "xterm-256color",
        cols: o.cols,
        rows: o.rows,
        env: { ...(process.env as Record<string, string>), ...o.env },
      }),
      o.stopRemote,
    );
  }

  get active(): boolean {
    return this.alive;
  }

  write(data: string): void {
    if (this.alive) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.alive) this.pty.resize(cols, rows);
  }

  onData(callback: (d: string) => void): () => void {
    const subscription = this.pty.onData(callback);
    return () => subscription.dispose();
  }

  onEnd(callback: (code: number) => void): () => void {
    const subscription = this.pty.onExit(({ exitCode }) => callback(exitCode));
    return () => subscription.dispose();
  }

  /** Returns once the agent is stopped where it runs (the container), not only the local terminal. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    const remote = Promise.resolve(this.stopRemote?.()).catch(() => {});
    this.pty.kill();
    await remote;
  }
}
