import type { OngletInfo } from "../shims/noyau";
import type { Decision, DemandeEnAttente, IdFenetre, Issue } from "../../../navigateur/src/commun/modele";
import { attendreReponse, DELAI_QUESTION_MS, decisionPermise, ongletActifDe, origineDe, questionCaduque } from "../../../navigateur/src/main/agent/pont";
import type { Store } from "../store/store";

type Listener = (pending: DemandeEnAttente[]) => void;

/** The agent's « lire l'onglet » cards waiting for the user (Electron's `questions` in main/index.ts). */
export class Questions {
  private readonly open = new Map<string, { demande: DemandeEnAttente; repondre: (d: Issue) => void }>();
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
    return attendreReponse(
      (repondre) => {
        const id = crypto.randomUUID();
        const ongletId = ongletActifDe(this.store.state, fenetreId)?.id ?? null;
        this.open.set(id, {
          demande: { id, ongletId, fenetreId, origine: origineDe(o.url), permissions: ["lire-onglet"], titre: o.titre, cible: o.id },
          repondre,
        });
        this.changed();
        return () => {
          if (this.open.delete(id)) this.changed();
        };
      },
      DELAI_QUESTION_MS,
      signal,
    );
  }

  pending(): DemandeEnAttente[] {
    return [...this.open.values()].map((q) => q.demande);
  }

  answer(id: string, d: Decision, o?: { confirme?: boolean }): void {
    const q = this.open.get(id);
    if (!q) return;
    this.open.delete(id);
    q.repondre(decisionPermise(q.demande, d, o?.confirme));
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
