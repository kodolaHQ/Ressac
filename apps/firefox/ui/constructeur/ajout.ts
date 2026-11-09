import type { CatalogueBloc } from "@webaios/noyau";
import { COLONNE_PX, RANGEE_PX } from "./disposition";

type Position = { x: number; y: number };

/** The file of a new `code` block: it returns its input as is. */
export const MODELE_CODE = "export default async (entree, webaios) => {\n  return entree;\n};\n";

/**
 * Parameters of a new block: the required fields that have a neutral value in the catalog (`liste.garder`: 10…). A
 * new unlinked block then only fails on its input; an address, with no neutral value, is left to fill in.
 */
export function parametresNeufs(c: CatalogueBloc): Record<string, unknown> {
  return Object.fromEntries(c.champs.filter((f) => f.requis && f.defaut !== undefined).map((f) => [f.nom, structuredClone(f.defaut)]));
}

/** `point`, or the first free place below it (a block dropped at the center does not cover a displayed block). */
export function placeLibre(point: Position, occupees: Iterable<Position>): Position {
  const prises = [...occupees];
  const libre = (p: Position) => prises.every((q) => Math.abs(q.x - p.x) >= COLONNE_PX * 0.9 || Math.abs(q.y - p.y) >= RANGEE_PX * 0.9);
  let p = { x: Math.round(point.x), y: Math.round(point.y) };
  for (let n = 0; n < 200 && !libre(p); n++) p = { x: p.x, y: p.y + RANGEE_PX };
  return p;
}

/** MIME type of a block dragged from the palette. */
export const GLISSER_BLOC = "application/x-webaios-bloc";
