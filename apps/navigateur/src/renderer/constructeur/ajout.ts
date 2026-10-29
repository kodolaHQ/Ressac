import type { CatalogueBloc } from "@webaios/noyau";
import { COLONNE_PX, RANGEE_PX } from "./disposition";

type Position = { x: number; y: number };

/** Le fichier d'un bloc `code` neuf : il rend son entrée telle quelle. */
export const MODELE_CODE = "export default async (entree, webaios) => {\n  return entree;\n};\n";

/**
 * Paramètres d'un bloc neuf : les champs requis qui ont une valeur neutre au catalogue (`liste.garder` : 10…). Un bloc
 * neuf non relié n'échoue alors que sur son entrée ; une adresse, sans valeur neutre, reste à remplir.
 */
export function parametresNeufs(c: CatalogueBloc): Record<string, unknown> {
  return Object.fromEntries(c.champs.filter((f) => f.requis && f.defaut !== undefined).map((f) => [f.nom, structuredClone(f.defaut)]));
}

/** `point`, ou la première place libre en dessous (un bloc posé au centre ne recouvre pas un bloc affiché). */
export function placeLibre(point: Position, occupees: Iterable<Position>): Position {
  const prises = [...occupees];
  const libre = (p: Position) => prises.every((q) => Math.abs(q.x - p.x) >= COLONNE_PX * 0.9 || Math.abs(q.y - p.y) >= RANGEE_PX * 0.9);
  let p = { x: Math.round(point.x), y: Math.round(point.y) };
  for (let n = 0; n < 200 && !libre(p); n++) p = { x: p.x, y: p.y + RANGEE_PX };
  return p;
}

/** Type MIME d'un bloc glissé depuis la palette. */
export const GLISSER_BLOC = "application/x-webaios-bloc";
