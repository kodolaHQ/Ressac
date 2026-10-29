import type { Execution, ResumeExecution } from "@webaios/noyau";
import type { ApiWebaios } from "../../commun/api";

export type SourceExecutions = Pick<ApiWebaios["accueil"], "executions" | "execution">;

const memeJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Les exécutions du widget dans le constructeur et celle qui est choisie (pastilles, onglet « Bloc ») : par défaut la
 * dernière vraie exécution (pas un essai). Choisir n'écrit rien.
 */
export class Executions {
  liste = $state.raw<ResumeExecution[]>([]);
  /** Choix de l'utilisateur ; null : la dernière vraie exécution. */
  voulue = $state<string | null>(null);
  /** L'exécution choisie complète (sorties, journaux) ; null tant qu'elle n'est pas lue ou s'il n'y en a pas. */
  detail = $state.raw<Execution | null>(null);
  readonly choisie: ResumeExecution | null = $derived(
    (this.voulue === null ? undefined : this.liste.find((e) => e.id === this.voulue)) ?? this.liste.find((e) => !e.essai) ?? null,
  );
  private requeteListe = 0;
  private requeteDetail = 0;

  constructor(
    readonly widget: string,
    private readonly source: SourceExecutions,
  ) {}

  /** Relit la liste (à l'ouverture et à chaque changement de l'accueil) ; une exécution choisie disparue est oubliée. */
  async charger(): Promise<void> {
    const n = ++this.requeteListe;
    const l = await this.source.executions(this.widget);
    if (n !== this.requeteListe) return;
    if (!memeJson(l, this.liste)) this.liste = l;
    if (this.voulue !== null && !l.some((e) => e.id === this.voulue)) this.voulue = null;
    await this.chargerDetail();
  }

  async choisir(id: string | null): Promise<void> {
    this.voulue = id;
    await this.chargerDetail();
  }

  private async chargerDetail(): Promise<void> {
    const r = this.choisie;
    const n = ++this.requeteDetail;
    if (!r) {
      this.detail = null;
      return;
    }
    // Déjà lue et inchangée (même fin, même statut) : rien à redemander.
    const d = this.detail;
    if (d && d.id === r.id && d.fin === r.fin && d.statut === r.statut) return;
    const e = await this.source.execution(this.widget, r.id);
    if (n !== this.requeteDetail) return;
    this.detail = e;
  }
}
