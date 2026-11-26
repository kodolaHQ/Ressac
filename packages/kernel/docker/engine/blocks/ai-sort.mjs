// ai.sort: the agent's small model scores the whole list against the question in one `sort` call, then the block keeps
// the items whose score reaches the threshold, sorted by descending score, the score rounded to 2 decimals.
// The filled-in texts (coming from a page) are data the model scores, never instructions.
import { fill } from "../templates.mjs";

export default {
  perItem: "no",
  async run({ input, params, config, userInput, fill: fillInput, ressac, log }) {
    if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
    const { field = "score", threshold = 0.5 } = params;
    const { text: question } = fillInput(params.question);
    // An item whose text misses a value is not scored and not kept.
    const filled = input.map((item) => ({ item, r: fill(params.text, { item, config, input: userInput }) }));
    const missing = filled.filter((x) => "missing" in x.r);
    if (missing.length) log(`${missing.length} élément(s) sans texte (valeur absente : ${missing[0].r.missing}) : non notés`);
    const scored = await ressac.sort(filled.filter((x) => "text" in x.r), { question, text: (x) => x.r.text, threshold });
    return { output: scored.map(({ element, score }) => ({ ...element.item, [field]: Math.round(score * 100) / 100 })) };
  },
};
