/** What the Applications page says about Docker. */
export type DockerState = "ok" | "docker-absent";

/**
 * Docker probe for the Applications page: only one at a time, its result reused during `fraicheurMs`. The list
 * never waits for the probe (`docker info` can take 30 s when Docker starts): `valeur()` returns the last known
 * state and restarts the probe if it has aged; `surChange` is called when the probe finds another state.
 */
export class DockerProbe {
  private known: DockerState = "ok";
  private probedAt = -Infinity;
  private running: Promise<void> | undefined;

  constructor(
    private readonly o: {
      probe: () => Promise<string>;
      onChange: () => void;
      freshnessMs?: number;
      now?: () => number;
    },
  ) {}

  value(): DockerState {
    const now = this.o.now ?? Date.now;
    if (!this.running && now() - this.probedAt >= (this.o.freshnessMs ?? 5000)) {
      this.running = this.o
        .probe()
        .then(
          (e) => (e === "docker-absent" ? "docker-absent" : "ok") as DockerState,
          () => "docker-absent" as const,
        )
        .then((e) => {
          this.probedAt = now();
          this.running = undefined;
          if (e === this.known) return;
          this.known = e;
          this.o.onChange();
        });
    }
    return this.known;
  }
}
