import type { Workshop, WriterAgent } from "../../../packages/kernel/src/index.ts";
import { AGENT_ACCOUNTS } from "./settings.ts";

const TTL_MS = 5 * 60_000;

/** Which agent writes: the preferred one if signed in, else the other, else none. Never starts the workshop. */
export function createWriterChoice(o: { workshop: Pick<Workshop, "state" | "exec">; preferred(): WriterAgent; now?(): number }) {
  const now = o.now ?? Date.now;
  const cache = new Map<WriterAgent, { at: number; in: boolean }>();
  const signedIn = async (a: WriterAgent): Promise<boolean> => {
    const hit = cache.get(a);
    if (hit && now() - hit.at < TTL_MS) return hit.in;
    const account = AGENT_ACCOUNTS.find((x) => x.id === a)!;
    let ok = false;
    try {
      ok = account.parse(await o.workshop.exec(account.status)).loggedIn;
    } catch {}
    cache.set(a, { at: now(), in: ok });
    return ok;
  };
  return {
    async agent(): Promise<WriterAgent | null> {
      if ((await o.workshop.state()) !== "demarre") return null;
      const first = o.preferred();
      for (const a of [first, first === "claude" ? "codex" : "claude"] as const) if (await signedIn(a)) return a;
      return null;
    },
    reset: () => cache.clear(),
    signedOut: (a: WriterAgent) => void cache.delete(a),
  };
}
