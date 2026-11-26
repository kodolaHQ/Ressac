// The `ressac` API given to the widgets' code (harvest.mjs, `code` blocks): every access goes through a call to the kernel.
import { parseFeed } from "./feed.mjs";

/** A log line: texts as they are, the rest as JSON. */
export const format = (...a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");

/**
 * `call(f, a)` sends a call to the kernel and waits for its answer; `log(...a)` receives the lines of
 * `ressac.log`; `input` (action only) becomes `ressac.input`.
 */
export function createRessac({ call, config, previous, now, log, input }) {
  /**
   * The agent's small model scores the whole list against one question in a single `sort` call (the kernel
   * splits it); returns `{ element, score }` at or above `threshold`, by descending score. No call for no item.
   */
  async function sort(items, { question, text, threshold = 0.5 } = {}) {
    const list = [...items];
    if (!list.length) return [];
    // The kernel keeps 500 characters per text; 2000 and 4000 are its argument bounds.
    const scores = await call("sort", { question: String(question).slice(0, 2000), texts: list.map((e) => String(text(e)).slice(0, 4000)) });
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
    kev: () => {
      throw new Error("ressac.kev n'existe plus : utilise ressac.sort.");
    },
    gemma: (prompt, options = {}) => call("gemma", { prompt, images: options.images, json: options.json }),
    sort,
    log,
  };
}
