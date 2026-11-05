import type { DroitDev, OngletInfo } from "../shims/noyau";
import type { CarteExtension, ReponseAccord } from "../../../navigateur/src/commun/extensions";
import type { Decision, DemandeEnAttente, IdFenetre, IdOnglet, Issue, Permission } from "../../../navigateur/src/commun/modele";
import { attendreDroits, attendreIssue, attendreReponse, DELAI_QUESTION_MS, decisionPermise, ongletActifDe, origineDe, questionCaduque } from "../../../navigateur/src/main/agent/pont";
import type { SitePermission } from "../store/site-permissions";
import type { Store } from "../store/store";

type Listener = (pending: DemandeEnAttente[]) => void;

/** The agent's « lire l'onglet » and extension grant cards waiting for the user (Electron's `questions` in main/index.ts). */
export class Questions {
  private readonly open = new Map<string, { demande: DemandeEnAttente; repondre: (d: Issue, droits?: DroitDev[]) => void }>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly store: Store) {
    // A tab closed, moved to a private space or gone to another site will never be answered: its question falls (a refusal).
    store.subscribe((state) => {
      let changed = false;
      for (const [id, q] of this.open)
        if (questionCaduque(q.demande, state)) {
          this.open.delete(id);
          q.repondre("retiree");
          changed = true;
        }
      if (changed) this.changed();
    });
  }

  /** Shows the card in the window and waits for the answer; false after DELAI_QUESTION_MS, or when `signal` aborts. */
  ask(o: OngletInfo, fenetreId: IdFenetre, signal?: AbortSignal): Promise<boolean> {
    const ongletId = ongletActifDe(this.store.state, fenetreId)?.id ?? null;
    const fields = { ongletId, fenetreId, origine: origineDe(o.url), permissions: ["lire-onglet" as const], titre: o.titre, cible: o.id };
    // Already stale (tab closed, private, gone elsewhere): no card, which no state change would ever take down.
    if (questionCaduque({ id: "", ...fields }, this.store.state)) return Promise.resolve(false);
    return attendreReponse((repondre) => this.pose(fields, repondre), DELAI_QUESTION_MS, signal);
  }

  /**
   * The dev tools card (Electron's demanderOutilsDev): the rights ticked when allowed, `[]` on a refusal, after
   * DELAI_QUESTION_MS, on `signal`, or when the tab closes, turns private or goes to another site.
   */
  askDevTools(o: OngletInfo, d: { droits: DroitDev[]; raison: string; agent: string }, fenetreId: IdFenetre, signal?: AbortSignal): Promise<DroitDev[]> {
    const ongletId = ongletActifDe(this.store.state, fenetreId)?.id ?? null;
    const fields = { ongletId, fenetreId, origine: origineDe(o.url), permissions: ["outils-dev" as const], titre: o.titre, cible: o.id, droits: d.droits, raison: d.raison, agent: d.agent };
    if (questionCaduque({ id: "", ...fields }, this.store.state)) return Promise.resolve([]);
    return attendreDroits((repondre) => this.pose(fields, repondre), DELAI_QUESTION_MS, signal);
  }

  /**
   * Shows the grant card of an agent extension (DemandeExtension) in the window; it falls (« retirée ») after
   * DELAI_QUESTION_MS, on `signal`, or when its space goes or turns private. A renforcée card needs « Je comprends ».
   */
  async askExtension(carte: CarteExtension, fenetreId: IdFenetre, signal?: AbortSignal): Promise<ReponseAccord> {
    const fields = { ongletId: null, fenetreId, origine: carte.cle, permissions: ["extension" as const], extension: carte };
    const issue = questionCaduque({ id: "", ...fields }, this.store.state)
      ? "retiree"
      : await attendreIssue((repondre) => this.pose(fields, repondre), DELAI_QUESTION_MS, signal);
    return { accepte: issue === "autoriser", empreinte: carte.empreinte, ...(issue === "retiree" ? { retiree: true } : {}) };
  }

  /** The console unlock card of an agent extension (Electron's debloquerConsole): Refuser is the default; it falls after DELAI_QUESTION_MS or on `signal`. */
  askConsole(o: { nom: string; espaces: string[]; raison: string; agent: string }, fenetreId: IdFenetre, signal?: AbortSignal): Promise<Issue> {
    const fields = { ongletId: null, fenetreId, origine: o.nom, permissions: ["console-extension" as const], titre: o.nom, raison: o.raison, agent: o.agent, espaces: o.espaces };
    return attendreIssue((repondre) => this.pose(fields, repondre), DELAI_QUESTION_MS, signal);
  }

  /**
   * A site's question, shown as the banner on its tab (Electron's `demander`): no delay, it waits for the answer; it falls
   * (« retiree ») on `signal` or when its tab closes. `fenetreId` is not kept: Electron's site questions have none, which
   * would show them on every tab of the window and move them with a closed window.
   */
  askSite(
    d: { ongletId: IdOnglet | null; fenetreId: IdFenetre | null; origine: string; permissions: SitePermission[]; lien?: string },
    signal?: AbortSignal,
  ): Promise<Issue> {
    // The three Firefox-only kinds are not Electron Permissions: the UI never shows a site question (estDemandeAgent).
    const fields = { ongletId: d.ongletId, origine: d.origine, permissions: d.permissions as Permission[], ...(d.lien ? { lien: d.lien } : {}) };
    if (questionCaduque({ id: "", ...fields }, this.store.state)) return Promise.resolve("retiree");
    return attendreIssue((repondre) => this.pose(fields, repondre), Infinity, signal);
  }

  private pose(fields: Omit<DemandeEnAttente, "id">, repondre: (d: Issue, droits?: DroitDev[]) => void): () => void {
    const id = crypto.randomUUID();
    this.open.set(id, { demande: { id, ...fields }, repondre });
    this.changed();
    return () => {
      if (this.open.delete(id)) this.changed();
    };
  }

  /** A window closed: its questions move to `to` (on its active tab), or are refused without one (Electron's questionsFenetreFermee). */
  windowClosed(closed: IdFenetre, to: IdFenetre | undefined): void {
    let changed = false;
    for (const [id, q] of this.open) {
      if (q.demande.fenetreId !== closed) continue;
      changed = true;
      if (to) q.demande = { ...q.demande, fenetreId: to, ongletId: ongletActifDe(this.store.state, to)?.id ?? null };
      else {
        this.open.delete(id);
        q.repondre("retiree");
      }
    }
    if (changed) this.changed();
  }

  pending(): DemandeEnAttente[] {
    return [...this.open.values()].map((q) => q.demande);
  }

  /** `droits`: the rights ticked on a dev tools card. */
  answer(id: string, d: Decision, o?: { confirme?: boolean }, droits?: DroitDev[]): void {
    const q = this.open.get(id);
    if (!q) return;
    this.open.delete(id);
    // Copied into this realm: the UI's array dies with its document.
    q.repondre(decisionPermise(q.demande, d, o?.confirme), droits && Array.from(droits, String) as DroitDev[]);
    this.changed();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private changed(): void {
    const pending = this.pending();
    for (const l of [...this.listeners])
      try {
        l(pending);
      } catch (e) {
        console.error("[questions] listener failed:", e);
      }
  }
}
