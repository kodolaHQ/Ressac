import type { DirectWidget } from "@webaios/noyau";

export type Pastille = { statut: string; elements: number | null };

/**
 * Status of each block: the chosen run's (full or summarized), replaced by the live state for blocks in progress.
 */
export function pastillesDe(execution: { blocs: { id: string; statut: string; elements: number | null }[] } | null, direct: DirectWidget | null): Record<string, Pastille> {
  const sortie: Record<string, Pastille> = {};
  for (const b of execution?.blocs ?? []) sortie[b.id] = { statut: b.statut, elements: b.elements };
  for (const [id, b] of Object.entries(direct?.blocs ?? {})) sortie[id] = { statut: b.statut, elements: b.elements };
  return sortie;
}
