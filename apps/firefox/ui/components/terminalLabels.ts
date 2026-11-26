import { LABELS } from "../../../../packages/kernel/src/mask/table";

/** What labelsOn reads of an xterm buffer row. */
interface Row {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * The labels printed on a terminal row, each with its first and last cell (0-based columns): a wide character before
 * one takes two cells, so the text's index is not its column.
 */
export function labelsOn(row: Row): { label: string; start: number; end: number }[] {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < row.length; x++) {
    const cell = row.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) columns.push(x);
  }
  return [...text.matchAll(LABELS)].map((m) => ({ label: m[0], start: columns[m.index]!, end: columns[m.index + m[0].length - 1]! }));
}

/**
 * `text` without bracketed-paste markers: a clipboard a page set could hold `\x1b[201~`, end the paste early and have
 * the rest (a `\r` included) taken as keystrokes. Removed until none is left: removing one may join another.
 */
export function withoutPasteMarkers(text: string): string {
  for (let prev = ""; prev !== text; ) [prev, text] = [text, text.replace(/\x1b\[20[01]~/g, "")];
  return text;
}
