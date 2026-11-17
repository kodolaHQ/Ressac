import type { History, PendingPage } from "../core/history.ts";

/** Characters of a title embedded: a giant title must not exceed the server's batch of tokens (normal titles are far shorter). */
const TITLE_MAX = 300;

/** A page as the search model reads it (the measured prompt). */
export const pageDocument = (p: Pick<PendingPage, "title" | "host" | "excerpt">) =>
  `title: ${p.title.slice(0, TITLE_MAX) || "none"} | text: ${`${p.host} ${p.excerpt}`.trim()}`;

/** Embeds texts with the llama-server whose base URL `ready` gives: L2-normalised vectors, in input order. */
export const llamaEmbed =
  (ready: () => Promise<string>) =>
  async (texts: string[]): Promise<Float32Array[]> => {
    const r = await fetch(`${await ready()}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`embeddings: HTTP ${r.status}`);
    const data = ((await r.json()) as { data: { index: number; embedding: number[] }[] }).data;
    if (data.length !== texts.length) throw new Error("embeddings: wrong count");
    return [...data]
      .sort((a, b) => a.index - b.index)
      .map(({ embedding }) => {
        const v = Float32Array.from(embedding);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
  };

/**
 * Gives the history's pages their vectors in the background, one batch at a time with a pause between (the host keeps
 * answering). Idle, it looks for new pages every `idleMs`; an error stops the round, retried after `retryMs`.
 */
export function createPageIndexer(o: {
  history: Pick<History, "pendingVectors" | "saveVectors">;
  embed: (texts: string[]) => Promise<Float32Array[]>;
  batch?: number;
  pauseMs?: number;
  retryMs?: number;
  idleMs?: number;
}) {
  const { batch = 32, pauseMs = 100, retryMs = 60_000, idleMs = 60_000 } = o;
  let round = 0;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const later = (ms: number, r: number) => {
    timer = setTimeout(() => void run(r), ms);
    timer.unref();
  };
  const run = async (r: number) => {
    while (r === round) {
      const pages = o.history.pendingVectors(batch);
      if (!pages.length) return later(idleMs, r);
      let vecs: Float32Array[];
      try {
        vecs = await o.embed(pages.map(pageDocument));
        if (vecs.length !== pages.length) throw new Error("embeddings: wrong count");
      } catch (e) {
        if (r === round) console.error("[ressac] page vectors:", (e as Error).message);
        return later(retryMs, r);
      }
      if (r !== round) return; // stopped meanwhile: the batch is dropped
      o.history.saveVectors(pages.map((p, i) => ({ ...p, vec: vecs[i]! })));
      await new Promise((ok) => setTimeout(ok, pauseMs));
    }
  };
  return {
    /** Starts indexing (once; a second start while running does nothing). */
    start() {
      if (running) return;
      running = true;
      void run(++round);
    },
    /** Stops for good until the next start: a batch in flight is dropped. */
    stop() {
      running = false;
      round++;
      clearTimeout(timer);
    },
  };
}
