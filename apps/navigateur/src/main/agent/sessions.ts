import { ErreurAtelier } from "@webaios/noyau";
import type { EtatPanneauAgent, TailleTerminal } from "../../commun/api";
import type { IdFenetre } from "../../commun/modele";

/** Sortie gardée par fenêtre, renvoyée quand l'interface se recharge : de quoi retrouver la conversation. */
export const TAMPON_MAX = 200_000;
/** La sortie de l'agent part vers l'interface par paquets : un message IPC par rafale, pas par morceau du pty. */
export const REGROUPEMENT_MS = 8;

/** Les derniers caractères d'une sortie, gardés par morceaux : ajouter ne recopie jamais tout le tampon. */
export class Tampon {
  private morceaux: string[] = [];
  private longueur = 0;
  private coupe = false;

  constructor(private readonly max: number) {}

  ajouter(d: string): void {
    this.morceaux.push(d);
    this.longueur += d.length;
    while (this.longueur > this.max) {
      this.coupe = true;
      const premier = this.morceaux[0]!;
      const enTrop = this.longueur - this.max;
      if (premier.length <= enTrop) {
        this.morceaux.shift();
        this.longueur -= premier.length;
      } else {
        this.morceaux[0] = premier.slice(enTrop);
        this.longueur -= enTrop;
      }
    }
  }

  /** Le rejeu d'un tampon coupé commence à une ligne entière : pas au milieu d'une séquence d'échappement. */
  texte(): string {
    const s = this.morceaux.join("");
    const ligne = this.coupe ? s.indexOf("\n") : -1;
    return ligne >= 0 && ligne < s.length / 10 ? s.slice(ligne + 1) : s;
  }

  vider(): void {
    this.morceaux = [];
    this.longueur = 0;
    this.coupe = false;
  }
}

/** Ce que le gestionnaire utilise d'une SessionAgent du noyau. */
export interface SessionLike {
  readonly active: boolean;
  ecrire(d: string): void;
  redimensionner(cols: number, rows: number): void;
  surDonnees(r: (d: string) => void): () => void;
  surFin(r: (code: number) => void): () => void;
  arreter(): void | Promise<void>;
}

interface Entree {
  session?: SessionLike;
  tampon: Tampon;
  /** Sortie pas encore envoyée à l'interface (voir REGROUPEMENT_MS). */
  aEnvoyer: string;
  minuterie?: NodeJS.Timeout;
  demarrage?: Promise<void>;
  /** Dernière taille du terminal, pour rouvrir la session à l'identique (relancerTout). */
  taille: TailleTerminal;
  /** Texte à mettre dans la saisie dès que la session sera active (voir preRemplir). */
  preRemplissage?: { texte: string; ecrit?: () => void };
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
    if (!e) this.entrees.set(f, (e = { tampon: new Tampon(TAMPON_MAX), aEnvoyer: "", taille }));
    const entree = e;
    entree.taille = taille;
    if (entree.session?.active) {
      entree.session.redimensionner(taille.cols, taille.rows);
      this.o.envoyer(f, "etat", { etat: "actif" });
      // Le tampon contient déjà la sortie en attente : elle n'est pas renvoyée une seconde fois.
      this.annulerEnvoi(entree);
      const tampon = entree.tampon.texte();
      if (tampon) this.o.envoyer(f, "donnees", tampon);
      return Promise.resolve();
    }
    if (entree.demarrage) return entree.demarrage;
    entree.tampon.vider();
    this.annulerEnvoi(entree);
    this.o.envoyer(f, "etat", { etat: "preparation" });
    entree.demarrage = this.o
      .ouvrir(taille)
      .then(
        (s) => {
          // Fenêtre fermée pendant le démarrage : personne n'affichera cet agent.
          if (this.entrees.get(f) !== entree) return void s.arreter();
          entree.session = s;
          s.surDonnees((d) => {
            entree.tampon.ajouter(d);
            entree.aEnvoyer += d;
            entree.minuterie ??= setTimeout(() => this.envoyerSortie(f, entree), REGROUPEMENT_MS);
          });
          s.surFin((code) => {
            // Session remplacée (relancerTout) : sa fin n'est pas celle de la conversation affichée.
            if (entree.session !== s) return;
            this.envoyerSortie(f, entree);
            entree.session = undefined;
            this.o.envoyer(f, "etat", { etat: "termine", code });
          });
          this.o.envoyer(f, "etat", { etat: "actif" });
          const p = entree.preRemplissage;
          entree.preRemplissage = undefined;
          if (p) this.ecrirePreRemplissage(s, p.texte, p.ecrit);
        },
        (err: Error) => {
          // Démarrage abandonné (fenêtre fermée, relancerTout) : son échec ne concerne plus le panneau.
          if (this.entrees.get(f) !== entree) return;
          this.o.envoyer(
            f,
            "etat",
            err instanceof ErreurAtelier && err.etat === "docker-absent" ? { etat: "docker-absent" } : { etat: "erreur", message: err.message },
          );
        },
      )
      .finally(() => (entree.demarrage = undefined));
    return entree.demarrage;
  }

  private envoyerSortie(f: IdFenetre, e: Entree): void {
    const d = e.aEnvoyer;
    this.annulerEnvoi(e);
    if (d && this.entrees.get(f) === e) this.o.envoyer(f, "donnees", d);
  }

  private annulerEnvoi(e: Entree): void {
    clearTimeout(e.minuterie);
    e.minuterie = undefined;
    e.aEnvoyer = "";
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

  /**
   * Met un texte dans la saisie de l'agent, sans l'envoyer : tout de suite si la session est active, sinon dès qu'elle
   * le devient (un seul texte en attente par fenêtre, le dernier gagne). `ecrit` est appelé juste avant l'écriture,
   * session ouverte : un accès accordé là survit à la remise à zéro de la politique par l'ouverture de la session.
   */
  preRemplir(f: IdFenetre, texte: string, ecrit?: () => void): void {
    let e = this.entrees.get(f);
    if (e?.session?.active) return this.ecrirePreRemplissage(e.session, texte, ecrit);
    if (!e) this.entrees.set(f, (e = { tampon: new Tampon(TAMPON_MAX), aEnvoyer: "", taille: { cols: 80, rows: 24 } }));
    e.preRemplissage = { texte, ...(ecrit ? { ecrit } : {}) };
  }

  private ecrirePreRemplissage(s: SessionLike, texte: string, ecrit?: () => void): void {
    ecrit?.();
    s.ecrire(texte);
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
      this.annulerEnvoi(e);
      const s = e.session;
      e.session = undefined;
      void s?.arreter();
    }
    await Promise.all(anciennes.map(([f, e]) => this.demarrer(f, e.taille)));
  }

  /** Rend la main une fois l'agent arrêté dans le conteneur. */
  async fermerFenetre(f: IdFenetre): Promise<void> {
    const e = this.entrees.get(f);
    if (e) this.annulerEnvoi(e);
    this.entrees.delete(f);
    await e?.session?.arreter();
  }

  async toutArreter(): Promise<void> {
    await Promise.all([...this.entrees.keys()].map((f) => this.fermerFenetre(f)));
  }
}
