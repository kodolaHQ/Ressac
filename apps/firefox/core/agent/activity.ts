/** The agent thinks between tools: what it last did stays shown this long after its last tool ends. */
export const ACTIVITY_HOLD_MS = 20_000;

/**
 * The tab the agent last acted on and what it did there (« Lit leboncoin.fr »). Shown while a tool runs, then
 * `holdMs` after the last one ends; gone at once when its tab closes (or turns private: the caller says `closed`).
 */
export function createActivity(now: () => number, holdMs = ACTIVITY_HOLD_MS) {
  let last: { tab: string; label: string } | null = null;
  const running = new Set<string>();
  let since = now();
  return {
    event(a: { tab: string; label: string }) {
      last = { tab: a.tab, label: a.label };
      since = now();
    },
    running(tab: string, on: boolean) {
      if (on) running.add(tab);
      else if (running.delete(tab)) since = now();
    },
    closed(tab: string) {
      running.delete(tab);
      if (last?.tab === tab) last = null;
    },
    state(): { tab: string; label: string; running: boolean } | null {
      if (!last || (running.size === 0 && now() - since > holdMs)) return null;
      return { ...last, running: running.has(last.tab) };
    },
  };
}
