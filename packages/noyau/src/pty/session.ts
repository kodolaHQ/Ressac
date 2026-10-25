import { spawn, type IPty } from "node-pty";

/** Un agent CLI qui tourne dans un pseudo-terminal (affiché par xterm.js côté interface). */
export class SessionAgent {
  private actif = true;

  private constructor(private readonly pty: IPty) {
    pty.onExit(() => {
      this.actif = false;
    });
  }

  static demarrer(commande: string[], o: { cols: number; rows: number; env?: Record<string, string> }): SessionAgent {
    const [fichier, ...args] = commande;
    if (!fichier) throw new Error("Commande vide");
    return new SessionAgent(
      spawn(fichier, args, {
        name: "xterm-256color",
        cols: o.cols,
        rows: o.rows,
        env: { ...(process.env as Record<string, string>), ...o.env },
      }),
    );
  }

  get active(): boolean {
    return this.actif;
  }

  ecrire(donnees: string): void {
    if (this.actif) this.pty.write(donnees);
  }

  redimensionner(cols: number, rows: number): void {
    if (this.actif) this.pty.resize(cols, rows);
  }

  surDonnees(rappel: (d: string) => void): () => void {
    const abonnement = this.pty.onData(rappel);
    return () => abonnement.dispose();
  }

  surFin(rappel: (code: number) => void): () => void {
    const abonnement = this.pty.onExit(({ exitCode }) => rappel(exitCode));
    return () => abonnement.dispose();
  }

  arreter(): void {
    if (this.actif) this.pty.kill();
  }
}
