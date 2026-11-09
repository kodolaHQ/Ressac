// list.keep: the first N items.
export default {
  perItem: "no",
  async run({ input, params }) {
    if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
    return { output: input.slice(0, params.count) };
  },
};
