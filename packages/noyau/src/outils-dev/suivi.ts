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
 * Attache les outils de développement aux onglets qui ont au moins un droit, et les détache quand ils n'en ont plus
 * (spec §8) : la collecte console/réseau commence à l'attachement et ses tampons sont vidés au détachement. Un onglet
 * qui garde ses droits sur une autre origine (appli relancée sur un autre port, démo déplacée par l'agent) est
 * rattaché : ses tampons repartent sur la nouvelle page au lieu d'échouer au premier appel.
 */
export class SuiviOutilsDev {
  readonly attaches = new Set<string>();
  /** Origine de chaque onglet au moment où il a été attaché. */
  private readonly origines = new Map<string, string | null>();
  /** Onglets où l'utilisateur a ouvert ses propres outils : l'attachement a échoué. */
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

  /** Une seule réconciliation à la fois ; les changements survenus pendant qu'elle tourne en relancent une seule. */
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
        // Même onglet, autre origine : on repart de la page affichée.
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
