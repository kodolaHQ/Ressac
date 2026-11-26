import type { LabelType } from "./detectors.js";
import { maskText } from "./mask.js";
import { valueName } from "./names.js";
import { LABELS, LabelTable, type Entry } from "./table.js";
import { ConversationLock, type WorkspaceLock } from "./lock.js";
import type { PassportOrigins, PassportRef, PassportStore } from "./passport.js";

/**
 * The label tables: one per conversation (session), resolvable, wiped when it ends; and the main token's, which issues
 * labels but resolves none (spec § 9 bis, invariant 8).
 */
export class Masker {
  /** Every tool name the MCP wrapper put behind the masker (the « no tool escapes » test reads it). */
  readonly covered = new Set<string>();
  /** The host's passports, given to every table; created before the kernel and outliving it. */
  readonly passport: PassportStore | undefined;
  private readonly main: LabelTable;
  private readonly tables = new Map<string, LabelTable>();
  /** Each conversation's lock, beside its table; the main token's never locks itself (it reveals nothing). */
  private readonly sessionLocks = new Map<string, ConversationLock>();
  private readonly mainLock = new ConversationLock();
  /**
   * The workspace lock replaces the ended conversations' locks: a reveal writes it before the value leaves, and while it
   * holds every token is gated as a conversation born locked (allows nothing), restarts included. Absent: never locked.
   */
  private readonly workspace: Pick<WorkspaceLock, "locked" | "info"> | undefined;
  private readonly bornLock = new ConversationLock();
  private readonly windows = new Map<string, string>();
  /** The sessions resumed from a conversation started before masking, or by Codex (spec § 9 bis, invariant 2). */
  private readonly uncoveredSessions = new Set<string>();
  /** The sessions a passport addition marked (design § 5.3), with the entries (profile and id, never a value) that did. */
  private readonly passportUncovered = new Map<string, PassportRef[]>();
  /** Each conversation's passport origins, as at its first read: a site added or removed later re-zones none of its pages. */
  private readonly origins = new Map<string, PassportOrigins>();
  private readonly listeners = new Set<() => void>();
  private readonly locale: () => string;

  constructor(o: { locale?: () => string; workspace?: Pick<WorkspaceLock, "locked" | "info">; passport?: PassportStore } = {}) {
    this.passport = o.passport;
    this.main = new LabelTable({ passport: o.passport });
    this.locale = o.locale ?? (() => "fr");
    this.workspace = o.workspace;
    this.bornLock.bornLocked();
  }

  open(session: string, win: string, o: { uncovered?: boolean } = {}): void {
    // The main token's labels resolve nothing, but kept they would tie one value across conversations: new ones each time.
    this.main.wipe();
    this.tables.set(session, new LabelTable({ resolvable: true, passport: this.passport }));
    if (o.uncovered) this.uncoveredSessions.add(session);
    const lock = new ConversationLock();
    if (this.workspace?.locked()) lock.bornLocked();
    this.sessionLocks.set(session, lock);
    this.windows.set(win, session);
    this.changed();
  }

  close(session: string): void {
    this.tables.get(session)?.wipe();
    this.tables.delete(session);
    this.sessionLocks.delete(session);
    this.uncoveredSessions.delete(session);
    this.passportUncovered.delete(session);
    this.origins.delete(session);
    for (const [win, s] of this.windows) if (s === session) this.windows.delete(win);
    this.changed();
  }

  /** The session's table; the main token's (null) or an unknown session's: the one that resolves nothing (fail closed). */
  table(session: string | null): LabelTable {
    return (session !== null && this.tables.get(session)) || this.main;
  }

  /**
   * The session's passport origins, taken at its first tool call (past the passport gate, before anything is
   * zoned): until then it has linked nothing, so a late profile load or an edit still counts. The main token's or an
   * unknown session's: the passport's now.
   */
  originsOf(session: string | null): PassportOrigins | undefined {
    if (session === null || !this.tables.has(session) || !this.passport) return this.passport?.origins();
    let o = this.origins.get(session);
    if (!o) this.origins.set(session, (o = this.passport.origins()));
    return o;
  }

  /**
   * What `originsOf` would give, without taking the snapshot: the stored one, else the passport's now. For chrome's
   * questions (mask.runs), which must not fix a conversation's sources before its own first tool call.
   */
  peekOrigins(session: string | null): PassportOrigins | undefined {
    return (session !== null && this.origins.get(session)) || this.passport?.origins();
  }

  /** The session's lock; the main token's or an unknown session's: the main one. */
  lock(session: string | null): ConversationLock {
    return (session !== null && this.sessionLocks.get(session)) || this.mainLock;
  }

