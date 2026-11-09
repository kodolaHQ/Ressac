/** What the Applications page says about Docker. */
export type EtatDocker = "ok" | "docker-absent";

/**
 * Docker probe for the Applications page: only one at a time, its result reused during `fraicheurMs`. The list
 * never waits for the probe (`docker info` can take 30 s when Docker starts): `valeur()` returns the last known
 * state and restarts the probe if it has aged; `surChange` is called when the probe finds another state.
 */
export class SondeDocker {
  private connu: EtatDocker = "ok";
  private sondeLe = -Infinity;
  private enCours: Promise<void> | undefined;

  constructor(
    private readonly o: {
      sonder: () => Promise<string>;
      surChange: () => void;
      fraicheurMs?: number;
      maintenant?: () => number;
    },
  ) {}

  valeur(): EtatDocker {
    const maintenant = this.o.maintenant ?? Date.now;
    if (!this.enCours && maintenant() - this.sondeLe >= (this.o.fraicheurMs ?? 5000)) {
      this.enCours = this.o
        .sonder()
        .then(
          (e) => (e === "docker-absent" ? "docker-absent" : "ok") as EtatDocker,
          () => "docker-absent" as const,
        )
        .then((e) => {
          this.sondeLe = maintenant();
          this.enCours = undefined;
          if (e === this.connu) return;
          this.connu = e;
          this.o.surChange();
        });
    }
    return this.connu;
  }
}
