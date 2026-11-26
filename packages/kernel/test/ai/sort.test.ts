import { expect, test } from "vitest";
import { SORT_CHUNK, SORT_TEXT_MAX, rescale, sortPrompt, sortScores } from "../../src/ai/sort.js";

const signal = new AbortController().signal;
/** A fake writer: `answer(prompt)` per call, every prompt kept. */
function writer(answer: (prompt: string) => unknown) {
  const prompts: string[] = [];
  const json: (boolean | undefined)[] = [];
  return {
    prompts,
    json,
    ai: { gemma: async (o: { prompt: string; json?: boolean }) => (prompts.push(o.prompt), json.push(o.json), answer(o.prompt)) },
  };
}
/** The item count of a sort prompt. */
const count = (p: string) => Number(/from 1 to (\d+),/.exec(p)![1]);
const keyed = (values: number[]) => ({ scores: Object.fromEntries(values.map((v, i) => [String(i + 1), v])) });

test("SORT_CHUNK is 50 and SORT_TEXT_MAX 500", () => {
  expect(SORT_CHUNK).toBe(50);
  expect(SORT_TEXT_MAX).toBe(500);
});

test("no text, no call", async () => {
  const w = writer(() => ({ scores: {} }));
  expect(await sortScores(w.ai, { question: "q", texts: [] }, signal)).toEqual([]);
  expect(w.prompts).toEqual([]);
});

test("51 texts make two calls and stay aligned", async () => {
  // Each slot answers (its number - 1) / 1000: the second call's first slot is 0.
  const w = writer((p) => keyed(Array.from({ length: count(p) }, (_, i) => i / 1000)));
  const texts = Array.from({ length: 51 }, (_, i) => `t${i}`);
  const r = await sortScores(w.ai, { question: "q", texts }, signal);
  expect(w.prompts.map(count)).toEqual([50, 1]);
  expect(w.json).toEqual([true, true]);
  expect(w.prompts[1]).toContain("\n1. t50");
  expect(r).toHaveLength(51);
  r.slice(0, 50).forEach((v, i) => expect(v).toBeCloseTo(rescale(i / 1000)));
  expect(r[50]).toBe(0);
});

test("the rescale maps 0, 0.25, 0.5, 0.75, 1 to 0, 0.3, 0.6, 0.8, 1", () => {
  expect([0, 0.25, 0.5, 0.75, 1].map(rescale).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.3, 0.6, 0.8, 1]);
});

test("the scores come back rescaled, so the block's threshold sees the rescaled value", async () => {
  const w = writer(() => keyed([0.5, 0.45]));
  const [a, b] = await sortScores(w.ai, { question: "q", texts: ["a", "b"] }, signal);
  // Raw 0.5 reaches a 0.6 threshold once rescaled; raw 0.45 (0.54) does not.
  expect(a).toBeGreaterThanOrEqual(0.6);
  expect(b).toBeLessThan(0.6);
});

test("wrong length fails", async () => {
  await expect(sortScores(writer(() => keyed([0.5])).ai, { question: "q", texts: ["a", "b"] }, signal)).rejects.toThrow("not return a score for each item");
  await expect(sortScores(writer(() => keyed([0.5, 0.5, 0.5])).ai, { question: "q", texts: ["a", "b"] }, signal)).rejects.toThrow("not return a score for each item");
});

test("a missing, extra or non-numeric key fails", async () => {
  for (const scores of [{ "1": 0.5, "3": 0.5 }, { "0": 0.5, "1": 0.5 }, { "1": 0.5, "2": "0.5" }, { a: 0.5, b: 0.5 }]) {
    await expect(sortScores(writer(() => ({ scores })).ai, { question: "q", texts: ["a", "b"] }, signal)).rejects.toThrow("not return a score for each item");
  }
  // The old array shape is refused too.
  await expect(sortScores(writer(() => ({ scores: [0.5, 0.5] })).ai, { question: "q", texts: ["a", "b"] }, signal)).rejects.toThrow("not return a score for each item");
});

test("a score above 1 fails", async () => {
  await expect(sortScores(writer(() => keyed([0.5, 1.2])).ai, { question: "q", texts: ["a", "b"] }, signal)).rejects.toThrow("not return a score for each item");
});

test("the error follows the locale", async () => {
  await expect(sortScores(writer(() => ({})).ai, { question: "q", texts: ["a"] }, signal, "fr")).rejects.toThrow("Le modèle n'a pas rendu une note par élément.");
});

test("a fenced JSON answer is accepted", async () => {
  const w = writer(() => "```json\n" + JSON.stringify(keyed([1])) + "\n```");
  expect(await sortScores(w.ai, { question: "q", texts: ["a"] }, signal)).toEqual([1]);
});

test("a text is cut at 500 characters and loses its newlines", () => {
  const p = sortPrompt("Q ?", ["a\nb\r\nc\u2028d\u2029e\u0085f\vg\fh", "x".repeat(600)]);
  expect(p).toContain("\nQuestion: Q ?\nItems:\n1. a b c d e f g h\n2. " + "x".repeat(500));
  expect(p).not.toContain("x".repeat(501));
  expect(p).toContain("from 1 to 2,");
  expect(p.startsWith("Score each numbered item for the question below.")).toBe(true);
});

test("a question holding a placeholder is not filled again", () => {
  expect(sortPrompt("{items} {n}", ["a"])).toContain("Question: {items} {n}\nItems:\n1. a");
});
