import type { Workshop, WriterAgent } from "../../../packages/kernel/src/index.ts";
import { AGENT_ACCOUNTS, startedWithin } from "./settings.ts";

const TTL_MS = 5 * 60_000;

/**
 * Which agent writes: the preferred one if signed in, else the other, else none; "workshop-stopped" when its accounts
 * cannot be read. `agent` never starts the workshop; `wakeAgent`, for a write, starts it when Ressac's machine is stopped (unless removed or failing).
 */
export function createWriterChoice(o: { workshop: Pick<Workshop, "state" | "exec" | "ensureStarted" | "harvestReady">; preferred(): WriterAgent; now?(): number }) {
  const now = o.now ?? Date.now;
  // The in-flight promise is cached, so parallel cold calls share one status exec; a failed check is not kept.
  const cache = new Map<WriterAgent, { at: number; in: Promise<boolean> }>();
  const signedIn = (a: WriterAgent): Promise<boolean> => {
    const hit = cache.get(a);
    if (hit && now() - hit.at < TTL_MS) return hit.in;
    const account = AGENT_ACCOUNTS.find((x) => x.id === a)!;
    const entry = { at: now(), in: o.workshop.exec(account.status).then((r) => account.parse(r).loggedIn) };
    cache.set(a, entry);
    const forget = () => void (cache.get(a) === entry && cache.delete(a));
    entry.in = entry.in.catch(() => (forget(), false));
    return entry.in;
  };
  const choice = {
    /** `exclude`: agents whose call answered "not signed in" while their status still says signed in (a dead token). */
    async agent(exclude?: ReadonlySet<WriterAgent>): Promise<WriterAgent | "workshop-stopped" | null> {
      if ((await o.workshop.state()) !== "started") return "workshop-stopped";
      const first = o.preferred();
      for (const a of [first, first === "claude" ? "codex" : "claude"] as const) if (!exclude?.has(a) && (await signedIn(a))) return a;
      return null;
    },
    async wakeAgent(exclude?: ReadonlySet<WriterAgent>): Promise<WriterAgent | "workshop-stopped" | null> {
      // A machine the user removed, or one failing, waits for them: a background write (a watch) never installs or boots it.
      if ((await o.workshop.state()) === "machine-stopped" && (await o.workshop.harvestReady())) await startedWithin(o.workshop.ensureStarted(), null); // still stopped: agent says so
      return choice.agent(exclude);
    },
    reset: () => cache.clear(),
    signedOut: (a: WriterAgent) => void cache.delete(a),
  };
  return choice;
}
