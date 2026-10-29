import type { DirectWidget, EtatDirect, Execution, ResumeExecution } from "@webaios/noyau";
import type { ApiWebaios } from "../../commun/api";

export type SourceExecutions = Pick<ApiWebaios["accueil"], "executions" | "execution">;
/** « ▶ Lancer », « Rejouer depuis ce bloc » et le suivi en direct. */
export type Lanceur = Pick<ApiWebaios["workflow"], "lancer" | "rejouer" | "direct" | "surDirect">;

/** Le préfixe des refus du noyau, repris pour une demande qui échoue en route. */
const PREFIXE_REJEU = "Rejeu impossible : ";

const memeJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Le choix de l'utilisateur, par widget et par fenêtre : changer d'onglet ne le perd pas. */
const choix = new Map<string, string>();

/** Oublie le choix des widgets qui ne sont plus sur l'accueil. */
export function oublierChoixExecutions(presents: Iterable<string>): void {
  const ids = new Set(presents);
  for (const id of [...choix.keys()]) if (!ids.has(id)) choix.delete(id);
}

/**
 * Les exécutions du widget dans le constructeur et celle qui est choisie (pastilles, onglet « Bloc », aperçu) : par
 * défaut la dernière vraie exécution (pas un essai) ; après « Lancer », la nouvelle ; après « Rejouer », l'essai. Choisir
 * n'écrit rien.
 */
export class Executions {
  liste = $state.raw<ResumeExecution[]>([]);
  /** Choix de l'utilisateur ; null : la dernière vraie exécution. */
  voulue = $state<string | null>(null);
  /** L'exécution choisie complète (sorties, journaux) ; null tant qu'elle n'est pas lue ou s'il n'y en a pas. */
  detail = $state.raw<Execution | null>(null);
  /** L'exécution choisie n'a pas pu être lue (chassée entre la liste et le détail, ou erreur). */
  introuvable = $state(false);
  /** Ce qui tourne en ce moment (tous widgets confondus, une exécution par voie) et ce qui attend dans les files. */
  direct = $state.raw<EtatDirect>({ courants: [], enAttente: [] });
  /** Le dernier refus de « Rejouer », en texte. */
  refus = $state<string | null>(null);
  /** Une demande « Lancer » ou « Rejouer » de ce constructeur n'a pas encore répondu. */
  private demande = $state(false);
  readonly choisie: ResumeExecution | null = $derived(
    (this.voulue === null ? undefined : this.liste.find((e) => e.id === this.voulue)) ?? this.liste.find((e) => !e.essai) ?? null,
  );
  /** L'exécution (ou l'essai) de ce widget qui tourne en ce moment. */
  readonly enDirect: DirectWidget | null = $derived.by(() => this.direct.courants.find((c) => c.widget === this.widget) ?? null);
  /** Une seule exécution à la fois par widget : « Lancer » et « Rejouer » attendent. */
  readonly occupe: boolean = $derived.by(() => this.demande || this.enDirect !== null || this.direct.enAttente.includes(this.widget));
  private requeteListe = 0;
  private requeteDetail = 0;

  constructor(
    readonly widget: string,
    private readonly source: SourceExecutions,
    private readonly lanceur?: Lanceur,
  ) {
    this.voulue = choix.get(widget) ?? null;
  }

  /** Relit la liste (à l'ouverture et à chaque changement de l'accueil) ; une exécution choisie disparue est oubliée. */
  async charger(): Promise<void> {
    return this.chargerListe(true);
  }

  /** Suit l'état en direct ; rend de quoi arrêter. */
  suivre(): () => void {
    if (!this.lanceur) return () => {};
    let fini = false;
    // Un événement poussé est plus récent que la lecture initiale : celle-ci ne l'écrase jamais.
    let recu = false;
    const fin = this.lanceur.surDirect((e) => {
      recu = true;
      this.appliquerDirect(e);
    });
    void this.lanceur
      .direct()
      .then((e) => !fini && !recu && this.appliquerDirect(e))
      .catch(() => {});
    return () => {
      fini = true;
      fin();
    };
  }

