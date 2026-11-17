import type { LlamaModel } from "../../../packages/kernel/src/index.ts";
import type { History } from "../core/history.ts";
import type { AskHit, AskResult } from "../shared/model.ts";
import { parseAsk } from "./ask-rules.ts";
import { llamaEmbed } from "./page-indexer.ts";

// The ⌘T bar's Demander mode: rules read the period, video sites and action requests, the search model ranks the
// history's pages by meaning (a French question finds an English page). Values measured in bench-cmdt/v4.

const AGENT: AskResult = { kind: "agent" };
/** Cosine under which a page is not shown: the nearest pages are shown even when the asked one is missing. */
const MIN_SCORE = 0.3;
const QUERY = "task: search result | query: ";

export function createAsk(o: {
  embed: Pick<LlamaModel, "ready" | "warm" | "installed">;
  history: () => Pick<History, "findSimilar"> | null;
  now?: () => Date;
  timeoutMs?: number;
}) {
  const now = o.now ?? (() => new Date());
  const timeoutMs = o.timeoutMs ?? 4000;
  const embed = llamaEmbed(() => o.embed.ready());
  return {
    async usable(): Promise<boolean> {
      return o.embed.installed();
    },
    warm(): void {
      o.embed.warm();
    },
    async find(question: string): Promise<AskResult> {
      const history = o.history();
      if (!history) return AGENT;
      const q = parseAsk(question, now());
      if (q.action) return AGENT;
      let timer: NodeJS.Timeout | undefined;
      // A cold or slow server is given up at the budget: the agent answers instead.
      const timeout = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error("timeout")), timeoutMs)));
      let vec: Float32Array;
      try {
        [vec] = (await Promise.race([embed([QUERY + q.rest]), timeout])) as [Float32Array];
      } catch {
        return AGENT;
      } finally {
        clearTimeout(timer);
      }
      const hits: AskHit[] = history
        .findSimilar(vec, { since: q.since, until: q.until, sites: q.sites, limit: 3 })
        .filter((r) => r.score >= MIN_SCORE)
        .map((r) => ({ url: r.url, title: r.title, lastVisit: r.lastVisit, excerpt: r.excerpt || null, favicon: r.favicon }));
      return hits.length ? { kind: "page", hits } : AGENT;
    },
  };
}