  /**
   * Every lock an outflow answers to: each conversation's and the main token's. Tokens are readable in the container, so
   * an agent could send through another window's token or the main one: no token escapes a lock.
   */
  locks(): ConversationLock[] {
    const sessions = [...this.sessionLocks.values()];
    // The workspace's lock (allows nothing) replaces an ended reveal's: while the revealing conversation lives, its own
    // lock already gates every token, and the value's origin stays open to it.
    const ended = this.workspace?.locked() && !sessions.some((l) => l.revealed().length);
    return [...sessions, this.mainLock, ...(ended ? [this.bornLock] : [])];
  }

  /** Some lock holds: a conversation's, the main token's or the workspace's. */
  locked(): boolean {
    return this.locks().some((l) => l.locked());
  }

  /** Every value revealed in a conversation, with the origin it was revealed from (null: none, a passport value). */
  revealedValues(): { entry: Entry; from: string | null }[] {
    return [...this.sessionLocks].flatMap(([s, lock]) =>
      lock.revealedFrom().flatMap(({ label, from }) => {
        const entry = this.table(s).resolve(label);
        return entry ? [{ entry, from }] : [];
      }),
    );
  }

  /** How the cards name every revealed value (« votre code »), never the value. */
  revealedNames(): string[] {
    const names = [...this.sessionLocks].flatMap(([s, lock]) => this.namesOf(s, lock));
    return [...new Set([...names, ...(this.workspace?.info()?.names ?? [])])];
  }

  private namesOf(session: string, lock: ConversationLock): string[] {
    return lock.revealed().flatMap(({ label }) => {
      const e = this.table(session).resolve(label);
      return e ? [valueName(e.type, e.zone, this.locale())] : [];
    });
  }

  /** Why the window's conversation is not covered: resumed from an uncovered one, and/or the passport entries added since it read. */
  uncoveredCause(win: string): { resumed: boolean; passport: PassportRef[] } {
    return this.uncoveredCauseOf(this.sessionOf(win));
  }

  /** The same, for one session (a chat discussion: several may share a window). */
  uncoveredCauseOf(s: string | null): { resumed: boolean; passport: PassportRef[] } {
    return { resumed: s !== null && this.uncoveredSessions.has(s), passport: [...((s !== null && this.passportUncovered.get(s)) || [])] };
  }

  /** An open session may have read in clear a value the passport now masks (design § 5.3): `entries`, the ones added. */
  markUncovered(session: string, entries: readonly PassportRef[]): void {
    if (!this.tables.has(session)) return;
    const kept = this.passportUncovered.get(session) ?? [];
    for (const r of entries) if (!kept.some((k) => k.profile === r.profile && k.id === r.id)) kept.push({ profile: r.profile, id: r.id });
    this.passportUncovered.set(session, kept);
    this.changed();
  }

  /** The open sessions that have masked some text. */
  touchedSessions(): string[] {
    return [...this.tables].filter(([, t]) => t.touched).map(([s]) => s);
  }

  sessionOf(win: string): string | null {
    return this.windows.get(win) ?? null;
  }

  /** What the user hands the agent (a paste, the ⌘T request): masked as their own data, with what it hid named for a card. */
  maskTyped(win: string, text: string): { text: string; names: string[] } {
    return this.maskInto(this.table(this.sessionOf(win)), text);
  }

  /**
   * The same, with one session's table (a chat discussion: the window's last session may be another one). Throws for a
   * session that is not open (ended, never opened): text for a gone discussion is never masked into the shared main table.
   */
  maskTypedFor(session: string, text: string): { text: string; names: string[] } {
    const table = this.tables.get(session);
    if (!table) throw new Error(`Masquage : la session ${session} n'est pas ouverte`);
    return this.maskInto(table, text);
  }

  private maskInto(table: LabelTable, text: string): { text: string; names: string[] } {
    const masked = maskText(text, { table, zone: "sources", origin: null });
    const before = new Set(text.match(LABELS) ?? []);
    const names = new Set<string>();
    for (const m of masked.matchAll(LABELS)) if (!before.has(m[0])) names.add(valueName(m[1] as LabelType, "sources", this.locale()));
    if (names.size) this.changed();
    return { text: masked, names: [...names] };
  }

  /** The value behind a label, for the user's own bubble (never sent to the agent). */
  lookupForUser(win: string, label: string): { type: LabelType; value: string } | null {
    return this.lookupForSession(this.sessionOf(win), label);
  }

  /** The same, in one session's table: another discussion's label resolves nothing. */
  lookupForSession(session: string | null, label: string): { type: LabelType; value: string } | null {
    const e = this.table(session).resolve(label);
    return e ? { type: e.type, value: e.raw } : null;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }
}
