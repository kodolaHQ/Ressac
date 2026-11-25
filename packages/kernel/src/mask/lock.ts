import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { writePrivateJson } from "../design/atomic-write.js";

/**
 * A conversation's lock after a reveal (spec § 3): the pairs « revealed value → allowed origins ». The kernel cannot
 * tell which value an outflow carries (the agent can encode any), so an outflow passes without a card only toward a
 * destination allowed for every revealed value: each reveal narrows, none widens another's.
 */
export class ConversationLock {
  private readonly entries: { label: string; origins: string[] | null; from: string | null }[] = [];
  private born = false;
  /** Unknown labels given to `reveal_value` or `fill_field` in this conversation (one count for both: Task 8 blocks at 3). */
  unknownLabels = 0;
  /** Reveals waiting on their card, by label: a second one for the same label waits for it (never two values out). */
  readonly revealing = new Map<string, Promise<void>>();

  /** `origins` null (or empty): a value read nowhere, which allows no destination. */
  /** `from`: the origin the revealed label was last read on, the one site an address carrying the value may reach uncarded. */
  reveal(label: string, origins: string[] | null, from: string | null = null): void {
    this.entries.push({ label, origins: origins?.length ? [...origins] : null, from });
  }

  /** A conversation opened while the workspace is locked (Task 10): locked with nothing revealed, allows nothing. */
  bornLocked(): void {
    this.born = true;
  }

  locked(): boolean {
    return this.born || this.entries.length > 0;
  }

  allows(destinationOrigin: string | null): boolean {
    if (!this.locked()) return true;
    if (this.born || destinationOrigin === null) return false;
    return this.entries.every((e) => e.origins?.includes(destinationOrigin) ?? false);
  }

  /** The origins `allows` accepts, for Firefox's hop guard; null unlocked. */
  allowedOrigins(): string[] | null {
    if (!this.locked()) return null;
    if (this.born) return [];
    return [...new Set(this.entries.flatMap((e) => e.origins ?? []))].filter((o) => this.allows(o));
  }

  revealed(): readonly { label: string; origins: string[] | null }[] {
    return this.entries.map((e) => ({ label: e.label, origins: e.origins && [...e.origins] }));
  }

  /** Each revealed label with the origin it was revealed from (`reveal`'s `from`). */
  revealedFrom(): readonly { label: string; from: string | null }[] {
    return this.entries.map((e) => ({ label: e.label, from: e.from }));
  }
}

/** The workspace lock's hook a reveal awaits before giving the value (the kernel's: lock file, reveal stamp, network cut). */
export interface WorkspaceLockHook {
  lock(o: { names: string[] }): Promise<void>;
}

// Tests and servers without a kernel: the kernel passes its own hook.
export const NO_WORKSPACE_LOCK: WorkspaceLockHook = { lock: () => Promise.resolve() };

/** What the lock file holds: names (« votre code »), never values; `codes`: each widget's and action's code hash at the first lock. */
export type WorkspaceLockInfo = { since: string; names: string[]; codes: Record<string, string> };

const LockFile = z.object({ since: z.string(), names: z.array(z.string()), codes: z.record(z.string(), z.string()) });

/**
 * The workspace lock after a reveal (spec § 3): until the user lifts it, every conversation is born locked, the shared
 * stores refuse writes and the container's network is cut to the model domains. The file (outside the workspace, never
 * mounted) is the only state: read at each call, so a restart or a second instance on the same file sees the same lock.
 * No file: unlocked; any other read failure or an invalid file reads as locked (fail closed).
 */
export class WorkspaceLock {
  private readonly listeners = new Set<() => void>();
  /** lock() and lift() one after the other: a lift never lands between a lock's read and its write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  locked(): boolean {
    return this.info() !== null;
  }

  info(): WorkspaceLockInfo | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { since: "", names: [], codes: {} };
    }
    try {
      return LockFile.parse(JSON.parse(raw));
    } catch {
      return { since: "", names: [], codes: {} };
    }
  }

  /** Adds `names`; the first lock's date and code hashes stay (code changed since the first reveal stays paused). */
  lock(o: { names: string[]; codes?: Record<string, string> }): Promise<void> {
    return this.serial(async () => {
      const before = this.info();
      const info: WorkspaceLockInfo = before
        ? { since: before.since, names: [...new Set([...before.names, ...o.names])], codes: before.codes }
        : { since: new Date().toISOString(), names: [...new Set(o.names)], codes: { ...o.codes } };
      await writePrivateJson(this.file, info);
    });
  }

  lift(): Promise<void> {
    return this.serial(() => rm(this.file, { force: true }));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private serial(f: () => Promise<void>): Promise<void> {
    const run = this.queue.catch(() => {}).then(f);
    this.queue = run;
    return run.then(() => {
      for (const cb of this.listeners) {
        try {
          cb();
        } catch (e) {
          console.error("[ressac] workspace lock listener:", e);
        }
      }
    });
  }
}
