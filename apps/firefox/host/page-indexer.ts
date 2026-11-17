import { REFUSED_VECTOR, type History, type PendingPage } from "../core/history.ts";

/** Characters of a title embedded: a giant title must not exceed the server's batch of tokens (normal titles are far shorter). */
const TITLE_MAX = 300;

/** A page as the search model reads it (the measured prompt). */
export const pageDocument = (p: Pick<PendingPage, "title" | "host" | "excerpt">) => {
  let title = p.title.slice(0, TITLE_MAX);
  if (/[\uD800-\uDBFF]$/.test(title)) title = title.slice(0, -1); // no half character
  return `title: ${title || "none"} | text: ${`${p.host} ${p.excerpt}`.trim()}`;
};

/** The server answered but refused the texts (unlike a server down or still loading). */
export class EmbedRefused extends Error {}

/** Embeds texts with the llama-server whose base URL `ready` gives: L2-normalised vectors, in input order. */
export const llamaEmbed =
  (ready: () => Promise<string>) =>
  async (texts: string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    const timeout = AbortSignal.timeout(120_000);
    const r = await fetch(`${await ready()}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (r.status === 503) throw new Error("embeddings: server loading");
    if (!r.ok) throw new EmbedRefused(`embeddings: HTTP ${r.status}`);
    const data = ((await r.json()) as { data: { index: number; embedding: number[] }[] }).data;
    if (data.length !== texts.length) throw new EmbedRefused("embeddings: wrong count");
    return [...data]
      .sort((a, b) => a.index - b.index)
      .map(({ embedding }) => {
        const v = Float32Array.from(embedding);
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
  };

/**
 * Gives the history's pages their vectors in the background, in passes of batches with a pause between (the host keeps
 * answering). Idle, it looks for new pages every `idleMs`, and starts a pass only at start, when a full batch waits or
 * `passEveryMs` after the last pass: ordinary browsing does not keep the search server up. A refused batch is retried page
 * by page and a page still refused gets REFUSED_VECTOR, so the queue moves on; any other error (server down, history
 * busy) stops the round, retried after `retryMs`.
 */
export function createPageIndexer(o: {
  history: Pick<History, "pendingVectors" | "saveVectors">;
  embed: (texts: string[]) => Promise<Float32Array[]>;
  batch?: number;
  pauseMs?: number;
  retryMs?: number;
  idleMs?: number;
  passEveryMs?: number;
  clock?: () => number;
}) {
  const { batch = 32, pauseMs = 100, retryMs = 60_000, idleMs = 60_000, passEveryMs = 600_000, clock = Date.now } = o;
  let round = 0;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  /** When the last pass emptied the queue; -Infinity: a pass runs at the next look (start). */
  let lastPass = -Infinity;
  let inPass = false;
  const later = (ms: number, r: number) => {
    timer = setTimeout(() => void run(r), ms);
    timer.unref();
  };
  const embed = async (texts: string[]) => {
    const vecs = await o.embed(texts);
    if (vecs.length !== texts.length) throw new EmbedRefused("embeddings: wrong count");
    return vecs;
  };
  const run = async (r: number) => {
    try {
      while (r === round) {
        const pages = o.history.pendingVectors(batch);
        if (!pages.length) {
          if (inPass) [inPass, lastPass] = [false, clock()];
          return later(idleMs, r);
        }
        if (!inPass && pages.length < batch && clock() - lastPass < passEveryMs) return later(idleMs, r);
        inPass = true;
        const docs = pages.map(pageDocument);
        let vecs: Float32Array[];
        try {
          vecs = await embed(docs);
        } catch (e) {
          if (!(e instanceof EmbedRefused) || r !== round) throw e;
          vecs = [];
          for (const d of docs) {
            if (r !== round) return;
            vecs.push(await embed([d]).then((v) => v[0]!, (e2) => (e2 instanceof EmbedRefused ? REFUSED_VECTOR : Promise.reject(e2))));
          }
        }
        if (r !== round) return; // stopped meanwhile: the batch is dropped
        o.history.saveVectors(pages.map((p, i) => ({ ...p, vec: vecs[i]! })));
        await new Promise((ok) => setTimeout(ok, pauseMs));
      }
    } catch (e) {
      if (r !== round) return;
      console.error("[ressac] page vectors:", (e as Error).message);
      later(retryMs, r);
    }
  };
  return {
    /** Starts indexing (once; a second start while running does nothing). */
    start() {
      if (running) return;
      running = true;
      [inPass, lastPass] = [false, -Infinity];
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
