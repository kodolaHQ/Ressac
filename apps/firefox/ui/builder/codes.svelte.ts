import { SvelteMap } from "svelte/reactivity";
import { say } from "./say";
import { CODE_MODEL } from "./add";
import type { Depot } from "./edit.svelte";

export type DepotCode = Pick<Depot, "readCode" | "saveCode">;

/** `base`: the text on disk when the draft began (null: file missing), to spot a change by the agent. */
type CodeDraft = { text: string; base: string | null };

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
  disk = $state<string | null | undefined>(undefined);
  error = $state<string | null>(null);
  /** The file changed on disk since the draft began: [Recharger] [Garder le mien] banner. */
  changedOnDisk = $state(false);
  recording = $state(false);
  private readSeq = 0;

  constructor(
    readonly widget: string,
    readonly name: string,
    private readonly repo: DepotCode,
    /** After each successful save (the workflow refused for lack of this file may start again). */
    private readonly afterSave?: (name: string) => void,
  ) {}

  private get key(): string {
    return codeKey(this.widget, this.name);
  }

  get text(): string {
    return drafts.get(this.key)?.text ?? this.disk ?? CODE_MODEL;
  }

  /** Draft typed by the user (changing block or closing asks for confirmation). */
  get hasDraft(): boolean {
    return drafts.has(this.key);
  }

  /** A draft, or a missing file (the shown template does not exist yet). */
  get unsaved(): boolean {
    return this.hasDraft || this.disk === null;
  }

  /** (Re)reads the file; a draft is never replaced, only flagged if the disk changed under it. */
  async read(): Promise<void> {
    const n = ++this.readSeq;
    const l = await this.repo.readCode(this.widget, this.name);
    if (n !== this.readSeq) return;
    if ("error" in l) {
      this.error = l.error;
      return;
    }
    if (this.error !== null && !this.recording) this.error = null;
    const t = "text" in l ? l.text : null;
    this.disk = t;
    const b = drafts.get(this.key);
    if (!b) {
      this.changedOnDisk = false;
      return;
    }
    if (t !== null && b.text === t) {
      // The disk caught up with the draft (the agent wrote the same thing): nothing left to save.
      drafts.delete(this.key);
      this.changedOnDisk = false;
      return;
    }
    this.changedOnDisk = t !== b.base;
  }

  enter(text: string): void {
    if (this.disk === undefined) return;
    const b = drafts.get(this.key);
    if (text === (this.disk ?? CODE_MODEL)) {
      drafts.delete(this.key);
      this.changedOnDisk = false;
    } else drafts.set(this.key, { text: text, base: b ? b.base : this.disk });
  }

  /** « Enregistrer le code » and ⌘S: only when there is something to write. */
  async save(): Promise<void> {
    if (!this.unsaved || this.recording || this.disk === undefined) return;
    const text = this.text;
    this.recording = true;
    try {
      const r = await this.repo.saveCode(this.widget, this.name, text);
      if (!r.ok) {
        this.error = r.error;
        return;
      }
      this.error = null;
      this.disk = text;
      this.changedOnDisk = false;
      const b = drafts.get(this.key);
      // A keystroke during the write stays a draft, based on what was just written.
      if (!b || b.text === text) drafts.delete(this.key);
      else drafts.set(this.key, { text: b.text, base: text });
      this.afterSave?.(this.name);
    } catch (e) {
      this.error = (e as Error).message || say("builder-save-impossible");
    } finally {
      this.recording = false;
    }
  }

  /** Banner: drop the draft for the file on disk. */
  reload(): void {
    drafts.delete(this.key);
    this.changedOnDisk = false;
  }

  /** Banner: keep the draft; it will replace the disk version on save. */
  keepMine(): void {
    const b = drafts.get(this.key);
    if (b && this.disk !== undefined) drafts.set(this.key, { text: b.text, base: this.disk });
    this.changedOnDisk = false;
  }
}

/** Changing block with `nom`'s code unsaved: the user confirms (the draft stays kept). */
export function confirmBlockChange(widget: string, name: string): boolean {
  if (!drafts.has(codeKey(widget, name))) return true;
  return confirm(say("builder-code-confirm-switch", { name }));
}

/** Closing the widget's builder with unsaved code: the user confirms, and the draft is dropped. */
export function confirmClose(widget: string): boolean {
  const names = unsavedCodes(widget);
  if (names.length === 0) return true;
  if (!confirm(say("builder-code-confirm-close", { names: names.join(", ") }))) return false;
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
