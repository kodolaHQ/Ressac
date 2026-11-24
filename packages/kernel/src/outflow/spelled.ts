import { DIGIT_WORDS } from "./digit-words.js";

const NATO = new Set(
  "alfa alpha bravo charlie delta echo foxtrot golf hotel india juliett juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" "),
);
// Romanised Japanese, Korean, Chinese and Russian digits: read in runs of 3 only, they are ordinary short words alone.
const ROMAN: Record<string, number> = {
  zero: 0, rei: 0, ichi: 1, ni: 2, san: 3, shi: 4, yon: 4, go: 5, roku: 6, shichi: 7, nana: 7, hachi: 8, kyu: 9, kyuu: 9,
  yeong: 0, gong: 0, il: 1, i: 2, sam: 3, sa: 4, o: 5, yuk: 6, chil: 7, pal: 8, gu: 9,
  ling: 0, yi: 1, er: 2, si: 4, wu: 5, liu: 6, qi: 7, ba: 8, jiu: 9,
  nol: 0, nul: 0, odin: 1, dva: 2, tri: 3, chetyre: 4, pyat: 5, shest: 6, sem: 7, vosem: 8, devyat: 9,
};
const DIGIT_CJK: Record<string, number> = { "〇": 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const DIGIT_HANGUL: Record<string, number> = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
// 3 or more numerals of one script or ASCII digits, glued or apart: a lone numeral (一緒, the particle 이) is an
// ordinary word. A run without a numeral is left alone by the caller.
const cjkRun = (set: string) => new RegExp(`[${set}0-9](?:[^\\p{L}\\p{N}]*[${set}0-9]){2,}`, "gu");
const CJK_RUNS = [
  [cjkRun(Object.keys(DIGIT_CJK).join("")), DIGIT_CJK],
  [cjkRun(Object.keys(DIGIT_HANGUL).join("")), DIGIT_HANGUL],
] as const;

// 3 or more single letters apart by one space (s e p t).
const SPACED = /(?<![\p{L}\p{M}])\p{L}(?: \p{L}(?![\p{L}\p{M}])){2,}(?![\p{L}\p{M}])/u;

// Own keys only: a plain object also answers « constructor » or « valueOf » from its prototype.
const own = (table: Record<string, number>, w: string) => (Object.hasOwn(table, w) ? table[w] : undefined);

const WORD_MAX = Math.max(...Object.keys(DIGIT_WORDS).map((w) => w.length));
const TOKEN_MAX = 200;

// Lowercase, no apostrophes, accents removed after a Latin or Greek letter only: Indic vowel signs are part of their letters.
export const fold = (s: string) =>
  s.toLowerCase().replace(/['\u2019\u02bc]/g, "").normalize("NFD").replace(/([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu, "$1").normalize("NFC");

/** The ASCII value of a decimal digit of any script: Unicode keeps each script's 0-9 contiguous, runs start at 0. */
export function ascii(d: string): string {
  const cp = d.codePointAt(0)!;
  let k = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(cp - k - 1))) k++;
  return String(k % 10);
}

/**
 * `word` alone is a digit word of the table or a NATO word (own keys only: « constructor » is no digit). Romanised
 * digits are left out: alone they are ordinary short words (il, si, go).
 */
export function digitWord(word: string): boolean {
  const w = fold(word);
  return Object.hasOwn(DIGIT_WORDS, w) || NATO.has(w);
}

/** The digits a token is made of when it splits entirely into 3 or more digit words, longest word first. */
function glued(token: string): string | undefined {
  if (token.length > TOKEN_MAX) return undefined;
  let digits = "";
  let count = 0;
  for (let i = 0; i < token.length; count++) {
    let n = 0;
    for (let len = Math.min(WORD_MAX, token.length - i); len >= 2 && !n; len--) {
      const d = own(DIGIT_WORDS, token.slice(i, i + len));
      if (d !== undefined) {
        digits += d;
        i += len;
        n = len;
      }
    }
    if (!n) return undefined;
  }
  return count >= 3 ? digits : undefined;
}

/**
 * `text` with digits written as words, spaced-out letters and NATO words read as what they spell, or undefined.
 * A word read two ways (Danish ni = 9, Japanese ni = 2; Indonesian lima = 5, NATO l) gives both rewrites, joined by a space.
 */
export function spelled(text: string): string | undefined {
  // Spaced letters are also read unglued, romanised first: in « B X i i gu il » the « i » are digits, not letters.
  const all = [rewrite(text, true), rewrite(text, false), SPACED.test(text) ? rewrite(text, false, false) : undefined];
  const outs = [...new Set(all.filter((r) => r !== undefined))];
  return outs.length ? outs.join(" ") : undefined;
}

/**
 * One reading of `text` (`tableFirst`: digit words before NATO and romanised digits; `glue`: spaced letters glued), or
 * undefined if nothing changed.
 */
export function rewrite(text: string, tableFirst: boolean, glue = true): string | undefined {
  let changed = false;
  const edit = (s: string, re: RegExp, to: (m: string) => string) =>
    s.replace(re, (m) => {
      changed = true;
      return to(m);
    });
  // Zero-width characters inside a word (tr\u200bois) are dropped; digits of other scripts (٣, ३) are read as ASCII.
  let t = edit(text.replace(/\p{Cf}/gu, ""), /(?![0-9])\p{Nd}/gu, ascii);
  // Spaced letters (s e p t) are glued even when they spell no digit: a spaced-out word is still the word.
  if (glue) t = edit(t, new RegExp(SPACED, "gu"), (m) => m.replaceAll(" ", ""));
  t = fold(t);
  t = edit(t, /(?<!\p{L})x[ -]ray(?!\p{L})/gu, () => "xray");
  for (const [re, set] of CJK_RUNS)
    t = t.replace(re, (m) => {
      // Digits alone (2024 3 15) are no numeral run: the digits are already there.
      if (![...m].some((c) => Object.hasOwn(set, c))) return m;
      changed = true;
      return [...m].map((c) => (Object.hasOwn(set, c) ? String(set[c]) : /[0-9]/.test(c) ? c : "")).join("");
    });
  const tokens = t.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  // One entry per token: what it reads as, and whether it is a single word (NATO, digit or romanised) that can join a run.
  const read = tokens.map((w) => {
    const nato = NATO.has(w) && !(tableFirst && Object.hasOwn(DIGIT_WORDS, w));
    const d = nato ? undefined : tableFirst ? (own(DIGIT_WORDS, w) ?? own(ROMAN, w)) : (own(ROMAN, w) ?? own(DIGIT_WORDS, w));
    if (nato) return { out: w[0]!, run: true };
    if (d !== undefined) return { out: String(d), run: true };
    // A numeral joins a run (3 huit 1 six), so mixing forms does not break it.
    if (/^\p{Nd}+$/u.test(w)) return { out: w, run: true, digit: true };
    const g = glued(w);
    if (g) changed = true;
    return { out: g ?? w, run: false };
  });
  const out: string[] = [];
  for (let i = 0; i < read.length; ) {
    let j = i;
    while (j < read.length && read[j]!.run) j++;
    // A run of bare numerals only (4-4-2) is no rewrite: the digits are already there.
    if (j - i >= 3 && read.slice(i, j).some((r) => !("digit" in r))) {
      changed = true;
      out.push(read.slice(i, j).map((r) => r.out).join(""));
      i = j;
    } else if (j > i) {
      // Too short to be a run: the words stay words.
      for (; i < j; i++) out.push(tokens[i]!);
    } else {
      out.push(read[i]!.out);
      i++;
    }
  }
  return changed ? out.join(" ") : undefined;
}
