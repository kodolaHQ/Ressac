import type { PolitiqueAcces } from "../acces/politique.js";
import { OutilsDevOccupes, type OngletInfo, type OutilsDevNavigateur } from "../mcp/pont.js";

function origineDe(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/**
 * Attaches the dev tools to the tabs that have at least one right, and detaches them when they no longer have any
 * (spec §8): console/network collection starts at attachment and its buffers are emptied at detachment. A tab
 * that keeps its rights on another origin (app relaunched on another port, demo moved by the agent) is
 * reattached: its buffers restart on the new page instead of failing on the first call.
 */
export class SuiviOutilsDev {
  readonly attaches = new Set<string>();
  /** Origin of each tab when it was attached. */
  private readonly origines = new Map<string, string | null>();
  /** Tabs where the user opened their own tools: the attachment failed. */
  readonly occupes = new Set<string>();
  private file: Promise<void> = Promise.resolve();
  private planifie = false;
  private arrete = false;
  private readonly desabonner: () => void;

  constructor(
    private readonly politique: PolitiqueAcces,
    private readonly outils: OutilsDevNavigateur,
    private readonly onglets: () => Promise<OngletInfo[]>,
  ) {
    this.desabonner = politique.surChange(() => this.planifier());
    this.planifier();
  }

  /** Only one reconciliation at a time; the changes that happen while it runs trigger a single one. */
  private planifier(): void {
    if (this.planifie || this.arrete) return;
    this.planifie = true;
    this.file = this.file
      .then(() => {
        this.planifie = false;
        return this.arrete ? undefined : this.reconcilier();
      })
      .catch(() => {});
  }

  private async reconcilier(): Promise<void> {
    const onglets = (await this.onglets()).filter((o) => this.politique.droitsDev(o).length);
    const voulus = new Map(onglets.map((o) => [o.id, origineDe(o.url)]));
    for (const [id, origine] of voulus) {
      if (this.attaches.has(id)) {
        if (this.origines.get(id) === origine) continue;
        // Same tab, other origin: we restart from the displayed page.
        this.attaches.delete(id);
        this.origines.delete(id);
        await this.outils.detacher(id).catch(() => {});
      }
      try {
        await this.outils.attacher(id);
        this.attaches.add(id);
        this.origines.set(id, origine);
        this.occupes.delete(id);
      } catch (e) {
        if (e instanceof OutilsDevOccupes) this.occupes.add(id);
      }
    }
    for (const id of [...this.attaches]) {
      if (voulus.has(id)) continue;
      this.attaches.delete(id);
      this.origines.delete(id);
      await this.outils.detacher(id).catch(() => {});
    }
    for (const id of [...this.occupes]) if (!voulus.has(id)) this.occupes.delete(id);
  }

  arreter(): void {
    this.arrete = true;
    this.desabonner();
    for (const id of this.attaches) void this.outils.detacher(id).catch(() => {});
    this.attaches.clear();
    this.origines.clear();
    this.occupes.clear();
  }
}
