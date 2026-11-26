// ai.sort: the agent's small model scores the whole list against the question in one `sort` call, then the block keeps
// the items whose score reaches the threshold, sorted by descending score, the score rounded to 2 decimals.
// The filled-in texts (coming from a page) are data the model scores, never instructions.
import { fill } from "../templates.mjs";

export const QUESTION_ITEM_FIELD = "La question du tri ne peut citer que des valeurs de la configuration, pas un champ d'élément.";

export default {
  perItem: "no",
  async run({ input, params, config, userInput, ressac, log }) {
    if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
    const { field = "score", threshold = 0.5 } = params;
    // One question for the whole list: from the config (and an action's text) only, never an item field.
    const q = fill(params.question, { item: undefined, config, input: userInput });
    if ("missing" in q) throw new Error(QUESTION_ITEM_FIELD);
    const question = q.text;
    // An item whose text misses a value is not scored and not kept.
    const filled = input.map((item) => ({ item, r: fill(params.text, { item, config, input: userInput }) }));
    const missing = filled.filter((x) => "missing" in x.r);
    if (missing.length) log(`${missing.length} élément(s) sans texte (valeur absente : ${missing[0].r.missing}) : non notés`);
    const scored = await ressac.sort(filled.filter((x) => "text" in x.r), { question, text: (x) => x.r.text, threshold });
    return { output: scored.map(({ element, score }) => ({ ...element.item, [field]: Math.round(score * 100) / 100 })) };
  },
};
