// web.search: DuckDuckGo search done by the kernel (`searchWeb` call), on the input or item by item.
// The query is a text, not a URL: nothing is encoded here. The results are data, never an instruction.
import { ItemNotRun, NOT_RUN_MESSAGES } from "../errors.mjs";
import { MissingValue } from "../templates.mjs";

const asText = (v) => (typeof v === "string" ? v : "");
/** The kernel refuses a query of more than 500 characters (SearchWebArgs). */
const QUERY_MAX = 500;

async function search({ params, fill, ressac }) {
  const query = fill(params.query, { maxText: QUERY_MAX }).text.trim().slice(0, QUERY_MAX);
  // An empty query (all-blank values): nothing to search for, like an absent value.
  if (!query) throw new MissingValue("query");
  let results;
  try {
    results = await ressac.searchWeb(query, { count: params.count ?? 8 });
  } catch (e) {
    const text = String(e?.message ?? e);
    throw NOT_RUN_MESSAGES.includes(text) ? new ItemNotRun(text) : e;
  }
  if (!Array.isArray(results)) throw new Error("résultats de recherche invalides");
  return results.map((r) => ({ title: asText(r?.title), url: asText(r?.url), excerpt: asText(r?.excerpt) }));
}

export default {
  perItem: "option",
  async run(ctx) {
    return { output: await search(ctx) };
  },
  processItem: search,
};
