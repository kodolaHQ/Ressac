import type { DirectWidget } from "@webaios/kernel";

export type Badge = { statut: string; elements: number | null };

/**
 * Status of each block: the chosen run's (full or summarized), replaced by the live state for blocks in progress.
 */
export function badgesOf(execution: { blocs: { id: string; statut: string; elements: number | null }[] } | null, direct: DirectWidget | null): Record<string, Badge> {
  const output: Record<string, Badge> = {};
  for (const b of execution?.blocs ?? []) output[b.id] = { statut: b.statut, elements: b.elements };
  for (const [id, b] of Object.entries(direct?.blocs ?? {})) output[id] = { statut: b.statut, elements: b.elements };
  return output;
}
