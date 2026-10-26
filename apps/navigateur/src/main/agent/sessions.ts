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
  /** Dernière taille du terminal, pour rouvrir la session à l'identique (relancerTout). */
  taille: TailleTerminal;
}

/** Une session d'agent par fenêtre (spec §8) : elle survit aux changements d'onglet et à la fermeture du panneau. */
export class SessionsAgent {
  private entrees = new Map<IdFenetre, Entree>();

  constructor(
    private readonly o: {
      ouvrir: (t: TailleTerminal) => Promise<SessionLike>;
      envoyer: (f: IdFenetre, canal: "donnees" | "etat", v: string | EtatPanneauAgent) => void;
      /** L'utilisateur valide un message (Entrée) dans le terminal de cette fenêtre. */
      surEnvoi?: (f: IdFenetre) => void;
    },
  ) {}

  /** Idempotent : une session active renvoie son état et son tampon ; sinon une nouvelle session démarre. */
  demarrer(f: IdFenetre, taille: TailleTerminal): Promise<void> {
    let e = this.entrees.get(f);
    if (!e) this.entrees.set(f, (e = { tampon: "", taille }));
    const entree = e;
    entree.taille = taille;
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
            // Session remplacée (relancerTout) : sa fin n'est pas celle de la conversation affichée.
            if (entree.session !== s) return;
            entree.session = undefined;
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
    const session = this.entrees.get(f)?.session;
    if (!session) return;
    session.ecrire(d);
    if (d.includes("\r")) this.o.surEnvoi?.(f);
  }

  redimensionner(f: IdFenetre, t: TailleTerminal): void {
    const e = this.entrees.get(f);
    if (e) e.taille = t;
    e?.session?.redimensionner(t.cols, t.rows);
  }

  /** Changement de profil : chaque fenêtre qui avait un agent en retrouve un nouveau, à la même taille. */
  async relancerTout(): Promise<void> {
    const anciennes = [...this.entrees];
    // De nouvelles entrées : un démarrage encore en cours sur l'ancien noyau sera abandonné à son arrivée.
    this.entrees.clear();
    for (const [, e] of anciennes) {
      const s = e.session;
      e.session = undefined;
      s?.arreter();
    }
    await Promise.all(anciennes.map(([f, e]) => this.demarrer(f, e.taille)));
  }

  fermerFenetre(f: IdFenetre): void {
    this.entrees.get(f)?.session?.arreter();
    this.entrees.delete(f);
  }

  toutArreter(): void {
    for (const f of [...this.entrees.keys()]) this.fermerFenetre(f);
  }
}
