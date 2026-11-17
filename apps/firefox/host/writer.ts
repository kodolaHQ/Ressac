import type { Workshop, WriterAgent } from "../../../packages/kernel/src/index.ts";
import { AGENT_ACCOUNTS } from "./settings.ts";

const TTL_MS = 5 * 60_000;

/** Which agent writes: the preferred one if signed in, else the other, else none; "workshop-stopped" when its accounts cannot be read. Never starts the workshop. */
export function createWriterChoice(o: { workshop: Pick<Workshop, "state" | "exec">; preferred(): WriterAgent; now?(): number }) {
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
  return {
    /** `exclude`: agents whose call answered "not signed in" while their status still says signed in (a dead token). */
    async agent(exclude?: ReadonlySet<WriterAgent>): Promise<WriterAgent | "workshop-stopped" | null> {
      if ((await o.workshop.state()) !== "demarre") return "workshop-stopped";
      const first = o.preferred();
      for (const a of [first, first === "claude" ? "codex" : "claude"] as const) if (!exclude?.has(a) && (await signedIn(a))) return a;
      return null;
    },
    reset: () => cache.clear(),
    signedOut: (a: WriterAgent) => void cache.delete(a),
  };
}
