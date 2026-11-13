import type { Warning, BlockCatalogEntry } from "@ressac/kernel";
import type { ApiRessac, WorkflowEdit } from "../../shared/api";
import { CODE_MODEL, freshParams } from "./add";
import { addBlock, move, History, sameDraft, followFile, toDraft, type Draft } from "./draft";
import { arrange, shownPositions, withoutLayout } from "./layout";
import { isActionKey } from "./target";
import { forgetRunChoices } from "./executions.svelte";

type Position = { x: number; y: number };
export type Validation = { ok: true } | { ok: false; error: string; block?: string };
export type SaveState = "saved" | "saving" | { invalid: string; block?: string } | { error: string };
/** `unreadable`: `workflow.json` is not readable at opening (truncated JSON…); `not-found`: neither widget nor harvest. */
export type Load = "loading" | "ready" | "not-found" | { unreadable: string };
/** Reading and writing the workflow, addressed by the workflow's key (`targetKey`). */
export type Depot = {
  read(key: string): ReturnType<ApiRessac["workflow"]["read"]>;
  save(key: string, draft: Draft): ReturnType<ApiRessac["workflow"]["save"]>;
  readCode(key: string, name: string): ReturnType<ApiRessac["workflow"]["readCode"]>;
  saveCode(key: string, name: string, text: string): ReturnType<ApiRessac["workflow"]["saveCode"]>;
};
export type Viewport = { x: number; y: number; zoom: number };

const UNSAVED_PREFIX = /^Non enregistré : /;
/** A gesture while the banner offers the agent's version: nothing goes out before the user's choice. */
export const AWAITING_CHOICE = "l'agent a modifié le workflow, choisis une version";
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The editing state of a widget's workflow in this window: draft, history, validation, saving. Only a gesture from
 * the user goes through `edit` (and so saves): opening, re-reading, rearranging or selecting never write.
 */
export class Edit {
  draft = $state.raw<Draft | null>(null);
  validation = $state.raw<Validation>({ ok: true });
  warnings = $state.raw<Warning[]>([]);
  recordingState = $state.raw<SaveState>("saved");
  /** The latest version seen on disk (or confirmed by a save). */
  lastKnown = $state.raw<Draft | null>(null);
  banner = $state<null | "proposer" | "illisible">(null);
  /** Displayed positions: the draft's, or the automatic layout of a workflow that has none. */
  positions = $state.raw<Record<string, Position>>({});
  loading = $state.raw<Load>("loading");
  widget = $state.raw<NonNullable<WorkflowEdit["widget"]> | null>(null);
  /** What the action whose workflow this is declares; null for a widget. */
  action = $state.raw<NonNullable<WorkflowEdit["action"]> | null>(null);
  origin = $state<"file" | "implicit">("file");
  /** The workflow on disk is valid: « Lancer » makes sense. */
  diskValid = $state(false);
  /** Canvas view, kept when the tab changes (no reframing on return). */
  viewport: Viewport | null = null;

  private history: History | null = null;
  /** Disk version the banner offers. */
  private diskVersion: { draft: Draft; read: WorkflowEdit } | null = null;
  /** Drafts sent for saving, not yet confirmed: their echo on disk is ignored. */
  private sent: Draft[] = [];
  private next: Draft | null = null;
  /** Draft held during the « proposer » banner: sent by « Garder la mienne », dropped otherwise. */
  private kept: Draft | null = null;
  private recordingInProgress = false;
  private read = 0;

  constructor(
    readonly id: string,
    private readonly repo: Depot,
  ) {}

  /** First read; afterwards, `review`. */
  async open(): Promise<void> {
    if (this.loading !== "loading") return this.review();
    const n = ++this.read;
    const l = await this.repo.read(this.id);
    if (n !== this.read) return;
    if (!l) {
      this.loading = "not-found";
      return;
    }
    this.load(l);
  }

  private load(l: WorkflowEdit): void {
    this.widget = l.widget ?? null;
    this.action = l.action ?? null;
    this.origin = l.origin;
    const disk = l.raw === null ? null : toDraft(l.raw);
    if (!disk) {
      this.loading = { unreadable: l.validation.ok ? "workflow.json illisible" : l.validation.error };
      this.diskValid = false;
      return;
    }
    this.history = new History(disk);
    this.lastKnown = disk;
    this.positions = shownPositions(disk, null);
    this.adoptRead(disk, l);
    this.loading = "ready";
  }

  /** Shows `disque` as read (validation and warnings of the disk); writes nothing. */
  private adoptRead(disk: Draft, l: WorkflowEdit): void {
    this.draft = disk;
    this.positions = shownPositions(disk, this.positions);
    this.lastKnown = disk;
    this.validation = l.validation;
    this.warnings = l.warnings;
    this.recordingState = l.validation.ok ? "saved" : invalid(l.validation.error, l.validation.block);
    this.diskValid = l.validation.ok;
    this.banner = null;
    this.diskVersion = null;
  }

