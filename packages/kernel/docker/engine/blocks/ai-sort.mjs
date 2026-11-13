// ai.sort: Kev scores each item (one question per item, today's `kev` call), then the block keeps
// those whose score reaches the threshold, sorted by descending score, the score rounded to 2 decimals.
// The filled-in text (coming from a page) is the state Kev scores, never an instruction.

export default {
  perItem: "always",
  // No score at all (Kev down): the sort fails clearly rather than returning an empty list.
  failIfAllFail: true,
  async processItem({ params, fill, ressac }) {
    const { text: state } = fill(params.text);
    const { text: instructions } = fill(params.question);
    const r = await ressac.kev(state, { q: { type: "noul", instructions } });
    const raw = r?.q?.noul;
    // Like `Number(...)` today, a number written as text is read; nothing, or anything else, is not a score.
    const score = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(score)) throw new Error("Kev n'a pas rendu de note");
    // The raw score is kept (and reused): the threshold applies to it, as today.
    return score;
  },
  async finalize(list, { params }) {
    const { field, threshold = 0.5 } = params;
    const scored = list
      .filter((e) => typeof e?.[field] === "number" && Number.isFinite(e[field]) && e[field] >= threshold)
      .sort((a, b) => b[field] - a[field]);
    return { output: scored.map((e) => ({ ...e, [field]: Math.round(e[field] * 100) / 100 })) };
  },
};
