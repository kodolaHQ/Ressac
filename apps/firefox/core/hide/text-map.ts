// « Cacher pour l'agent »: the page's visible text as one string, and the way back from its offsets to text nodes.

/** A text node's data; `block` is true when a block boundary precedes it. */
export type TextPiece = { text: string; block: boolean };

/** The pieces joined with "\n" at block boundaries, otherwise with nothing; `starts[i]` is piece i's offset. */
export function joinPieces(pieces: TextPiece[]): { text: string; starts: number[] } {
  let text = "";
  const starts: number[] = [];
  pieces.forEach((p, i) => {
    if (i && p.block) text += "\n";
    starts.push(text.length);
    text += p.text;
  });
  return { text, starts };
}

/** Each run [start, end) of the joined text as the piece slices [from, to) it covers. */
export function runsToPieces(runs: { start: number; end: number }[], starts: number[], lengths: number[]): { piece: number; from: number; to: number }[][] {
  return runs.map(({ start, end }) => {
    const out: { piece: number; from: number; to: number }[] = [];
    starts.forEach((s, piece) => {
      const from = Math.max(start, s) - s;
      const to = Math.min(end, s + (lengths[piece] ?? 0)) - s;
      if (to > from) out.push({ piece, from, to });
    });
    return out;
  });
}