  /** `workflow.json` may have changed (the agent writes it, or it is the echo of a save): writes nothing. */
  async review(): Promise<void> {
    const n = ++this.read;
    const l = await this.repo.read(this.id);
    if (n !== this.read) return;
    // The agent may be rewriting widget.json (or action.json): the canvas stays as is.
    if (!l) return;
    this.widget = l.widget ?? null;
    this.action = l.action ?? null;
    if (this.loading !== "ready" || !this.draft || !this.history) {
      this.loading = "loading";
      this.load(l);
      return;
    }
    const disk = l.raw === null ? null : toDraft(l.raw);
    const decision = followFile({ local: this.draft, lastKnown: this.lastKnown, disk: disk, sent: this.sent });
    if (decision === "illisible") {
      this.banner = "illisible";
      this.diskValid = false;
      return;
    }
    if (decision === "adopter") {
      this.origin = l.origin;
      this.history.do(disk!);
      this.adoptRead(disk!, l);
      return;
    }
    if (decision === "proposer") {
      this.diskVersion = { draft: disk!, read: l };
      this.banner = "proposer";
      return;
    }
    // Ignore: the disk is the draft, its last known version or an echo.
    this.origin = l.origin;
    if (sameDraft(disk!, this.draft)) {
      this.lastKnown = disk;
      this.diskValid = l.validation.ok;
      this.banner = null;
      this.diskVersion = null;
      if (this.kept) {
        // The disk caught up with the held draft: nothing left to choose or send.
        this.kept = null;
        this.recordingState = l.validation.ok ? "saved" : invalid(l.validation.error, l.validation.block);
      }
      if (this.recordingState !== "saving") {
        if (!sameJson(this.validation, l.validation)) this.validation = l.validation;
        if (!sameJson(this.warnings, l.warnings)) this.warnings = l.warnings;
      }
    } else if (this.banner === "illisible") {
      this.banner = null;
      this.diskValid = l.validation.ok;
    }
  }

  /** Banner: drop the draft for the disk version. */
  takeDiskVersion(): void {
    const v = this.diskVersion;
    if (!v || !this.history) return;
    this.kept = null;
    this.next = null;
    this.history.do(v.draft);
    this.origin = v.read.origin;
    this.adoptRead(v.draft, v.read);
  }

  /**
   * Banner: keep the draft. It goes to saving (held by a gesture, or valid) and then replaces the disk version;
   * invalid, it is refused and nothing is written.
   */
  keepMine(): void {
    if (this.diskVersion) this.lastKnown = this.diskVersion.draft;
    const send = this.kept !== null || this.validation.ok;
    this.diskVersion = null;
    this.banner = null;
    this.kept = null;
    if (this.draft && send) this.save(this.draft);
  }

  /**
   * A gesture from the user: applied to the draft, kept in the history, saved. The displayed positions are frozen with
   * it (a workflow without a layout keeps the one we see, with no jump afterwards). `fusion`: successive gestures with
   * the same key (keystrokes of the same field) make only one history entry.
   */
  edit(f: (b: Draft) => Draft, fusion?: string): void {
    this.change(f, false, fusion);
  }

  /** End of a drag: `positions` are those of all displayed blocks; nothing is written if none moved. */
  move(positions: Record<string, Position>): void {
    const moved = Object.entries(positions).some(([id, p]) => {
      const q = this.positions[id];
      return !q || q.x !== p.x || q.y !== p.y;
    });
    if (!moved) return;
    this.positions = { ...this.positions, ...positions };
    this.change((b) => b, true);
  }

  /** `figer`: the displayed positions alone are enough to save (a drag); otherwise `f` must change the draft. */
  private change(f: (b: Draft) => Draft, freeze: boolean, fusion?: string): void {
    const before = this.draft;
    if (!before || !this.history) return;
    const base = move(before, this.positions);
    const after = f(base);
    if (!freeze && (after === base || sameDraft(after, base))) return;
    if (after === before || sameDraft(after, before)) return;
    this.history.do(after, fusion);
    this.apply(after);
  }

  /** Adds a catalog block; a `code` block gets its file (template that returns its input) before existing. */
  async add(c: BlockCatalogEntry, position: Position): Promise<string> {
    if (!this.draft) return "";
    const params = freshParams(c);
    if (c.type === "code") {
      const source = await this.freeFile(c.type);
      // Never another block's file: without a free name (or without being able to write the template), the block is not added.
      if (!source) {
        this.recordingState = { error: "aucun nom de fichier libre pour le bloc Code" };
        return "";
      }
      const r = await this.repo.saveCode(this.id, source, CODE_MODEL);
      if (!r.ok) {
        this.recordingState = { error: r.error };
        return "";
      }
      params.source = source;
    }
    let id = "";
    this.edit((b) => {
      const r = addBlock(b, c.type, position, params);
      id = r.id;
      return r.draft;
    });
    return id;
  }

