import { SvelteMap } from "svelte/reactivity";
import { MODELE_CODE } from "./ajout";
import type { Depot } from "./edition.svelte";

export type DepotCode = Pick<Depot, "lireCode" | "enregistrerCode">;

/** `base`: the text on disk when the draft began (null: file missing), to spot a change by the agent. */
type BrouillonCode = { texte: string; base: string | null };

/**
 * This window's unsaved codes, by `<widget>/<file>`: they survive block and tab changes; only « Enregistrer le code »
 * writes them.
 */
const brouillons = new SvelteMap<string, BrouillonCode>();
const cleCode = (widget: string, nom: string) => `${widget}/${nom}`;

/** Files whose code is not saved: the widget's (names), or all (`<widget>/<file>`). */
export function codesNonEnregistres(widget?: string): string[] {
  const cles = [...brouillons.keys()];
  if (widget === undefined) return cles;
  return cles.filter((c) => c.startsWith(`${widget}/`)).map((c) => c.slice(widget.length + 1));
}

/**
 * Drops the drafts of widgets with no builder tab left open in the window (tab closed by the agent, space
 * closed…): the window never holds back its closing for code that can no longer be seen.
 */
export function garderCodesDe(ouverts: Iterable<string>): void {
  const w = new Set(ouverts);
  for (const c of [...brouillons.keys()]) if (!w.has(c.slice(0, c.indexOf("/")))) brouillons.delete(c);
}

/** Drops a widget's drafts (tab closed anyway), or all of them. */
export function oublierCodes(widget?: string): void {
  for (const c of [...brouillons.keys()]) if (widget === undefined || c.startsWith(`${widget}/`)) brouillons.delete(c);
}

/** The `.mjs` file of a `code` block as the editor shows it: text on disk, or the user's draft. */
export class FichierCode {
  /** Text on disk; null: missing; undefined: not read yet. */
  disque = $state<string | null | undefined>(undefined);
  erreur = $state<string | null>(null);
  /** The file changed on disk since the draft began: [Recharger] [Garder le mien] banner. */
  changeSurDisque = $state(false);
  enregistrement = $state(false);
  private lecture = 0;

  constructor(
    readonly widget: string,
    readonly nom: string,
    private readonly depot: DepotCode,
    /** After each successful save (the workflow refused for lack of this file may start again). */
    private readonly apresEnregistrement?: (nom: string) => void,
  ) {}

  private get cle(): string {
    return cleCode(this.widget, this.nom);
  }

  get texte(): string {
    return brouillons.get(this.cle)?.texte ?? this.disque ?? MODELE_CODE;
  }

  /** Draft typed by the user (changing block or closing asks for confirmation). */
  get aBrouillon(): boolean {
    return brouillons.has(this.cle);
  }

  /** A draft, or a missing file (the shown template does not exist yet). */
  get nonEnregistre(): boolean {
    return this.aBrouillon || this.disque === null;
  }

  /** (Re)reads the file; a draft is never replaced, only flagged if the disk changed under it. */
  async lire(): Promise<void> {
    const n = ++this.lecture;
    const l = await this.depot.lireCode(this.widget, this.nom);
    if (n !== this.lecture) return;
    if ("erreur" in l) {
      this.erreur = l.erreur;
      return;
    }
    if (this.erreur !== null && !this.enregistrement) this.erreur = null;
    const t = "texte" in l ? l.texte : null;
    this.disque = t;
    const b = brouillons.get(this.cle);
    if (!b) {
      this.changeSurDisque = false;
      return;
    }
    if (t !== null && b.texte === t) {
      // The disk caught up with the draft (the agent wrote the same thing): nothing left to save.
      brouillons.delete(this.cle);
      this.changeSurDisque = false;
      return;
    }
    this.changeSurDisque = t !== b.base;
  }

  saisir(texte: string): void {
    if (this.disque === undefined) return;
    const b = brouillons.get(this.cle);
    if (texte === (this.disque ?? MODELE_CODE)) {
      brouillons.delete(this.cle);
      this.changeSurDisque = false;
    } else brouillons.set(this.cle, { texte, base: b ? b.base : this.disque });
  }

  /** « Enregistrer le code » and ⌘S: only when there is something to write. */
  async enregistrer(): Promise<void> {
    if (!this.nonEnregistre || this.enregistrement || this.disque === undefined) return;
    const texte = this.texte;
    this.enregistrement = true;
    try {
      const r = await this.depot.enregistrerCode(this.widget, this.nom, texte);
      if (!r.ok) {
        this.erreur = r.erreur;
        return;
      }
      this.erreur = null;
      this.disque = texte;
      this.changeSurDisque = false;
      const b = brouillons.get(this.cle);
      // A keystroke during the write stays a draft, based on what was just written.
      if (!b || b.texte === texte) brouillons.delete(this.cle);
      else brouillons.set(this.cle, { texte: b.texte, base: texte });
      this.apresEnregistrement?.(this.nom);
    } catch (e) {
      this.erreur = (e as Error).message || "Enregistrement impossible";
    } finally {
      this.enregistrement = false;
    }
  }

  /** Banner: drop the draft for the file on disk. */
  recharger(): void {
    brouillons.delete(this.cle);
    this.changeSurDisque = false;
  }

  /** Banner: keep the draft; it will replace the disk version on save. */
  garderLeMien(): void {
    const b = brouillons.get(this.cle);
    if (b && this.disque !== undefined) brouillons.set(this.cle, { texte: b.texte, base: this.disque });
    this.changeSurDisque = false;
  }
}

/** Changing block with `nom`'s code unsaved: the user confirms (the draft stays kept). */
export function confirmerChangementDeBloc(widget: string, nom: string): boolean {
  if (!brouillons.has(cleCode(widget, nom))) return true;
  return confirm(`Le code de ${nom} n'est pas enregistré. Changer de bloc quand même ? Il reste gardé dans cette fenêtre.`);
}

/** Closing the widget's builder with unsaved code: the user confirms, and the draft is dropped. */
export function confirmerFermeture(widget: string): boolean {
  const noms = codesNonEnregistres(widget);
  if (noms.length === 0) return true;
  if (!confirm(`Le code de ${noms.join(", ")} n'est pas enregistré. Fermer quand même ? Il sera perdu.`)) return false;
  oublierCodes(widget);
  return true;
}

let garde = false;
/**
 * Once per window: closing it with unsaved code goes through « beforeunload » (the main process then asks for
 * confirmation).
 */
export function garderAvantFermeture(): void {
  if (garde) return;
  garde = true;
  window.addEventListener("beforeunload", (e) => {
    if (brouillons.size === 0) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
