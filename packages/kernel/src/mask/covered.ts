import { readFileSync } from "node:fs";
import { writePrivateJson } from "../design/atomic-write.js";

/** The oldest ids go past this: a conversation resumed after so many new ones reads as not covered (fail closed). */
const KEPT = 1000;

/**
 * The Claude conversations and Codex threads started under masking (`<maskingFolder>/covered.json`): a later `--resume` of one of them is
 * covered, any other resume is not (spec § 9 bis, invariant 2). An unreadable or invalid file covers nothing.
 */
export class CoveredConversations {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  has(id: string): boolean {
    return this.read().includes(id);
  }

  /** Two adds run one after the other: neither drops the other's id. */
  add(id: string): Promise<void> {
    const run = this.queue.catch(() => {}).then(async () => {
      const ids = this.read().filter((x) => x !== id);
      await writePrivateJson(this.file, [...ids, id].slice(-KEPT));
    });
    this.queue = run;
    return run;
  }

  /** A conversation that revealed a value is no longer covered: resumed after the lift, its context holds the value. */
  remove(id: string): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => writePrivateJson(this.file, this.read().filter((x) => x !== id)));
    this.queue = run;
    return run;
  }

  private read(): string[] {
    try {
      const v: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
}
