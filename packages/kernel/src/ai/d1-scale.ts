/** d1 "yes" score → pplx-decider-flash scale; fitted by quantile matching on 365 widget items and 40 watcher gestures, checked on a held-out set. */
export const D1_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.259, 0.3],
  [0.354, 0.5],
  [0.406, 0.6],
  [1, 1],
];

function map(d: number): number {
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  const i = D1_ANCHORS.findIndex(([x]) => d <= x);
  const [x0, y0] = D1_ANCHORS[i - 1];
  const [x1, y1] = D1_ANCHORS[i];
  return y0 + ((d - x0) / (x1 - x0)) * (y1 - y0);
}

/** Replaces each numeric `noul` of a /v1/systemone `answers` object by its pplx-scale value; anything else is returned as is. */
export function toPplxScale(answers: unknown): unknown {
  if (typeof answers !== "object" || answers === null) return answers;
  const out: Record<string, unknown> = {};
  for (const [id, a] of Object.entries(answers)) {
    const n = (a as { noul?: unknown } | null)?.noul;
    out[id] = typeof n === "number" && Number.isFinite(n) ? { ...(a as object), noul: map(n) } : a;
  }
  return out;
}
