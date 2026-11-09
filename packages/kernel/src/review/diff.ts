export interface DiffLine { marque: " " | "+" | "-"; texte: string; ancien: number | null; nouveau: number | null }
export interface Block { ancienDebut: number; ancienNombre: number; nouveauDebut: number; nouveauNombre: number; lignes: DiffLine[] }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads a unified patch (a single file): the file header is ignored, each « @@ » opens a block. */
export function parserDiff(patch: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let old = 0;
  let fresh = 0;
  for (const line of patch.split("\n")) {
    const e = HEADER.exec(line);
    if (e) {
      current = {
        ancienDebut: Number(e[1]), ancienNombre: e[2] === undefined ? 1 : Number(e[2]),
        nouveauDebut: Number(e[3]), nouveauNombre: e[4] === undefined ? 1 : Number(e[4]),
        lignes: [],
      };
      old = current.ancienDebut;
      fresh = current.nouveauDebut;
      blocks.push(current);
      continue;
    }
    if (!current || line === "" || line.startsWith("\\")) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === " ") current.lignes.push({ marque: mark, texte: text, ancien: old++, nouveau: fresh++ });
    else if (mark === "-") current.lignes.push({ marque: mark, texte: text, ancien: old++, nouveau: null });
    else if (mark === "+") current.lignes.push({ marque: mark, texte: text, ancien: null, nouveau: fresh++ });
  }
  return blocks;
}

/** Line number of the new line of line i, or of the first new line that follows in the block. */
export function newPosition(b: Block, i: number): number {
  for (let k = i; k < b.lignes.length; k++) {
    const n = b.lignes[k]!.nouveau;
    if (n !== null) return n;
  }
  return b.nouveauDebut + b.nouveauNombre;
}
