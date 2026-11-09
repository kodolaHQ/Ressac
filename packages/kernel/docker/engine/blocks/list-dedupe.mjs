// list.dedupe: the first one is kept; an item is a duplicate if one of its normalized keys has already been seen.
import { readPath } from "../templates.mjs";
import { normalizedKey } from "../normalize.mjs";

export default {
  perItem: "no",
  async run({ input, params }) {
    if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
    const seen = params.keys.map(() => new Set());
    const output = [];
    for (const item of input) {
      const keys = params.keys.map((path) => normalizedKey(readPath(item, path)));
      if (keys.some((k, i) => k && seen[i].has(k))) continue;
      keys.forEach((k, i) => k && seen[i].add(k));
      output.push(item);
    }
    return { output };
  },
};
