export interface LigneDiff { marque: " " | "+" | "-"; texte: string; ancien: number | null; nouveau: number | null }
export interface Bloc { ancienDebut: number; ancienNombre: number; nouveauDebut: number; nouveauNombre: number; lignes: LigneDiff[] }

const ENTETE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Reads a unified patch (a single file): the file header is ignored, each « @@ » opens a block. */
export function parserDiff(patch: string): Bloc[] {
  const blocs: Bloc[] = [];
  let courant: Bloc | null = null;
  let ancien = 0;
  let nouveau = 0;
  for (const ligne of patch.split("\n")) {
    const e = ENTETE.exec(ligne);
    if (e) {
      courant = {
        ancienDebut: Number(e[1]), ancienNombre: e[2] === undefined ? 1 : Number(e[2]),
        nouveauDebut: Number(e[3]), nouveauNombre: e[4] === undefined ? 1 : Number(e[4]),
        lignes: [],
      };
      ancien = courant.ancienDebut;
      nouveau = courant.nouveauDebut;
      blocs.push(courant);
      continue;
    }
    if (!courant || ligne === "" || ligne.startsWith("\\")) continue;
    const marque = ligne[0];
    const texte = ligne.slice(1);
    if (marque === " ") courant.lignes.push({ marque, texte, ancien: ancien++, nouveau: nouveau++ });
    else if (marque === "-") courant.lignes.push({ marque, texte, ancien: ancien++, nouveau: null });
    else if (marque === "+") courant.lignes.push({ marque, texte, ancien: null, nouveau: nouveau++ });
  }
  return blocs;
}

/** Line number of the new line of line i, or of the first new line that follows in the block. */
export function positionNouvelle(b: Bloc, i: number): number {
  for (let k = i; k < b.lignes.length; k++) {
    const n = b.lignes[k]!.nouveau;
    if (n !== null) return n;
  }
  return b.nouveauDebut + b.nouveauNombre;
}
