/** The letters of the hints (vim's link hints, the sidebar's jump to a tab): the home row. */
export const HINT_KEYS = "asdfghjkl";

/** `n` labels over HINT_KEYS, breadth-first: as short as possible, and none is the start of another. */
export function hintLabels(n: number): string[] {
  const labels = [""];
  let next = 0;
  while (labels.length - next < n || next === 0) {
    const stem = labels[next++]!;
    for (const c of HINT_KEYS) labels.push(stem + c);
  }
  return labels.slice(next, next + n);
}
