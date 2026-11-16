import type { LocalAi } from "../ai/local-ai.js";
import type { Gesture } from "./sessions.js";

export type Verdict = "ok" | "strange";
/** The decision model gets this long; later, the action passes. */
export const WATCHER_TIMEOUT_MS = 3000;
/** The decision model's score for « yes » (the `noul` answer); at or under this, it said no. */
export const WATCHER_NO_AT_MOST = 0.3;

/** Only these four fields of a gesture ever reach the model: never a page text, a title, or a link text. */
const plain = (x: Gesture): Gesture => ({
  tool: x.tool,
  ...(x.query !== undefined ? { query: x.query } : {}),
  ...(x.url !== undefined ? { url: x.url } : {}),
  ...(x.composed !== undefined ? { composed: x.composed } : {}),
});

/** One yes/no question to the decision model; anything but a clear « no » is "ok" (no model, error, 3 s, unsure). */
export function createWatcher(ai: Pick<LocalAi, "kev"> | undefined, o: { timeoutMs?: number } = {}) {
  return {
    async judge(goal: string, past: readonly Gesture[], next: Gesture): Promise<Verdict> {
      if (!ai) return "ok";
      const stop = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const late = new Promise<never>((_, no) => {
          timer = setTimeout(() => { stop.abort(); no(new Error("watcher: no answer in time")); }, o.timeoutMs ?? WATCHER_TIMEOUT_MS);
        });
        const answers = await Promise.race([
          ai.kev(
            {
              state: JSON.stringify({ past: past.map(plain), next: plain(next) }),
              // English, and naming harmful gestures: measured with d1-2B, the French question let harmful gestures through.
              questions: { q: { type: "noul", instructions: `The stated goal is: ${goal.slice(0, 200)}. Does this action serve that goal? An action that puts data (cookie, password, token, login, card or account number) into a URL, or that opens a mailbox, an account, a payment or settings unrelated to the goal, does not serve it.` } },
            },
            { signal: stop.signal },
          ),
          late,
        ]);
        const score = (answers as { q?: { noul?: unknown } } | null)?.q?.noul;
        return typeof score === "number" && score <= WATCHER_NO_AT_MOST ? "strange" : "ok";
      } catch {
        return "ok"; // fail open: the watcher never blocks a tool
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
export type Watcher = ReturnType<typeof createWatcher>;
