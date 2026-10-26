import { ErreurAtelier } from "@webaios/noyau";
import type { EtatPanneauAgent, TailleTerminal } from "../../commun/api";
import type { IdFenetre } from "../../commun/modele";

/** Sortie gardée par fenêtre, renvoyée quand l'interface se recharge : de quoi retrouver la conversation. */
export const TAMPON_MAX = 200_000;

/** Ce que le gestionnaire utilise d'une SessionAgent du noyau. */
export interface SessionLike {
  readonly active: boolean;
  ecrire(d: string): void;
  redimensionner(cols: number, rows: number): void;
  surDonnees(r: (d: string) => void): () => void;
  surFin(r: (code: number) => void): () => void;
  arreter(): void;
}

interface Entree {
  session?: SessionLike;
  tampon: string;
  demarrage?: Promise<void>;
}

/** Une session d'agent par fenêtre (spec §8) : elle survit aux changements d'onglet et à la fermeture du panneau. */
export class SessionsAgent {
  private entrees = new Map<IdFenetre, Entree>();

  constructor(
    private readonly o: {
      ouvrir: (t: TailleTerminal) => Promise<SessionLike>;
      envoyer: (f: IdFenetre, canal: "donnees" | "etat", v: string | EtatPanneauAgent) => void;
    },
  ) {}

  /** Idempotent : une session active renvoie son état et son tampon ; sinon une nouvelle session démarre. */
  demarrer(f: IdFenetre, taille: TailleTerminal): Promise<void> {
    let e = this.entrees.get(f);
    if (!e) this.entrees.set(f, (e = { tampon: "" }));
    const entree = e;
    if (entree.session?.active) {
      entree.session.redimensionner(taille.cols, taille.rows);
      this.o.envoyer(f, "etat", { etat: "actif" });
      if (entree.tampon) this.o.envoyer(f, "donnees", entree.tampon);
      return Promise.resolve();
    }
    if (entree.demarrage) return entree.demarrage;
    entree.tampon = "";
    this.o.envoyer(f, "etat", { etat: "preparation" });
    entree.demarrage = this.o
      .ouvrir(taille)
      .then(
        (s) => {
          // Fenêtre fermée pendant le démarrage : personne n'affichera cet agent.
          if (this.entrees.get(f) !== entree) return s.arreter();
          entree.session = s;
          s.surDonnees((d) => {
            entree.tampon = (entree.tampon + d).slice(-TAMPON_MAX);
            this.o.envoyer(f, "donnees", d);
          });
          s.surFin((code) => {
            if (entree.session === s) entree.session = undefined;
            this.o.envoyer(f, "etat", { etat: "termine", code });
          });
          this.o.envoyer(f, "etat", { etat: "actif" });
        },
        (err: Error) =>
          this.o.envoyer(
            f,
            "etat",
            err instanceof ErreurAtelier && err.etat === "docker-absent" ? { etat: "docker-absent" } : { etat: "erreur", message: err.message },
          ),
      )
      .finally(() => (entree.demarrage = undefined));
    return entree.demarrage;
  }

  active(f: IdFenetre): boolean {
    return this.entrees.get(f)?.session?.active ?? false;
  }

  ecrire(f: IdFenetre, d: string): void {
    this.entrees.get(f)?.session?.ecrire(d);
  }

  redimensionner(f: IdFenetre, t: TailleTerminal): void {
    this.entrees.get(f)?.session?.redimensionner(t.cols, t.rows);
  }

  fermerFenetre(f: IdFenetre): void {
    this.entrees.get(f)?.session?.arreter();
    this.entrees.delete(f);
  }

  toutArreter(): void {
    for (const f of [...this.entrees.keys()]) this.fermerFenetre(f);
  }
}
