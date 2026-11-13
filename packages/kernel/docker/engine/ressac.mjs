// The `ressac` API given to the widgets' code (harvest.mjs, `code` blocks): every access goes through a call to the kernel.
import { parseFeed } from "./feed.mjs";

/** A log line: texts as they are, the rest as JSON. */
export const format = (...a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

/**
 * `call(f, a)` sends a call to the kernel and waits for its answer; `log(...a)` receives the lines of
 * `ressac.log`; `input` (action only) becomes `ressac.input`.
 */
export function createRessac({ call, config, previous, now, log, input }) {
  async function sort(items, { question, text, threshold = 0.5, parallel = 8 } = {}) {
    const list = [...items];
    const scores = new Array(list.length);
    let next = 0;
    async function worker() {
      while (next < list.length) {
        const i = next++;
        const r = await call("kev", { state: String(text(list[i])), questions: { q: { type: "noul", instructions: question } } });
        const score = Number(r?.q?.noul);
        scores[i] = Number.isFinite(score) ? score : 0;
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, list.length)) }, worker));
    return list
      .map((element, i) => ({ element, score: scores[i] }))
      .filter((x) => x.score >= threshold)
      .sort((a, b) => b.score - a.score);
  }

  return {
    config,
    previous,
    now,
    // Action run with a text only: absent for a widget.
    ...(typeof input === "string" ? { input } : {}),
    readPage: (url, options = {}) => call("readPage", { url, account: options.account, scroll: options.scroll }),
    fetch: (url, options = {}) => call("fetch", { url, format: options.format ?? "text" }),
    searchWeb: (query, { count = 8 } = {}) => call("searchWeb", { query, count }),
    readFeed: async (url) => parseFeed(String(await call("fetch", { url, format: "text" }))),
    kev: (state, questions) => call("kev", { state, questions }),
    gemma: (prompt, options = {}) => call("gemma", { prompt, images: options.images, json: options.json }),
    sort,
    log,
  };
}