  /**
   * Les blocs non finis ne sont pas relayés à la fin d'une exécution : quand celle de ce widget s'arrête (ou laisse la
   * place à la suivante), la vue se recale sur l'exécution écrite au lieu de garder des pastilles « en cours ».
   */
  private appliquerDirect(e: EtatDirect): void {
    const avant = this.enDirect;
    this.direct = e;
    const apres = this.enDirect;
    if (avant && (!apres || apres.debut !== avant.debut || apres.genre !== avant.genre)) void this.charger().catch(() => {});
  }

  /** `relire` : un détail introuvable fait relire la liste une fois (l'exécution est sans doute partie). */
  private async chargerListe(relire: boolean): Promise<void> {
    const n = ++this.requeteListe;
    const l = await this.source.executions(this.widget);
    if (n !== this.requeteListe) return;
    if (!memeJson(l, this.liste)) this.liste = l;
    // Un autre constructeur de ce widget dans la fenêtre (onglet quitté pendant « Lancer ») a pu changer le choix.
    const garde = choix.get(this.widget) ?? null;
    if (garde !== this.voulue) this.voulue = garde;
    if (this.voulue !== null && !l.some((e) => e.id === this.voulue)) this.garder(null);
    if (!(await this.chargerDetail()) && relire) await this.chargerListe(false);
  }

  async choisir(id: string | null): Promise<void> {
    this.garder(id);
    this.refus = null;
    if (!(await this.chargerDetail())) await this.chargerListe(false);
  }

  private garder(id: string | null): void {
    this.voulue = id;
    if (id === null) choix.delete(this.widget);
    else choix.set(this.widget, id);
  }

  /**
   * « ▶ Lancer » : une vraie exécution, choisie à sa fin ; sans id rendu (agent arrêté…), le choix reste. Si c'est la
   * dernière vraie, le choix redevient celui par défaut : les exécutions suivantes le reprennent.
   */
  async lancer(): Promise<void> {
    if (!this.lanceur || this.occupe) return;
    this.demande = true;
    this.refus = null;
    let execution: string | undefined;
    try {
      execution = (await this.lanceur.lancer(this.widget)).execution;
      if (execution !== undefined) this.garder(execution);
    } catch (e) {
      console.error(`[webaios] exécution du widget ${this.widget} :`, e);
    } finally {
      this.demande = false;
    }
    await this.charger();
    if (execution !== undefined && this.voulue === execution && this.liste.find((e) => !e.essai)?.id === execution) this.garder(null);
  }

  /** « Rejouer depuis ce bloc » avec les sorties amont de l'exécution choisie ; l'essai rendu est choisi. */
  async rejouer(bloc: string): Promise<void> {
    const origine = this.choisie;
    if (!this.lanceur || this.occupe || !origine) return;
    this.demande = true;
    this.refus = null;
    try {
      const r = await this.lanceur.rejouer(this.widget, origine.id, bloc);
      if (r.ok) this.garder(r.execution);
      else this.refus = r.erreur;
    } catch (e) {
      this.refus = PREFIXE_REJEU + ((e as Error)?.message || "erreur inattendue");
    } finally {
      this.demande = false;
    }
    await this.charger();
  }

  /** false : le détail de l'exécution choisie n'a pas pu être lu (`introuvable`). */
  private async chargerDetail(): Promise<boolean> {
    const r = this.choisie;
    const n = ++this.requeteDetail;
    if (!r) {
      this.detail = null;
      this.introuvable = false;
      return true;
    }
    // Déjà lue et inchangée (même fin, même statut) : rien à redemander.
    const d = this.detail;
    if (d && d.id === r.id && d.fin === r.fin && d.statut === r.statut) return true;
    let e: Execution | null;
    try {
      e = await this.source.execution(this.widget, r.id);
    } catch {
      e = null;
    }
    if (n !== this.requeteDetail) return true;
    this.detail = e;
    this.introuvable = e === null;
    return e !== null;
  }
}
