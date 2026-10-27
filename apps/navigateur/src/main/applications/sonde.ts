/** Ce que la page Applications dit de Docker. */
export type EtatDocker = "ok" | "docker-absent";

/**
 * Sonde de Docker pour la page Applications : une seule à la fois, son résultat resservi pendant `fraicheurMs`. La liste
 * n'attend jamais la sonde (`docker info` peut prendre 30 s quand Docker démarre) : `valeur()` rend le dernier état
 * connu et relance la sonde s'il a vieilli ; `surChange` est appelé quand la sonde trouve un autre état.
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
