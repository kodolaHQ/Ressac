import { SvelteMap } from "svelte/reactivity";
import { CODE_MODEL } from "./add";
import type { Depot } from "./edition.svelte";

export type DepotCode = Pick<Depot, "lireCode" | "enregistrerCode">;

/** `base`: the text on disk when the draft began (null: file missing), to spot a change by the agent. */
type CodeDraft = { texte: string; base: string | null };

/**
 * This window's unsaved codes, by `<widget>/<file>`: they survive block and tab changes; only « Enregistrer le code »
 * writes them.
 */
const drafts = new SvelteMap<string, CodeDraft>();
const codeKey = (widget: string, name: string) => `${widget}/${name}`;

/** Files whose code is not saved: the widget's (names), or all (`<widget>/<file>`). */
export function unsavedCodes(widget?: string): string[] {
  const keys = [...drafts.keys()];
  if (widget === undefined) return keys;
  return keys.filter((c) => c.startsWith(`${widget}/`)).map((c) => c.slice(widget.length + 1));
}

/**
 * Drops the drafts of widgets with no builder tab left open in the window (tab closed by the agent, space
 * closed…): the window never holds back its closing for code that can no longer be seen.
 */
export function keepCodesOf(opened: Iterable<string>): void {
  const w = new Set(opened);
  for (const c of [...drafts.keys()]) if (!w.has(c.slice(0, c.indexOf("/")))) drafts.delete(c);
}

/** Drops a widget's drafts (tab closed anyway), or all of them. */
export function forgetCodes(widget?: string): void {
  for (const c of [...drafts.keys()]) if (widget === undefined || c.startsWith(`${widget}/`)) drafts.delete(c);
}

/** The `.mjs` file of a `code` block as the editor shows it: text on disk, or the user's draft. */
export class CodeFile {
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
    private readonly apresEnregistrement?: (name: string) => void,
  ) {}

  private get cle(): string {
    return codeKey(this.widget, this.nom);
  }

  get texte(): string {
    return drafts.get(this.cle)?.texte ?? this.disque ?? CODE_MODEL;
  }

  /** Draft typed by the user (changing block or closing asks for confirmation). */
  get aBrouillon(): boolean {
    return drafts.has(this.cle);
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
    const b = drafts.get(this.cle);
    if (!b) {
      this.changeSurDisque = false;
      return;
    }
    if (t !== null && b.texte === t) {
      // The disk caught up with the draft (the agent wrote the same thing): nothing left to save.
      drafts.delete(this.cle);
      this.changeSurDisque = false;
      return;
    }
    this.changeSurDisque = t !== b.base;
  }

  saisir(text: string): void {
    if (this.disque === undefined) return;
    const b = drafts.get(this.cle);
    if (text === (this.disque ?? CODE_MODEL)) {
      drafts.delete(this.cle);
      this.changeSurDisque = false;
    } else drafts.set(this.cle, { texte: text, base: b ? b.base : this.disque });
  }

  /** « Enregistrer le code » and ⌘S: only when there is something to write. */
  async enregistrer(): Promise<void> {
    if (!this.nonEnregistre || this.enregistrement || this.disque === undefined) return;
    const text = this.texte;
    this.enregistrement = true;
    try {
      const r = await this.depot.enregistrerCode(this.widget, this.nom, text);
      if (!r.ok) {
        this.erreur = r.erreur;
        return;
      }
      this.erreur = null;
      this.disque = text;
      this.changeSurDisque = false;
      const b = drafts.get(this.cle);
      // A keystroke during the write stays a draft, based on what was just written.
      if (!b || b.texte === text) drafts.delete(this.cle);
      else drafts.set(this.cle, { texte: b.texte, base: text });
      this.apresEnregistrement?.(this.nom);
    } catch (e) {
      this.erreur = (e as Error).message || "Enregistrement impossible";
    } finally {
      this.enregistrement = false;
    }
  }

  /** Banner: drop the draft for the file on disk. */
  recharger(): void {
    drafts.delete(this.cle);
    this.changeSurDisque = false;
  }

  /** Banner: keep the draft; it will replace the disk version on save. */
  garderLeMien(): void {
    const b = drafts.get(this.cle);
    if (b && this.disque !== undefined) drafts.set(this.cle, { texte: b.texte, base: this.disque });
    this.changeSurDisque = false;
  }
}

/** Changing block with `nom`'s code unsaved: the user confirms (the draft stays kept). */
export function confirmerChangementDeBloc(widget: string, name: string): boolean {
  if (!drafts.has(codeKey(widget, name))) return true;
  return confirm(`Le code de ${name} n'est pas enregistré. Changer de bloc quand même ? Il reste gardé dans cette fenêtre.`);
}

/** Closing the widget's builder with unsaved code: the user confirms, and the draft is dropped. */
export function confirmClose(widget: string): boolean {
  const names = unsavedCodes(widget);
  if (names.length === 0) return true;
  if (!confirm(`Le code de ${names.join(", ")} n'est pas enregistré. Fermer quand même ? Il sera perdu.`)) return false;
  forgetCodes(widget);
  return true;
}

let kept = false;
/**
 * Once per window: closing it with unsaved code goes through « beforeunload » (the main process then asks for
 * confirmation).
 */
export function keepBeforeClosing(): void {
  if (kept) return;
  kept = true;
  window.addEventListener("beforeunload", (e) => {
    if (drafts.size === 0) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
