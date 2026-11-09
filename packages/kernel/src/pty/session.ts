import { spawn, type IPty } from "node-pty";

/** A CLI agent running in a pseudo-terminal (displayed by xterm.js on the UI side). */
export class SessionAgent {
  private actif = true;

  private constructor(
    private readonly pty: IPty,
    /** Stops the agent where it really runs (the container), in addition to the local terminal. */
    private readonly arreterDistant?: () => void | Promise<void>,
  ) {
    pty.onExit(() => {
      this.actif = false;
    });
  }

  static demarrer(
    command: string[],
    o: { cols: number; rows: number; env?: Record<string, string>; arreterDistant?: () => void | Promise<void> },
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
      o.arreterDistant,
    );
  }

  get active(): boolean {
    return this.actif;
  }

  ecrire(data: string): void {
    if (this.actif) this.pty.write(data);
  }

  redimensionner(cols: number, rows: number): void {
    if (this.actif) this.pty.resize(cols, rows);
  }

  surDonnees(callback: (d: string) => void): () => void {
    const subscription = this.pty.onData(callback);
    return () => subscription.dispose();
  }

  surFin(callback: (code: number) => void): () => void {
    const subscription = this.pty.onExit(({ exitCode }) => callback(exitCode));
    return () => subscription.dispose();
  }

  /** Returns once the agent is stopped where it runs (the container), not only the local terminal. */
  async arreter(): Promise<void> {
    if (!this.actif) return;
    const remote = Promise.resolve(this.arreterDistant?.()).catch(() => {});
    this.pty.kill();
    await remote;
  }
}