  /** `<id>.mjs` of the future block, or the next free one: never an existing file nor another block's file. */
  private async freeFile(type: string): Promise<string | null> {
    const b = this.draft!;
    const { id } = addBlock(b, type, { x: 0, y: 0 }, {});
    const taken = new Set(b.blocks.map((x) => x.params.source).filter((s): s is string => typeof s === "string"));
    for (let n = 1; n <= 50; n++) {
      const name = `${id}${n === 1 ? "" : `-${n}`}.mjs`;
      if (taken.has(name)) continue;
      const parsed = await this.repo.readCode(this.id, name);
      if ("absent" in parsed) return name;
      if ("error" in parsed) return null;
    }
    return null;
  }

  /**
   * The file `source` was just saved: if the draft was refused for lack of this file (a `code` block reading it is
   * the cause), it goes to saving again. Otherwise nothing (no disk echo would do it).
   */
  savedCode(source: string): void {
    const v = this.validation;
    if (v.ok || v.block === undefined || !this.draft || this.banner === "proposer" || this.recordingState === "saving") return;
    const b = this.draft.blocks.find((x) => x.id === v.block);
    if (b?.type === "code" && b.params.source === source) this.save(this.draft);
  }

  cancel(): void {
    const b = this.history?.cancel();
    if (b) this.apply(b, true);
  }

  restore(): void {
    const b = this.history?.restore();
    if (b) this.apply(b, true);
  }

  /** Redoes the automatic layout: displayed positions only, nothing is saved. */
  reorder(): void {
    if (this.draft) this.positions = arrange(this.draft);
  }

  /**
   * `history`: return to a past state; without a layout, it takes the automatic layout again (not the displayed
   * positions, which would keep the undone move).
   */
  private apply(b: Draft, hist = false): void {
    this.draft = b;
    this.positions = shownPositions(b, hist && withoutLayout(b) ? null : this.positions);
    if (this.banner === "proposer") {
      this.keep(b);
      return;
    }
    this.banner = null;
    this.diskVersion = null;
    this.save(b);
  }

  /** The banner offers the agent's version (re-read after each wait: it may have appeared meanwhile). */
  private expectedChoice(): boolean {
    return this.banner === "proposer";
  }

  private keep(b: Draft): void {
    this.kept = b;
    this.recordingState = { invalid: AWAITING_CHOICE };
  }

  /** Saves go out one by one; a draft outdated before its turn is not sent. */
  private save(b: Draft): void {
    this.next = b;
    this.recordingState = "saving";
    if (!this.recordingInProgress) void this.clear();
  }

  private async clear(): Promise<void> {
    this.recordingInProgress = true;
    try {
      while (this.next) {
        if (this.banner === "proposer") {
          // The banner appeared meanwhile: this draft awaits the user's choice.
          this.keep(this.next);
          this.next = null;
          break;
        }
        const b = this.next;
        this.next = null;
        this.sent.push(b);
        let r: Awaited<ReturnType<Depot["save"]>> | { error: string };
        try {
          r = await this.repo.save(this.id, b);
        } catch (e) {
          r = { error: (e as Error).message || "Enregistrement impossible" };
        }
        this.sent = this.sent.filter((x) => x !== b);
        if ("ok" in r && r.ok) {
          this.lastKnown = b;
          this.diskValid = true;
        }
        if (this.next) continue;
        if (this.expectedChoice()) {
          // The banner appeared in flight: the header keeps waiting for the user's choice.
          this.recordingState = { invalid: AWAITING_CHOICE };
        } else if (!("ok" in r)) {
          this.recordingState = { error: r.error };
        } else if (r.ok) {
          this.validation = { ok: true };
          this.warnings = r.warnings;
          this.recordingState = "saved";
        } else {
          this.validation = { ok: false, error: r.error, ...(r.block === undefined ? {} : { block: r.block }) };
          this.warnings = r.warnings;
          this.recordingState = invalid(r.error, r.block);
        }
      }
    } finally {
      this.recordingInProgress = false;
    }
  }
}

function invalid(error: string, block?: string): SaveState {
  const text = error.replace(UNSAVED_PREFIX, "");
  return block === undefined ? { invalid: text } : { invalid: text, block: block };
}

/** One edit per widget and per window: changing tab loses neither an invalid draft nor the history. */
const edits = new Map<string, Edit>();

/**
 * Forgets the edits of widgets no longer on home: a reused id never picks up the old history. Actions' edits (key
 * `action:<id>`) do not depend on home: they stay.
 */
export function forgetEdits(presents: Iterable<string>): void {
  const ids = new Set(presents);
  for (const id of [...edits.keys()]) if (!ids.has(id) && !isActionKey(id)) edits.delete(id);
  forgetRunChoices(ids);
}

let tracking = false;
/** Once per window: on each change of home, the edits of departed widgets are forgotten. */
export function followDisappearances(home: Pick<ApiRessac["home"], "read" | "onChange">): void {
  if (tracking) return;
  tracking = true;
  home.onChange(() => {
    void home
      .read()
      // An empty list is more likely a home unreadable for a moment: nothing is forgotten on it.
      .then((ws) => ws.length > 0 && forgetEdits(ws.map((w) => w.id)))
      .catch(() => {});
  });
}

export function createEdit(id: string, depot: Depot): Edit {
  let e = edits.get(id);
  if (!e) {
    e = new Edit(id, depot);
    edits.set(id, e);
  }
  return e;
}
