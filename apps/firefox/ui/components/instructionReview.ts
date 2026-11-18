import type { DiffLine } from "@ressac/kernel";

/** Unchanged lines kept around each change; longer unchanged runs fold into one « ⋯ N lignes » row. */
export const CONTEXT = 3;

/** A container path as the user reads it: relative to the workspace, the home as `~/`. */
export const shownPath = (p: string): string => (p.startsWith("/workspace/") ? p.slice("/workspace/".length) : p.startsWith("/home/node/") ? "~/" + p.slice("/home/node/".length) : p);

/** The changed lines with CONTEXT lines around them; the unchanged runs between are counted, not shown. */
export function foldLines(lines: DiffLine[]): (DiffLine | { folded: number })[] {
  const near = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind !== " ") for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) near[j] = true;
  });
  const out: (DiffLine | { folded: number })[] = [];
  lines.forEach((l, i) => {
    if (near[i]) return void out.push(l);
    const last = out.at(-1);
    if (last && "folded" in last) last.folded++;
    else out.push({ folded: 1 });
  });
  return out;
}
