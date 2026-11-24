import { fold } from "../outflow/spelled.js";

type Word = { unit: number } | { tens: number } | { teen: number } | { mult: number } | "and";
const WORDS: Record<string, Word> = {};
const add = (names: string, make: (i: number) => Word, from = 0) =>
  names.split(" ").forEach((n, i) => (WORDS[n] = make(i + from)));
add("zero un deux trois quatre cinq six sept huit neuf", (unit) => ({ unit }));
add("zero one two three four five six seven eight nine", (unit) => ({ unit }));
WORDS.une = { unit: 1 };
add("dix onze douze treize quatorze quinze seize", (teen) => ({ teen }), 10);
add("ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", (teen) => ({ teen }), 10);
add("vingt trente quarante cinquante soixante", (i) => ({ tens: (i + 2) * 10 }));
add("twenty thirty forty fifty sixty seventy eighty ninety", (i) => ({ tens: (i + 2) * 10 }));
for (const [w, mult] of [["cent", 100], ["mille", 1e3], ["million", 1e6], ["hundred", 100], ["thousand", 1e3]] as const) WORDS[w] = { mult };
WORDS.et = WORDS.and = "and";

type Tok = { w: Word; start: number; end: number; token: string };

/**
 * The numbers of a run of compound number words, written one after the other: a word that cannot extend the current
 * number starts the next one (« trois cent quatre-vingt-un six cent vingt-quatre » → 381624, « zéro six douze » → 0612).
 */
function value(toks: Tok[]): string {
  let out = "";
  let total = 0;
  let cur = 0;
  let prev = "";
  let last: "" | "unit" | "teen" | "tens" | "mult" = "";
  for (const { w, token } of toks) {
    if (w === "and") continue;
    const kind = "unit" in w ? "unit" : "teen" in w ? "teen" : "tens" in w ? "tens" : "mult";
    const quatreVingt = kind === "tens" && token.startsWith("vingt") && prev === "quatre";
    const fresh =
      (kind === "unit" && (last === "unit" || (last === "teen" && prev !== "dix") || (last === "tens" && cur % 10 !== 0))) ||
      (kind === "teen" && (last === "unit" || last === "teen" || (last === "tens" && cur % 10 !== 0))) ||
      (kind === "tens" && !quatreVingt && (last === "unit" || last === "teen" || last === "tens")) ||
      (kind === "mult" && "mult" in w && w.mult === 100 && cur >= 100);
    if (fresh) {
      out += String(total + cur);
      total = cur = 0;
    }
    if ("unit" in w) cur += w.unit;
    else if ("teen" in w) cur += w.teen;
    // quatre-vingt: the 4 already added becomes 4 × 20.
    else if ("tens" in w) cur = quatreVingt ? cur - 4 + 80 : cur + w.tens;
    else if (w.mult === 100) cur = (cur % 100 || 1) * 100;
    else if (w.mult === 1e3) (total += (cur || 1) * 1e3), (cur = 0);
    else (total = (total + cur || 1) * 1e6), (cur = 0);
    prev = token;
    last = kind;
  }
  return out + String(total + cur);
}

/**
 * Each run of French or English number words read as a digit string, with its span in `text`. A run of single digit
 * words needs 4 words; whether a code word is near is the detector's call. shortcut: a compound run of one word
 * (« vingt ») gives nothing, upgrade if a lone number word must be matched.
 */
export function numerals(text: string): { digits: string; start: number; end: number }[] {
  const toks: Tok[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const token = fold(m[0]).replace(/^(vingt|cent)s$/, "$1");
    const w = Object.hasOwn(WORDS, token) ? WORDS[token] : undefined;
    toks.push({ w: w ?? ({ unit: -1 } as Word), start: m.index, end: m.index + m[0].length, token: w ? token : "" });
  }
  const out: { digits: string; start: number; end: number }[] = [];
  for (let i = 0; i < toks.length; ) {
    if (!toks[i]!.token || toks[i]!.w === "and") {
      i++;
      continue;
    }
    // Extend over numeral words joined by spaces, commas or hyphens only (« zéro six, douze, trente-quatre »).
    let j = i + 1;
    while (j < toks.length && toks[j]!.token && /^[\s,-]+$/.test(text.slice(toks[j - 1]!.end, toks[j]!.start))) j++;
    while (toks[j - 1]!.w === "and") j--;
    const run = toks.slice(i, j);
    const start = run[0]!.start;
    const end = run[run.length - 1]!.end;
    const plain = run.every((t) => typeof t.w === "object" && "unit" in t.w);
    if (plain) {
      if (run.length >= 4) out.push({ digits: run.map((t) => (t.w as { unit: number }).unit).join(""), start, end });
    } else if (run.length >= 2) out.push({ digits: value(run), start, end });
    i = j;
  }
  return out;
}
