export interface DiffLine { mark: " " | "+" | "-"; text: string; old: number | null; new: number | null }
export interface Block { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads a unified patch (a single file): the file header is ignored, each « @@ » opens a block. */
export function parseDiff(patch: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let old = 0;
  let fresh = 0;
  for (const line of patch.split("\n")) {
    const e = HEADER.exec(line);
    if (e) {
      current = {
        oldStart: Number(e[1]), oldCount: e[2] === undefined ? 1 : Number(e[2]),
        newStart: Number(e[3]), newCount: e[4] === undefined ? 1 : Number(e[4]),
        lines: [],
      };
      old = current.oldStart;
      fresh = current.newStart;
      blocks.push(current);
      continue;
    }
    if (!current || line === "" || line.startsWith("\\")) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === " ") current.lines.push({ mark: mark, text: text, old: old++, new: fresh++ });
    else if (mark === "-") current.lines.push({ mark: mark, text: text, old: old++, new: null });
    else if (mark === "+") current.lines.push({ mark: mark, text: text, old: null, new: fresh++ });
  }
  return blocks;
}

/** Line number of the new line of line i, or of the first new line that follows in the block. */
export function newPosition(b: Block, i: number): number {
  for (let k = i; k < b.lines.length; k++) {
    const n = b.lines[k]!.new;
    if (n !== null) return n;
  }
  return b.newStart + b.newCount;
}
