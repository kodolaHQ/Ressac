import { WorkshopError } from "@webaios/noyau";
import type { AgentPanelState, TailleTerminal } from "../../shared/api";
import type { WindowId } from "../../shared/modele";

/** Output kept per window, returned when the UI reloads: enough to find the conversation again. */
export const TAMPON_MAX = 200_000;
/** The agent's output goes to the UI in batches: one IPC message per burst, not per pty chunk. */
export const GROUPING_MS = 8;

/** The last characters of an output, kept in chunks: appending never copies the whole buffer. */
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
      const tooMany = this.longueur - this.max;
      if (premier.length <= tooMany) {
        this.morceaux.shift();
        this.longueur -= premier.length;
      } else {
        this.morceaux[0] = premier.slice(tooMany);
        this.longueur -= tooMany;
      }
    }
  }

  /** Replaying a cut buffer starts at a whole line: not in the middle of an escape sequence. */
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

/** What the manager uses of a kernel SessionAgent. */
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
  /** Output not yet sent to the UI (see REGROUPEMENT_MS). */
  aEnvoyer: string;
  minuterie?: NodeJS.Timeout;
  demarrage?: Promise<void>;
  /** Last terminal size, to reopen the session identically (relancerTout). */
  taille: TailleTerminal;
  /** Text to put in the input as soon as the session is active (see preRemplir). */
  preRemplissage?: { texte: string; ecrit?: () => void };
}

/** One agent session per window (spec §8): it survives tab changes and the panel closing. */
export class SessionsAgent {
  private entrees = new Map<WindowId, Entree>();

  constructor(
    private readonly o: {
      ouvrir: (f: WindowId, t: TailleTerminal) => Promise<SessionLike>;
      envoyer: (f: WindowId, canal: "donnees" | "etat", v: string | AgentPanelState) => void;
      /** The user submits a message (Enter) in this window's terminal. */
      surEnvoi?: (f: WindowId) => void;
    },
  ) {}

  /** Idempotent: an active session returns its state and its buffer; otherwise a new session starts. */
  demarrer(f: WindowId, taille: TailleTerminal): Promise<void> {
    let e = this.entrees.get(f);
    if (!e) this.entrees.set(f, (e = { tampon: new Tampon(TAMPON_MAX), aEnvoyer: "", taille }));
    const entree = e;
    entree.taille = taille;
    if (entree.session?.active) {
      entree.session.redimensionner(taille.cols, taille.rows);
      this.o.envoyer(f, "etat", { etat: "actif" });
      // The buffer already contains the pending output: it is not sent a second time.
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
      .ouvrir(f, taille)
      .then(
        (s) => {
          // Window closed during startup: nobody will display this agent.
          if (this.entrees.get(f) !== entree) return void s.arreter();
          entree.session = s;
          s.surDonnees((d) => {
            entree.tampon.ajouter(d);
            entree.aEnvoyer += d;
            entree.minuterie ??= setTimeout(() => this.envoyerSortie(f, entree), GROUPING_MS);
          });
          s.surFin((code) => {
            // Session replaced (relancerTout): its end is not that of the displayed conversation.
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
          // Startup abandoned (window closed, relancerTout): its failure no longer concerns the panel.
          if (this.entrees.get(f) !== entree) return;
          this.o.envoyer(
            f,
            "etat",
            err instanceof WorkshopError && err.etat === "docker-absent" ? { etat: "docker-absent" } : { etat: "erreur", message: err.message },
          );
        },
      )
      .finally(() => (entree.demarrage = undefined));
    return entree.demarrage;
  }

  private envoyerSortie(f: WindowId, e: Entree): void {
    const d = e.aEnvoyer;
    this.annulerEnvoi(e);
    if (d && this.entrees.get(f) === e) this.o.envoyer(f, "donnees", d);
  }

  private annulerEnvoi(e: Entree): void {
    clearTimeout(e.minuterie);
    e.minuterie = undefined;
    e.aEnvoyer = "";
  }

  active(f: WindowId): boolean {
    return this.entrees.get(f)?.session?.active ?? false;
  }

  ecrire(f: WindowId, d: string): void {
    const session = this.entrees.get(f)?.session;
    if (!session) return;
    session.ecrire(d);
    if (d.includes("\r")) this.o.surEnvoi?.(f);
  }

  /**
   * Puts a text in the agent's input, without sending it: right away if the session is active, otherwise as soon as it
   * becomes so (a single pending text per window, the last wins). `ecrit` is called just before writing,
   * session open: an access granted there survives the policy's reset by the session opening.
   */
  preRemplir(f: WindowId, text: string, written?: () => void): void {
    let e = this.entrees.get(f);
    if (e?.session?.active) return this.ecrirePreRemplissage(e.session, text, written);
    if (!e) this.entrees.set(f, (e = { tampon: new Tampon(TAMPON_MAX), aEnvoyer: "", taille: { cols: 80, rows: 24 } }));
    e.preRemplissage = { texte: text, ...(written ? { ecrit: written } : {}) };
  }

  private ecrirePreRemplissage(s: SessionLike, text: string, written?: () => void): void {
    written?.();
    s.ecrire(text);
  }

  redimensionner(f: WindowId, t: TailleTerminal): void {
    const e = this.entrees.get(f);
    if (e) e.taille = t;
    e?.session?.redimensionner(t.cols, t.rows);
  }

  /** Profile change: every window that had an agent gets a new one, at the same size. */
  async relancerTout(): Promise<void> {
    const olds = [...this.entrees];
    // New entries: a startup still in progress on the old kernel will be abandoned when it arrives.
    this.entrees.clear();
    for (const [, e] of olds) {
      this.annulerEnvoi(e);
      const s = e.session;
      e.session = undefined;
      void s?.arreter();
    }
    await Promise.all(olds.map(([f, e]) => this.demarrer(f, e.taille)));
  }

  /** Hands control back once the agent is stopped in the container. */
  async fermerFenetre(f: WindowId): Promise<void> {
    const e = this.entrees.get(f);
    if (e) this.annulerEnvoi(e);
    this.entrees.delete(f);
    await e?.session?.arreter();
  }

  async toutArreter(): Promise<void> {
    await Promise.all([...this.entrees.keys()].map((f) => this.fermerFenetre(f)));
  }
}
