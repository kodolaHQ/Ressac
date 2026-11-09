// list.new: the items whose key this block has not seen. Its memory: the seen keys with the date they were
// last seen (`[key, isoDate]`), from oldest to most recent, at most KEYS_MAX.
// An old memory made of texts (no dates) is read as dated `now`: nothing reappears all at once. With
// `keepDays`, a key seen longer ago is forgotten: it becomes new again and is not written back.
import { readPath } from "../templates.mjs";

export const KEYS_MAX = 5000;
/** A longer key is kept (and compared) cut to this length. */
export const KEY_MAX_LENGTH = 500;
export const DAY_MS = 86_400_000;

/** The key kept for a value (cut to KEY_MAX_LENGTH); null if absent. */
export const asKey = (v) =>
  v === undefined || v === null || v === ""
    ? null
    : (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, KEY_MAX_LENGTH);

/** The kept keys, by key, with their date; in memory order (a duplicate key keeps its last place). */
function readMemory(memory, now) {
  const seen = new Map();
  if (!Array.isArray(memory)) return seen;
  for (const entry of memory) {
    const [key, date] = typeof entry === "string" ? [entry, now] : Array.isArray(entry) ? entry : [];
    if (typeof key !== "string") continue;
    const k = key.slice(0, KEY_MAX_LENGTH);
    seen.delete(k);
    seen.set(k, typeof date === "string" && !Number.isNaN(Date.parse(date)) ? date : now);
  }
  return seen;
}

export default {
  perItem: "no",
  async run({ input, params, memory, log, now }) {
    if (!Array.isArray(input)) throw new Error("liste attendue en entrée");
    const instant = now ?? new Date().toISOString();
    const seen = readMemory(memory, instant);
    if (params.keepDays !== undefined) {
      const limit = Date.parse(instant) - params.keepDays * DAY_MS;
      for (const [key, date] of seen) if (Date.parse(date) < limit) seen.delete(key);
    }
    const seenThisTime = new Set();
    const newKeys = [];
    let withoutKey = 0;
    const output = input.filter((item) => {
      const key = asKey(readPath(item, params.key));
      // An item without a key cannot be recognized next time: it passes, without being kept.
      if (key === null) {
        withoutKey++;
        return true;
      }
      // Already seen before, or already passed higher up in this list: not new.
      const isNew = !seen.has(key) && !seenThisTime.has(key);
      seenThisTime.add(key);
      if (isNew) newKeys.push(key);
      return isNew;
    });
    if (withoutKey) log(`${withoutKey} élément(s) sans clé ${params.key}, gardés`);
    // The keys seen again this time become the most recent, dated now (an ad still online does not
    // come back); the oldest are forgotten beyond KEYS_MAX.
    const all = [
      ...[...seen].filter(([k]) => !seenThisTime.has(k)),
      ...[...seenThisTime].map((k) => [k, instant]),
    ];
    // `fullMemory` (before the cap) is used by the progressive run, which first removes the pending keys.
    return { output, memory: all.slice(-KEYS_MAX), newKeys, fullMemory: all };
  },
};
